// outbound-access.js - may this caller see the prompt text of an outbound-ledger
// entry? The ledger stores the full prompt, and the prompt is also in the target
// session's history, so it is shown only to a caller who could read that session.
//
// The caller is one of two shapes:
//   - the daemon-owner socket (the CLI verb) carries no user record; the OS
//     gate on the socket proves the caller is the daemon's own OS user. That
//     user already owns and can read the stored history, with the full prompt,
//     of every session that runs as it, so it gets the text for each target
//     that ran as the daemon OS user, in single-user and multi-user mode
//     alike. Only in os-users mode does a target run as another OS user; that
//     one gets metadata only, and so does an entry that did not record the OS
//     user of its target. The decision rests on the user recorded in the entry
//     when it was written, never on a console session id, which a restart
//     renumbers.
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
var RUNS_AS_DAEMON = require("./outbound-entry").RUNS_AS_DAEMON;

function createOutboundAccess(deps) {
  var projectAccess = deps.projectAccess;
  var getProject = deps.getProject;
  var isOsUsers = typeof deps.isOsUsers === "function" ? deps.isOsUsers : function () { return false; };

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

  // Where the target ran, as recorded when the entry was written (runsAs is
  // "daemon" or the OS user name). An entry without it, or with any other
  // value, is not known to run as the daemon OS user.
  function recordedOsUserVerdict(entry) {
    var runsAs = (entry.target || {}).runsAs;
    if (runsAs === RUNS_AS_DAEMON) return { allowed: true };
    if (typeof runsAs === "string" && runsAs) return { allowed: false, reason: "the target session runs as another OS user" };
    return { allowed: false, reason: "the OS user the target session runs as was not recorded, so it cannot be established" };
  }

  // The daemon's OS user, in multi-user mode (single-user mode is the implicit
  // principal). It reads the text of any session that ran as itself, judged
  // from what the entry recorded, never from a lookup that can be renumbered.
  function canSocketCallerRead(entry) {
    if (!isOsUsers()) return { allowed: true };
    return recordedOsUserVerdict(entry);
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
    // no session boundary to check, including for a target that is gone. The
    // owner is still the daemon's OS user, so a target that ran as another one
    // is withheld, as for the socket caller.
    if (principal.implicit) return canSocketCallerRead(entry);

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
    if (isOsUsers()) {
      var recorded = recordedOsUserVerdict(entry);
      if (!recorded.allowed) return recorded;
    }
    if (!projectAccess.canReadSession(principal.user, session, { authenticated: true })) {
      return { allowed: false, reason: "the caller cannot read the target session" };
    }
    return { allowed: true };
  }

  return { canReadPrompt: canReadPrompt };
}

module.exports = { createOutboundAccess: createOutboundAccess };
