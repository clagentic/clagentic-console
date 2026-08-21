// activity-latch.js - Pure decision logic for the client-local 'processing'
// activity-indicator latch.
//
// 'processing' (the field app-favicon.js's initActivityFooter subscribes
// to) is a client-local edge latch with no server reconciliation —
// app-messages.js's status/done/auth_required handlers wrote it
// unconditionally, with no knowledge of which session a message actually
// belongs to. A background session's status:"processing" could raise the
// FOCUSED session's latch with no done ever routed back to clear it
// (stuck-ON) — the inverse of the historical stuck-OFF symptom this
// codebase has previously fixed for the transcript footer.
//
// This module extracts the two DECISION functions those handlers need —
// "should this session-scoped edge apply to the currently-focused session?"
// and "when should the staleness backstop timer arm/fire/clear?" — as pure,
// DOM-free logic. app-messages.js and app-favicon.js are both DOM-heavy
// (app-favicon.js's import graph reaches theme.js <-> markdown.js, which
// has a circular-import ordering hazard around mermaid theme init that
// makes them unimportable in a plain Node test process without a much
// heavier harness than this repo carries — see the test file for this
// module's header comment). Carving the pure decision logic out here —
// mirroring how activity-state.js was carved out of the sidebar/hub render
// sites for the same reason — is what makes this fix's core logic
// behaviorally testable at all, rather than only provable by source-text
// inspection.

/**
 * Should a session-scoped activity-latch edge (status:"processing",
 * done, auth_required) be applied to the client's current local state?
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

// ---------------------------------------------------------------------------
// lr-58c813: accept/reject ledger — instrumentation only, no decision logic.
//
// MILLER (lr-96e7da) hypothesized cross-session crosstalk on this latch at
// 0.5 confidence and flagged it never instrumented to proof; the symptom
// recurred (lr-5edd64) in code that already has this guard. This ledger
// records what shouldApplyActivityEdge actually decided at runtime, at the
// three call sites in app-messages.js (status/done/auth_required), WITHOUT
// changing which branch any of them take — recordActivityEdgeDecision is
// called for its side effect (counting) only, after the real decision has
// already been made by shouldApplyActivityEdge, never in place of it.
//
// The fail-open branch (msgLocalId == null) is counted SEPARATELY per the
// task spec: it is a deliberate back-compat path, but a live send site that
// still fails to stamp localId would silently re-enable the pre-fix
// unguarded write through this exact branch, and no existing test would
// notice. A nonzero count here in production is the actionable signal.
//
// Bounded: this is a plain in-memory counter object, reset on page
// load/reload (no persistence, no growth — four integers total, no per-
// event array). It does not log to the console on every message (that would
// flood devtools on a chatty session); callers read the totals on demand via
// getActivityEdgeLedger(), e.g. from devtools or a future diagnostics-panel
// hook — never a per-event stream.

var _activityEdgeLedger = {
  accepted: 0,
  rejected: 0,
  acceptedFailOpen: 0, // subset of `accepted`: msgLocalId == null specifically
};

/**
 * Record the outcome of a shouldApplyActivityEdge call for the ledger.
 * Pure bookkeeping — does not itself decide anything and must be called
 * with the SAME inputs the real decision already used, after the fact.
 *
 * @param {string} msgType - "status" | "done" | "auth_required"
 * @param {number|string|null|undefined} msgLocalId
 * @param {number|string|null|undefined} activeSessionId
 * @param {boolean} accepted - the shouldApplyActivityEdge result already computed by the caller
 */
export function recordActivityEdgeDecision(msgType, msgLocalId, activeSessionId, accepted) {
  if (accepted) {
    _activityEdgeLedger.accepted++;
    if (msgLocalId == null) _activityEdgeLedger.acceptedFailOpen++;
  } else {
    _activityEdgeLedger.rejected++;
  }
}

/** Read-only snapshot of the ledger totals (does not reset). */
export function getActivityEdgeLedger() {
  return {
    accepted: _activityEdgeLedger.accepted,
    rejected: _activityEdgeLedger.rejected,
    acceptedFailOpen: _activityEdgeLedger.acceptedFailOpen,
  };
}

/** Test-only reset so ledger tests don't leak counts across cases. */
export function _resetActivityEdgeLedgerForTest() {
  _activityEdgeLedger = { accepted: 0, rejected: 0, acceptedFailOpen: 0 };
}

/**
 * Staleness-backstop timer state machine. A single timer is
 * armed on a genuine 0->1 'processing' transition and disarmed on every
 * 1->0 transition — never a recurring poll, never more than one in-flight
 * timer regardless of how many turns/sessions run. Kept here as pure state
 * transitions (arm/clear/shouldFire) so the bound (one timer, one-shot,
 * re-armed only by a fresh transition) is asserted directly rather than
 * only described in a comment.
 */
export function createActivityStaleBackstop(opts) {
  var delayMs = (opts && opts.delayMs) || 5 * 60 * 1000; // mirrors sdk-bridge.js ACTIVITY_STALE_MS
  var setTimeoutFn = (opts && opts.setTimeout) || setTimeout;
  var clearTimeoutFn = (opts && opts.clearTimeout) || clearTimeout;
  var onFire = (opts && opts.onFire) || function () {};
  var timer = null;
  var armCount = 0; // exposed for the "never polls / never stacks" test assertion

  function clear() {
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function arm() {
    clear(); // at most one in-flight timer, ever — re-arming replaces, never stacks
    armCount++;
    timer = setTimeoutFn(function () {
      timer = null;
      onFire();
    }, delayMs);
  }

  /** Called on every store 'processing' transition (state !== prev only). */
  function onTransition(nowProcessing) {
    if (nowProcessing) {
      arm();
    } else {
      clear();
    }
  }

  return {
    onTransition: onTransition,
    isArmed: function () { return timer !== null; },
    armCount: function () { return armCount; },
    _clearForTest: clear,
  };
}
