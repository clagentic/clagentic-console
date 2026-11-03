"use strict";

// Who a session's push notification goes to. The one rule behind every
// session-scoped push (permission request, elicitation, ask_user, response
// done, loop done, prompt reminders):
//   - an owned session pushes to its owner only;
//   - an ownerless session in single-user mode broadcasts (there is one person);
//   - an ownerless session in multi-user mode pushes to NO ONE. A broadcast
//     would hand every subscriber the payload, which can carry tool input,
//     paths or code. "Visible to all" on an ownerless session is a legacy
//     default, not consent to phone delivery. The in-app banner and panel
//     keep following the visibility rules.
//   - a mode that cannot be read counts as multi-user, the stricter mode.

var usersModule = require("./users");

function multiUserMode(isMultiUser) {
  try {
    return isMultiUser() !== false;
  } catch (e) {
    return true;
  }
}

/**
 * @param {?object} pushModule the push module (sendPush, sendPushToUser).
 * @param {?string} ownerId the session's owner, if any.
 * @param {object} payload the push payload.
 * @param {function(): boolean} [isMultiUser] the daemon's mode; defaults to the
 *   users store.
 * @returns {"owner"|"broadcast"|"none"} where the push went.
 */
function pushForSession(pushModule, ownerId, payload, isMultiUser) {
  if (!pushModule) return "none";
  if (ownerId && typeof pushModule.sendPushToUser === "function") {
    pushModule.sendPushToUser(ownerId, payload);
    return "owner";
  }
  if (multiUserMode(isMultiUser || usersModule.isMultiUser)) return "none";
  pushModule.sendPush(payload);
  return "broadcast";
}

module.exports = { pushForSession: pushForSession };
