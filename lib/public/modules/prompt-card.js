// prompt-card.js - the answer state machine every surface that answers an
// operator prompt shares (the transcript card and the notification banner),
// and the card's terminal rendering.
//
// A surface never displays an outcome ("Allowed", "Submitted") until the
// server has confirmed it. Answering only moves it to a "sending" state; the
// final label is applied when the server's prompt_resolved (or prompt_cancel)
// arrives, or, for a banner, the server dismisses it. If the socket is down,
// the connection drops, or no confirmation arrives in time, the surface
// returns to its answerable state so the operator can retry.
//
// Deliberately imports nothing but the import-free own-key.js, so it can be
// exercised without the rest of the frontend module graph.

import { ownValue } from './prompt-kinds/own-key.js';

export var SENDING_CLASS = "sending";
export var ACK_TIMEOUT_MS = 10000;

var NOTE_CLASS = "permission-sending-note";
var DEFAULT_CONTROLS = "button, input, select, textarea";
var DEFAULT_ACTIONS = ".permission-actions";
// container -> { timer, disabled: controls this send disabled, actions }
var sends = new WeakMap();
// container -> { controls, actions } for a surface that is not a card.
var surfaces = new WeakMap();

function surfaceOf(container) {
  return surfaces.get(container) || { controls: DEFAULT_CONTROLS, actions: DEFAULT_ACTIONS };
}

// Ends the send in flight: its timer stops and the controls it disabled are
// live again (those already disabled before it stay as they were).
function endSend(container, reenable) {
  var send = sends.get(container);
  if (!send) return;
  sends.delete(container);
  clearTimeout(send.timer);
  if (reenable) send.disabled.forEach(function (el) { el.disabled = false; });
}

function removeNote(container) {
  var notes = container.querySelectorAll("." + NOTE_CLASS);
  for (var i = 0; i < notes.length; i++) notes[i].remove();
}

function addNote(container, text, isError) {
  removeNote(container);
  var note = document.createElement("div");
  note.className = NOTE_CLASS + (isError ? " permission-note-error" : "");
  note.textContent = text;
  var actions = container.querySelector(surfaceOf(container).actions);
  if (actions && actions.parentNode) {
    actions.parentNode.appendChild(note);
  } else {
    container.appendChild(note);
  }
}

/**
 * Declare a surface other than a card: which of its controls an answer
 * locks, and where its notes go.
 * @param {Element} container
 * @param {{controls: string, actions: string}} opts - selectors.
 */
export function definePromptSurface(container, opts) {
  surfaces.set(container, { controls: opts.controls, actions: opts.actions });
}

/** True while a card is awaiting server confirmation. */
export function isUnconfirmed(container) {
  return container.classList.contains(SENDING_CLASS);
}

/** True once a card shows its final outcome. */
export function isSettled(container) {
  return container.classList.contains("resolved");
}

/**
 * Restore a sending card to its answerable state.
 * @param {Element} container
 * @param {string} [message] - shown as an inline note explaining why.
 */
export function restorePromptCard(container, message) {
  if (isSettled(container)) {
    endSend(container, false);
    return;
  }
  endSend(container, true);
  container.classList.remove(SENDING_CLASS);
  if (message) addNote(container, message, true);
  else removeNote(container);
}

/**
 * Restore every surface under root that is awaiting a confirmation (the
 * connection that would have carried it is gone).
 * @param {Element} root
 * @param {string} [message]
 */
export function restoreUnconfirmedUnder(root, message) {
  var waiting = root.querySelectorAll("." + SENDING_CLASS);
  for (var i = 0; i < waiting.length; i++) restorePromptCard(waiting[i], message);
}

/**
 * Submit an answer for a card without claiming it took effect.
 *
 * @param {Element} container
 * @param {function(): boolean} trySend - sends the payload; returns false when
 *   the socket is not usable.
 * @param {object} [opts]
 * @param {number} [opts.ackTimeoutMs]
 * @param {function()} [opts.onSent]
 * @returns {boolean} true when the answer was handed to the socket.
 */
export function submitPromptResponse(container, trySend, opts) {
  opts = opts || {};
  if (isSettled(container) || isUnconfirmed(container)) return false;

  var sent = false;
  try { sent = !!trySend(); } catch (e) { sent = false; }
  if (!sent) {
    addNote(container, "Not connected. Reconnect, then choose again.", true);
    return false;
  }

  container.classList.add(SENDING_CLASS);
  var disabled = [];
  var controls = container.querySelectorAll(surfaceOf(container).controls);
  for (var i = 0; i < controls.length; i++) {
    if (controls[i].disabled) continue;
    controls[i].disabled = true;
    disabled.push(controls[i]);
  }
  addNote(container, "Sending...", false);
  if (opts.onSent) opts.onSent();

  var timeoutMs = opts.ackTimeoutMs || ACK_TIMEOUT_MS;
  sends.set(container, {
    disabled: disabled,
    timer: setTimeout(function () {
      restorePromptCard(container, "No confirmation from the server. Choose again to retry.");
    }, timeoutMs),
  });
  return true;
}

/** Called when the server confirms or ends the prompt. */
export function settlePromptCard(container) {
  endSend(container, false);
  container.classList.remove(SENDING_CLASS);
  removeNote(container);
}

var TONE_CLASSES = { allowed: "resolved-allowed", denied: "resolved-denied", cancelled: "resolved-cancelled" };

/**
 * The terminal rendering every card shares: the card's actions are replaced
 * by the outcome label and no control stays live.
 * @param {Element} container
 * @param {{text: string, tone: "allowed"|"denied"|"cancelled"}} outcome
 */
export function showOutcome(container, outcome) {
  container.classList.add("resolved", ownValue(TONE_CLASSES, outcome.tone) || TONE_CLASSES.cancelled);
  var actions = container.querySelector(".permission-actions");
  if (actions) {
    // The label is text, never markup, whatever a kind's outcome returns.
    var label = document.createElement("span");
    label.className = "permission-decision-label";
    label.textContent = outcome.text;
    actions.textContent = "";
    actions.appendChild(label);
  }
  var feedbackRow = container.querySelector(".plan-feedback-row");
  if (feedbackRow) feedbackRow.remove();
  var controls = container.querySelectorAll("button, input, select, textarea");
  for (var i = 0; i < controls.length; i++) controls[i].disabled = true;
}

// How a prompt that ended without an answer reads, by reason. "stale" means
// the server no longer holds it (answered elsewhere, or its process ended
// before recording an outcome).
var CANCEL_LABELS = {
  stale: "No longer active (already resolved or expired)",
  expired: "Expired",
  shutdown: "Ended by a daemon restart",
};

export function cancelledLabel(reason) {
  return ownValue(CANCEL_LABELS, reason) || "Cancelled";
}
