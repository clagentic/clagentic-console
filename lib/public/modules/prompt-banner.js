// prompt-banner.js - the answer buttons of a prompt's notification banner.
//
// A banner answers through the same state machine as the prompt's card
// (prompt-card.js): a click locks its answer buttons and shows "Sending..."
// until the server settles the prompt and dismisses the banner; no
// confirmation in time, or a dropped connection, makes them answerable
// again. Close and "Go to session" stay usable throughout.
//
// Deliberately free of DOM globals beyond the banner element it is given, so
// it can be exercised without the rest of the frontend module graph.

import { definePromptSurface, submitPromptResponse, restoreUnconfirmedUnder } from './prompt-card.js';
import { permissionChoices } from './prompt-kinds/permission-choices.js';

var DECISION_BUTTONS = "button[data-decision]";
var ACTIONS = ".notif-banner-actions";

var PERMISSION_BUTTONS = {
  allow: { label: "Sure", className: "notif-banner-allow" },
  allow_always: { label: "Allow for session", className: "notif-banner-always" },
  deny: { label: "No", className: "notif-banner-deny" },
};

var PLAN_BUTTONS = [
  { decision: "allow", label: "Approve", className: "notif-banner-allow" },
  { decision: "deny", label: "Reject", className: "notif-banner-deny" },
];

/**
 * The answer buttons a prompt's banner offers; a kind with none offers only
 * "Go to session". A tool-permission banner offers the card's answers, in the
 * card's order: no Allow for session for an ask that may not offer it, and
 * No first for an ask that must open on No.
 * @param {string} kind
 * @param {object} [meta] - the notification's meta (the ask's hints).
 * @returns {{decision: string, label: string, className: string}[]}
 */
export function bannerActions(kind, meta) {
  if (kind === "permission") {
    return permissionChoices(meta).map(function (decision) {
      return Object.assign({ decision: decision }, PERMISSION_BUTTONS[decision]);
    });
  }
  if (kind === "plan") return PLAN_BUTTONS.map(function (a) { return Object.assign({}, a); });
  return [];
}

/**
 * Wire a banner's decision buttons to answer its prompt.
 * @param {Element} banner
 * @param {object} prompt
 * @param {string} prompt.requestId
 * @param {string} prompt.kind
 * @param {?string} [prompt.slug] - the project the prompt belongs to.
 * @param {function(object): boolean} send - sends a WS message; false when
 *   the socket is unusable.
 */
export function wirePromptBanner(banner, prompt, send) {
  definePromptSurface(banner, { controls: DECISION_BUTTONS, actions: ACTIONS });
  var buttons = banner.querySelectorAll(DECISION_BUTTONS);
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", answerWith(buttons[i]));
  }

  function answerWith(btn) {
    return function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      var msg = { type: "prompt_response", requestId: prompt.requestId, kind: prompt.kind, decision: btn.getAttribute("data-decision") };
      if (prompt.slug) msg.targetSlug = prompt.slug;
      submitPromptResponse(banner, function () { return send(msg); });
    };
  }
}

/** Make every banner under root that awaits a confirmation answerable again. */
export function restoreUnconfirmedBanners(root, message) {
  if (root) restoreUnconfirmedUnder(root, message);
}
