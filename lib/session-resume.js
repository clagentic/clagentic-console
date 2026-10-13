// session-resume.js - bring a stored session back into a project's session
// manager on its own vendor and agent. One implementation for the browser's
// resume_session message and for input injected from outside (session-input.js).

var fs = require("fs");
var path = require("path");
var utils = require("./utils");

// A session id becomes a file name; anything that could leave the sessions
// directory is not an id.
var SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isSafeSessionId(id) {
  return typeof id === "string" && SAFE_SESSION_ID.test(id);
}

// Reads the console's own record of a session: its meta line and its history.
// Returns null when there is no such file or it has no usable meta line.
function readStoredSession(sessionsDir, cliSessionId) {
  if (!sessionsDir || !isSafeSessionId(cliSessionId)) return null;
  var raw;
  try { raw = fs.readFileSync(path.join(sessionsDir, cliSessionId + ".jsonl"), "utf8"); }
  catch (e) { return null; }
  var lines = raw.split("\n");
  var meta;
  try { meta = JSON.parse(lines[0]); } catch (e) { return null; }
  if (!meta || meta.type !== "meta") return null;
  var history = [];
  for (var i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    try { history.push(JSON.parse(lines[i])); } catch (e) { /* a torn last line is expected after a crash */ }
  }
  return { meta: meta, history: history };
}

// Whether a session id exists in the console's store or the vendor's.
// deps: { sm, adapter, cwd }
function sessionExistsInStore(deps, cliSessionId) {
  if (!isSafeSessionId(cliSessionId)) return Promise.resolve(false);
  if (readStoredSession(deps.sm.sessionsDir, cliSessionId)) return Promise.resolve(true);
  if (!deps.adapter || typeof deps.adapter.getSessionInfo !== "function") return Promise.resolve(false);
  return Promise.resolve()
    .then(function () { return deps.adapter.getSessionInfo(cliSessionId, { dir: deps.cwd }); })
    .then(function (info) { return !!info; })
    .catch(function () { return false; });
}

function titleFromHistory(history) {
  for (var i = 0; i < history.length; i++) {
    if (history[i].type === "user_message" && history[i].text) return history[i].text.substring(0, 50);
  }
  return "Resumed session";
}

// Resumes cliSessionId into deps.sm and resolves the session (never rejects).
// Vendor, agent, owner, visibility and granted tools come from the stored
// meta record so the session continues as what it was, not as the project's
// default. Without a console record the vendor's own history is used.
//
// deps: { sm, adapter, cwd }
// opts: { ws, activate }  ws is the requesting browser connection, if any;
//       activate:false keeps every connected client on the session it is viewing.
function resumeStoredSession(deps, cliSessionId, opts) {
  var sm = deps.sm;
  var ws = (opts && opts.ws) || undefined;
  var activate = !(opts && opts.activate === false);

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
    return Promise.resolve(finish({
      history: stored.history,
      title: meta.title || titleFromHistory(stored.history),
    }));
  }

  var cliSess = require("./cli-sessions");
  var titlePromise = Promise.resolve()
    .then(function () { return deps.adapter.getSessionInfo(cliSessionId, { dir: deps.cwd }); })
    .then(function (info) { return (info && info.summary) ? info.summary.substring(0, 100) : null; })
    .catch(function () { return null; });

  return Promise.all([cliSess.readCliSessionHistory(deps.cwd, cliSessionId), titlePromise])
    .then(function (results) {
      var history = results[0];
      return finish({ history: history, title: results[1] || titleFromHistory(history) });
    })
    .catch(function () { return finish({}); });
}

module.exports = {
  isSafeSessionId: isSafeSessionId,
  readStoredSession: readStoredSession,
  sessionExistsInStore: sessionExistsInStore,
  resumeStoredSession: resumeStoredSession,
};
