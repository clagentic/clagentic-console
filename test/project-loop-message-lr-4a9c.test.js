"use strict";
/**
 * Regression tests for lr-4a9c: remove a single queued message from
 * pendingUserMessages before it is delivered at the next loop iteration
 * boundary.
 *
 * Followup to lr-e31b / lr-7025 (PRs #316, #317) — the loop_message queue
 * previously had no way to un-queue a single message; a user who queued one
 * by mistake had to wait for it to be delivered at the next boundary.
 *
 * Covered:
 *   1. loop_message_remove splices the targeted message out of
 *      pendingUserMessages by id and re-broadcasts loop_pending_messages.
 *   2. loop_message_remove is rejected (loop_message_error) when no loop is
 *      running.
 *   3. loop_message_remove is rejected when the id is missing or does not
 *      match any queued message (already delivered / already removed).
 *   4. loop_message_error on rejection is sent only to the requesting
 *      client, mirroring loop_message's targeted-error behavior.
 *   5. Each loop_message queue entry carries a stable id distinct from
 *      other entries, which loop_message_remove depends on.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-loop-msg-remove-"));
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

test("lr-4a9c: loop_message_remove splices the targeted message out of the queue", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup } = makeEngine(cwd);
  try {
    engine.loopState.active = true;
    engine.handleLoopMessage({}, { type: "loop_message", text: "first" });
    engine.handleLoopMessage({}, { type: "loop_message", text: "second" });
    engine.handleLoopMessage({}, { type: "loop_message", text: "third" });
    assert.strictEqual(engine.loopState.pendingUserMessages.length, 3);

    var targetId = engine.loopState.pendingUserMessages[1].id;
    assert.ok(targetId, "queued message must carry an id");

    ctx._sent.length = 0;
    var handled = engine.handleLoopMessage({}, { type: "loop_message_remove", id: targetId });
    assert.strictEqual(handled, true);

    assert.strictEqual(engine.loopState.pendingUserMessages.length, 2);
    assert.strictEqual(
      engine.loopState.pendingUserMessages.some(function(m) { return m.id === targetId; }),
      false,
      "removed message must no longer be present"
    );
    assert.deepStrictEqual(
      engine.loopState.pendingUserMessages.map(function(m) { return m.text; }),
      ["first", "third"],
      "the other two queued messages must survive in order"
    );

    var pendingBroadcast = ctx._sent.find(function(m) { return m.type === "loop_pending_messages"; });
    assert.ok(pendingBroadcast, "expected a loop_pending_messages re-broadcast");
    assert.strictEqual(pendingBroadcast.messages.length, 2);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-4a9c: loop_message_remove is rejected when no loop is running", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup } = makeEngine(cwd);
  try {
    engine.loopState.active = false;
    var ws = {};
    var handled = engine.handleLoopMessage(ws, { type: "loop_message_remove", id: "whatever" });
    assert.strictEqual(handled, true);

    var errMsg = ctx._sent.find(function(m) { return m.type === "loop_message_error"; });
    assert.ok(errMsg, "expected a loop_message_error broadcast");
    assert.match(errMsg.text, /no loop is currently running/i);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-4a9c: loop_message_remove is rejected when id is missing", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup } = makeEngine(cwd);
  try {
    engine.loopState.active = true;
    var handled = engine.handleLoopMessage({}, { type: "loop_message_remove" });
    assert.strictEqual(handled, true);

    var errMsg = ctx._sent.find(function(m) { return m.type === "loop_message_error"; });
    assert.ok(errMsg, "expected a loop_message_error broadcast");
    assert.match(errMsg.text, /no message id/i);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-4a9c: loop_message_remove is rejected when id does not match a queued message", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup } = makeEngine(cwd);
  try {
    engine.loopState.active = true;
    engine.handleLoopMessage({}, { type: "loop_message", text: "queued" });
    ctx._sent.length = 0;

    var handled = engine.handleLoopMessage({}, { type: "loop_message_remove", id: "does-not-exist" });
    assert.strictEqual(handled, true);
    assert.strictEqual(engine.loopState.pendingUserMessages.length, 1, "unrelated queued message must survive");

    var errMsg = ctx._sent.find(function(m) { return m.type === "loop_message_error"; });
    assert.ok(errMsg, "expected a loop_message_error broadcast");
    assert.match(errMsg.text, /not found/i);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-4a9c: loop_message_error on a rejected remove is sent only to the requesting client", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup } = makeEngine(cwd);
  try {
    engine.loopState.active = true;
    var ws = { marker: "client-a" };
    engine.handleLoopMessage(ws, { type: "loop_message_remove", id: "missing" });

    var call = ctx._sentTo.find(function(c) { return c[1].type === "loop_message_error"; });
    assert.ok(call, "loop_message_error should be routed via sendTo");
    assert.strictEqual(call[0], ws, "error should be sent to the originating client");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-4a9c: distinct loop_message calls produce distinct ids", function() {
  var cwd = makeTempHome();
  var { engine, cleanup } = makeEngine(cwd);
  try {
    engine.loopState.active = true;
    engine.handleLoopMessage({}, { type: "loop_message", text: "a" });
    engine.handleLoopMessage({}, { type: "loop_message", text: "b" });
    var ids = engine.loopState.pendingUserMessages.map(function(m) { return m.id; });
    assert.strictEqual(ids.length, 2);
    assert.notStrictEqual(ids[0], ids[1]);
    assert.ok(ids[0] && ids[1], "both ids must be truthy");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});
