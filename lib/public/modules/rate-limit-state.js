// rate-limit-state.js - Per-session rate-limit / schedule-message arming state.
//
// lr-0827ba: this state was previously a handful of bare module-scoped
// variables in input.js and app-rate-limit.js (scheduleDelayMs,
// rateLimitResetsAt, rateLimitResetTimer, rateLimitResetState, scheduled
// message bubble text/resetsAt). Because the SPA does not reload the page
// when the user switches projects, all sessions across all projects shared
// that single set of variables — arming a schedule in a second project
// silently clobbered the first project's armed state.
//
// This module replaces those bare variables with a small state map keyed by
// session localId (the same id the server uses as its session-map key, see
// lib/sessions.js and the `id` field on `session_switched`), mirroring the
// existing sessionDrafts precedent in app-messages.js/app.js. Each session's
// entry keeps running in the background (including its reset setTimeout)
// even while a different session is focused, mirroring server-side behavior
// (the server's scheduled inputs are bound to one session each).
//
// DOM-free by design so it can be imported and unit-tested directly under
// plain Node (see test/rate-limit-state.test.js), following the same
// DOM-free-sibling-module convention as sticky-notes-fmt.js.

var _bySession = Object.create(null);

// How many armed scheduled inputs a session may hold until the server says
// otherwise (it sends its own limit with every list).
var DEFAULT_SCHEDULED_INPUT_LIMIT = 5;

function emptyEntry() {
  return {
    // What the composer will schedule the next typed message as, or null:
    // { kind: "once", delayMs } | { kind: "once", atMs } |
    // { kind: "recurring", everyMs, untilMs | count } (input.js sendMessage()
    // consumes this).
    armedSchedule: null,
    // Rate-limit-driven auto-schedule bookkeeping (app-rate-limit.js).
    rateLimitResetsAt: null,
    rateLimitResetTimer: null,
    rateLimitResetState: {},
    // The session's armed scheduled inputs, exactly as the server last listed
    // them: the only source for the bubbles, the panel list and the button.
    scheduledInputs: [],
    scheduledInputLimit: DEFAULT_SCHEDULED_INPUT_LIMIT,
  };
}

function getEntry(sessionId) {
  if (sessionId == null) return emptyEntry();
  if (!_bySession[sessionId]) _bySession[sessionId] = emptyEntry();
  return _bySession[sessionId];
}

// --- Armed schedule (what the next typed message is scheduled as) ---

export function getArmedSchedule(sessionId) {
  return getEntry(sessionId).armedSchedule;
}

export function setArmedSchedule(sessionId, spec) {
  if (sessionId == null) return;
  getEntry(sessionId).armedSchedule = spec || null;
}

// The armed "in N minutes" delay, 0 when none is armed or the armed schedule
// is of another shape. The rate-limit auto-schedule arms through this.
export function getScheduleDelayMs(sessionId) {
  var spec = getEntry(sessionId).armedSchedule;
  return spec && spec.kind === "once" && spec.delayMs > 0 ? spec.delayMs : 0;
}

export function setScheduleDelayMs(sessionId, ms) {
  if (sessionId == null) return;
  getEntry(sessionId).armedSchedule = ms > 0 ? { kind: "once", delayMs: ms } : null;
}

// --- Rate-limit reset bookkeeping ---

export function getRateLimitResetsAt(sessionId) {
  return getEntry(sessionId).rateLimitResetsAt;
}

export function setRateLimitResetsAt(sessionId, resetsAt) {
  if (sessionId == null) return;
  getEntry(sessionId).rateLimitResetsAt = resetsAt;
}

export function getRateLimitResetTimer(sessionId) {
  return getEntry(sessionId).rateLimitResetTimer;
}

export function setRateLimitResetTimer(sessionId, timer) {
  if (sessionId == null) return;
  getEntry(sessionId).rateLimitResetTimer = timer;
}

export function getRateLimitResetState(sessionId) {
  return getEntry(sessionId).rateLimitResetState;
}

// --- Scheduled inputs (the server's list for the session) ---

export function getScheduledInputs(sessionId) {
  return getEntry(sessionId).scheduledInputs.slice();
}

// Replaces the session's list with the one the server sent. limit is the
// server's per-session cap, when it sent one.
export function setScheduledInputs(sessionId, inputs, limit) {
  if (sessionId == null) return;
  var e = getEntry(sessionId);
  e.scheduledInputs = Array.isArray(inputs) ? inputs.slice() : [];
  if (typeof limit === "number" && isFinite(limit) && limit >= 0) e.scheduledInputLimit = limit;
}

export function clearScheduledInputs(sessionId) {
  if (sessionId == null) return;
  getEntry(sessionId).scheduledInputs = [];
}

// A session can take another scheduled input exactly while its list is below
// the cap. The schedule panel derives whether its Schedule control is enabled
// from this for the session on screen; it is never stored separately.
export function canArmScheduledInput(sessionId) {
  var e = getEntry(sessionId);
  return e.scheduledInputs.length < e.scheduledInputLimit;
}

// --- Whole-session lifecycle ---

// True if this session has any armed/queued state worth restoring on
// switch-in (used to decide whether a redraw is needed).
export function hasArmedState(sessionId) {
  if (sessionId == null) return false;
  var e = _bySession[sessionId];
  if (!e) return false;
  return e.armedSchedule != null || e.scheduledInputs.length > 0;
}

// Clears a single session's state entirely, including canceling its
// background reset timer. Call when a session is actually destroyed/closed,
// NOT on a mere project/session switch (switching away must leave the timer
// running in the background so it fires even while unfocused).
export function clearSession(sessionId) {
  if (sessionId == null) return;
  var e = _bySession[sessionId];
  if (e && e.rateLimitResetTimer) clearTimeout(e.rateLimitResetTimer);
  delete _bySession[sessionId];
}

// Test/diagnostic helper: wipes all tracked sessions. Not used in production
// code paths (there is no "reset everything" client action), only in tests
// that need isolation between cases.
export function _resetAllForTest() {
  for (var k in _bySession) {
    if (_bySession[k] && _bySession[k].rateLimitResetTimer) clearTimeout(_bySession[k].rateLimitResetTimer);
  }
  _bySession = Object.create(null);
}
