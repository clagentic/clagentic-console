"use strict";

// The one place a "sign-in needed" notification is raised. The bridge and the
// message processor both detect the condition; neither owns a tag, a dedupe or
// a route: the core collapses a repeat for a session into one notification and
// the shared router opens the session.

var { notifyFor } = require("./notify");

var AUTH_BODY = "Open a terminal, then click the URL and follow the instructions.";

/**
 * @param {?object} pushModule the push module.
 * @param {?object} notifications the in-app banner store.
 * @param {object} f
 * @param {string} f.slug the project.
 * @param {{localId: (number|string), ownerId: ?string}} f.session
 * @param {string} f.title
 * @param {string} f.vendor the agent that needs the sign-in.
 * @param {string} f.loginCommand
 * @param {?string} f.linuxUser
 * @param {boolean} f.canAutoLogin
 * @returns {?object} what the core delivered, or null when nothing was.
 */
function notifyAuthRequired(pushModule, notifications, f) {
  return notifyFor(pushModule, notifications).notify("auth_required", {
    slug: f.slug,
    sessionId: f.session.localId,
  }, {
    push: { title: f.title, body: AUTH_BODY },
    banner: {
      title: f.title,
      body: AUTH_BODY,
      vendor: f.vendor,
      loginCommand: f.loginCommand,
      linuxUser: f.linuxUser,
      canAutoLogin: f.canAutoLogin,
    },
  }, { ownerId: f.session.ownerId || null });
}

module.exports = { notifyAuthRequired: notifyAuthRequired };
