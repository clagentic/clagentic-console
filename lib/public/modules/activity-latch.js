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
