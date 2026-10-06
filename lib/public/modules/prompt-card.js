// prompt-card.js - the shell every operator-prompt card shares: the
// pending/sending/confirmed state machine and the terminal rendering.
//
// A card never displays an outcome ("Allowed", "Submitted") until the server
// has confirmed it. Answering only moves the card to a "sending" state; the
// final label is applied when the server's prompt_resolved (or prompt_cancel)
// arrives. If the socket is down, or no confirmation arrives in time, the
// card returns to its answerable state so the operator can retry.
//
// Deliberately free of imports so it can be exercised without the rest of the
// frontend module graph.

export var SENDING_CLASS = "sending";
export var ACK_TIMEOUT_MS = 10000;

var NOTE_CLASS = "permission-sending-note";
var ackTimers = new WeakMap();

function clearAckTimer(container) {
  var t = ackTimers.get(container);
  if (t) {
    clearTimeout(t);
    ackTimers.delete(container);
  }
}

function removeNote(container) {
  var notes = container.querySelectorAll("." + NOTE_CLASS);
  for (var i = 0; i < notes.length; i++) notes[i].remove();
}

function setControlsDisabled(container, disabled) {
  var controls = container.querySelectorAll("button, input");
  for (var i = 0; i < controls.length; i++) {
    var el = controls[i];
    if (disabled) {
      el.disabled = true;
    } else if (el.classList.contains("plan-feedback-send")) {
      // The feedback send button is only live while its input has text.
      var input = container.querySelector(".plan-feedback-input");
      el.disabled = !(input && input.value && input.value.trim());
    } else {
      el.disabled = false;
    }
  }
}

function addNote(container, text, isError) {
  removeNote(container);
  var note = document.createElement("div");
  note.className = NOTE_CLASS + (isError ? " permission-note-error" : "");
  note.textContent = text;
  var actions = container.querySelector(".permission-actions");
  if (actions && actions.parentNode) {
    actions.parentNode.appendChild(note);
  } else {
    container.appendChild(note);
  }
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
  clearAckTimer(container);
  if (isSettled(container)) return;
  container.classList.remove(SENDING_CLASS);
  setControlsDisabled(container, false);
  if (message) addNote(container, message, true);
  else removeNote(container);
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
  setControlsDisabled(container, true);
  addNote(container, "Sending...", false);
  if (opts.onSent) opts.onSent();

  var timeoutMs = opts.ackTimeoutMs || ACK_TIMEOUT_MS;
  ackTimers.set(container, setTimeout(function () {
    restorePromptCard(container, "No confirmation from the server. Choose again to retry.");
  }, timeoutMs));
  return true;
}

/** Called when the server confirms or ends the prompt. */
export function settlePromptCard(container) {
  clearAckTimer(container);
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
  container.classList.add("resolved", TONE_CLASSES[outcome.tone] || TONE_CLASSES.cancelled);
  var actions = container.querySelector(".permission-actions");
  if (actions) {
    actions.innerHTML = '<span class="permission-decision-label">' + outcome.text + '</span>';
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
  return CANCEL_LABELS[reason] || "Cancelled";
}
