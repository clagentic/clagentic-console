// Regression coverage for lr-0827ba (GitHub issue #328): rate-limit
// auto-schedule arming state was global to the browser tab instead of
// per-session, so arming it in a second project silently overwrote/lost
// the first project's armed state.
//
// Server-side session.scheduledMessage (lib/project.js) was already
// correctly per-session — these tests cover the two other pieces of the
// fix:
//
//   1. Server-side WS payloads (rate_limit, rate_limit_usage,
//      scheduled_message_queued/sent/cancelled) are stamped with the
//      session's localId so a client can route/correlate events correctly.
//   2. Client-side dispatch (app-messages.js) and the session-switch redraw
//      hook (app-rate-limit.js / app-messages.js) route on that localId
//      instead of always assuming "the currently focused session".
//
// lib/project.js, lib/sdk-message-processor.js, and app-messages.js/
// app-rate-limit.js are not importable directly under plain Node (DOM +
// live server dependencies), so — matching the existing convention in
// test/frontend-state-correlation-lr-fb49.test.js — these are source-text
// regression checks asserting the fix is present.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

var PROJECT_JS = readMod("lib/project.js");
var SDK_MESSAGE_PROCESSOR_JS = readMod("lib/sdk-message-processor.js");
var APP_MESSAGES_JS = readMod("lib/public/modules/app-messages.js");
var APP_RATE_LIMIT_JS = readMod("lib/public/modules/app-rate-limit.js");

// ---------------------------------------------------------------------------
// Server-side: WS payloads stamped with session localId
// ---------------------------------------------------------------------------

test("lib/project.js: scheduled_message_queued is stamped with localId: session.localId", function () {
  var idx = PROJECT_JS.indexOf('type: "scheduled_message_queued"');
  assert.ok(idx !== -1, "expected the scheduled_message_queued entry to still exist");
  var block = PROJECT_JS.slice(idx, idx + 200);
  assert.match(block, /localId:\s*session\.localId/, "scheduled_message_queued must carry localId: session.localId so the client can route it to the right session");
});

test("lib/project.js: scheduled_message_sent is stamped with localId: session.localId", function () {
  var idx = PROJECT_JS.indexOf('sm.sendAndRecord(session, { type: "scheduled_message_sent"');
  assert.ok(idx !== -1, "expected the scheduled_message_sent send to still exist");
  var block = PROJECT_JS.slice(idx, idx + 120);
  assert.match(block, /localId:\s*session\.localId/, "scheduled_message_sent must carry localId: session.localId");
});

test("lib/project.js: scheduled_message_cancelled is stamped with localId: session.localId", function () {
  var idx = PROJECT_JS.indexOf('sm.sendAndRecord(session, { type: "scheduled_message_cancelled"');
  assert.ok(idx !== -1, "expected the scheduled_message_cancelled send to still exist");
  var block = PROJECT_JS.slice(idx, idx + 120);
  assert.match(block, /localId:\s*session\.localId/, "scheduled_message_cancelled must carry localId: session.localId");
});

test("lib/sdk-message-processor.js: rate_limit_usage broadcast is stamped with localId: session.localId", function () {
  var idx = SDK_MESSAGE_PROCESSOR_JS.indexOf('type: "rate_limit_usage"');
  assert.ok(idx !== -1, "expected the rate_limit_usage send to still exist");
  var block = SDK_MESSAGE_PROCESSOR_JS.slice(idx, idx + 250);
  assert.match(block, /localId:\s*session\.localId/, "rate_limit_usage must carry localId: session.localId even though it is a project-wide broadcast");
});

test("lib/sdk-message-processor.js: rate_limit event is stamped with localId: session.localId", function () {
  var idx = SDK_MESSAGE_PROCESSOR_JS.indexOf('type: "rate_limit",');
  assert.ok(idx !== -1, "expected the rate_limit sendAndRecord call to still exist");
  var block = SDK_MESSAGE_PROCESSOR_JS.slice(idx, idx + 500);
  assert.match(block, /localId:\s*session\.localId/, "rate_limit must carry localId: session.localId");
});

// ---------------------------------------------------------------------------
// Client-side: dispatch routes on msg.localId rather than assuming focus
// ---------------------------------------------------------------------------

test("app-messages.js: scheduled_message_queued passes msg.localId through to addScheduledMessageBubble", function () {
  var idx = APP_MESSAGES_JS.indexOf('case "scheduled_message_queued":');
  assert.ok(idx !== -1);
  var block = APP_MESSAGES_JS.slice(idx, idx + 300);
  assert.match(
    block,
    /addScheduledMessageBubble\(msg\.text,\s*msg\.resetsAt,\s*msg\.localId\)/,
    "scheduled_message_queued must forward msg.localId so a background session's scheduled message doesn't render into the focused session's message list"
  );
});

test("app-messages.js: scheduled_message_sent/cancelled route through clearScheduledMessage(msg.localId)", function () {
  var sentIdx = APP_MESSAGES_JS.indexOf('case "scheduled_message_sent":');
  var cancelIdx = APP_MESSAGES_JS.indexOf('case "scheduled_message_cancelled":');
  assert.ok(sentIdx !== -1 && cancelIdx !== -1);
  assert.match(APP_MESSAGES_JS.slice(sentIdx, sentIdx + 250), /clearScheduledMessage\(msg\.localId\)/);
  assert.match(APP_MESSAGES_JS.slice(cancelIdx, cancelIdx + 200), /clearScheduledMessage\(msg\.localId\)/);
});

test("app-messages.js: session_switched calls restoreRateLimitStateForSession after resetClientState (redraw-on-switch-in hook)", function () {
  var idx = APP_MESSAGES_JS.indexOf('case "session_switched":');
  assert.ok(idx !== -1);
  var switchedInIdx = APP_MESSAGES_JS.indexOf('break;', idx);
  var block = APP_MESSAGES_JS.slice(idx, switchedInIdx);
  var resetIdx = block.indexOf("resetClientState();");
  var restoreIdx = block.indexOf("restoreRateLimitStateForSession(");
  assert.ok(resetIdx !== -1, "expected resetClientState() call inside session_switched");
  assert.ok(restoreIdx !== -1, "expected restoreRateLimitStateForSession(...) call inside session_switched");
  assert.ok(restoreIdx > resetIdx, "restoreRateLimitStateForSession must run AFTER resetClientState so it redraws into the freshly-cleared DOM for the newly active session, not the outgoing one");
});

// ---------------------------------------------------------------------------
// Client-side: background sessions keep their timers running across switches
// ---------------------------------------------------------------------------

test("app-rate-limit.js: resetRateLimitState no longer cancels a session's background rate-limit reset timer", function () {
  var idx = APP_RATE_LIMIT_JS.indexOf("export function resetRateLimitState()");
  assert.ok(idx !== -1);
  var endIdx = APP_RATE_LIMIT_JS.indexOf("\n}", idx);
  var block = APP_RATE_LIMIT_JS.slice(idx, endIdx);
  assert.doesNotMatch(
    block,
    /rateLimitResetTimer\s*=\s*null/,
    "resetRateLimitState must not null out a bare rateLimitResetTimer any more — that used to cancel the OUTGOING session's " +
    "background reset timer on every switch, which is exactly the lr-0827ba bug (arming state didn't survive a project switch)"
  );
});

test("app-rate-limit.js: handleRateLimitEvent arms the event's own session (eventSessionId), not unconditionally the focused one", function () {
  var idx = APP_RATE_LIMIT_JS.indexOf("export function handleRateLimitEvent(msg)");
  assert.ok(idx !== -1);
  var block = APP_RATE_LIMIT_JS.slice(idx, idx + 3500);
  assert.match(block, /var eventSessionId\s*=\s*msg\.localId\s*!=\s*null\s*\?\s*msg\.localId\s*:\s*currentSessionId\(\)/);
  assert.match(block, /setRateLimitResetsAt\(eventSessionId,/);
  assert.match(block, /setScheduleDelayForSession\(eventSessionId,/);
});
