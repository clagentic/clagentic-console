// Extracted from lib/server.js's addProject() closure (lr-c4da07 rework) so
// the Home Hub recent-sessions access filter is directly unit-testable
// against real code, not a test-file reimplementation of its loop shape.
// lib/server.js's getAllProjectSessions is now a thin call into
// computeAllProjectSessions below; both production and test code call this
// same function.

// Gathers every session across every project the given user may access,
// annotated with project metadata, for the Home Hub recent-sessions list.
//
// userId: REQUIRED to filter results to what the viewing user may actually
// see. Fails CLOSED: no userId (or no onGetProjectAccess) means no sessions
// are returned. There is no legitimate no-auth caller of this function --
// the WS upgrade handler in lib/server.js rejects any connection without an
// authenticated user with 401 before ws._clayUser can ever be set, including
// in single-user/PIN mode (still a real authenticated user, just one
// account) -- so failing closed here never breaks a real deployment mode.
//
// deps:
//   projects           Map<slug, projectCtx> (or anything with .forEach(fn(ctx, slug)))
//   users               the users module (canAccessProject / canAccessSession)
//   onGetProjectAccess  function(slug) -> access object | {error} | falsy
//   callerSlug          the connecting project's own slug (for includeSelf skip)
//   includeSelf         when true, callerSlug's own sessions are included too
//   userId              the viewing user's id, or null/undefined to fail closed
function computeAllProjectSessions(deps) {
  var projects = deps.projects;
  var users = deps.users;
  var onGetProjectAccess = deps.onGetProjectAccess;
  var callerSlug = deps.callerSlug;
  var includeSelf = deps.includeSelf;
  var userId = deps.userId;

  var allSessions = [];
  if (!userId || !onGetProjectAccess) return allSessions;

  projects.forEach(function (pCtx, pSlug) {
    if (!includeSelf && pSlug === callerSlug) return; // skip self unless asked
    var status = pCtx.getStatus();
    if (status.isWorktree) return;
    var pSm = pCtx.getSessionManager();
    if (!pSm) return;
    // Resolve per-project access ONCE per project (hoisted out of the
    // per-session inner loop below, not re-resolved per session) and skip
    // the whole project up front if the user cannot access it at all --
    // avoids an O(projects * sessions) repeated-resolution pattern for a
    // value that does not vary per session.
    var access = onGetProjectAccess(pSlug);
    if (!access || access.error) return;
    if (!users.canAccessProject(userId, access)) return;
    var projectTitle = status.title || status.project || pSlug;
    var projectIcon = status.icon || null;
    pSm.sessions.forEach(function (s) {
      if (!s.hidden && users.canAccessSession(userId, s, access)) {
        // Push a shallow copy annotated with project metadata rather than
        // mutating the live session object with transient UI fields.
        allSessions.push(Object.assign({}, s, {
          _projectTitle: projectTitle,
          _projectSlug: pSlug,
          _projectIcon: projectIcon,
        }));
      }
    });
  });
  return allSessions;
}

module.exports = {
  computeAllProjectSessions: computeAllProjectSessions,
};
