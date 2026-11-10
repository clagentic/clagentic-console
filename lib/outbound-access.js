// outbound-access.js - may this caller see the prompt text of an outbound-ledger
// entry? The prompt is also in the target session's history, so it is shown only
// to a caller who could read that session.
//
// The decision for a target that runs as another OS user is not made here. It is
// made when the entry is written (lib/outbound-entry.js): such an entry, and one
// that did not record the OS user of its target, stores no prompt and no context
// note, only metadata and the reason. No read path and no later mode can return
// text that was never stored, so this module has no os-users branch.
//
// The caller is one of two shapes:
//   - the daemon-owner socket (the CLI verb) carries no user record; the OS
//     gate on the socket proves the caller is the daemon's own OS user. It gets
//     each entry as stored.
//   - a caller that is a console user (a transport that authenticates one) is
//     judged by canReadSession, which applies canAccessSession: project access,
//     then owner, shared or private.
//
// Metadata is always shown. A text that is not shown is replaced by a stated
// reason, never silently dropped.

// deps:
//   projectAccess   lib/project-access.js createProjectAccess() result
//   getProject(slug) -> project context | null
// caller: { user, authenticated }  user is a user record or null
function createOutboundAccess(deps) {
  var projectAccess = deps.projectAccess;
  var getProject = deps.getProject;

  // The session an entry's target names, or null. Only the vendor session id
  // names a session for good. A console id is renumbered by a restart, so it
  // never identifies a target here: an access decision that rested on it could
  // hand the text of one session to the reader of another.
  function findTarget(entry) {
    var target = entry.target || {};
    var project = target.project ? getProject(target.project) : null;
    if (!project || !project.sm || !project.sm.sessions || !target.cliSessionId) return null;
    var found = null;
    project.sm.sessions.forEach(function (s) {
      if (!found && s.cliSessionId === target.cliSessionId) found = s;
    });
    return found;
  }

  // Returns { allowed: true } or { allowed: false, reason }.
  function canReadPrompt(entry, caller) {
    caller = caller || {};
    var principal = projectAccess.principalFor(caller.user || null, { authenticated: caller.authenticated === true });
    if (!principal) {
      if (!caller.user && caller.authenticated === true) return { allowed: true };
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
    if (!projectAccess.canReadSession(principal.user, session, { authenticated: true })) {
      return { allowed: false, reason: "the caller cannot read the target session" };
    }
    return { allowed: true };
  }

  // May this caller see that something happened in `project`? The project-level
  // half of canReadPrompt, for readers (the agent roster) that record where an
  // identity was seen and not a session's text.
  function canReadProject(project, caller) {
    caller = caller || {};
    var principal = projectAccess.principalFor(caller.user || null, { authenticated: caller.authenticated === true });
    if (!principal) return false;
    if (principal.implicit) return true;
    return !!project && projectAccess.canAccess(principal.id, project, { authenticated: true });
  }

  return { canReadPrompt: canReadPrompt, canReadProject: canReadProject };
}

module.exports = { createOutboundAccess: createOutboundAccess };
