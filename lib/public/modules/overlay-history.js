// overlay-history.js — mobile swipe-back / browser-back overlay dismissal
//
// Problem: on mobile PWAs, a back swipe fires a browser `popstate` event.
// If no app-level history entry exists for the open overlay, the browser
// navigates away (exits the PWA or goes to the previous real page).
//
// Pattern:
//   - Each overlay calls pushOverlayState() on open.
//   - Each overlay's close function calls popOverlayState().
//   - A panel opened through the shared overlay (overlay-modal.js, the panel
//     option) does both itself; its close runs on Escape, the close control and
//     a back swipe alike.
//   - The central popstate handler in app.js:
//       1. Calls consumeOverlayPopstate() — returns true if an overlay entry
//          was active (and suppresses the redundant history.back() in the
//          subsequent popOverlayState() call).
//       2. If true, closes the top panel that holds an entry
//          (overlay-registry.js closeTopHeldPanel), else calls the close
//          function of the overlay that still keeps its own entry, and returns.
//       3. Otherwise falls through to normal project-switch logic.
//
// The key invariant: history.back() must be called exactly once per sentinel.
// When the user closes via UI (X / Escape), popOverlayState() calls
// history.back() to remove the sentinel. When the browser already did the
// pop (back swipe), consumeOverlayPopstate() sets a suppress flag so the
// close function's popOverlayState() call is a no-op.

var _depth = 0;
var _suppressBack = false;
// history.back() calls this module made itself whose popstate has not arrived.
// With overlays nested (the phone Settings list under a settings panel),
// closing the top one leaves another sentinel active, so its own popstate
// would otherwise read as a back swipe and close the one underneath.
var _ownPops = 0;

// Call when an overlay opens. Pushes a sentinel history entry.
export function pushOverlayState() {
  _depth++;
  history.pushState({ overlay: true, depth: _depth }, "");
}

// Call when an overlay closes. If the close is user-initiated (not from a
// popstate callback), calls history.back() to remove the sentinel we pushed.
// If _suppressBack is set (we're inside the popstate handler), skip the
// history.back() — it already happened.
export function popOverlayState() {
  if (_depth > 0) {
    _depth--;
    if (_suppressBack) {
      _suppressBack = false;
    } else {
      _ownPops++;
      history.back();
    }
  }
}

// Called first by the popstate handler. True when this popstate is the echo of
// a history.back() popOverlayState() issued, which closes nothing further.
export function consumeOwnPopstate() {
  if (_ownPops > 0) {
    _ownPops--;
    return true;
  }
  return false;
}

// Returns true if at least one overlay history entry is active.
export function hasOverlayState() {
  return _depth > 0;
}

// Called by the popstate handler before invoking the overlay close function.
// Marks that history.back() should be suppressed in the upcoming
// popOverlayState() call (since the browser already did the pop).
// Returns true if an overlay entry was consumed, false if none was active.
export function consumeOverlayPopstate() {
  if (_depth > 0) {
    _suppressBack = true;
    return true;
  }
  return false;
}
