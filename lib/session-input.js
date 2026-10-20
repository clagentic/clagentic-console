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
var { validateFrom, validateFromSession, senderFields, forClient, stampRecord, newMessageId } = require("./injected-sender");
var senderRef = require("./sender-ref");
var directory = require("./session-directory");
var { slugifyAgentName } = agentsModule;

// The result vocabulary reported to the caller. "error" is not a verdict on
// the request: delivery was attempted and failed, so a caller may retry.
// "ambiguous" is a clean answer, not a failure: an address named several
// sessions and the caller picks one by id (see resolveSendTarget).
var RESULT = Object.freeze({
  DELIVERED: "delivered",
  RESUMED: "resumed-and-delivered",
  OPENED: "opened",
  LISTED: "listed",
  NOT_FOUND: "not-found",
  AMBIGUOUS: "ambiguous",
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

function present(value) {
  return value !== undefined && value !== null && value !== false;
}

// deps:
//   getProject(slug)      -> project context | null
//   listProjects()        -> [{ slug, project }] every project held (default: none)
//   agentCatalog(project) -> [{ name }] named agents on offer (default: the picker's catalog)
function createSessionInput(deps) {
  var getProject = deps.getProject;
  var listProjects = deps.listProjects || function () { return []; };

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

  function checkFromSession(fromSession) {
    var v = validateFromSession(fromSession);
    return v.error ? refused(v.error) : null;
  }

  // The directory entries of one project.
  function entriesOf(slug, project) {
    return directory.collect([{ slug: slug, project: project }]);
  }

  // Resolves --to to a console session. Returns { projectSlug, sessionId, via }
  // or { refusal } (not-found, ambiguous or refused).
  function resolveAddressTarget(req) {
    var parsed = directory.parseAddress(req.to);
    if (parsed.error) return { refusal: refused(parsed.error) };
    if (req.projectSlug && req.projectSlug !== parsed.project) {
      return { refusal: refused("project " + shown(req.projectSlug) + " does not match the address " + shown(req.to)) };
    }
    var resolved = resolveProject(parsed.project);
    if (resolved.refusal) return { refusal: resolved.refusal };
    var found = directory.resolve(entriesOf(parsed.project, resolved.project), parsed);
    if (found.none) {
      return { refusal: { ok: false, result: RESULT.NOT_FOUND, reason: "no session matches the address " + shown(req.to), to: req.to } };
    }
    if (found.candidates) {
      return {
        refusal: {
          ok: false,
          result: RESULT.AMBIGUOUS,
          reason: "the address " + shown(req.to) + " matches " + found.candidates.length + " sessions; choose one and send again with --project and --session",
          to: req.to,
          candidates: found.candidates,
        },
      };
    }
    return { projectSlug: parsed.project, sessionId: found.match.consoleSessionId, via: "to" };
  }

  // Resolves --reply: the sender of the most recent injected message in the
  // caller's own session. The caller is the session its environment references
  // (lib/sender-ref.js), checked against the daemon's own store.
  function resolveReplyTarget(req) {
    if (!req.senderProject || !req.senderSessionId) {
      return { refusal: refused("reply works only from inside a console session: no session reference was given (CLAGENTIC_CONSOLE_SESSION_ID is not set)") };
    }
    var ref = { project: req.senderProject, sessionId: req.senderSessionId };
    var caller = senderRef.resolve(getProject, ref);
    if (!caller) {
      return { refusal: refused("reply refused: the calling session " + shown(req.senderProject) + "/" + shown(req.senderSessionId) + " is not a running session the console holds") };
    }
    var callerProject = getProject(req.senderProject);
    var callerSession = null;
    callerProject.sm.sessions.forEach(function (s) {
      if (!callerSession && String(s.localId) === caller.sessionId) callerSession = s;
    });
    if (typeof callerProject.sm.loadSessionHistory === "function") callerProject.sm.loadSessionHistory(callerSession);
    var last = directory.lastInjectedSender(callerSession.history);
    if (last.reason) return { refusal: refused(last.reason) };

    // The sender is found the way --to finds a session: through the directory, by
    // the recorded project, vendor and vendor session id together. The console id
    // it matched is read now and never stored, because a console id can name
    // another session after a restart.
    var senderProject = getProject(last.project);
    if (!senderProject || !senderProject.sm) {
      return { refusal: { ok: false, result: RESULT.NOT_FOUND, reason: "reply refused: the sender's project " + shown(last.project) + " is not held by the console" } };
    }
    var found = directory.resolve(entriesOf(last.project, senderProject), { project: last.project, vendor: last.vendor, sessionId: last.cliSessionId });
    if (found.none) {
      return { refusal: { ok: false, result: RESULT.NOT_FOUND, reason: "reply refused: no session of the console holds the recorded sender (project " + shown(last.project) + ", vendor " + shown(last.vendor) + ", vendor session id " + shown(last.cliSessionId) + ")" } };
    }
    if (found.candidates) {
      return {
        refusal: {
          ok: false,
          result: RESULT.AMBIGUOUS,
          reason: "reply refused: the recorded sender matches " + found.candidates.length + " sessions; choose one and send again with --project and --session",
          candidates: found.candidates,
        },
      };
    }
    return { projectSlug: last.project, sessionId: found.match.consoleSessionId, via: "reply" };
  }

  // A reply goes only to a session this daemon's OS user may address (the rule
  // sender-ref applies to a caller). Returns a refusal or null.
  function verifyReplyTarget(project, session, req) {
    if (req.resolvedBy !== "reply") return null;
    if (typeof project.getLinuxUserForSession === "function" && project.getLinuxUserForSession(session)) {
      return refused("reply refused: the sender session " + shown(req.sessionId) + " runs as another OS user");
    }
    return null;
  }

  // Exactly one way of naming the target: sessionId (with projectSlug), to, or
  // reply. Returns { projectSlug, sessionId, via } for to and reply, {} to leave
  // the request as it is, or { refusal }.
  function resolveSendTarget(req) {
    var named = ["sessionId", "to", "reply"].filter(function (k) { return present(req[k]); });
    if (named.length > 1) return { refusal: refused("name the target one way only: sessionId, to or reply (given: " + named.join(", ") + ")") };
    if (present(req.to)) return resolveAddressTarget(req);
    if (present(req.reply)) return resolveReplyTarget(req);
    return {};
  }

  // History entry that marks the turn as injected, not typed. The input is
  // already delivered when this runs, so a failure to record is logged and does
  // not turn a delivered turn into an error a caller would retry.
  function recordInjected(project, session, req, initiator, messageId) {
    var entry = stampRecord({
      type: "user_message",
      text: req.prompt,
      source: "external-trigger",
      initiator: initiator,
      messageId: messageId,
    });
    if (req.triggerId) entry.triggerId = req.triggerId;
    if (req.contextNote) entry.contextNote = req.contextNote;
    // The reference a console-started caller holds, resolved in the daemon's own
    // store; one it does not hold falls through to declared or undeclared.
    var extracted = senderRef.resolve(getProject, { project: req.senderProject, sessionId: req.senderSessionId });
    var sender = senderFields(initiator, validateFrom(req.from).from, extracted, validateFromSession(req.fromSession).fromSession);
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
      name: session.sessionName || null,
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

    // The same id goes to the vendor and into the history entry and sender record.
    var messageId = newMessageId();

    function delivered() {
      recordInjected(project, session, req, initiator, messageId);
      var out = describe(project, session);
      out.ok = true;
      out.result = (resumed || needsStart) ? RESULT.RESUMED : RESULT.DELIVERED;
      // Said back so a caller that gave an address (or none, for a reply)
      // learns which session took the input.
      if (req.resolvedBy) {
        out.resolvedBy = req.resolvedBy;
        out.project = req.projectSlug;
        out.label = senderRef.labelFor(out.agent, out.vendor, req.projectSlug);
      }
      return out;
    }

    function pushFailure(e) {
      console.error("[session-input] delivery failed:", messageOf(e));
      return { ok: false, result: RESULT.ERROR, reason: "delivery failed: " + messageOf(e) };
    }

    if (processing) {
      try { sdk.pushMessage(session, req.prompt, null, initiator, messageId); }
      catch (e) { return pushFailure(e); }
      return delivered();
    }

    session.isProcessing = true;
    project.onProcessingChanged();
    session.sentToolResults = {};
    if (needsStart) {
      return startThen(project, session, "session " + String(session.cliSessionId), function () {
        return sdk.startQuery(session, req.prompt, undefined, project.getLinuxUserForSession(session), initiator, messageId);
      }, delivered, sendStartFailure);
    }
    try { sdk.pushMessage(session, req.prompt, null, initiator, messageId); }
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
    // A copy: resolving an address fills in the project and session id.
    req = Object.assign({}, req);
    var init = resolveInitiator(req.initiator);
    if (init.refusal) return init.refusal;
    var promptRefusal = checkPrompt(req.prompt);
    if (promptRefusal) return promptRefusal;
    var fromRefusal = checkFrom(req.from) || checkFromSession(req.fromSession);
    if (fromRefusal) return fromRefusal;
    var target = resolveSendTarget(req);
    if (target.refusal) return target.refusal;
    // Set here and nowhere else, so a caller cannot supply it.
    req.resolvedBy = target.via;
    if (target.via) {
      req.projectSlug = target.projectSlug;
      req.sessionId = target.sessionId;
    }
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
    if (live) return verifyReplyTarget(project, live, req) || deliver(project, live, req, init.initiator, false);

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
        return verifyReplyTarget(project, session, req) || deliver(project, session, req, init.initiator, true);
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
    if (present(req.sessionName)) {
      var named = directory.validateName(req.sessionName);
      if (named.error) return { refusal: refused(named.error) };
      var taken = nameTakenBy(project, named.name);
      if (taken) {
        return { refusal: refused("session name " + shown(named.name) + " is already in use by " + taken + " in this project; a name is unique among its sessions that are not reaped") };
      }
      options.sessionName = named.name;
    }
    return { options: options };
  }

  // The console id of a non-reaped session of the project holding the name, as
  // text for a refusal, or null. Reaped sessions do not hold a name.
  function nameTakenBy(project, name) {
    var holder = null;
    project.sm.sessions.forEach(function (s) {
      if (!holder && !s.hidden && s.sessionName === name && senderRef.isLive(s)) holder = "session " + String(s.localId);
    });
    return holder;
  }

  // The token of an address, for a session to open: a named agent of the project's
  // catalog, else a vendor (opening addresses no existing session, so there is
  // nothing to be ambiguous). Returns { kind: { agentName } | { vendor } } or { refusal }.
  function openKindFromToken(project, token) {
    var agent = agentCatalog(project).filter(function (a) {
      return a && slugifyAgentName(a.name) === token;
    })[0];
    if (agent) return { kind: { agentName: agent.name } };
    if (isKnownVendor(token)) return { kind: { vendor: token } };
    return { refusal: refused("unknown agent or vendor " + shown(token)) };
  }

  // req: { projectSlug, prompt, vendor?, agentName?, sessionVisibility?,
  //        initiator?, contextNote?, cwd?, triggerId? }
  // Returns the result, or a Promise of it when the first turn starts
  // asynchronously (see settle()).
  function openSession(req) {
    req = Object.assign({}, req);
    var init = resolveInitiator(req.initiator);
    if (init.refusal) return init.refusal;
    var promptRefusal = checkPrompt(req.prompt);
    if (promptRefusal) return promptRefusal;
    var openFromRefusal = checkFrom(req.from) || checkFromSession(req.fromSession);
    if (openFromRefusal) return openFromRefusal;
    var parsed = null;
    if (present(req.to)) {
      parsed = directory.parseAddress(req.to);
      if (parsed.error) return refused(parsed.error);
      if (req.projectSlug && req.projectSlug !== parsed.project) {
        return refused("project " + shown(req.projectSlug) + " does not match the address " + shown(req.to));
      }
      if (present(req.vendor) || present(req.agentName)) {
        return refused("the address names the agent or vendor; do not also give vendor or agentName");
      }
      if (parsed.name !== undefined) {
        if (present(req.sessionName)) return refused("the address names the session (/" + parsed.name + "); do not also give sessionName");
        req.sessionName = parsed.name;
      }
      req.projectSlug = parsed.project;
    }
    var resolved = resolveProject(req.projectSlug);
    if (resolved.refusal) return resolved.refusal;
    var project = resolved.project;
    if (parsed && parsed.token) {
      var named = openKindFromToken(project, parsed.token);
      if (named.refusal) return named.refusal;
      req = Object.assign(req, named.kind);
    }
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
    var openedMessageId = newMessageId();
    return startThen(project, sess, "local session " + sess.localId, function () {
      return project.sdk.startQuery(sess, req.prompt, undefined, project.getLinuxUserForSession(sess), init.initiator, openedMessageId);
    }, function () {
      // Recorded once, only now that the query has started: a rejected start
      // leaves no history entry for a prompt that never ran.
      recordInjected(project, sess, req, init.initiator, openedMessageId);
      return opened();
    }, openStartFailure);
  }

  // req: { projectSlug?, agentName?, vendor?, state? }. Read-only: the sessions
  // of the console's own store (lib/session-directory.js), newest first.
  function listSessions(req) {
    req = req || {};
    if (req.projectSlug && !getProject(req.projectSlug)) {
      return refused("unknown project " + shown(req.projectSlug));
    }
    var found = directory.list(listProjects(), {
      project: req.projectSlug,
      agent: req.agentName,
      vendor: req.vendor,
      state: req.state,
    });
    if (found.error) return refused(found.error);
    return { ok: true, result: RESULT.LISTED, count: found.entries.length, sessions: found.entries };
  }

  return {
    openSession: logged("open_session", neverThrows(openSession)),
    sendInput: logged("send_session_input", neverThrows(sendInput)),
    listSessions: logged("list_sessions", neverThrows(listSessions)),
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
