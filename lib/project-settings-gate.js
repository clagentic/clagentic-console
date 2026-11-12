"use strict";

// The one server-side rule for every message that writes a project-scoped or
// folder-scoped setting: the caller needs the projectSettings permission AND
// access to the project the write lands on. It is the rule the client applies
// before it opens Project Settings (public/modules/settings-access.js), now
// enforced where a hand-built message cannot skip it.
//
// Administrators hold every permission and every project (users-permissions.js),
// and an owner reaches their own project through the same access check. In
// single-user mode the authenticated connection is the implicit owner and is
// let through; a user record on a single-user connection still needs the
// permission, as it did before.

var REFUSAL_TEXT = "Project settings access is not permitted";

// Every reason is a fixed string so a log line never carries caller input.
var REASON = {
  unauthenticated: "caller is not authenticated",
  permission: "caller lacks the projectSettings permission",
  access: "caller cannot access the target project",
  unavailable: "the permission check is not available",
};

// Log fields echo caller-chosen text; keep them short and single-line.
function logSlug(value) {
  var s = typeof value === "string" ? value : "";
  return JSON.stringify(s.length > 80 ? s.slice(0, 80) : s);
}

/**
 * deps: projectAccess (lib/project-access.js), usersModule (getEffectivePermissions),
 *       osUsers (os-users mode flag), sendTo(ws, msg)
 * Returns { refuse(ws, type, targetSlug, ownerId?) }: true when the message was refused
 * (logged and answered, nothing written), false when the caller may go on.
 */
function createProjectSettingsGate(deps) {
  var projectAccess = deps.projectAccess;
  var usersModule = deps.usersModule;
  var osUsers = !!deps.osUsers;
  var sendTo = deps.sendTo;

  // ownerId: the target project's owner, for a setter whose rule has always let
  // the owner in without the permission (the project default permission mode).
  function verdict(ws, targetSlug, ownerId) {
    if (!projectAccess || typeof projectAccess.principalFor !== "function") return REASON.unavailable;
    var principal = projectAccess.principalFor(ws._clagenticUser, projectAccess.authOf(ws));
    if (!principal) return REASON.unauthenticated;
    if (principal.implicit) return null;
    var isOwner = !!ownerId && principal.id === ownerId;
    // An administrator holds every permission (users-permissions.js).
    if (!principal.admin && !isOwner) {
      if (!usersModule || typeof usersModule.getEffectivePermissions !== "function") return REASON.unavailable;
      var perms = usersModule.getEffectivePermissions(principal.user, osUsers);
      if (!perms || !perms.projectSettings) return REASON.permission;
    }
    // ...and every project, and an owner reaches their own, so neither needs a
    // per-project lookup.
    if (principal.admin || isOwner) return null;
    var multiUser = typeof projectAccess.isMultiUser === "function" ? projectAccess.isMultiUser() : true;
    if (multiUser && !projectAccess.canAccess(principal.id, targetSlug, projectAccess.authOf(ws))) return REASON.access;
    return null;
  }

  function refuse(ws, type, targetSlug, ownerId) {
    var reason = verdict(ws, targetSlug, ownerId);
    if (!reason) return false;
    console.warn("[project-settings-gate] refused " + type + " for " + logSlug(targetSlug) + ": " + reason);
    sendTo(ws, { type: "error", text: REFUSAL_TEXT });
    return true;
  }

  return { refuse: refuse };
}

module.exports = { createProjectSettingsGate: createProjectSettingsGate, REFUSAL_TEXT: REFUSAL_TEXT };
