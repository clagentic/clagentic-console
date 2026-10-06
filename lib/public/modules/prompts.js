// prompts.js - the client's single owner of operator-prompt cards.
//
// Every prompt message, whatever its kind and whether it arrives live, in a
// replayed history page or in the pending snapshot sent on connect, goes
// through apply(). A card is a pure function of the server's state for its
// requestId (prompt-state.js), never of the order messages arrived in; the
// kind renderer (prompt-kinds/) only draws the body and answer controls.
//
// Deliberately free of DOM globals beyond document.createElement (via the
// renderers), so a host can drive it with a hand-built DOM.

import { createPromptStates, normalizePromptMessage, isTerminal } from './prompt-state.js';
import {
  submitPromptResponse, restorePromptCard, settlePromptCard, isUnconfirmed,
  showOutcome, cancelledLabel,
} from './prompt-card.js';
import { PROMPT_KINDS } from './prompt-kinds/index.js';

/**
 * @param {object} host
 * @param {function(Element, ?string)} host.place - insert a new card into
 *   the transcript, focusing the element matching the selector if given.
 * @param {function(object): boolean} host.send - send a WS message; false
 *   when the socket is unusable.
 * @param {function(): string} host.layout - "channel" or "bubble".
 * @param {function(string, object): string} host.toolSummary
 * @param {function(?string): {name: string, avatar: string}} host.vendorIdentity
 * @param {function(): number} host.getContextPercent
 * @param {function(): ?string} host.getPlanContent
 * @param {function(boolean)} host.setMainInputDisabled
 * @param {function(Element): boolean} host.contains - whether an element is
 *   still in the transcript.
 * @param {function(string): ?Element} host.findInTranscript - the card for a
 *   requestId in the transcript, if one is there.
 */
export function createPromptController(host) {
  var states = createPromptStates();
  // requestId -> { container, kind, fields }
  var cards = Object.create(null);

  // The card currently in the transcript for requestId, if any. A transcript
  // rebuilt without clear() leaves a detached element behind; it is looked
  // up again rather than updated out of sight.
  function cardFor(requestId) {
    var rec = cards[requestId];
    if (!rec) return null;
    if (rec.container && host.contains(rec.container)) return rec;
    rec.container = host.findInTranscript(requestId);
    return rec.container ? rec : null;
  }

  function respond(requestId, kind, container, fields) {
    var payload = Object.assign({ type: "prompt_response", requestId: requestId, kind: kind }, fields);
    submitPromptResponse(container, function () { return host.send(payload); });
  }

  function draw(n) {
    var renderer = PROMPT_KINDS[n.kind];
    if (!renderer) return null;
    var rendererHost = Object.assign({}, host, {
      respond: function (container, fields) { respond(n.requestId, n.kind, container, fields); },
    });
    var container = renderer.draw(n.fields, n.requestId, rendererHost);
    container.dataset.promptKind = n.kind;
    cards[n.requestId] = { container: container, kind: n.kind, fields: n.fields, host: rendererHost };
    host.place(container, renderer.focusSelector || null);
    return cards[n.requestId];
  }

  function settle(rec, st) {
    var renderer = PROMPT_KINDS[rec.kind];
    if (rec.container.classList.contains("resolved")) return;
    settlePromptCard(rec.container);
    var outcome = st.state === "cancelled"
      ? { text: cancelledLabel(st.reason), tone: "cancelled" }
      : renderer.outcome(st);
    showOutcome(rec.container, outcome);
    if (renderer.settle) renderer.settle(rec.container, st, rec.fields, outcome, rec.host);
  }

  // Bring a card in line with its requestId's state. serverPending is the
  // server's assertion that the prompt is still unanswered: a card left
  // mid-send by a dropped socket becomes answerable again.
  function sync(requestId, serverPending) {
    var st = states.get(requestId);
    var rec = cardFor(requestId);
    if (!st || !rec) return;
    if (isTerminal(st)) settle(rec, st);
    else if (serverPending && isUnconfirmed(rec.container)) restorePromptCard(rec.container);
  }

  return {
    /**
     * Apply one prompt message (any kind, current or legacy shape). Returns
     * the prompt's effective state, or null for an unrelated message.
     */
    apply: function (msg) {
      var n = normalizePromptMessage(msg);
      if (!n || !n.requestId) return null;
      if (n.phase === "request" || n.phase === "pending") {
        states.apply(n.requestId, n.serverState || { state: "pending" });
        if (!cardFor(n.requestId)) draw(n);
        sync(n.requestId, n.phase === "pending");
      } else if (n.phase === "resolved") {
        states.apply(n.requestId, Object.assign({ state: "resolved" }, n.fields));
        sync(n.requestId);
      } else {
        states.apply(n.requestId, { state: "cancelled", reason: n.fields.reason });
        sync(n.requestId);
      }
      return states.get(n.requestId);
    },

    /** Return every card awaiting a server confirmation to its answerable state. */
    restoreUnconfirmed: function (message) {
      Object.keys(cards).forEach(function (id) {
        var rec = cards[id];
        if (rec.container && isUnconfirmed(rec.container)) restorePromptCard(rec.container, message);
      });
    },

    /** Forget everything (a different session's transcript is shown). */
    clear: function () {
      states.clear();
      cards = Object.create(null);
    },

    get: function (requestId) { return states.get(requestId); },
  };
}
