// session-resume.js - bring a stored session back into a project's session
// manager on its own vendor and agent. One implementation for the browser's
// resume_session message and for input injected from outside (session-input.js).
//
// A failure is reported as a failure: every function here either answers
// positively (a session, or a verified absence) or rejects with an Error whose
// `retryable` says whether trying again can help. An unreadable store and a
// history that cannot be loaded are never read as "no such session" or as an
// empty history.

var fs = require("fs");
var path = require("path");
var utils = require("./utils");

// A session id becomes a file name; anything that could leave the sessions
// directory is not an id.
var SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isSafeSessionId(id) {
  return typeof id === "string" && SAFE_SESSION_ID.test(id);
}

function messageOf(err) {
  return err && err.message ? err.message : String(err);
}

function resumeError(message, retryable) {
  var err = new Error(message);
  err.retryable = retryable;
  return err;
}

// Reads the console's own record of a session: its meta line and its history.
// Returns null only when there is no such file. A file that is there but cannot
// be read, or whose records are damaged, throws (see resumeError).
//
// Any malformed or blank line refuses the resume, wherever it is: skipping it
// would hand the vendor a history with a hole in it. The only thing tolerated is
// the single newline that ends the file, which the console's writer always adds.
function readStoredSession(sessionsDir, cliSessionId) {
  if (!sessionsDir || !isSafeSessionId(cliSessionId)) return null;
  var raw;
  try { raw = fs.readFileSync(path.join(sessionsDir, cliSessionId + ".jsonl"), "utf8"); }
  catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw resumeError("cannot read stored session " + cliSessionId + ": " + messageOf(e), true);
  }
  var lines = (raw.endsWith("\n") ? raw.slice(0, -1) : raw).split("\n");
  var meta;
  try { meta = JSON.parse(lines[0]); }
  catch (e) { throw resumeError("stored session " + cliSessionId + " is damaged: its meta record is not valid JSON", false); }
  if (!meta || meta.type !== "meta") {
    throw resumeError("stored session " + cliSessionId + " is damaged: its first record is not a meta record", false);
  }
  var history = [];
  for (var i = 1; i < lines.length; i++) {
    try { history.push(JSON.parse(lines[i])); }
    catch (e) {
      throw resumeError("stored session " + cliSessionId + " is damaged: line " + (i + 1) + " is malformed", false);
    }
  }
  return { meta: meta, history: history };
}

// Whether the console's own store holds a session. Sessions the vendor holds
// but the console never recorded are not addressable by injected input.
// Rejects when the record is there but unreadable or damaged.
function sessionExistsInStore(sm, cliSessionId) {
  return Promise.resolve().then(function () {
    return readStoredSession(sm.sessionsDir, cliSessionId) !== null;
  });
}

function titleFromHistory(history) {
  for (var i = 0; i < history.length; i++) {
    if (history[i].type === "user_message" && history[i].text) return history[i].text.substring(0, 50);
  }
  return "Resumed session";
}

function defaultReadHistory(cwd, cliSessionId) {
  return require("./cli-sessions").readCliSessionHistory(cwd, cliSessionId, { strict: true });
}

// Resumes cliSessionId into deps.sm and resolves the session (null when the
// session manager declines). Rejects, with `retryable` set, when the stored
// record or the vendor's history cannot be loaded: a session is never resumed
// on a history that failed to load.
// Vendor, agent, owner, visibility and granted tools come from the stored
// meta record so the session continues as what it was, not as the project's
// default. Without a console record the vendor's own history is used.
//
// deps: { sm, adapter, cwd, readHistory? }  readHistory(cwd, id) -> Promise<history[]>
// opts: { ws, activate }  ws is the requesting browser connection, if any;
//       activate:false keeps every connected client on the session it is viewing.
function resumeStoredSession(deps, cliSessionId, opts) {
  var sm = deps.sm;
  var ws = (opts && opts.ws) || undefined;
  var activate = !(opts && opts.activate === false);

  return Promise.resolve().then(function () {
    var stored = readStoredSession(sm.sessionsDir, cliSessionId);
    var meta = stored && stored.meta;
    var resumeOpts = { activate: activate };
    if (meta) {
      if (meta.vendor) resumeOpts.vendor = meta.vendor;
      if (meta.agentName) resumeOpts.agentName = meta.agentName;
      if (meta.ownerId) resumeOpts.ownerId = meta.ownerId;
      if (meta.sessionVisibility) resumeOpts.sessionVisibility = meta.sessionVisibility;
      // Sanitized so a crafted meta record cannot auto-approve a tool.
      if (meta.allowedTools) resumeOpts.allowedTools = utils.sanitizeAllowedTools(meta.allowedTools);
    }

    function finish(extra) {
      var session = sm.resumeSession(cliSessionId, Object.assign(resumeOpts, extra), ws);
      if (session && typeof sm.retrimHistory === "function") sm.retrimHistory(session);
      return session || null;
    }

    if (stored) {
      return finish({
        history: stored.history,
        title: meta.title || titleFromHistory(stored.history),
      });
    }

    var readHistory = deps.readHistory || defaultReadHistory;
    // The summary only names the resumed session; a lookup that fails leaves
    // the title taken from the history instead and does not affect delivery.
    var titlePromise = Promise.resolve()
      .then(function () { return deps.adapter.getSessionInfo(cliSessionId, { dir: deps.cwd }); })
      .then(function (info) { return (info && info.summary) ? info.summary.substring(0, 100) : null; })
      .catch(function () { return null; });

    var historyPromise = Promise.resolve()
      .then(function () { return readHistory(deps.cwd, cliSessionId); })
      .catch(function (err) {
        throw resumeError("could not load the history of session " + cliSessionId + ": " + messageOf(err), true);
      });

    return Promise.all([historyPromise, titlePromise]).then(function (results) {
      var history = results[0];
      return finish({ history: history, title: results[1] || titleFromHistory(history) });
    });
  });
}

module.exports = {
  isSafeSessionId: isSafeSessionId,
  readStoredSession: readStoredSession,
  sessionExistsInStore: sessionExistsInStore,
  resumeStoredSession: resumeStoredSession,
};
