// The one place that answers "who is this, and may they touch that project?".
//
// Every caller (HTTP gate, WebSocket upgrade, per-message gate, project
// lists, palette, schedules, file and session handlers) goes through here so
// no site can forget the check, dereference a missing user, or treat a failed
// lookup as permission.
//
// AUTHENTICATION precedes and is separate from PRINCIPAL resolution. "No user"
// is the implicit owner only when the caller PROVED the request or connection
// was authenticated ({ authenticated: true }): isRequestAuthed(req) for HTTP,
// the WebSocket upgrade's auth check (carried on the connection by
// authOf(ws)), or the local MCP bridge. Without that proof no user is nobody,
// in every mode, so a route that forgets the login check refuses instead of
// serving the owner's data.
//
// Given the proof, whether "no user" means an owner or a stranger is decided
// by the MODE of the daemon, never by the absence alone:
//   - single-user mode: the authenticated connection carries no user record,
//     because the connection is the implicit owner. It is allowed everything,
//     and every project.
//   - multi-user mode: no user means unauthenticated, which is a refusal.
// A lookup that cannot be completed (no lookup wired, project unknown, lookup
// error, mode unknown) is a refusal, never an allow.
//
// deps:
//   users               module exposing canAccessProject(userId, access) and
//                       canAccessSession(userId, session, access)
//   onGetProjectAccess  function(slug) -> access object | { error } | falsy
//   isMultiUser         function() -> boolean; absent or throwing means
//                       multi-user, so a failure to learn the mode denies

// The proof a caller hands in alongside a possibly-missing user. Only the
// boolean true counts.
function isProven(opts) {
  return !!opts && opts.authenticated === true;
}

// The proof carried by a WebSocket connection or an HTTP request object. The
// upgrade handler and the HTTP route set _clagenticAuthenticated only after
// their login check passed; anything else, including a bare object, is
// unproven.
function authOf(conn) {
  return { authenticated: !!conn && conn._clagenticAuthenticated === true };
}

function createProjectAccess(deps) {
  var users = deps.users;
  var onGetProjectAccess = deps.onGetProjectAccess;
  var isMultiUser = deps.isMultiUser;

  function multiUserMode() {
    if (typeof isMultiUser !== "function") return true;
    try {
      return isMultiUser() !== false;
    } catch (e) {
      return true;
    }
  }

  // The principal behind a request or connection, or null when it must be
  // refused. `user` is the authenticated user record, or null/undefined.
  //   { id, user, admin, implicit }
  // id is null only for the implicit single-user owner, who needs
  // opts.authenticated === true.
  function principalFor(user, opts) {
    if (user && typeof user === "object" && user.id) {
      return { id: user.id, user: user, admin: user.role === "admin", implicit: false };
    }
    if (user) return null;
    if (!isProven(opts)) return null;
    if (multiUserMode()) return null;
    return { id: null, user: null, admin: true, implicit: true };
  }

  function isAdmin(user, opts) {
    var principal = principalFor(user, opts);
    return !!principal && principal.admin;
  }

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

  // userId is the id of an authenticated user, or null/undefined for none.
  function canAccess(userId, slug, opts) {
    var principal = principalFor(userId ? { id: userId } : null, opts);
    if (!principal) return false;
    if (principal.implicit) return typeof slug === "string" && slug !== "";
    var access = resolve(slug);
    if (!access) return false;
    return users.canAccessProject(principal.id, access) === true;
  }

  // Entries are project status objects (anything with a .slug).
  function filterProjectList(userId, list, opts) {
    if (!Array.isArray(list)) return [];
    if (!principalFor(userId ? { id: userId } : null, opts)) return [];
    return list.filter(function (p) {
      return !!p && canAccess(userId, p.slug, opts);
    });
  }

  // Whether `user` may see `session`. Access to the owning project is settled
  // before a message reaches a handler (the per-message gate in project.js),
  // so only the session's own owner/visibility rules are applied here. No
  // principal or no session is a refusal; the implicit owner reads everything.
  function canReadSession(user, session, opts) {
    var principal = principalFor(user, opts);
    if (!principal || !session) return false;
    if (principal.implicit) return true;
    return users.canAccessSession(principal.id, session, { visibility: "public" }) === true;
  }

  return {
    principalFor: principalFor,
    authOf: authOf,
    isAdmin: isAdmin,
    resolve: resolve,
    canAccess: canAccess,
    filterProjectList: filterProjectList,
    canReadSession: canReadSession,
  };
}

module.exports = {
  createProjectAccess: createProjectAccess,
  authOf: authOf,
};
