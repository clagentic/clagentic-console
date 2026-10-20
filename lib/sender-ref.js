// sender-ref.js - the plain reference a console-started agent process carries to
// its own console session, and how the daemon resolves one.
//
// Part of the console's session-record format. Two non-secret variables are set
// in the environment of every Claude process the console starts, whatever
// identity provider is configured:
//
//   CLAGENTIC_CONSOLE_PROJECT      the project slug the session belongs to
//   CLAGENTIC_CONSOLE_SESSION_ID   the console session id (localId) in that project
//
// The pair is not an identity assertion and grants nothing. send-input,
// open-session and a file-drop writer pass it along; the daemon looks it up in
// its OWN session store and records the sender as "extracted". It is not proof
// against a same-user process copying the variables; only an attested sender is.

var PROJECT_ENV = "CLAGENTIC_CONSOLE_PROJECT";
var SESSION_ENV = "CLAGENTIC_CONSOLE_SESSION_ID";

var SESSION_ID_RE = /^[0-9]{1,9}$/;

// The environment additions for a session, or {} when it has no usable reference.
function envFor(ref) {
  if (!ref || typeof ref.project !== "string" || !ref.project) return {};
  var id = String(ref.sessionId);
  if (!SESSION_ID_RE.test(id)) return {};
  var out = {};
  out[PROJECT_ENV] = ref.project;
  out[SESSION_ENV] = id;
  return out;
}

// Removes any inherited reference: the console sets it only for a session it
// started, so a daemon launched from inside a session must not pass its own on.
function strip(env) {
  delete env[PROJECT_ENV];
  delete env[SESSION_ENV];
  return env;
}

// The reference a caller process holds, from its environment. null when absent.
function fromEnv(env) {
  env = env || {};
  var project = env[PROJECT_ENV];
  var sessionId = env[SESSION_ENV];
  if (typeof project !== "string" || !project || typeof sessionId !== "string" || !sessionId) return null;
  return { project: project, sessionId: sessionId };
}

// The one label for a session, "<agent>@<project>" or, with no named agent,
// "<vendor>@<project>". null when it has neither. The chat's sender label and
// the session directory's addresses are both this.
function labelFor(agent, vendor, project) {
  var who = agent || vendor;
  if (!who || !project) return null;
  return who + "@" + project;
}

function isLive(session) {
  return !!(session.isProcessing || session.queryInstance || (session.worker && session.messageQueue === "worker"));
}

// Resolves a reference against the daemon's own store. Returns
// { project, sessionId, agent, vendor, name } or null. null (never a guess) when
// the project or session is not held, the session has no live runtime (the
// caller of a reference is a running process of that session), or it runs as
// another OS user (the daemon's socket and trigger directory admit only its own).
//
// getProject(slug) -> project context | null
function resolve(getProject, ref) {
  if (!ref || typeof ref.project !== "string" || !ref.project) return null;
  var id = typeof ref.sessionId === "number" ? String(ref.sessionId) : ref.sessionId;
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) return null;
  var project = getProject(ref.project);
  if (!project || !project.sm || !project.sm.sessions) return null;
  var found = null;
  project.sm.sessions.forEach(function (s) {
    if (!found && String(s.localId) === id) found = s;
  });
  if (!found || !isLive(found)) return null;
  if (typeof project.getLinuxUserForSession === "function" && project.getLinuxUserForSession(found)) return null;
  // Required here: the worker loads this module for its env helpers only.
  var slugifyAgentName = require("./agents").slugifyAgentName;
  var agent = found.agentName || null;
  var vendor = found.vendor || project.sm.defaultVendor || null;
  var name = labelFor(agent, vendor, ref.project);
  if (!name) return null;
  return {
    project: ref.project,
    sessionId: id,
    agent: agent,
    agentSlug: agent ? slugifyAgentName(agent) : null,
    vendor: vendor,
    name: name,
  };
}

module.exports = {
  labelFor: labelFor,
  isLive: isLive,
  PROJECT_ENV: PROJECT_ENV,
  SESSION_ENV: SESSION_ENV,
  envFor: envFor,
  strip: strip,
  fromEnv: fromEnv,
  resolve: resolve,
};
