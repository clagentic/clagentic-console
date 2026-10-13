// session-resume.js - bring a stored session back into a project's session
// manager on its own vendor and agent. One implementation for the browser's
// resume_session message and for input injected from outside (session-input.js).
//
// A failure is reported as a failure: every function here either answers
// positively (a session, or a verified absence) or rejects with an Error whose
// `retryable` says whether trying again can help. An unreadable store, an
// adapter that cannot be asked and a history that cannot be loaded are never
// read as "no such session" or as an empty history.

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
// A crash can tear the last line being written, so a malformed final record is
// skipped. A malformed record anywhere earlier is damage, not a torn write, and
// resuming past it would hand the vendor a history with a hole in it.
function readStoredSession(sessionsDir, cliSessionId) {
  if (!sessionsDir || !isSafeSessionId(cliSessionId)) return null;
  var raw;
  try { raw = fs.readFileSync(path.join(sessionsDir, cliSessionId + ".jsonl"), "utf8"); }
  catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw resumeError("cannot read stored session " + cliSessionId + ": " + messageOf(e), true);
  }
  var lines = raw.split("\n");
  var meta;
  try { meta = JSON.parse(lines[0]); }
  catch (e) { throw resumeError("stored session " + cliSessionId + " is damaged: its meta record is not valid JSON", false); }
  if (!meta || meta.type !== "meta") {
    throw resumeError("stored session " + cliSessionId + " is damaged: its first record is not a meta record", false);
  }
  var lastIndex = lines.length - 1;
  while (lastIndex > 0 && !lines[lastIndex]) lastIndex--;
  var history = [];
  for (var i = 1; i <= lastIndex; i++) {
    if (!lines[i]) continue;
    try { history.push(JSON.parse(lines[i])); }
    catch (e) {
      if (i === lastIndex) continue;
      throw resumeError("stored session " + cliSessionId + " is damaged: record " + i + " is malformed and is not the last", false);
    }
  }
  return { meta: meta, history: history };
}

// Whether a session id exists in the console's store or the vendor's. Resolves
// false only when every place that can be asked positively reports absence;
// rejects (retryable) when one could not be asked.
// deps: { sm, adapter, cwd }
function sessionExistsInStore(deps, cliSessionId) {
  if (!isSafeSessionId(cliSessionId)) return Promise.resolve(false);
  return Promise.resolve().then(function () {
    if (readStoredSession(deps.sm.sessionsDir, cliSessionId)) return true;
    // No adapter, or one without session lookup, has nothing to say about it.
    if (!deps.adapter || typeof deps.adapter.getSessionInfo !== "function") return false;
    return Promise.resolve(deps.adapter.getSessionInfo(cliSessionId, { dir: deps.cwd })).then(
      function (info) { return !!info; },
      function (err) { throw resumeError("could not look up session " + cliSessionId + " with the vendor: " + messageOf(err), true); }
    );
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
