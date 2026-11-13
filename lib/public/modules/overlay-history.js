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
//     option) does both itself, naming itself as the owner of its entry; its
//     close runs on Escape, the close control and a back swipe alike.
//   - The central popstate handler in app.js:
//       1. Calls consumeOwnPopstate() — true when the event is the echo of a
//          history.back() this module issued; nothing closes.
//       2. Otherwise asks the registry to close an open menu or dialog first
//          (overlay-registry.js closeTopBlockingOverlay): those hold no entry,
//          so restoreOverlayState() puts the entry the browser just popped back.
//       3. Else calls consumeOverlayPopstate() (suppresses the redundant
//          history.back() in the subsequent popOverlayState() call) and closes the
//          overlay that owns the top entry: the panel, or one of the overlays
//          that still keep their own anonymous entry.
//       4. Otherwise falls through to normal project-switch logic.
//
// The key invariant: history.back() must be called exactly once per sentinel.
// When the user closes via UI (X / Escape), popOverlayState() calls
// history.back() to remove the sentinel. When the browser already did the
// pop (back swipe), consumeOverlayPopstate() sets a suppress flag so the
// close function's popOverlayState() call is a no-op.

// The open entries, oldest first: the owner of each (a panel's node), or null for
// an overlay that keeps its own entry without naming itself.
var _entries = [];
var _suppressBack = false;
// history.back() calls this module made itself whose popstate has not arrived.
// With overlays nested (the phone Settings list under a settings panel),
// closing the top one leaves another sentinel active, so its own popstate
// would otherwise read as a back swipe and close the one underneath.
var _ownPops = 0;

function indexOfOwner(owner) {
  var want = owner || null;
  for (var i = _entries.length - 1; i >= 0; i--) if (_entries[i] === want) return i;
  return -1;
}

// Call when an overlay opens. Pushes a sentinel history entry.
export function pushOverlayState(owner) {
  _entries.push(owner || null);
  history.pushState({ overlay: true, depth: _entries.length }, "");
}

// Call when an overlay closes. If the close is user-initiated (not from a
// popstate callback), calls history.back() to remove the sentinel we pushed.
// If _suppressBack is set (we're inside the popstate handler), skip the
// history.back() — it already happened.
export function popOverlayState(owner) {
  var at = indexOfOwner(owner);
  if (at === -1) return;
  _entries.splice(at, 1);
  if (_suppressBack) {
    _suppressBack = false;
  } else {
    _ownPops++;
    history.back();
  }
}

// Release an entry without history.back(): the page navigates next and pushes its
// own entry, so a queued back would land on the old sentinel and leave the URL on
// the page it came from. The spent sentinel stays under the navigation's entry.
export function releaseOverlayState(owner) {
  var at = indexOfOwner(owner);
  if (at !== -1) _entries.splice(at, 1);
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
  return _entries.length > 0;
}

// The owner of the newest entry: the panel node, or null when it is an overlay
// that keeps its own entry. Only meaningful while hasOverlayState() is true.
export function topOverlayOwner() {
  return _entries.length ? _entries[_entries.length - 1] : null;
}

// Called by the popstate handler before invoking the overlay close function.
// Marks that history.back() should be suppressed in the upcoming
// popOverlayState() call (since the browser already did the pop).
// Returns true if an overlay entry was consumed, false if none was active.
export function consumeOverlayPopstate() {
  if (_entries.length > 0) {
    _suppressBack = true;
    return true;
  }
  return false;
}

// The back closed something that holds no entry (a dialog or a menu opened over an
// overlay), so the entry the browser popped is put back: the overlay under it
// stays open with its entry, and one back closed one thing.
export function restoreOverlayState() {
  _suppressBack = false;
  if (_entries.length) history.pushState({ overlay: true, depth: _entries.length }, "");
}
