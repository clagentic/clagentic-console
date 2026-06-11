// pendingNavigate state machine — no DOM dependencies.
// Shared by filebrowser.js (browser import) and lib/pending-navigate.js
// (Node-testable CJS shim that re-implements the same contract for tests).
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
