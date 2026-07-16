"use strict";
// Regression coverage for a PEACHES follow-up finding on lr-0827ba (PR #340,
// GitHub issue #328): forgetSessionRateLimitState()/clearSession() existed
// but were never called on session deletion, so rate-limit-state.js's
// per-session map and any pending background reset-timer setTimeout leaked
// forever every time a session was deleted.
//
// Fix: lib/sessions.js gained broadcastSessionDeleted(localIds), called from
// deleteSession() (single) and deleteSessionsBulk() (batch); lib/project-loop.js's
// delete_loop_group handler calls it too. The client (app-messages.js) dispatches
// the new "session_deleted" WS message to forgetSessionRateLimitState() for each id.
//
// Server-side pieces are covered here with real createSessionManager (matching
// the existing session-lifecycle-lr-e0de.test.js convention: a fake `send`
// captures broadcasts, no inline reimplementation of production logic).
// Client-side dispatch wiring is covered as a source-text check (app-messages.js
// is DOM/live-WS coupled and not importable under plain Node, matching the
// frontend-state-correlation-lr-fb49.test.js convention) plus a direct,
// DOM-free exercise of rate-limit-state.js's clearSession — the actual cleanup
// logic forgetSessionRateLimitState() delegates to.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-"));
}

function makeSessionManager(tmpHome, sendSpy) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessions;
  try {
    sessions = require("../lib/sessions");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  return sessions.createSessionManager({
    cwd: tmpHome,
    send: sendSpy,
    sendTo: function () {},
    sendEach: function () {},
  });
}

// ---------------------------------------------------------------------------
// Server-side: deleteSession / deleteSessionsBulk broadcast session_deleted
// ---------------------------------------------------------------------------

test("lib/sessions.js: deleteSession broadcasts session_deleted with the deleted localId", function () {
  var tmpHome = makeTempHome();
  var sent = [];
  var sm = makeSessionManager(tmpHome, function (obj) { sent.push(obj); });

  var sess = sm.createSessionRaw({});
  var localId = sess.localId;
  // Give it a second session too, so deleting the first isn't "delete the
  // only session" (which takes the createSession(null, ...) fallback path).
  sm.createSessionRaw({});

  sent.length = 0; // ignore anything sent by createSessionRaw itself
  sm.deleteSession(localId, null);

  var deletedMsgs = sent.filter(function (m) { return m.type === "session_deleted"; });
  assert.equal(deletedMsgs.length, 1, "expected exactly one session_deleted broadcast");
  assert.deepEqual(deletedMsgs[0].ids, [localId], "session_deleted must carry the deleted session's localId");
});

test("lib/sessions.js: deleteSessionsBulk broadcasts session_deleted with all deleted localIds", function () {
  var tmpHome = makeTempHome();
  var sent = [];
  var sm = makeSessionManager(tmpHome, function (obj) { sent.push(obj); });

  var a = sm.createSessionRaw({});
  var b = sm.createSessionRaw({});
  var c = sm.createSessionRaw({});

  sent.length = 0;
  sm.deleteSessionsBulk([a.localId, b.localId], null);

  var deletedMsgs = sent.filter(function (m) { return m.type === "session_deleted"; });
  assert.equal(deletedMsgs.length, 1, "expected exactly one session_deleted broadcast for the whole batch");
  assert.deepEqual(
    deletedMsgs[0].ids.slice().sort(),
    [a.localId, b.localId].sort(),
    "session_deleted must carry every id actually deleted in the batch"
  );
  // c was never targeted for deletion — must not appear.
  assert.ok(deletedMsgs[0].ids.indexOf(c.localId) === -1);
});

test("lib/sessions.js: deleteSessionsBulk does not broadcast session_deleted when nothing was actually deletable", function () {
  var tmpHome = makeTempHome();
  var sent = [];
  var sm = makeSessionManager(tmpHome, function (obj) { sent.push(obj); });

  sm.createSessionRaw({});
  sent.length = 0;

  // Non-existent localId — nothing should be deleted or broadcast.
  sm.deleteSessionsBulk([999999], null);

  var deletedMsgs = sent.filter(function (m) { return m.type === "session_deleted"; });
  assert.equal(deletedMsgs.length, 0, "no session_deleted broadcast when the batch had no real deletions");
});

// ---------------------------------------------------------------------------
// Client-side: app-messages.js dispatches session_deleted to
// forgetSessionRateLimitState, and lib/project-loop.js's delete_loop_group
// handler also broadcasts session_deleted (source-text checks — these
// modules are DOM/live-WS coupled and not importable under plain Node,
// matching the frontend-state-correlation-lr-fb49.test.js convention).
//
// lr-4e49 Part 2 converted app-messages.js's switch(msg.type) to a handler
// registry (registerHandlers({ type: fn })) — same dispatch behavior, no
// case "..." labels left to match against. Updated to match the registry
// object-literal shape; the assertion (forgetSessionRateLimitState called
// for every deleted id) is unchanged.
// ---------------------------------------------------------------------------

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

test("app-messages.js: session_deleted dispatch calls forgetSessionRateLimitState for each deleted id", function () {
  var src = readMod("lib/public/modules/app-messages.js");
  var idx = src.indexOf("session_deleted: function (msg) {");
  assert.ok(idx !== -1, "expected a session_deleted handler in the registry");
  var endIdx = src.indexOf("session_list: function (msg) {", idx);
  assert.ok(endIdx !== -1 && endIdx > idx);
  var block = src.slice(idx, endIdx);
  assert.match(
    block,
    /forgetSessionRateLimitState\(deletedId\)/,
    "session_deleted must call forgetSessionRateLimitState for every deleted id, or its background reset timer leaks forever"
  );
  assert.match(src, /forgetSessionRateLimitState/, "forgetSessionRateLimitState must be imported from app-rate-limit.js");
});

test("lib/project-loop.js: delete_loop_group broadcasts session_deleted for every session it removes", function () {
  var src = readMod("lib/project-loop.js");
  var idx = src.indexOf('msg.type === "delete_loop_group"');
  assert.ok(idx !== -1);
  var block = src.slice(idx, idx + 800);
  assert.match(
    block,
    /sm\.broadcastSessionDeleted\(sessionIds\)/,
    "delete_loop_group must broadcast session_deleted for the sessions it deletes, matching deleteSession/deleteSessionsBulk"
  );
});

// ---------------------------------------------------------------------------
// End-to-end (DOM-free): the actual cleanup logic forgetSessionRateLimitState
// delegates to — rate-limit-state.js's clearSession — really does cancel the
// background timer and drop the entry (already covered in isolation by
// rate-limit-state.test.js; re-asserted here scoped to the deletion scenario
// specifically, since that's the defect PEACHES flagged).
// ---------------------------------------------------------------------------

test("rate-limit-state.js: clearSession (forgetSessionRateLimitState's delegate) cancels the timer and drops the entry for a deleted session", async function () {
  var mod = await import("../lib/public/modules/rate-limit-state.js");
  mod._resetAllForTest();

  var fired = false;
  var timer = setTimeout(function () { fired = true; }, 60);
  mod.setScheduleDelayMs("deleted-session-42", 300000);
  mod.setRateLimitResetTimer("deleted-session-42", timer);

  assert.ok(mod.hasArmedState("deleted-session-42"));

  mod.clearSession("deleted-session-42");

  assert.equal(mod.hasArmedState("deleted-session-42"), false);
  assert.equal(mod.getScheduleDelayMs("deleted-session-42"), 0);

  await new Promise(function (resolve) {
    setTimeout(function () {
      assert.equal(fired, false, "the deleted session's background reset timer must have been canceled, not left to fire later");
      resolve();
    }, 100);
  });
});
