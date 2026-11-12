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
  emptyFolder: "the named folder holds no project",
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
 * Returns { refuse(ws, type, targetSlug, ownerId?), refuseFolder(ws, type, folderName, memberSlugs) }:
 * true when the message was refused (logged and answered, nothing written),
 * false when the caller may go on.
 */
function createProjectSettingsGate(deps) {
  var projectAccess = deps.projectAccess;
  var usersModule = deps.usersModule;
  var osUsers = !!deps.osUsers;
  var sendTo = deps.sendTo;

  // slugs: every project the write lands on (one for a project setter, each
  // member of the folder for a folder setter). A folder with no members fails
  // closed for a non-administrator: there is nothing to prove access to.
  // ownerId: the target project's owner, for a setter whose rule has always let
  // the owner in without the permission (the project default permission mode).
  function verdict(ws, slugs, ownerId) {
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
    if (!slugs.length) return REASON.emptyFolder;
    var multiUser = typeof projectAccess.isMultiUser === "function" ? projectAccess.isMultiUser() : true;
    if (!multiUser) return null;
    var proof = projectAccess.authOf(ws);
    for (var i = 0; i < slugs.length; i++) {
      if (!projectAccess.canAccess(principal.id, slugs[i], proof)) return REASON.access;
    }
    return null;
  }

  function deny(ws, type, label, reason) {
    console.warn("[project-settings-gate] refused " + type + " for " + label + ": " + reason);
    sendTo(ws, { type: "error", text: REFUSAL_TEXT });
    return true;
  }

  function refuse(ws, type, targetSlug, ownerId) {
    var reason = verdict(ws, [targetSlug], ownerId);
    return reason ? deny(ws, type, logSlug(targetSlug), reason) : false;
  }

  // Folder setters change a folder that can hold other users' projects, so the
  // caller must reach every project in the named folder, not just the project
  // the connection is open on. memberSlugs: slugs currently in that folder.
  function refuseFolder(ws, type, folderName, memberSlugs) {
    var members = Array.isArray(memberSlugs) ? memberSlugs : [];
    var reason = verdict(ws, members, null);
    return reason ? deny(ws, type, "folder " + logSlug(folderName), reason) : false;
  }

  return { refuse: refuse, refuseFolder: refuseFolder };
}

module.exports = { createProjectSettingsGate: createProjectSettingsGate, REFUSAL_TEXT: REFUSAL_TEXT };
