"use strict";

// Who a session's push notification (and its in-app reminder) goes to. The one
// rule behind every session-scoped push (permission request, elicitation,
// ask_user, response done, loop done, prompt reminders):
//   - an owned session pushes to its owner only;
//   - an ownerless session in single-user mode broadcasts (there is one person);
//   - an ownerless session in multi-user mode pushes to the admins only. An
//     admin can already read every ownerless session (canAccessSession admits
//     only admins to one), so tool input in the payload crosses no visibility
//     boundary. It is never a broadcast to every subscriber, and a session
//     opened from a console session inherits that session's owner instead
//     (lib/session-input.js), so it is rarely ownerless at all;
//   - a mode that cannot be read counts as multi-user, the stricter mode.

var usersModule = require("./users");

function multiUserMode(isMultiUser) {
  try {
    return isMultiUser() !== false;
  } catch (e) {
    return true;
  }
}

function defaultListAdmins() {
  return usersModule.getAllUsers().filter(function (u) {
    return u.role === "admin";
  }).map(function (u) {
    return u.id;
  });
}

// The admin ids, or [] when the user store cannot be read: no audience beats a
// wider one.
function adminIds(listAdmins) {
  try {
    return (listAdmins || defaultListAdmins)() || [];
  } catch (e) {
    return [];
  }
}

/**
 * @param {?string} ownerId the session's owner, if any.
 * @param {function(): boolean} [isMultiUser] the daemon's mode; defaults to the
 *   users store.
 * @param {function(): string[]} [listAdmins] the admin user ids; defaults to
 *   the users store.
 * @returns {{kind: "owner"|"admins"|"broadcast", userIds: string[]}} kind
 *   "broadcast" has no ids: it means every subscriber (single-user mode).
 *   "admins" with no ids reaches no one.
 */
function audienceFor(ownerId, isMultiUser, listAdmins) {
  if (ownerId) return { kind: "owner", userIds: [ownerId] };
  if (multiUserMode(isMultiUser || usersModule.isMultiUser)) {
    return { kind: "admins", userIds: adminIds(listAdmins) };
  }
  return { kind: "broadcast", userIds: [] };
}

/**
 * @param {?object} pushModule the push module (sendPush, sendPushToUser).
 * @param {?string} ownerId the session's owner, if any.
 * @param {object} payload the push payload.
 * @param {function(): boolean} [isMultiUser] see audienceFor.
 * @param {function(): string[]} [listAdmins] see audienceFor.
 * @returns {"owner"|"admins"|"broadcast"|"none"} where the push went.
 */
function pushForSession(pushModule, ownerId, payload, isMultiUser, listAdmins) {
  if (!pushModule) return "none";
  var audience = audienceFor(ownerId, isMultiUser, listAdmins);
  if (audience.kind === "broadcast") {
    pushModule.sendPush(payload);
    return "broadcast";
  }
  if (typeof pushModule.sendPushToUser !== "function" || !audience.userIds.length) return "none";
  audience.userIds.forEach(function (id) {
    pushModule.sendPushToUser(id, payload);
  });
  return audience.kind;
}

module.exports = { audienceFor: audienceFor, pushForSession: pushForSession };
