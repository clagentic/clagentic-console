// outbound-access.js - may this caller see the prompt text of an outbound-ledger
// entry? The ledger stores the full prompt, and the prompt is also in the target
// session's history, so it is shown only to a caller who could read that session.
//
// The caller is one of two shapes:
//   - the daemon-owner socket (the CLI verb) carries no user record; the OS
//     gate on the socket proves the caller is the daemon's own OS user. That
//     user already owns and can read the stored history, with the full prompt,
//     of every session that runs as it, so it gets the text for each target
//     that runs as the daemon OS user, in single-user and multi-user mode
//     alike. Only in os-users mode does a target run as another OS user; that
//     one gets metadata only, and so does one the console no longer holds
//     (whose OS user cannot be established).
//   - a caller that is a console user (a transport that authenticates one) is
//     judged by canReadSession, which applies canAccessSession: project access,
//     then owner, shared or private.
//
// Metadata is always shown. A text that is not shown is replaced by a stated
// reason, never silently dropped.

// deps:
//   projectAccess   lib/project-access.js createProjectAccess() result
//   getProject(slug) -> project context | null
//   isOsUsers() -> boolean   optional; true when sessions run as other OS users
// caller: { user, authenticated }  user is a user record or null
function createOutboundAccess(deps) {
  var projectAccess = deps.projectAccess;
  var getProject = deps.getProject;
  var isOsUsers = typeof deps.isOsUsers === "function" ? deps.isOsUsers : function () { return false; };

  // The session an entry's target names, or null. The vendor session id names a
  // session for good; a console id is renumbered by a restart, so one is trusted
  // only for a session that already existed when the entry was written.
  function findTarget(entry) {
    var target = entry.target || {};
    var project = target.project ? getProject(target.project) : null;
    if (!project || !project.sm || !project.sm.sessions) return null;
    var ts = Date.parse(entry.ts);
    var found = null;
    project.sm.sessions.forEach(function (s) {
      if (found) return;
      if (target.cliSessionId) {
        if (s.cliSessionId === target.cliSessionId) found = s;
        return;
      }
      if (target.sessionId === undefined || String(s.localId) !== String(target.sessionId)) return;
      if (typeof s.createdAt === "number" && isFinite(ts) && s.createdAt > ts) return;
      found = s;
    });
    return found;
  }

  // The daemon's OS user, in multi-user mode (single-user mode is the implicit
  // principal). It reads the text of any session that runs as itself.
  function canSocketCallerRead(entry) {
    if (!isOsUsers()) return { allowed: true };
    var session = findTarget(entry);
    if (!session) {
      return { allowed: false, reason: "the target session is not held by the console, so the OS user it runs as cannot be established" };
    }
    var project = getProject((entry.target || {}).project);
    if (typeof project.getLinuxUserForSession === "function" && project.getLinuxUserForSession(session)) {
      return { allowed: false, reason: "the target session runs as another OS user" };
    }
    return { allowed: true };
  }

  // Returns { allowed: true } or { allowed: false, reason }.
  function canReadPrompt(entry, caller) {
    caller = caller || {};
    var principal = projectAccess.principalFor(caller.user || null, { authenticated: caller.authenticated === true });
    if (!principal) {
      if (!caller.user && caller.authenticated === true) return canSocketCallerRead(entry);
      return { allowed: false, reason: "the caller is not authenticated; prompt text is shown only to a caller who can read the target session" };
    }
    // The single-user owner reads every session the console holds, so there is
    // no session boundary to check, including for a target that is gone.
    if (principal.implicit) return { allowed: true };

    var target = entry.target || {};
    if (!target.project || !projectAccess.canAccess(principal.id, target.project, { authenticated: true })) {
      return { allowed: false, reason: "the caller cannot access the target project" };
    }
    var session = findTarget(entry);
    if (!session) {
      return { allowed: false, reason: "the target session is not held by the console, so access to it cannot be checked" };
    }
    var project = getProject(target.project);
    if (typeof project.getLinuxUserForSession === "function" && project.getLinuxUserForSession(session)) {
      return { allowed: false, reason: "the target session runs as another OS user" };
    }
    if (!projectAccess.canReadSession(principal.user, session, { authenticated: true })) {
      return { allowed: false, reason: "the caller cannot read the target session" };
    }
    return { allowed: true };
  }

  return { canReadPrompt: canReadPrompt };
}

module.exports = { createOutboundAccess: createOutboundAccess };
