// session-input.js - open a session, or send input to one, on behalf of a
// caller that is not the authenticated browser: an external-trigger file
// (project-external-trigger.js) or the daemon IPC verbs (lib/daemon.js).
// One implementation behind both, so the same request gets the same result.
//
// Any caller, any session kind: the vendor and agent come from the request on
// open, and from the stored session on send. Input never counts as a human
// turn: an initiator of "human" (or anything unknown) is refused, and an absent
// one is "trigger". Human turns come only from the browser's WebSocket path.
//
// Security is unchanged from the external trigger: the callers that reach this
// are the OS user that owns the config directory (file drop; daemon.sock is
// chmod 0700). Routing per user in multi-user mode remains future work.

var { INITIATORS } = require("./turn-initiator");
var { isKnownVendor } = require("./yoke");
var { getNewWorkRefusal } = require("./new-work-gate");
var agentsModule = require("./agents");
var sessionResume = require("./session-resume");
var { logField, logText } = require("./log-field");
var { validateFrom, senderFields, forClient } = require("./injected-sender");
var senderRef = require("./sender-ref");

// The result vocabulary reported to the caller. "error" is not a verdict on
// the request: delivery was attempted and failed, so a caller may retry.
var RESULT = Object.freeze({
  DELIVERED: "delivered",
  RESUMED: "resumed-and-delivered",
  OPENED: "opened",
  NOT_FOUND: "not-found",
  REFUSED: "refused",
  ERROR: "error",
});

// Initiators injected input may name. HUMAN is deliberately absent.
var ACCEPTED_INITIATORS = Object.freeze([
  INITIATORS.TRIGGER,
  INITIATORS.SCHEDULED,
  INITIATORS.SCHEDULED_NOW,
  INITIATORS.LOOP,
]);

var VISIBILITIES = Object.freeze(["shared", "private"]);

function shown(value) {
  return JSON.stringify(String(value).slice(0, 64));
}

function refused(reason) {
  return { ok: false, result: RESULT.REFUSED, reason: reason };
}

// The daemon is shedding new work (memory pressure). Not a verdict on the
// request, so a file-drop caller keeps its trigger and tries again later.
function refusedForLoad(reason) {
  return { ok: false, result: RESULT.REFUSED, reason: reason, retryable: true };
}

// Returns { initiator } or { refusal }.
function resolveInitiator(raw) {
  if (raw === undefined || raw === null) return { initiator: INITIATORS.TRIGGER };
  if (typeof raw === "string" && ACCEPTED_INITIATORS.indexOf(raw) !== -1) return { initiator: raw };
  var why = raw === INITIATORS.HUMAN
    ? "human turns come only from the authenticated browser"
    : "unknown initiator";
  return {
    refusal: refused("initiator " + shown(raw) + " refused: " + why + " (accepted: " + ACCEPTED_INITIATORS.join(", ") + ")"),
  };
}

// A session in memory is addressed by the id its vendor assigned or by the
// console's own session id (what open-session returns, always present).
function findSession(sm, id) {
  var byVendorId = null;
  var byConsoleId = null;
  sm.sessions.forEach(function (s) {
    if (!byVendorId && s.cliSessionId === id) byVendorId = s;
    if (!byConsoleId && String(s.localId) === id) byConsoleId = s;
  });
  return byVendorId || byConsoleId;
}

function messageOf(err) {
  return err && err.message ? err.message : String(err);
}

// The query did not start, so the input was not delivered and sending it again
// cannot deliver it twice.
function sendStartFailure(project, session, label, err) {
  session.isProcessing = false;
  project.onProcessingChanged();
  console.error("[session-input] turn start failed for " + label + ":", messageOf(err));
  return { ok: false, result: RESULT.ERROR, retryable: true, reason: "turn start failed: " + messageOf(err) };
}

// A session this request created whose first turn did not start is removed, so
// a failed open leaves nothing behind, and is not retried: the caller opens
// again if it wants to.
function openStartFailure(project, session, label, err) {
  session.isProcessing = false;
  project.onProcessingChanged();
  console.error("[session-input] open failed for " + label + ":", messageOf(err));
  try { project.sm.deleteSession(session.localId); }
  catch (e) { console.error("[session-input] could not remove " + label + ":", messageOf(e)); }
  return { ok: false, result: RESULT.ERROR, retryable: false, reason: "open failed: " + messageOf(err) };
}

// Starts the session's query and answers when it has actually started: a
// rejection (or a synchronous throw) is a failed delivery, never a delivered
// one. Returns the value of onStarted(), or a Promise of it when the start is
// asynchronous. onFailed(project, session, label, err) makes the failure result.
function startThen(project, session, label, start, onStarted, onFailed) {
  var started;
  try { started = start(); }
  catch (e) { return onFailed(project, session, label, e); }
  if (started && typeof started.then === "function") {
    return started.then(onStarted, function (err) { return onFailed(project, session, label, err); });
  }
  return onStarted();
}

// A caller on the daemon's IPC or the trigger watcher must always get a
// result, so an unexpected throw is reported as an error, not propagated.
function neverThrows(fn) {
  return function (req) {
    try { return fn(req); }
    catch (e) {
      console.error("[session-input] unexpected failure:", messageOf(e));
      return { ok: false, result: RESULT.ERROR, reason: "unexpected failure: " + messageOf(e) };
    }
  };
}

// One line per request, whichever caller made it (IPC verb or file drop): the
// project, the console session and the result, with the reason when the
// request was refused or failed. The prompt, the context note and the request
// body are never part of it; a reason only quotes a bounded identifier.
function logResult(verb, req, out) {
  req = req || {};
  out = out || {};
  var line = "[session-input] " + verb + ": project=" + logField(req.projectSlug)
    + " session=" + logField(out.consoleSessionId || req.sessionId)
    + " result=" + logField(out.result);
  if (out.retryable === true) line += " retryable=true";
  // Last, because it is free text.
  if (out.reason) line += " reason=" + logText(out.reason);
  console.log(line);
}

function logged(verb, fn) {
  return function (req) {
    var out = fn(req);
    if (out && typeof out.then === "function") {
      return out.then(function (result) { logResult(verb, req, result); return result; });
    }
    logResult(verb, req, out);
    return out;
  };
}

// deps:
//   getProject(slug)      -> project context | null
//   agentCatalog(project) -> [{ name }] named agents on offer (default: the picker's catalog)
function createSessionInput(deps) {
  var getProject = deps.getProject;

  function defaultAgentCatalog(project) {
    // Neither lookup throws: both answer [] when discovery has not run or the
    // directory is absent.
    return agentsModule.getAll().concat(agentsModule.readProjectAgents(project.cwd));
  }
  var agentCatalog = deps.agentCatalog || defaultAgentCatalog;

  function resolveProject(slug) {
    var project = typeof slug === "string" && slug ? getProject(slug) : null;
    if (!project) return { refusal: refused("unknown project " + shown(slug)) };
    if (!project.sm || !project.sdk) {
      return { refusal: { ok: false, result: RESULT.ERROR, reason: "project " + shown(slug) + " is not ready" } };
    }
    return { project: project };
  }

  function checkPrompt(prompt) {
    return typeof prompt === "string" && prompt ? null : refused("prompt must be a non-empty string");
  }

  function checkFrom(from) {
    var v = validateFrom(from);
    return v.error ? refused(v.error) : null;
  }

  // History entry that marks the turn as injected, not typed. The input is
  // already delivered when this runs, so a failure to record is logged and does
  // not turn a delivered turn into an error a caller would retry.
  function recordInjected(project, session, req, initiator) {
    var entry = {
      type: "user_message",
      text: req.prompt,
      source: "external-trigger",
      initiator: initiator,
    };
    if (req.triggerId) entry.triggerId = req.triggerId;
    if (req.contextNote) entry.contextNote = req.contextNote;
    // The reference a console-started caller holds, resolved in the daemon's own
    // store; one it does not hold falls through to declared or undeclared.
    var extracted = senderRef.resolve(getProject, { project: req.senderProject, sessionId: req.senderSessionId });
    var sender = senderFields(initiator, validateFrom(req.from).from, extracted);
    for (var k in sender) entry[k] = sender[k];
    try {
      project.sm.recordHistoryEntry(session, entry, true);
      project.sm.appendToSessionFile(session, entry);
      // Clients already viewing the session see it now, not after a reload.
      if (typeof project.sm.sendToSession === "function") {
        project.sm.sendToSession(session, forClient(entry));
      }
    } catch (e) {
      console.error("[session-input] failed to record injected message:", e.message || e);
    }
  }

  function describe(project, session) {
    return {
      consoleSessionId: String(session.localId),
      sessionId: session.cliSessionId || null,
      localId: session.localId,
      vendor: session.vendor || project.sm.defaultVendor || null,
      agent: session.agentName || null,
    };
  }

  // Delivers req.prompt as the session's next turn: into the running query,
  // or by starting one (the session's runtime was ended) on the session's own
  // vendor and agent.
  function deliver(project, session, req, initiator, resumed) {
    var sdk = project.sdk;
    var processing = !!session.isProcessing;
    var needsStart = !processing && !session.queryInstance && (!session.worker || session.messageQueue !== "worker");

    if (needsStart) {
      var refusal = getNewWorkRefusal();
      if (refusal) return refusedForLoad(refusal);
    }

    function delivered() {
      recordInjected(project, session, req, initiator);
      var out = describe(project, session);
      out.ok = true;
      out.result = (resumed || needsStart) ? RESULT.RESUMED : RESULT.DELIVERED;
      return out;
    }

    function pushFailure(e) {
      console.error("[session-input] delivery failed:", messageOf(e));
      return { ok: false, result: RESULT.ERROR, reason: "delivery failed: " + messageOf(e) };
    }

    if (processing) {
      try { sdk.pushMessage(session, req.prompt, null, initiator); }
      catch (e) { return pushFailure(e); }
      return delivered();
    }

    session.isProcessing = true;
    project.onProcessingChanged();
    session.sentToolResults = {};
    if (needsStart) {
      return startThen(project, session, "session " + String(session.cliSessionId), function () {
        return sdk.startQuery(session, req.prompt, undefined, project.getLinuxUserForSession(session), initiator);
      }, delivered, sendStartFailure);
    }
    try { sdk.pushMessage(session, req.prompt, null, initiator); }
    catch (e) {
      session.isProcessing = false;
      project.onProcessingChanged();
      return pushFailure(e);
    }
    return delivered();
  }

  // req: { projectSlug, sessionId, prompt, initiator?, contextNote?, triggerId? }
  // Returns the result, or a Promise of it when the session must be read from
  // the store first (see settle()).
  function sendInput(req) {
    req = req || {};
    var init = resolveInitiator(req.initiator);
    if (init.refusal) return init.refusal;
    var promptRefusal = checkPrompt(req.prompt);
    if (promptRefusal) return promptRefusal;
    var fromRefusal = checkFrom(req.from);
    if (fromRefusal) return fromRefusal;
    if (typeof req.sessionId !== "string" || !req.sessionId) {
      return refused("sessionId must be a non-empty string");
    }
    // An id names files in the store; one that is not a plain id is refused, not
    // looked up and not reported as absent.
    if (!sessionResume.isSafeSessionId(req.sessionId)) {
      return refused("unsafe session id " + shown(req.sessionId) + " refused");
    }
    var resolved = resolveProject(req.projectSlug);
    if (resolved.refusal) return resolved.refusal;
    var project = resolved.project;

    var live = findSession(project.sm, req.sessionId);
    if (live) return deliver(project, live, req, init.initiator, false);

    // Only the console's own store is asked: a session started outside the
    // console is not addressable, and its absence here is positive.
    var storeDeps = { sm: project.sm, cwd: project.cwd };
    function notFound() {
      return { ok: false, result: RESULT.NOT_FOUND, reason: "no session " + shown(req.sessionId) + " in project " + shown(req.projectSlug) };
    }
    return sessionResume.sessionExistsInStore(project.sm, req.sessionId).then(function (exists) {
      if (!exists) return notFound();
      var gate = getNewWorkRefusal();
      if (gate) return refusedForLoad(gate);
      // activate:false: nobody asked to look at this session.
      return sessionResume.resumeStoredSession(storeDeps, req.sessionId, { activate: false }).then(function (session) {
        // The session was found in the store, so a manager that declines to
        // bring it back is a failure to resume, not an absence.
        if (!session) {
          return { ok: false, result: RESULT.ERROR, retryable: false, reason: "session " + shown(req.sessionId) + " exists but could not be resumed" };
        }
        return deliver(project, session, req, init.initiator, true);
      });
    }).catch(function (err) {
      // Lookup and resume failures carry whether trying again can help
      // (session-resume.js); the input was not delivered either way.
      console.error("[session-input] send failed:", messageOf(err));
      return { ok: false, result: RESULT.ERROR, retryable: !!(err && err.retryable), reason: "send failed: " + messageOf(err) };
    });
  }

  // Checks an open request's session kind; returns { options } for
  // sm.createSession (the options the browser's new_session passes) or { refusal }.
  function resolveSessionKind(project, req) {
    var options = {};
    if (req.vendor !== undefined && req.vendor !== null) {
      if (typeof req.vendor !== "string" || !isKnownVendor(req.vendor)) {
        return { refusal: refused("unknown vendor " + shown(req.vendor)) };
      }
      options.vendor = req.vendor;
    }
    if (req.agentName !== undefined && req.agentName !== null) {
      var known = typeof req.agentName === "string" && agentCatalog(project).some(function (a) {
        return a && a.name === req.agentName;
      });
      if (!known) return { refusal: refused("unknown agent " + shown(req.agentName)) };
      options.agentName = req.agentName;
    }
    if (req.sessionVisibility !== undefined && req.sessionVisibility !== null) {
      if (VISIBILITIES.indexOf(req.sessionVisibility) === -1) {
        return { refusal: refused("unknown sessionVisibility " + shown(req.sessionVisibility) + " (accepted: " + VISIBILITIES.join(", ") + ")") };
      }
      options.sessionVisibility = req.sessionVisibility;
    }
    return { options: options };
  }

  // req: { projectSlug, prompt, vendor?, agentName?, sessionVisibility?,
  //        initiator?, contextNote?, cwd?, triggerId? }
  // Returns the result, or a Promise of it when the first turn starts
  // asynchronously (see settle()).
  function openSession(req) {
    req = req || {};
    var init = resolveInitiator(req.initiator);
    if (init.refusal) return init.refusal;
    var promptRefusal = checkPrompt(req.prompt);
    if (promptRefusal) return promptRefusal;
    var openFromRefusal = checkFrom(req.from);
    if (openFromRefusal) return openFromRefusal;
    var resolved = resolveProject(req.projectSlug);
    if (resolved.refusal) return resolved.refusal;
    var project = resolved.project;
    var kind = resolveSessionKind(project, req);
    if (kind.refusal) return kind.refusal;
    var gate = getNewWorkRefusal();
    if (gate) return refusedForLoad(gate);

    var sm = project.sm;
    var sess = sm.createSession(kind.options);
    var label = req.triggerId ? " — " + String(req.triggerId).substring(0, 12) : "";
    sess.title = (req.contextNote || "External trigger") + label;
    if (req.cwd) sess.cwd = req.cwd;
    sm.saveSessionFile(sess);
    sm.broadcastSessionList();

    sess.isProcessing = true;
    project.onProcessingChanged();
    sess.sentToolResults = {};
    // The session stays open for follow-up from a person.
    sess.acceptEditsAfterStart = true;

    function opened() {
      var out = describe(project, sess);
      out.ok = true;
      out.result = RESULT.OPENED;
      return out;
    }
    return startThen(project, sess, "local session " + sess.localId, function () {
      return project.sdk.startQuery(sess, req.prompt, undefined, project.getLinuxUserForSession(sess), init.initiator);
    }, function () {
      // Recorded once, only now that the query has started: a rejected start
      // leaves no history entry for a prompt that never ran.
      recordInjected(project, sess, req, init.initiator);
      return opened();
    }, openStartFailure);
  }

  return {
    openSession: logged("open_session", neverThrows(openSession)),
    sendInput: logged("send_session_input", neverThrows(sendInput)),
  };
}

// sendInput and openSession answer synchronously when nothing has to wait and
// with a Promise otherwise, so a caller that can act at once (the trigger
// watcher on a live session) does. settle() runs fn on either.
function settle(valueOrPromise, fn) {
  if (valueOrPromise && typeof valueOrPromise.then === "function") return valueOrPromise.then(fn);
  return fn(valueOrPromise);
}

module.exports = {
  createSessionInput: createSessionInput,
  settle: settle,
  resolveInitiator: resolveInitiator,
  RESULT: RESULT,
  ACCEPTED_INITIATORS: ACCEPTED_INITIATORS,
};
