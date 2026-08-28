// activity-latch.js - Pure decision logic for session-scoping a
// session-addressed WS edge to the client's currently-focused session.
//
// lr-5edd64: this module used to also own the client-local 'processing'
// activity-indicator latch's staleness backstop (createActivityStaleBackstop)
// and an accept/reject ledger built to observe that latch
// (recordActivityEdgeDecision/getActivityEdgeLedger, lr-58c813). Both are
// deleted here: 'processing' (the field app-favicon.js's initActivityFooter
// subscribes to) is no longer an independently-written client-local latch —
// it is a pure PROJECTION of server-authoritative per-session state
// (app-messages.js's session_list/session_switched handlers, deriving via
// activity-state.js's sessionActivity()). A staleness backstop and a ledger
// both existed solely to defend that latch against a missed edge; with
// nothing left to defend, keeping them would make them load-bearing again
// for no real behavior (MILLER lr-5edd64 comment #2, Q6).
//
// shouldApplyActivityEdge itself remains: app-messages.js's status handler
// still uses it to session-scope a DIFFERENT, non-render concern —
// sessionIsProcessing (dead-session-todo-compaction) and the pre-thinking-
// dots clear — both of which target whatever session this client is
// currently viewing, so a background session's status:"processing" must
// still not touch them. That guard was never specific to the 'processing'
// latch; it is a general "does this session-addressed edge belong to the
// session I'm currently looking at?" predicate, reused here for its second,
// still-live purpose.

/**
 * Should a session-scoped edge (e.g. status:"processing") be applied to
 * state the client currently associates with its focused session?
 *
 * Mirrors the lr-0827ba pattern already used by scheduled_message_*
 * handlers: a message with no localId (older server, or a message type
 * that was never session-scoped) always applies, matching pre-fix
 * behavior; a message WITH a localId only applies when it matches the
 * session the client currently has focused.
 *
 * @param {number|string|null|undefined} msgLocalId - localId on the
 *   incoming message, or null/undefined if the server didn't stamp one.
 * @param {number|string|null|undefined} activeSessionId - the client's
 *   currently-focused session id (store.get('activeSessionId')).
 * @returns {boolean}
 */
export function shouldApplyActivityEdge(msgLocalId, activeSessionId) {
  return msgLocalId == null || msgLocalId === activeSessionId;
}
