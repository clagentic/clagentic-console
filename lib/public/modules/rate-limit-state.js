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
// (session.scheduledMessage in lib/project.js is already correctly
// per-session).
//
// DOM-free by design so it can be imported and unit-tested directly under
// plain Node (see test/rate-limit-state.test.js), following the same
// DOM-free-sibling-module convention as sticky-notes-fmt.js.

var _bySession = Object.create(null);

function emptyEntry() {
  return {
    // Auto-schedule arming (input.js sendMessage() consumes this).
    scheduleDelayMs: 0,
    // Rate-limit-driven auto-schedule bookkeeping (app-rate-limit.js).
    rateLimitResetsAt: null,
    rateLimitResetTimer: null,
    rateLimitResetState: {},
    // Scheduled-message bubble (queued user message awaiting send).
    scheduledMsgText: null,
    scheduledMsgResetsAt: null,
  };
}

function getEntry(sessionId) {
  if (sessionId == null) return emptyEntry();
  if (!_bySession[sessionId]) _bySession[sessionId] = emptyEntry();
  return _bySession[sessionId];
}

// --- Schedule delay (auto-send arming) ---

export function getScheduleDelayMs(sessionId) {
  return getEntry(sessionId).scheduleDelayMs;
}

export function setScheduleDelayMs(sessionId, ms) {
  if (sessionId == null) return;
  getEntry(sessionId).scheduleDelayMs = ms;
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

// --- Scheduled-message bubble ---

export function getScheduledMsg(sessionId) {
  var e = getEntry(sessionId);
  if (e.scheduledMsgText == null) return null;
  return { text: e.scheduledMsgText, resetsAt: e.scheduledMsgResetsAt };
}

export function setScheduledMsg(sessionId, text, resetsAt) {
  if (sessionId == null) return;
  var e = getEntry(sessionId);
  e.scheduledMsgText = text;
  e.scheduledMsgResetsAt = resetsAt;
}

export function clearScheduledMsg(sessionId) {
  if (sessionId == null) return;
  var e = getEntry(sessionId);
  e.scheduledMsgText = null;
  e.scheduledMsgResetsAt = null;
}

// --- Whole-session lifecycle ---

// True if this session has any armed/queued state worth restoring on
// switch-in (used to decide whether a redraw is needed).
export function hasArmedState(sessionId) {
  if (sessionId == null) return false;
  var e = _bySession[sessionId];
  if (!e) return false;
  return e.scheduleDelayMs > 0 || e.scheduledMsgText != null;
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
