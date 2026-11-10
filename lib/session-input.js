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
var { validateFrom, validateFromSession, senderFields, forClient, stampRecord, newMessageId, isInjected, consoleTurnEntry } = require("./injected-sender");
var senderRef = require("./sender-ref");
var { findNameHolder, releaseReapedHolders } = require("./session-name-holder");
var directory = require("./session-directory");
var permissionSettings = require("./permission-settings");
var { checkSettingsFile } = require("./session-settings-file");
var { checkPermissionMode } = require("./permission-mode-policy");
var { slugifyAgentName } = agentsModule;
var outboundEntry = require("./outbound-entry");
var sessionEnd = require("./session-end");
var promptSource = require("./prompt-source");
var promptAnswer = require("./prompt-answer");

// The result vocabulary reported to the caller. "error" is not a verdict on
// the request: delivery was attempted and failed, so a caller may retry.
// "ambiguous" is a clean answer, not a failure: an address named several
// sessions and the caller picks one by id (see resolveSendTarget).
// "busy" is only answered to a scheduled firing (fireScheduled): the session was
// mid-turn and the input was not delivered; the IPC verbs never answer it.
var RESULT = Object.freeze({
  DELIVERED: "delivered",
  RESUMED: "resumed-and-delivered",
  OPENED: "opened",
  LISTED: "listed",
  NOT_FOUND: "not-found",
  AMBIGUOUS: "ambiguous",
  REFUSED: "refused",
  ERROR: "error",
  BUSY: "busy",
  ENDED: "ended",
  ALREADY_ENDED: "already-ended",
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
  // A scheduled firing skipped for a busy session retries every few seconds;
  // one line per retry would bury the log.
  if (out.result === RESULT.BUSY) return;
  var line = "[session-input] " + verb + ": project=" + logField(req.projectSlug)
    + " session=" + logField(out.consoleSessionId || req.sessionId)
    + " result=" + logField(out.result);
  if (out.retryable === true) line += " retryable=true";
  // Last, because it is free text.
  if (out.reason) line += " reason=" + logText(out.reason);
  console.log(line);
}

// after(verb, req, result), when given, runs once the line is logged. It must
// not throw into the caller: the result is already decided.
function logged(verb, fn, after) {
  function finish(req, result) {
    logResult(verb, req, result);
    if (after) {
      try { after(verb, req, result); }
      catch (e) { console.error("[session-input] after-result hook failed:", messageOf(e)); }
    }
    return result;
  }
  return function (req) {
    var out = fn(req);
    if (out && typeof out.then === "function") {
      return out.then(function (result) { return finish(req, result); });
    }
    return finish(req, out);
  };
}

function present(value) {
  return value !== undefined && value !== null && value !== false;
}

// deps:
//   getProject(slug)      -> project context | null
//   listProjects()        -> [{ slug, project }] every project held (default: none)
//   agentCatalog(project) -> [{ name }] named agents on offer (default: the picker's catalog)
//   getPermissionSettings() -> the server's permission settings (lib/permission-settings.js)
//                              or null (default: the settings' defaults)
//   outboundLedger        -> { record(entry) } the sender-side ledger
//                            (lib/outbound-ledger.js); default: none kept
//   now()                 -> ms clock for ledger entries (default Date.now)
function createSessionInput(deps) {
  var getProject = deps.getProject;
  var listProjects = deps.listProjects || function () { return []; };
  var outboundLedger = deps.outboundLedger || null;
  var clock = deps.now || Date.now;

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
    // The in-memory window holds only the tail of a long history. A miss there
    // falls through to a bounded reverse read of the stored file, which stops
    // at the newest injected entry and touches no session state.
    if (last.none) {
      if (typeof callerProject.sm.findNewestHistoryEntry !== "function") {
        console.error("[session-input] reply: the session manager has no stored-history reader; cannot look past the in-memory window");
        return { refusal: refused("reply refused: the stored history of the calling session cannot be searched") };
      }
      var stored = null;
      try {
        stored = callerProject.sm.findNewestHistoryEntry(callerSession, isInjected);
      } catch (e) {
        console.error("[session-input] reply: stored history unreadable:", messageOf(e));
      }
      if (stored) last = directory.lastInjectedSender([stored]);
    }
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

  // The sender fields of a request. The reference a console-started caller holds
  // is resolved in the daemon's own store; one it does not hold falls through to
  // declared or undeclared.
  function senderOf(req, initiator) {
    var extracted = senderRef.resolve(getProject, { project: req.senderProject, sessionId: req.senderSessionId });
    return senderFields(initiator, validateFrom(req.from).from, extracted, validateFromSession(req.fromSession).fromSession);
  }

  // Appends to the sender-side ledger. A ledger that cannot be written is
  // logged by the ledger and never changes the answer to the request.
  function writeLedger(entry) {
    if (!outboundLedger) return;
    try { outboundLedger.record(entry); }
    catch (e) { console.error("[session-input] outbound ledger failed:", messageOf(e)); }
  }

  // The verb a result is logged under, as the ledger names it. Other verbs
  // (listing, a scheduled firing) are not outbound calls of a sender.
  var LEDGER_VERB = {
    open_session: outboundEntry.VERB.OPEN_SESSION,
    send_session_input: outboundEntry.VERB.SEND_INPUT,
    end_session: outboundEntry.VERB.END_SESSION,
    answer_prompt: outboundEntry.VERB.ANSWER_PROMPT,
  };

  // A delivery, recorded where the history entry is, so both carry the same
  // message id and sender.
  function ledgerDelivery(verb, project, session, req, initiator, messageId, sender) {
    if (!outboundLedger) return;
    // Building the entry reads the session and the project; none of it may
    // throw into the delivery.
    try {
      var linuxUser = typeof project.getLinuxUserForSession === "function" ? project.getLinuxUserForSession(session) : null;
      writeLedger(outboundEntry.buildEntry({
        verb: verb,
        ts: new Date(clock()).toISOString(),
        req: req,
        out: null,
        initiator: initiator,
        messageId: messageId,
        sender: sender,
        target: Object.assign({ project: req.projectSlug, runsAs: linuxUser || outboundEntry.RUNS_AS_DAEMON }, describe(project, session)),
      }));
    } catch (e) {
      console.error("[session-input] outbound ledger entry failed:", messageOf(e));
    }
  }

  // A request that was not delivered (refused, not found, ambiguous, failed).
  // A delivery already left its entry in recordInjected.
  function ledgerOutcome(verb, req, out) {
    if (!outboundLedger || !LEDGER_VERB[verb] || !out) return;
    // A delivery already left its entry; an end and an answer leave theirs here.
    if (out.ok === true && verb !== "end_session" && verb !== "answer_prompt") return;
    req = req || {};
    var init = resolveInitiator(req.initiator);
    var initiator = init.initiator || null;
    writeLedger(outboundEntry.buildEntry({
      verb: LEDGER_VERB[verb],
      ts: new Date(clock()).toISOString(),
      req: req,
      out: out,
      initiator: initiator,
      sender: senderOf(req, initiator),
      target: { project: req.projectSlug, consoleSessionId: out.consoleSessionId, sessionId: out.sessionId, agent: out.agent, vendor: out.vendor, name: out.name },
    }));
  }

  // History entry that marks the turn as injected, not typed. The input is
  // already delivered when this runs, so a failure to record is logged and does
  // not turn a delivered turn into an error a caller would retry.
  function recordInjected(verb, project, session, req, initiator, messageId) {
    var entry;
    if (req.automation) {
      // A turn the console composed itself (fireScheduled): the console is the
      // sender, shown as the automation, never as the operator or a caller.
      entry = consoleTurnEntry(initiator, req.prompt, req.automation.note);
      entry.messageId = messageId;
    } else {
      entry = stampRecord({
        type: "user_message",
        text: req.prompt,
        source: "external-trigger",
        initiator: initiator,
        messageId: messageId,
      });
      if (req.triggerId) entry.triggerId = req.triggerId;
      if (req.contextNote) entry.contextNote = req.contextNote;
      var sender = senderOf(req, initiator);
      for (var k in sender) entry[k] = sender[k];
      ledgerDelivery(verb, project, session, req, initiator, messageId, sender);
    }
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

  // The OS user a turn starts as. A console automation also grants that user
  // access to the project, as the scheduled turn always did; the callers that
  // act for someone else (send-input, a trigger) keep the lookup alone.
  function startUserFor(project, session, req) {
    if (req.automation && typeof project.ensureProjectAccessForSession === "function") {
      return project.ensureProjectAccessForSession(session);
    }
    return project.getLinuxUserForSession(session);
  }

  // A turn the console started on its own is not one a client is waiting on, so
  // the clients viewing the session are told it is running.
  function announceStartedTurn(project, session) {
    try {
      project.sm.sendToSession(session, { type: "status", status: "processing" });
      project.sm.broadcastSessionList();
    } catch (e) {
      console.error("[session-input] could not announce the started turn:", messageOf(e));
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
      recordInjected(outboundEntry.VERB.SEND_INPUT, project, session, req, initiator, messageId);
      if (req.automation && !processing) announceStartedTurn(project, session);
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
        return sdk.startQuery(session, req.prompt, undefined, startUserFor(project, session, req), initiator, messageId);
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
    // Set by fireScheduled and nowhere else, so a caller cannot make its input
    // look like the console's own automation.
    delete req.automation;
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

    return withSession(project, req, function (session, resumed) {
      return verifyReplyTarget(project, session, req) || deliver(project, session, req, init.initiator, resumed);
    });
  }

  // Runs act(session, resumed) on the session req.sessionId names: the one in
  // memory, else the one the console's store holds, brought back on its own
  // vendor and agent. Answers act's result, or a Promise of it when the store
  // must be read; a session the store does not hold is not-found.
  function withSession(project, req, act) {
    var live = findSession(project.sm, req.sessionId);
    if (live) return act(live, false);

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
        return act(session, true);
      });
    }).catch(function (err) {
      // Lookup and resume failures carry whether trying again can help
      // (session-resume.js); the input was not delivered either way.
      console.error("[session-input] send failed:", messageOf(err));
      return { ok: false, result: RESULT.ERROR, retryable: !!(err && err.retryable), reason: "send failed: " + messageOf(err) };
    });
  }

  // The target of a verb that acts on one existing session (end-session,
  // answer-prompt), named by id with its project or by --to, resolved as
  // send-input resolves it. Fills req.projectSlug and req.sessionId in (req is
  // the caller's own copy). Returns { project } or { refusal }.
  function resolveSessionTarget(req) {
    var named = ["sessionId", "to"].filter(function (k) { return present(req[k]); });
    if (named.length > 1) return { refusal: refused("name the target one way only: sessionId or to (given: " + named.join(", ") + ")") };
    var target = resolveSendTarget(Object.assign({}, req, { reply: undefined }));
    if (target.refusal) return { refusal: target.refusal };
    if (target.via) {
      req.projectSlug = target.projectSlug;
      req.sessionId = target.sessionId;
    }
    if (typeof req.sessionId !== "string" || !req.sessionId) {
      return { refusal: refused("sessionId must be a non-empty string") };
    }
    if (!sessionResume.isSafeSessionId(req.sessionId)) {
      return { refusal: refused("unsafe session id " + shown(req.sessionId) + " refused") };
    }
    var resolved = resolveProject(req.projectSlug);
    if (resolved.refusal) return { refusal: resolved.refusal };
    return { project: resolved.project };
  }

  // req: { projectSlug, sessionId | to, from?, fromSession?, reason? }
  // Stands one live session down: its prompts settle as cancelled (reason
  // ended), its turn is aborted and its query closed (lib/session-end.js).
  // History is kept and the session resumes by id. Addressed as send-input
  // addresses a session; a session that is not live, or only in the store, is
  // already-ended, and nothing is resumed to be ended. Returns the result, or a
  // Promise of it when the store must be asked.
  function endSession(req) {
    req = Object.assign({}, req);
    var fromRefusal = checkFrom(req.from) || checkFromSession(req.fromSession);
    if (fromRefusal) return fromRefusal;
    var by = sessionEnd.sourceFor(validateFrom(req.from).from);
    if (by.error) return refused(by.error);
    var located = resolveSessionTarget(req);
    if (located.refusal) return located.refusal;
    var project = located.project;

    function answer(result, session) {
      var out = session ? describe(project, session) : {};
      out.ok = result === RESULT.ENDED || result === RESULT.ALREADY_ENDED;
      out.result = result;
      out.endedBy = by.source;
      return out;
    }

    var live = findSession(project.sm, req.sessionId);
    if (live) {
      if (!senderRef.isLive(live)) return answer(RESULT.ALREADY_ENDED, live);
      var ended = sessionEnd.endLiveSession({
        session: live,
        sm: project.sm,
        send: project.send,
        slug: req.projectSlug,
        source: by.source,
        reason: req.reason,
      });
      var out = answer(RESULT.ENDED, live);
      out.agents = ended.agents;
      out.failures = ended.failures;
      if (ended.failures.length) out.ok = false;
      return out;
    }
    // Only the console's own store is asked, and a stored session is never
    // brought back just to be ended.
    return sessionResume.sessionExistsInStore(project.sm, req.sessionId).then(function (exists) {
      if (!exists) return { ok: false, result: RESULT.NOT_FOUND, reason: "no session " + shown(req.sessionId) + " in project " + shown(req.projectSlug) };
      var stored = answer(RESULT.ALREADY_ENDED, null);
      stored.sessionId = req.sessionId;
      return stored;
    }).catch(function (err) {
      console.error("[session-input] end failed:", messageOf(err));
      return { ok: false, result: RESULT.ERROR, retryable: !!(err && err.retryable), reason: "end failed: " + messageOf(err) };
    });
  }

  // req: { projectSlug, sessionId | to, requestId, decision, from?, fromSession? }
  // Answers one pending prompt of a live session through the prompt registry
  // (lib/prompt-answer.js), as a browser answer does. Addressed as end-session
  // addresses a session, under the same trust (the daemon's OS user); the
  // answer is recorded as caller:<from>, or user without --from. A session with
  // no runtime holds no pending prompt, so a stored one is not-found and is
  // never resumed. Returns the result, or a Promise of it when the store must
  // be asked.
  function answerPrompt(req) {
    req = Object.assign({}, req);
    var fromRefusal = checkFrom(req.from) || checkFromSession(req.fromSession);
    if (fromRefusal) return fromRefusal;
    var by = promptSource.callerSource(validateFrom(req.from).from, "an answer");
    if (by.error) return refused(by.error);
    if (typeof req.requestId !== "string" || !req.requestId) return refused("requestId must be a non-empty string");
    if (typeof req.decision !== "string" || !req.decision) return refused("decision must be a non-empty string");
    var located = resolveSessionTarget(req);
    if (located.refusal) return located.refusal;
    var project = located.project;

    function answered(session) {
      var out = describe(project, session);
      return Object.assign(out, promptAnswer.answerPrompt({
        sm: project.sm,
        session: session,
        requestId: req.requestId,
        decision: req.decision,
        source: by.source,
      }));
    }

    var live = findSession(project.sm, req.sessionId);
    if (live) return answered(live);
    return sessionResume.sessionExistsInStore(project.sm, req.sessionId).then(function (exists) {
      if (!exists) return { ok: false, result: RESULT.NOT_FOUND, reason: "no session " + shown(req.sessionId) + " in project " + shown(req.projectSlug), requestId: req.requestId, kind: null, source: by.source };
      return { ok: false, result: RESULT.NOT_FOUND, reason: "session " + shown(req.sessionId) + " has no runtime, so no pending request", requestId: req.requestId, kind: null, source: by.source, sessionId: req.sessionId };
    }).catch(function (err) {
      console.error("[session-input] answer failed:", messageOf(err));
      return { ok: false, result: RESULT.ERROR, retryable: !!(err && err.retryable), reason: "answer failed: " + messageOf(err) };
    });
  }

  // The scheduled-input firing (lib/scheduled-input/service.js): one scheduled
  // input delivered to the session its record names, through deliver(), the path
  // send-input uses. Not an IPC verb and not reachable from a request body:
  // only the service calls it.
  //
  // req: { projectSlug, sessionId, prompt, note?, initiator?, force? }
  // initiator is scheduled (the default) or scheduled-now. A session that is
  // mid-turn is skipped (result "busy", retryable) unless force is set, which
  // is a person pressing "send now": the input then joins the running turn,
  // as send-input does.
  function fireScheduled(req) {
    req = Object.assign({}, req);
    if (req.initiator === undefined) req.initiator = INITIATORS.SCHEDULED;
    if (req.initiator !== INITIATORS.SCHEDULED && req.initiator !== INITIATORS.SCHEDULED_NOW) {
      return refused("a scheduled firing is " + INITIATORS.SCHEDULED + " or " + INITIATORS.SCHEDULED_NOW);
    }
    var promptRefusal = checkPrompt(req.prompt);
    if (promptRefusal) return promptRefusal;
    if (typeof req.sessionId !== "string" || !sessionResume.isSafeSessionId(req.sessionId)) {
      return refused("unsafe session id " + shown(req.sessionId) + " refused");
    }
    var resolved = resolveProject(req.projectSlug);
    if (resolved.refusal) return resolved.refusal;
    var project = resolved.project;
    req.automation = { note: req.note };
    return withSession(project, req, function (session, resumed) {
      if (session.isProcessing && !req.force) {
        return { ok: false, result: RESULT.BUSY, retryable: true, reason: "the session is mid-turn", consoleSessionId: String(session.localId) };
      }
      return deliver(project, session, req, req.initiator, resumed);
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
        return { refusal: refused("session name " + shown(named.name) + " is already in use by " + taken + " in this project; a name has one holder") };
      }
      options.sessionName = named.name;
    }
    if (present(req.settingsFile)) {
      var checked = checkSettingsFile(req.settingsFile);
      if (checked.error) return { refusal: refused(checked.error) };
      // A bare test double without the vendor check is let through, as for the mode.
      if (typeof project.supportsSettingsFileFor === "function" && !project.supportsSettingsFileFor({ vendor: options.vendor || null })) {
        return { refusal: refused("this vendor does not take a settings file (--settings)") };
      }
      options.settingsFile = checked.path;
    }
    return { options: options };
  }

  // The console id of a non-reaped session of the project holding the name, as
  // text for a refusal, or null. Reaped sessions do not hold a name.
  function nameTakenBy(project, name) {
    var holder = findNameHolder(project.sm.sessions, name);
    return holder ? "session " + String(holder.localId) : null;
  }

  // The mode a session opened here starts in: the request's own permissionMode,
  // else the server setting "Mode for sessions opened by the CLI or a trigger",
  // else accept edits. Every value passes the shared mode check for the vendor
  // the session will run on. A mode the request names that fails it refuses the
  // open; a stored setting that fails it falls back to accept edits (logged).
  // Returns { mode } or { refusal }.
  function resolveOpenMode(project, req, options) {
    if (req.permissionMode !== undefined && req.permissionMode !== null && typeof req.permissionMode !== "string") {
      return { refusal: refused("permissionMode must be a string") };
    }
    var settings = deps.getPermissionSettings ? deps.getPermissionSettings() : null;
    var vendorProbe = { vendor: options.vendor || null };
    var chosen = permissionSettings.resolveOpenedSessionMode({
      requested: req.permissionMode,
      setting: settings && settings.openedSessionMode,
      check: function (mode) {
        // A project without the vendor-aware check (a bare double) still gets
        // the mode and server-setting checks.
        if (typeof project.checkPermissionModeFor === "function") return project.checkPermissionModeFor(vendorProbe, mode);
        return checkPermissionMode(mode, {});
      },
      onFallback: function (why) {
        console.warn("[session-input] stored opened-session mode " + logField(settings.openedSessionMode) + " refused (" + why + "); using " + permissionSettings.DEFAULT_OPENED_SESSION_MODE);
      },
    });
    if (chosen.error) return { refusal: refused("permissionMode " + shown(req.permissionMode) + " refused: " + chosen.error) };
    return { mode: chosen.mode };
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
  //        permissionMode?, settingsFile?, initiator?, contextNote?, cwd?, triggerId? }
  // Returns the result, or a Promise of it when the first turn starts
  // asynchronously (see settle()).
  function openSession(req) {
    req = Object.assign({}, req);
    delete req.automation;
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
    var openMode = resolveOpenMode(project, req, kind.options);
    if (openMode.refusal) return openMode.refusal;
    var gate = getNewWorkRefusal();
    if (gate) return refusedForLoad(gate);

    var sm = project.sm;
    // The opened mode is given at creation, so the session_switched that
    // createSession emits already carries it (not the project default). It is
    // saved with the session just below: a follow-up from a person, a resume
    // and a restart all keep it.
    // A session opened from a console session the daemon identified belongs to
    // that session's owner, so its prompts push to a person who can read it. A
    // declared or undeclared sender is a claim, never an inheritance.
    var openedBy = senderRef.resolve(getProject, { project: req.senderProject, sessionId: req.senderSessionId });
    // activate:false: an opened session is listed but never moves a connected tab.
    var created = Object.assign({}, kind.options, { permissionMode: openMode.mode, activate: false });
    if (openedBy && openedBy.ownerId) created.ownerId = openedBy.ownerId;
    var sess = sm.createSession(created);
    var label = req.triggerId ? " — " + String(req.triggerId).substring(0, 12) : "";
    sess.title = (req.contextNote || "External trigger") + label;
    if (req.cwd) sess.cwd = req.cwd;
    sm.saveSessionFile(sess);
    sm.broadcastSessionList();

    sess.isProcessing = true;
    project.onProcessingChanged();
    sess.sentToolResults = {};

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
      recordInjected(outboundEntry.VERB.OPEN_SESSION, project, sess, req, init.initiator, openedMessageId);
      // A name has one holder: the claim took effect in memory at open (the new
      // session is non-reaped and wins over its reaped twins meanwhile), and
      // only now, with the start done, is it taken from the reaped sessions
      // that still carry it. A failed open changes no other session.
      if (kind.options.sessionName) {
        releaseReapedHolders(sm.sessions, kind.options.sessionName, function (s) {
          if (typeof sm.saveSessionFile === "function") sm.saveSessionFile(s);
        }, sess.localId);
      }
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
    openSession: logged("open_session", neverThrows(openSession), ledgerOutcome),
    sendInput: logged("send_session_input", neverThrows(sendInput), ledgerOutcome),
    endSession: logged("end_session", neverThrows(endSession), ledgerOutcome),
    answerPrompt: logged("answer_prompt", neverThrows(answerPrompt), ledgerOutcome),
    listSessions: logged("list_sessions", neverThrows(listSessions)),
    fireScheduled: logged("fire_scheduled_input", neverThrows(fireScheduled)),
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
