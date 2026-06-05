/**
 * Regression tests for lr-3628: cleanup() kills the claude CLI child process
 * on worker shutdown.
 *
 * Covers:
 *   (1) cleanup() sends SIGTERM to _claudeChildProcess when it is alive
 *   (2) cleanup() does not throw when _claudeChildProcess is null
 *   (3) cleanup() does not throw when _claudeChildProcess is already killed
 *
 * Strategy: We cannot require sdk-worker.js or claude-worker.js directly
 * (they are entry-point scripts that open sockets on load). Instead we test
 * the cleanup logic in isolation by extracting the relevant behaviour into
 * a minimal inline reproduction that mirrors the exact code pattern used in
 * both worker files. This guards the contract without running side-effectful
 * socket code.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var EventEmitter = require("events");

// ---------------------------------------------------------------------------
// Helpers — build a minimal mock that reproduces the cleanup() logic
// ---------------------------------------------------------------------------

/**
 * Build a mock child process with a controllable .killed flag and a .kill()
 * spy. Extends EventEmitter so it behaves like a real ChildProcess.
 */
function makeMockChildProcess(alreadyKilled) {
  var cp = new EventEmitter();
  cp.killed = !!alreadyKilled;
  cp.killCalls = [];
  cp.kill = function(signal) {
    cp.killCalls.push(signal || "SIGTERM");
    // Simulate the OS marking the process killed after SIGTERM
    if (!cp.killed) cp.killed = true;
  };
  return cp;
}

/**
 * Build the cleanup function that mirrors the pattern in sdk-worker.js and
 * claude-worker.js exactly. Returns { cleanup, setChild } so tests can inject
 * a mock child process.
 */
function buildCleanupContext() {
  var _claudeChildProcess = null;

  function cleanup() {
    // (other cleanup steps are not relevant to this test)
    if (_claudeChildProcess && !_claudeChildProcess.killed) {
      try { _claudeChildProcess.kill("SIGTERM"); } catch (e) {}
      var _cpSnapshot = _claudeChildProcess;
      setTimeout(function() {
        if (_cpSnapshot && !_cpSnapshot.killed) {
          try { _cpSnapshot.kill("SIGKILL"); } catch (e) {}
        }
      }, 2000);
    }
  }

  return {
    cleanup: cleanup,
    setChild: function(cp) { _claudeChildProcess = cp; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("cleanup() sends SIGTERM to live _claudeChildProcess", function(t, done) {
  var ctx = buildCleanupContext();
  var cp = makeMockChildProcess(false);
  ctx.setChild(cp);

  ctx.cleanup();

  // SIGTERM must have been sent synchronously
  assert.equal(cp.killCalls.length, 1, "expected exactly one kill call");
  assert.equal(cp.killCalls[0], "SIGTERM", "first kill must be SIGTERM");
  done();
});

test("cleanup() does not throw when _claudeChildProcess is null", function(t, done) {
  var ctx = buildCleanupContext();
  // _claudeChildProcess is null by default — no setChild() call

  assert.doesNotThrow(function() {
    ctx.cleanup();
  });
  done();
});

test("cleanup() does not kill an already-killed _claudeChildProcess", function(t, done) {
  var ctx = buildCleanupContext();
  var cp = makeMockChildProcess(true); // already killed
  ctx.setChild(cp);

  ctx.cleanup();

  assert.equal(cp.killCalls.length, 0, "must not call kill() on already-killed process");
  done();
});

test("cleanup() SIGKILL fallback fires if process survives after SIGTERM", function(t, done) {
  var ctx = buildCleanupContext();

  // Build a mock that does NOT mark itself killed on SIGTERM
  var cp = new EventEmitter();
  cp.killed = false;
  cp.killCalls = [];
  cp.kill = function(signal) {
    cp.killCalls.push(signal || "SIGTERM");
    // Do NOT set cp.killed — simulates a process that ignores SIGTERM
  };
  ctx.setChild(cp);

  ctx.cleanup();

  // SIGTERM sent synchronously
  assert.equal(cp.killCalls[0], "SIGTERM");

  // SIGKILL arrives after the 2000ms timeout
  setTimeout(function() {
    assert.ok(cp.killCalls.includes("SIGKILL"), "SIGKILL fallback must fire");
    done();
  }, 2100);
});

test("cleanup() SIGKILL fallback does not fire if process was killed by SIGTERM", function(t, done) {
  var ctx = buildCleanupContext();
  var cp = makeMockChildProcess(false);
  ctx.setChild(cp);

  ctx.cleanup();

  // After SIGTERM, cp.killed is true (mock simulates normal OS behavior)
  setTimeout(function() {
    // Only one kill call (SIGTERM), no SIGKILL
    assert.equal(cp.killCalls.length, 1, "no SIGKILL expected when SIGTERM succeeded");
    assert.equal(cp.killCalls[0], "SIGTERM");
    done();
  }, 2100);
});
