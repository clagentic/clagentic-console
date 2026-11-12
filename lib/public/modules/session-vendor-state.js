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
 * @returns {{currentVendor: string, vendorSelectionLocked: boolean}|null}
 */
export function vendorStateForSwitch(msg, current, defaultId) {
  var locked = !!(current && current.vendorSelectionLocked);
  if (msg.vendor) {
    // A locked page without history keeps the vendor it holds.
    return {
      currentVendor: !locked || msg.hasHistory ? msg.vendor : (current.currentVendor || null),
      vendorSelectionLocked: locked || !!msg.hasHistory,
    };
  }
  if (msg.hasHistory) return { currentVendor: defaultId, vendorSelectionLocked: false };
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
 * Whether a model_info belongs to something other than what the page is on, and
 * so must change nothing: a vendor other than the bound one, or another session's.
 *   state { currentVendor, activeSessionId }
 */
export function isForeignModelInfo(msg, state) {
  if (msg.vendor && state.currentVendor && msg.vendor !== state.currentVendor) return true;
  return msg.sessionId != null && state.activeSessionId != null && msg.sessionId !== state.activeSessionId;
}
