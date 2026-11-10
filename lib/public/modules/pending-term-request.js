// Ties a terminal the client asked for to the terminal the server reports
// back. A command queued for "the next terminal" would otherwise land in
// whichever terminal is created first, including one somebody else opened in
// the same window. The request id travels in term_create and returns in
// term_created; only the matching terminal takes the queued command.

var counter = 0;

/** @returns {string} a client-unique id for one term_create request */
export function newTermRequestId() {
  counter += 1;
  return "tq-" + Date.now().toString(36) + "-" + counter;
}

/**
 * Takes the queued command and login vendor when this term_created answers the
 * queued request; any other terminal leaves the slot alone.
 * @param {{get: function(string): *, set: function(object)}} store
 * @param {{requestId?: string}} msg  the term_created message
 * @returns {?{command: string, vendor: string}} null when nothing is queued or
 *   the terminal is not the one requested
 */
export function consumePendingTerm(store, msg) {
  var command = store.get("pendingTermCommand");
  var requestId = store.get("pendingTermRequestId");
  if (!command || !requestId || !msg || msg.requestId !== requestId) return null;
  var vendor = store.get("pendingLoginVendor") || "";
  store.set({ pendingTermCommand: null, pendingLoginVendor: "", pendingTermRequestId: "" });
  return { command: command, vendor: vendor };
}
