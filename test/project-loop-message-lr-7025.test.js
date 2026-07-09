"use strict";
/**
 * Regression tests for lr-7025: cap pendingUserMessages queue length and
 * per-message text length in handleLoopMessage(), and broadcast a
 * loop_message_error when a message is rejected for either cap.
 *
 * Followup to lr-e31b (PR #316) — PEACHES and BOBBIE both flagged that
 * pendingUserMessages grew unbounded (both in memory and in the persisted
 * loop-state JSON written by saveLoopState() on every push).
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-loop-msg-cap-"));
}

/**
 * Build the minimal ctx that attachLoop needs. Captures every broadcast
 * (send/sendTo) call so tests can assert on what was emitted.
 */
function makeCtx(cwd, opts) {
  opts = opts || {};
  var noop = function() {};
  var sent = [];
  var sentTo = [];
  var sessions = new Map();
  var nextLocalId = 1;

  var ctx = {
    cwd: cwd,
    slug: "test-project",
    sm: {
      sessions: sessions,
      setResolveLoopInfo: noop,
      createSession: function() {
        var s = {
          localId: nextLocalId++,
          history: [],
          loop: {},
          isProcessing: false,
        };
        sessions.set(s.localId, s);
        return s;
      },
      saveSessionFile: noop,
      appendToSessionFile: noop,
      broadcastSessionList: noop,
    },
    sdk: { startQuery: opts.startQuery || noop },
    send: function(msg) { sent.push(msg); },
    sendTo: function(ws, msg) { sent.push(msg); sentTo.push([ws, msg]); },
    sendToSession: noop,
    pushModule: null,
    notificationsModule: null,
    getHubSchedules: function() { return []; },
    getAllProjectSessions: function() { return []; },
    getStatus: noop,
    getLinuxUserForSession: function() { return null; },
    onProcessingChanged: noop,
    hydrateImageRefs: noop,
  };
  ctx._sent = sent;
  ctx._sentTo = sentTo;
  return ctx;
}

function makeEngine(cwd, ctxOpts) {
  var tmpHome = makeTempHome();

  ["../lib/config", "../lib/utils", "../lib/store", "../lib/scheduler", "../lib/project-loop", "../lib/loop-handoff"]
    .forEach(function(m) {
      try { delete require.cache[require.resolve(m)]; } catch(_) {}
    });

  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var engine, ctx, mod;
  try {
    mod = require("../lib/project-loop");
    ctx = makeCtx(cwd || tmpHome, ctxOpts);
    engine = mod.attachLoop(ctx);
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }

  engine.stopTimer();

  function cleanup() {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch(_) {}
  }

  return { engine: engine, ctx: ctx, cleanup: cleanup, mod: mod };
}

// ---------------------------------------------------------------------------

test("lr-7025: loop_message rejects text over the per-message length cap", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup, mod } = makeEngine(cwd);
  try {
    engine.loopState.active = true;
    var tooLong = "a".repeat(mod.LOOP_MESSAGE_MAX_TEXT_LENGTH + 1);
    var ws = {};
    var handled = engine.handleLoopMessage(ws, { type: "loop_message", text: tooLong });
    assert.strictEqual(handled, true);
    assert.strictEqual(engine.loopState.pendingUserMessages.length, 0, "over-length message must not be queued");

    var errMsg = ctx._sent.find(function(m) { return m.type === "loop_message_error"; });
    assert.ok(errMsg, "expected a loop_message_error broadcast");
    assert.match(errMsg.text, /too long/i);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-7025: loop_message at exactly the length cap is accepted", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup, mod } = makeEngine(cwd);
  try {
    engine.loopState.active = true;
    var exact = "b".repeat(mod.LOOP_MESSAGE_MAX_TEXT_LENGTH);
    var handled = engine.handleLoopMessage({}, { type: "loop_message", text: exact });
    assert.strictEqual(handled, true);
    assert.strictEqual(engine.loopState.pendingUserMessages.length, 1, "message at the cap boundary should be accepted");
    assert.strictEqual(
      ctx._sent.some(function(m) { return m.type === "loop_message_error"; }),
      false,
      "no error should be broadcast for a message exactly at the cap"
    );
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-7025: loop_message rejects once the queue is at max length", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup, mod } = makeEngine(cwd);
  try {
    engine.loopState.active = true;

    // Fill the queue to the cap.
    for (var i = 0; i < mod.LOOP_MESSAGE_MAX_QUEUE_LENGTH; i++) {
      var handled = engine.handleLoopMessage({}, { type: "loop_message", text: "msg " + i });
      assert.strictEqual(handled, true);
    }
    assert.strictEqual(engine.loopState.pendingUserMessages.length, mod.LOOP_MESSAGE_MAX_QUEUE_LENGTH);

    // Clear captured broadcasts from the fill-up so we only inspect the
    // rejection below.
    ctx._sent.length = 0;

    var overflowHandled = engine.handleLoopMessage({}, { type: "loop_message", text: "one too many" });
    assert.strictEqual(overflowHandled, true);
    assert.strictEqual(
      engine.loopState.pendingUserMessages.length,
      mod.LOOP_MESSAGE_MAX_QUEUE_LENGTH,
      "queue must not grow past the cap"
    );
    assert.strictEqual(
      engine.loopState.pendingUserMessages.some(function(m) { return m.text === "one too many"; }),
      false,
      "rejected message must not be queued (reject, not drop-oldest)"
    );

    var errMsg = ctx._sent.find(function(m) { return m.type === "loop_message_error"; });
    assert.ok(errMsg, "expected a loop_message_error broadcast");
    assert.match(errMsg.text, /queue is full/i);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-7025: loop_message_error on rejection is sent only to the requesting client, not broadcast", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup, mod } = makeEngine(cwd);
  try {
    engine.loopState.active = true;

    var ws = { marker: "client-a" };
    var tooLong = "z".repeat(mod.LOOP_MESSAGE_MAX_TEXT_LENGTH + 1);
    engine.handleLoopMessage(ws, { type: "loop_message", text: tooLong });

    var call = ctx._sentTo.find(function(c) { return c[1].type === "loop_message_error"; });
    assert.ok(call, "loop_message_error should be routed via sendTo");
    assert.strictEqual(call[0], ws, "error should be sent to the originating client");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});
