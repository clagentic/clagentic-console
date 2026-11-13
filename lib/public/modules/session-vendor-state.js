// session-vendor-state.js - which vendor a session belongs to, decided from the
// messages the server sends, as pure functions so the rules can be tested
// without a page. The store is read and written by the callers.

/**
 * The vendor state a session_switched settles on, or null when the session has
 * neither a recorded vendor nor history (a new session keeps the visitor's own
 * choice, so nothing is imposed).
 *   current   { currentVendor, vendorSelectionLocked } as the store holds them
 *             before the switch
 *   defaultId the registry's preferred vendor, for a session with history and
 *             no recorded vendor
 * A session with history has its vendor structurally bound: it is locked so a
 * late model_info from the default adapter cannot flip the page back.
 * msg.vendorSource says how the server resolved the vendor; only an absent one
 * (or a message from a path that sends none) takes the default. "error" means
 * the session's recorded vendor could not be read: whether or not it has
 * history, no vendor is shown and the page is locked so a model_info cannot
 * name one.
 * current.sameSession is false when the switch is to another session than the
 * one the page was on, so a pick made on that one is not carried over.
 * @returns {{currentVendor: string|null, vendorSelectionLocked: boolean}|null}
 */
export function vendorStateForSwitch(msg, current, defaultId) {
  var locked = !!(current && current.vendorSelectionLocked);
  if (!msg.vendor && msg.vendorSource === "error") {
    return { currentVendor: null, vendorSelectionLocked: true };
  }
  if (msg.vendor) {
    // A locked page without history keeps the vendor it holds, but only on the
    // same session: another session takes the vendor the server resolved for it.
    var keepHeld = locked && !msg.hasHistory && current.sameSession !== false;
    return {
      currentVendor: keepHeld ? (current.currentVendor || null) : msg.vendor,
      vendorSelectionLocked: locked || !!msg.hasHistory,
    };
  }
  if (msg.hasHistory) return { currentVendor: defaultId, vendorSelectionLocked: false };
  // A brand-new session keeps the vendor picked before its first message; the
  // caller re-applies this after the reset that clears the page's vendor.
  if (locked && current.currentVendor && current.sameSession !== false) {
    return { currentVendor: current.currentVendor, vendorSelectionLocked: true };
  }
  return null;
}

/** The vendor each session of a session list records, by session id. */
export function sessionVendorMap(sessions) {
  var map = {};
  if (!Array.isArray(sessions)) return map;
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i] && sessions[i].vendor) map[sessions[i].id] = sessions[i].vendor;
  }
  return map;
}

/** The vendor the session list recorded for a session id, or null. */
export function listedVendor(map, sessionId) {
  if (sessionId == null || !map) return null;
  return Object.prototype.hasOwnProperty.call(map, sessionId) ? map[sessionId] : null;
}

/**
 * Whether the composer placeholder must be recomputed after a store change:
 * only when the vendor the active session shows changed, never for a new
 * session_list map that leaves it as it was, and never while loop-queue mode
 * holds the queue wording.
 *   state, prev  { currentVendor, activeSessionId, sessionVendors, loopQueueMode }
 */
export function placeholderNeedsRecompute(state, prev) {
  if (state.loopQueueMode) return false;
  var shown = function (s) {
    return s.currentVendor || listedVendor(s.sessionVendors, s.activeSessionId);
  };
  return shown(state) !== shown(prev);
}

/**
 * Whether a model_info belongs to something other than what the page is on, and
 * so must change nothing: a vendor other than the bound one, or another session's.
 *   state { currentVendor, activeSessionId }
 */
export function isForeignModelInfo(msg, state) {
  if (msg.vendor && state.currentVendor && msg.vendor !== state.currentVendor) return true;
  return msg.sessionId != null && state.activeSessionId != null && msg.sessionId !== state.activeSessionId;
}
