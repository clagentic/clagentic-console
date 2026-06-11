// pendingNavigate state machine — no DOM dependencies.
// Imported by filebrowser.js (browser) and by test/pending-navigate.test.js
// (Node ESM import — no DOM shim needed).
//
// Extracted for lr-a3ca: history_meta must peek without consuming so that
// history_done remains the sole consumer.

var pendingNavigate = null;

export function setPendingNavigate(nav) {
  pendingNavigate = nav;
}

export function clearPendingNavigate() {
  pendingNavigate = null;
}

// Non-consuming read — use in history_meta guard.
export function peekPendingNavigate() {
  return pendingNavigate;
}

// Consuming read — use in history_done only.
export function getPendingNavigate() {
  var nav = pendingNavigate;
  pendingNavigate = null;
  return nav;
}
