"use strict";
/**
 * Regression tests for lr-e31b: allow a human user_message to reach a
 * running loop iteration.
 *
 * Loop iterations are ephemeral single-turn SDK sessions — their input
 * stream is closed (handle.endInput()) immediately after the first message
 * is pushed, so a live message cannot be injected into the in-flight turn.
 * The chosen semantics: queue the message and deliver it at the START of
 * the NEXT iteration, folded into that iteration's prompt and also recorded
 * as its own session.history entry so the transcript shows what was sent.
 *
 * Covered:
 *   1. loop_message is rejected (with loop_message_error) when no loop is running.
 *   2. loop_message queues the text and broadcasts loop_pending_messages.
 *   3. runNextIteration() drains the queue into the next iteration's prompt
 *      and session history, then clears the queue.
 *   4. finishLoop() clears any undelivered queued messages so they cannot
 *      leak into a future run.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-loop-msg-"));
}

/**
 * Build the minimal ctx that attachLoop needs. Captures every broadcast
 * (send) call so tests can assert on what was emitted.
 */
function makeCtx(cwd, opts) {
  opts = opts || {};
  var noop = function() {};
  var sent = [];
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
    sendTo: function(ws, msg) { sent.push(msg); },
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
  var engine, ctx;
  try {
    var { attachLoop } = require("../lib/project-loop");
    ctx = makeCtx(cwd || tmpHome, ctxOpts);
    engine = attachLoop(ctx);
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }

  engine.stopTimer();

  function cleanup() {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch(_) {}
  }

  return { engine: engine, ctx: ctx, cleanup: cleanup };
}

// ---------------------------------------------------------------------------

test("lr-e31b: loop_message is rejected when no loop is active", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup } = makeEngine(cwd);
  try {
    assert.strictEqual(engine.loopState.active, false);
    var handled = engine.handleLoopMessage({}, { type: "loop_message", text: "hello" });
    assert.strictEqual(handled, true, "loop_message must be recognized even when rejected");
    var errMsg = ctx._sent.find(function(m) { return m.type === "loop_message_error"; });
    assert.ok(errMsg, "expected a loop_message_error broadcast");
    assert.strictEqual(engine.loopState.pendingUserMessages.length, 0);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-e31b: loop_message queues text and broadcasts loop_pending_messages while a loop is active", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup } = makeEngine(cwd);
  try {
    engine.loopState.active = true;

    var ws = { _clayUser: { id: "u1", displayName: "Andy" } };
    var handled = engine.handleLoopMessage(ws, { type: "loop_message", text: "  check the staging logs  " });
    assert.strictEqual(handled, true);

    assert.strictEqual(engine.loopState.pendingUserMessages.length, 1);
    var entry = engine.loopState.pendingUserMessages[0];
    assert.strictEqual(entry.text, "check the staging logs", "text should be trimmed");
    assert.strictEqual(entry.from, "u1");
    assert.strictEqual(entry.fromName, "Andy");
    assert.ok(typeof entry.ts === "number");

    var broadcast = ctx._sent.filter(function(m) { return m.type === "loop_pending_messages"; }).pop();
    assert.ok(broadcast, "expected a loop_pending_messages broadcast");
    assert.strictEqual(broadcast.messages.length, 1);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-e31b: loop_message with blank text is a silent no-op", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup } = makeEngine(cwd);
  try {
    engine.loopState.active = true;
    engine.handleLoopMessage({}, { type: "loop_message", text: "   " });
    assert.strictEqual(engine.loopState.pendingUserMessages.length, 0);
    assert.strictEqual(ctx._sent.some(function(m) { return m.type === "loop_pending_messages"; }), false);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-e31b: runNextIteration() drains the queue into the next iteration prompt and session history, then clears it", function() {
  var cwd = makeTempHome();
  var capturedPrompts = [];
  var { engine, ctx, cleanup } = makeEngine(cwd, {
    startQuery: function(session, text) { capturedPrompts.push(text); },
  });
  try {
    var ls = engine.loopState;

    // Loop files on disk so startLoop() can read PROMPT.md / LOOP.json.
    var dir = path.join(cwd, ".claude", "loops", "loop_test123");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROMPT.md"), "Do the task.");
    fs.writeFileSync(path.join(dir, "LOOP.json"), JSON.stringify({ loopMode: "simple", maxIterations: 5 }));

    ls.loopId = "loop_test123";
    ls.loopFilesId = "loop_test123";
    ls.wizardData = { loopMode: "simple" };

    // Capture the setTimeout(runNextIteration, 1000) callback scheduled by
    // simple-mode onQueryComplete so we can advance to iteration 2 without
    // waiting a real second.
    var capturedAdvance = null;
    var origSetTimeout = global.setTimeout;
    global.setTimeout = function(fn, delay) {
      if (delay === 1000) { capturedAdvance = fn; return 0; }
      return origSetTimeout(fn, delay);
    };

    try {
      engine.startLoop({ maxIterations: 5 });

      // Iteration 1 has started with an empty queue (fresh run) — capture its
      // session so we can simulate the coder completing normally.
      assert.strictEqual(capturedPrompts.length, 1, "iteration 1 should have started a query");
      var iter1SessionId = ls.currentSessionId;
      var iter1Session = ctx.sm.sessions.get(iter1SessionId);
      assert.ok(iter1Session, "iteration 1 session should exist");

      // Simulate a human message arriving while iteration 1 is in flight —
      // this is exactly the scenario the WS handler covers (tested above);
      // here we exercise what the NEXT iteration boundary does with it.
      ls.pendingUserMessages = [
        { text: "focus on the staging config first", from: "u1", fromName: "Andy", ts: 1000 },
      ];

      // Complete iteration 1 with clean history (no error markers) so the
      // simple-mode onQueryComplete path schedules iteration 2.
      iter1Session.history.push({ type: "done", code: 0 });
      iter1Session.onQueryComplete(iter1Session);

      assert.ok(capturedAdvance, "iteration 1 completion should schedule the next iteration");
      capturedAdvance();
    } finally {
      global.setTimeout = origSetTimeout;
    }

    assert.strictEqual(capturedPrompts.length, 2, "iteration 2 should have started a query");
    var iter2Prompt = capturedPrompts[1];
    assert.ok(
      iter2Prompt.indexOf("focus on the staging config first") !== -1,
      "queued message text must be folded into iteration 2's prompt"
    );
    assert.ok(
      iter2Prompt.indexOf("Do the task.") !== -1,
      "original PROMPT.md text must still be present"
    );

    // Queue must be drained after being consumed.
    assert.strictEqual(ls.pendingUserMessages.length, 0);

    // The queued message must also land in iteration 2's session history as
    // its own user_message entry (with sender attribution), distinct from
    // the folded prompt text.
    var iter2SessionId = ls.currentSessionId;
    var iter2Session = ctx.sm.sessions.get(iter2SessionId);
    assert.ok(iter2Session, "iteration 2 session should exist");
    var queuedEntry = iter2Session.history.find(function(h) {
      return h.type === "user_message" && h.text === "focus on the staging config first";
    });
    assert.ok(queuedEntry, "queued message should be recorded in iteration 2's session history");
    assert.strictEqual(queuedEntry.from, "u1");
    assert.strictEqual(queuedEntry.fromName, "Andy");

    var clearedBroadcast = ctx._sent.filter(function(m) { return m.type === "loop_pending_messages"; }).pop();
    assert.ok(clearedBroadcast, "expected a loop_pending_messages broadcast clearing the queue");
    assert.strictEqual(clearedBroadcast.messages.length, 0);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

test("lr-e31b: finishLoop() clears undelivered queued messages", function() {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup } = makeEngine(cwd);
  try {
    var ls = engine.loopState;
    ls.active = true;
    ls.stopping = false;
    ls.iteration = 2;
    ls.maxIterations = 5;
    ls.currentSessionId = null;
    ls.judgeSessionId = null;
    ls.pendingUserMessages = [{ text: "leftover message", ts: 1000 }];

    // finishLoop is not directly exported, but stopLoop()'s fallback path
    // calls it. Exercise it via the same public surface the lr-e823 tests
    // use: patch setTimeout to capture and invoke the fallback synchronously.
    var capturedCallback = null;
    var origSetTimeout = global.setTimeout;
    global.setTimeout = function(fn, delay) {
      if (delay === 5000) { capturedCallback = fn; return 0; }
      return origSetTimeout(fn, delay);
    };
    try {
      engine.stopLoop();
    } finally {
      global.setTimeout = origSetTimeout;
    }
    assert.ok(capturedCallback, "stopLoop should schedule a fallback timer");
    capturedCallback(); // invokes finishLoop("stopped") since seq/stopping unchanged

    assert.strictEqual(ls.active, false);
    assert.strictEqual(ls.pendingUserMessages.length, 0, "undelivered queue must be cleared on finish");

    var clearedBroadcast = ctx._sent.filter(function(m) { return m.type === "loop_pending_messages"; }).pop();
    assert.ok(clearedBroadcast, "expected a loop_pending_messages broadcast clearing the queue on finish");
    assert.strictEqual(clearedBroadcast.messages.length, 0);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});
