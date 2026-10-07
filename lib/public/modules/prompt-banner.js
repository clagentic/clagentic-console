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

var DECISION_BUTTONS = "button[data-decision]";
var ACTIONS = ".notif-banner-actions";

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
