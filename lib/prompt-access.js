"use strict";

// Who may answer an operator prompt. Every path that applies an answer (the
// WS card, the push notification's HTTP route) asks this one rule, the same
// one switchSession applies to viewing: a user may answer only prompts of a
// session they can see. A request with no authenticated user (single-user
// mode) owns everything, and a prompt with no session (a project-scope
// browser-extension command) is answerable by whoever reached the project.

var users = require("./users");

/**
 * @param {?{id: string}} user - the authenticated user, or null.
 * @param {?object} session - the prompt's session, or null.
 * @returns {boolean}
 */
function mayAnswerPrompt(user, session) {
  if (!user || !session) return true;
  return users.canAccessSession(user.id, session, { visibility: "public" });
}

module.exports = { mayAnswerPrompt: mayAnswerPrompt };
