// permission-card.js - pending/confirmed state machine for permission cards.
//
// A permission card must never display a final decision ("Allowed", "Denied")
// until the server has confirmed it via permission_resolved. Clicking only
// moves the card to a "sending" state; the final label is applied by the
// server-confirmed path. If the socket is down, or no confirmation arrives in
// time, the card returns to its clickable state so the operator can retry.
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

// True while a card is awaiting server confirmation.
export function isUnconfirmed(container) {
  return container.classList.contains(SENDING_CLASS);
}

/**
 * Restore a sending card to its clickable state.
 * @param {Element} container
 * @param {string} [message] - shown as an inline note explaining why.
 */
export function restorePermissionCard(container, message) {
  clearAckTimer(container);
  if (container.classList.contains("resolved")) return;
  container.classList.remove(SENDING_CLASS);
  setControlsDisabled(container, false);
  if (message) addNote(container, message, true);
  else removeNote(container);
}

/**
 * Submit a decision for a card without claiming it took effect.
 *
 * @param {Element} container
 * @param {function(): boolean} trySend - sends the payload; returns false when
 *   the socket is not usable.
 * @param {object} [opts]
 * @param {number} [opts.ackTimeoutMs]
 * @param {function()} [opts.onSent]
 * @returns {boolean} true when the request was handed to the socket.
 */
export function submitPermissionDecision(container, trySend, opts) {
  opts = opts || {};
  if (container.classList.contains("resolved") || container.classList.contains(SENDING_CLASS)) return false;

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
    restorePermissionCard(container, "No confirmation from the server. Choose again to retry.");
  }, timeoutMs));
  return true;
}

/** Called when the server confirms or invalidates the request. */
export function settlePermissionCard(container) {
  clearAckTimer(container);
  container.classList.remove(SENDING_CLASS);
  removeNote(container);
}
