// permission-state.js - client copy of the server's permission-request state.
//
// The server owns the lifecycle; this store only mirrors what the server has
// said about each requestId, from whichever message said it first: a live
// event, a replayed request stamped with permissionState, or the pending
// snapshot sent on connect. Terminal states are final on the server, so they
// are final here too - a later "pending" can never reopen a settled request,
// which is what makes card rendering independent of message order (paged
// history delivers resolutions before the requests they close).
//
// Deliberately free of imports so it can be exercised without the rest of the
// frontend module graph.

/** @typedef {{state: "pending"|"resolved"|"cancelled", decision?: ?string, reason?: ?string}} PermissionState */

export function isTerminal(st) {
  return !!st && (st.state === "resolved" || st.state === "cancelled");
}

export function createPermissionStates() {
  var states = Object.create(null);

  return {
    /**
     * Merge what the server said about requestId; returns the effective state.
     * @param {string} requestId
     * @param {PermissionState} next
     * @returns {PermissionState}
     */
    apply: function (requestId, next) {
      var cur = states[requestId];
      if (!next || isTerminal(cur)) return cur || null;
      if (isTerminal(next) || !cur) {
        states[requestId] = {
          state: next.state,
          decision: next.decision || null,
          reason: next.reason || null,
        };
      }
      return states[requestId];
    },

    /** @returns {?PermissionState} */
    get: function (requestId) {
      return states[requestId] || null;
    },

    clear: function () {
      states = Object.create(null);
    },
  };
}
