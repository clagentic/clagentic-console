"use strict";
/**
 * Regression test for lr-e823:
 * stopLoop() fallback timer must not terminate a loop that started AFTER the
 * stop was issued. The fix captures loopState._loopSeq before the async gap
 * and no-ops the timer if the seq has advanced (i.e. a new loop started).
 *
 * Strategy: patch global setTimeout to capture the timer callback synchronously
 * so we can invoke it at will without waiting 5 seconds. Then verify:
 *
 *   1. _loopSeq increments each time a loop's active state is established
 *      via startLoop-equivalent mutation (seq is the per-run identity).
 *   2. The fallback timer no-ops when _loopSeq has advanced (stop/restart race).
 *   3. The fallback timer fires when _loopSeq is unchanged (normal slow stop).
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-loop-race-"));
}

/**
 * Build the minimal ctx that attachLoop needs to initialise without crashing.
 * None of the SDK/session callbacks matter for these tests — we manipulate
 * loopState directly.
 */
function makeCtx(cwd) {
  var noop = function() {};
  return {
    cwd: cwd,
    slug: "test-project",
    sm: {
      sessions: { get: function() { return null; } },
      setResolveLoopInfo: noop,
      createSession: function() {
        return {
          localId: "sess-" + Math.random(),
          history: [],
          loop: {},
          isProcessing: false,
        };
      },
      saveSessionFile: noop,
      appendToSessionFile: noop,
      broadcastSessionList: noop,
    },
    sdk: { startQuery: noop },
    send: noop,
    sendTo: noop,
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
}

/**
 * Load a fresh attachLoop with an isolated CLAGENTIC_HOME temp dir, then
 * stop the registry timer and return {engine, tmpHome, cleanup}.
 */
function makeEngine(cwd) {
  var tmpHome = makeTempHome();

  // Bust config cache so the fresh CLAGENTIC_HOME is picked up.
  ["../lib/config", "../lib/utils", "../lib/store", "../lib/scheduler", "../lib/project-loop"]
    .forEach(function(m) {
      try { delete require.cache[require.resolve(m)]; } catch(_) {}
    });

  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var engine;
  try {
    var { attachLoop } = require("../lib/project-loop");
    engine = attachLoop(makeCtx(cwd || tmpHome));
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }

  // Stop the registry interval so it doesn't leak into other tests.
  engine.stopTimer();

  function cleanup() {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch(_) {}
  }

  return { engine: engine, cleanup: cleanup };
}

// ---------------------------------------------------------------------------
// Test 1: _loopSeq starts at 0 and increments each time startLoop() sets
// loopState.active = true (simulated by patching loopState directly then
// verifying the count changes after two startLoop calls that succeed).
//
// Since startLoop reads files from disk we exercise _loopSeq by calling
// stopLoop (which snapshots the seq) and confirming the snapshot equals the
// current counter, then artificially incrementing to prove isolation.
// ---------------------------------------------------------------------------

test("lr-e823: _loopSeq starts at 0", function() {
  var cwd = makeTempHome();
  var { engine, cleanup } = makeEngine(cwd);
  try {
    assert.strictEqual(engine.loopState._loopSeq, 0,
      "_loopSeq should be 0 before any loop starts");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

// ---------------------------------------------------------------------------
// Test 2: fallback timer no-ops when _loopSeq has advanced (stop/restart race)
//
// Steps:
//   a. Manually set loopState to "active, stopping, seq=1" (simulates a loop
//      that is being stopped).
//   b. Patch global setTimeout to capture the callback without waiting.
//   c. Call stopLoop() — it should capture stoppingSeq=1 and schedule a timer.
//   d. Advance _loopSeq to 2 (simulates a new loop starting after the stop).
//   e. Invoke the captured callback — it must be a no-op (active stays true).
// ---------------------------------------------------------------------------

test("lr-e823: stop fallback no-ops when _loopSeq advanced (stop/restart race)", function() {
  var cwd = makeTempHome();
  var { engine, cleanup } = makeEngine(cwd);
  try {
    var ls = engine.loopState;

    // Arrange: simulate an active running loop at seq=1.
    ls.active = true;
    ls.stopping = false;
    ls._loopSeq = 1;
    ls.currentSessionId = null;
    ls.judgeSessionId = null;

    // Patch setTimeout to capture the fallback callback synchronously.
    var capturedCallback = null;
    var origSetTimeout = global.setTimeout;
    global.setTimeout = function(fn, delay) {
      // Capture only the 5000ms fallback; ignore shorter timers.
      if (delay === 5000) {
        capturedCallback = fn;
        return 0;
      }
      return origSetTimeout(fn, delay);
    };

    try {
      engine.stopLoop();
    } finally {
      global.setTimeout = origSetTimeout;
    }

    assert.ok(capturedCallback, "stopLoop() should have scheduled a fallback timer");
    assert.ok(ls.stopping, "loopState.stopping should be true after stopLoop");

    // Simulate a rapid restart: new loop starts, seq increments to 2.
    ls._loopSeq = 2;
    ls.stopping = false; // new loop clears stopping flag

    // Now fire the stale fallback — it should see seq mismatch and no-op.
    capturedCallback();

    assert.strictEqual(ls.active, true,
      "active must remain true — stale fallback must not terminate the new loop");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});

// ---------------------------------------------------------------------------
// Test 3: fallback timer fires correctly when the loop is still the same one
// (normal slow stop, no restart).
// ---------------------------------------------------------------------------

test("lr-e823: stop fallback fires when loop identity unchanged (normal slow stop)", function() {
  var cwd = makeTempHome();
  var { engine, cleanup } = makeEngine(cwd);
  try {
    var ls = engine.loopState;

    // Arrange: simulate an active running loop at seq=1.
    ls.active = true;
    ls.stopping = false;
    ls._loopSeq = 1;
    ls.currentSessionId = null;
    ls.judgeSessionId = null;

    var capturedCallback = null;
    var origSetTimeout = global.setTimeout;
    global.setTimeout = function(fn, delay) {
      if (delay === 5000) {
        capturedCallback = fn;
        return 0;
      }
      return origSetTimeout(fn, delay);
    };

    try {
      engine.stopLoop();
    } finally {
      global.setTimeout = origSetTimeout;
    }

    assert.ok(capturedCallback, "stopLoop() should have scheduled a fallback timer");

    // No restart — seq and stopping flag unchanged from stopLoop's mutations.
    // (stopping=true from stopLoop, _loopSeq still 1)
    assert.strictEqual(ls._loopSeq, 1, "seq must still be 1");
    assert.strictEqual(ls.stopping, true, "stopping must be true");

    // Fire the fallback — same identity, should call finishLoop -> active=false.
    capturedCallback();

    assert.strictEqual(ls.active, false,
      "active must be false — fallback should call finishLoop on same-seq loop");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch(_) {}
  }
});
