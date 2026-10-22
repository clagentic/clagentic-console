// Regression coverage for lr-0827ba (GitHub issue #328): rate-limit
// auto-schedule arming state was global to the browser tab instead of
// per-session, so arming it in a second project silently overwrote/lost
// the first project's armed state.
//
// The server's scheduled inputs (lib/scheduled-input/) are bound to one
// session each — these tests cover the two other pieces of the fix:
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
//
// lr-4e49 Part 2 converted app-messages.js's switch(msg.type) to a handler
// registry (registerHandlers({ type: fn })) — same dispatch behavior, no
// case "..." labels left to match against. The three app-messages.js
// checks below were updated to match the registry object-literal shape
// instead; the assertions themselves (which functions are called, with
// which arguments, in which order) are unchanged.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

var SDK_MESSAGE_PROCESSOR_JS = readMod("lib/sdk-message-processor.js");
var APP_MESSAGES_JS = readMod("lib/public/modules/app-messages.js");
var APP_RATE_LIMIT_JS = readMod("lib/public/modules/app-rate-limit.js");

// ---------------------------------------------------------------------------
// Server-side: WS payloads stamped with session localId
// ---------------------------------------------------------------------------

// The scheduled-message events are now sent by lib/scheduled-input/ws.js;
// these run it rather than reading its source.
function publishedBy(eventType, recordExtra) {
  var { createPublisher } = require("../lib/scheduled-input/ws");
  var session = { localId: 41, cliSessionId: "vendor-41" };
  var recorded = [];
  var live = [];
  var publish = createPublisher({
    getProject: function () { return { sm: { sessions: new Map([[41, session]]), sendAndRecord: function (s, o) { recorded.push(o); }, sendToSession: function (s, o) { live.push(o); } } }; },
    listFor: function () { return []; },
  });
  publish({
    type: eventType, slug: "p", session: session,
    record: Object.assign({ id: "si_1", kind: "once", text: "go", nextAt: 5, createdAt: 1, state: "armed", sessionId: "vendor-41", sessionIdKind: "vendor" }, recordExtra),
  });
  return { recorded: recorded, live: live };
}

test("scheduled-input publisher: scheduled_message_queued is stamped with localId: session.localId", function () {
  var out = publishedBy("queued");
  assert.equal(out.recorded[0].type, "scheduled_message_queued");
  assert.equal(out.recorded[0].localId, 41, "scheduled_message_queued must carry localId so the client can route it to the right session");
});

test("scheduled-input publisher: scheduled_message_sent is stamped with localId: session.localId", function () {
  var out = publishedBy("sent");
  assert.equal(out.recorded[0].type, "scheduled_message_sent");
  assert.equal(out.recorded[0].localId, 41);
});

test("scheduled-input publisher: scheduled_message_cancelled is stamped with localId: session.localId", function () {
  var out = publishedBy("cancelled", { state: "ended", endReason: "gone" });
  assert.equal(out.recorded[0].type, "scheduled_message_cancelled");
  assert.equal(out.recorded[0].localId, 41);
});

test("scheduled-input publisher: the session's list is stamped with localId too, for its viewers only", function () {
  var out = publishedBy("queued");
  assert.equal(out.live[0].type, "scheduled_input_list");
  assert.equal(out.live[0].localId, 41);
  assert.equal(out.live[0].limit, 5);
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

test("app-messages.js: scheduled_input_list goes to applyScheduledInputList, which keys the list on msg.localId", function () {
  assert.match(APP_MESSAGES_JS, /scheduled_input_list:\s*applyScheduledInputList/,
    "the session's list must be routed by the handler that stores it under msg.localId, so a background session's list doesn't render into the focused session's message list");
  var idx = APP_RATE_LIMIT_JS.indexOf("export function applyScheduledInputList(msg)");
  assert.ok(idx !== -1);
  var block = APP_RATE_LIMIT_JS.slice(idx, idx + 600);
  assert.match(block, /msg\.localId\s*!=\s*null\s*\?\s*msg\.localId\s*:\s*currentSessionId\(\)/);
  assert.match(block, /if \(targetSessionId === currentSessionId\(\)\) renderScheduledBubbles\(/,
    "only the session on screen is drawn");
});

test("app-messages.js: the older scheduled-message events take no state; the list is the only source", function () {
  var queuedIdx = APP_MESSAGES_JS.indexOf("scheduled_message_queued:");
  var cancelIdx = APP_MESSAGES_JS.indexOf("scheduled_message_cancelled:");
  assert.ok(queuedIdx !== -1 && cancelIdx !== -1);
  assert.match(APP_MESSAGES_JS.slice(queuedIdx, queuedIdx + 60), /scheduled_message_queued:\s*function \(\) \{\}/);
  assert.match(APP_MESSAGES_JS.slice(cancelIdx, cancelIdx + 60), /scheduled_message_cancelled:\s*function \(\) \{\}/);
  // scheduled_message_sent is not a no-op: it only shows the session as
  // processing, and only for the session on screen. It must not touch the list.
  var sentIdx = APP_MESSAGES_JS.indexOf("scheduled_message_sent:");
  assert.ok(sentIdx !== -1);
  var sentEnd = APP_MESSAGES_JS.indexOf("\n  },", sentIdx);
  var sentBlock = APP_MESSAGES_JS.slice(sentIdx, sentEnd);
  assert.match(sentBlock, /msg\.localId == null \|\| msg\.localId === store\.get\('activeSessionId'\)/);
  assert.match(sentBlock, /setStatus\("processing"\)/);
  assert.doesNotMatch(sentBlock, /setScheduledInputs|applyScheduledInputList/);
});

test("app-messages.js: session_switched calls restoreRateLimitStateForSession after resetClientState (redraw-on-switch-in hook)", function () {
  var idx = APP_MESSAGES_JS.indexOf("session_switched: function (msg) {");
  assert.ok(idx !== -1);
  var handlerEndIdx = APP_MESSAGES_JS.indexOf("\n  },", idx);
  var block = APP_MESSAGES_JS.slice(idx, handlerEndIdx);
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
