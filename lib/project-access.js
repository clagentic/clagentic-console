// The one place that answers "may this user touch that project?".
//
// Every caller (HTTP gate, WebSocket upgrade, per-message gate, project
// lists, palette, schedules) goes through here so no site can forget the
// check or treat a failed lookup as permission. A lookup that cannot be
// completed (no lookup wired, project unknown, lookup error, no user) is a
// refusal, never an allow.
//
// deps:
//   users               module exposing canAccessProject(userId, access)
//   onGetProjectAccess  function(slug) -> access object | { error } | falsy

function createProjectAccess(deps) {
  var users = deps.users;
  var onGetProjectAccess = deps.onGetProjectAccess;

  // The access record for a slug, or null when it cannot be established.
  function resolve(slug) {
    if (typeof slug !== "string" || !slug) return null;
    if (typeof onGetProjectAccess !== "function") return null;
    var access;
    try {
      access = onGetProjectAccess(slug);
    } catch (e) {
      return null;
    }
    if (!access || access.error) return null;
    return access;
  }

  function canAccess(userId, slug) {
    if (!userId) return false;
    var access = resolve(slug);
    if (!access) return false;
    return users.canAccessProject(userId, access) === true;
  }

  // Entries are project status objects (anything with a .slug).
  function filterProjectList(userId, list) {
    if (!userId || !Array.isArray(list)) return [];
    return list.filter(function (p) {
      return !!p && canAccess(userId, p.slug);
    });
  }

  return {
    resolve: resolve,
    canAccess: canAccess,
    filterProjectList: filterProjectList,
  };
}

// Whether `user` may see `session`. Access to the owning project is settled
// before a message reaches a handler (the per-message gate in project.js),
// so only the session's own owner/visibility rules are applied here. No user
// or no session is a refusal.
function canReadSession(users, user, session) {
  if (!user || !session) return false;
  return users.canAccessSession(user.id, session, { visibility: "public" }) === true;
}

module.exports = {
  createProjectAccess: createProjectAccess,
  canReadSession: canReadSession,
};
