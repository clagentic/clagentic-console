"use strict";

// The one server-side rule for the messages that name another project by slug
// to remove it (remove_project, remove_project_check) or to receive its tasks
// (moveTasksTo): the caller must own the project removed, or be an
// administrator, and must be able to reach the project that receives tasks.
// The per-message gate has already settled access to the project the
// connection is open on; these slugs come from the message body, so they are
// judged here. A worktree has no record of its own and is judged by its
// parent's (the access resolver already maps it).
//
// An answer that cannot be given is a refusal: no resolver for a connection
// that carries a user, an unknown slug, a record with no owner. A project
// context built without a resolver and a connection with no user is the
// single-user unit harness and is let through, as project-access.js documents.

var { logField } = require("./log-field");

var REFUSAL_TEXT = "You do not have permission to remove this project";

/**
 * deps: projectAccess (lib/project-access.js), sendTo(ws, msg)
 * Returns { refuse(ws, type, slug, receivingSlug?) }: true when the request was
 * refused (logged, nothing changed), false when the caller may go on.
 */
function createProjectRemovalGate(deps) {
  var projectAccess = deps.projectAccess;

  function principalOf(ws) {
    return projectAccess.principalFor(ws._clagenticUser, projectAccess.authOf(ws));
  }

  function mayRemove(ws, slug) {
    if (!projectAccess) return !ws._clagenticUser;
    var principal = principalOf(ws);
    if (!principal) return false;
    if (principal.admin) return true;
    var access = projectAccess.resolve(slug);
    return !!access && !!access.ownerId && access.ownerId === principal.id;
  }

  function mayReceive(ws, slug) {
    if (!projectAccess) return !ws._clagenticUser;
    var principal = principalOf(ws);
    if (!principal) return false;
    if (principal.admin) return true;
    return projectAccess.canAccess(principal.id, slug, projectAccess.authOf(ws));
  }

  function refuse(ws, type, slug, receivingSlug) {
    var reason = null;
    if (!mayRemove(ws, slug)) reason = "caller neither owns nor administers the project";
    else if (receivingSlug && !mayReceive(ws, receivingSlug)) reason = "caller cannot reach the receiving project";
    if (!reason) return false;
    console.warn("[project-removal-gate] refused " + type + " for " + logField(slug) + ": " + reason);
    return true;
  }

  return { refuse: refuse };
}

module.exports = { createProjectRemovalGate: createProjectRemovalGate, REFUSAL_TEXT: REFUSAL_TEXT };
