"use strict";
// Regression tests for lr-daca: exit-listener leak in createSessionManager.
//
// Root cause: createSessionManager() registered process.on("exit", ...) once
// per call and never deregistered it. With one call per project opened, the
// listener count grew without bound, triggering MaxListenersExceededWarning at
// daemon startup (51 listeners against the default cap of 50).
//
// Fix: the exit handler is captured as a named function; sm.destroy() removes
// it via process.removeListener(). project.js destroy() calls sm.destroy().
//
// Tests drive real production code from lib/sessions.js — no inline
// reimplementations (per AMoS code-craft rule: avoid tautological tests).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-daca-"));
}

// Each makeSessionManager call busts the require cache so a fresh
// createSessionManager module is loaded for each test. This matches the
// isolation pattern used in session-lifecycle-lr-e0de.test.js.
function makeSessionManager(tmpHome) {
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
    send: function () {},
    sendTo: function () {},
    sendEach: function () {},
  });
}

// ---------------------------------------------------------------------------
// Test 1: sm.destroy() removes the exit listener (listener count drops back).
// ---------------------------------------------------------------------------
test("lr-daca: sm.destroy() removes the exit listener registered by createSessionManager", function () {
  var tmpHome = makeTempHome();
  try {
    var before = process.listenerCount("exit");
    var sm = makeSessionManager(tmpHome);
    var after = process.listenerCount("exit");
    assert.equal(after, before + 1, "createSessionManager must register exactly one exit listener");

    sm.destroy();
    var afterDestroy = process.listenerCount("exit");
    assert.equal(afterDestroy, before, "sm.destroy() must remove the exit listener");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: N project opens then N destroys leaves listener count unchanged.
// Simulates the actual daemon lifecycle where projects are added and removed.
// ---------------------------------------------------------------------------
test("lr-daca: listener count stays bounded across N project open/destroy cycles", function () {
  var N = 10;
  var baseline = process.listenerCount("exit");
  var managers = [];
  var homes = [];

  for (var i = 0; i < N; i++) {
    var tmpHome = makeTempHome();
    homes.push(tmpHome);
    managers.push(makeSessionManager(tmpHome));
  }

  // After opening N projects, count is baseline + N.
  var peakCount = process.listenerCount("exit");
  assert.equal(peakCount, baseline + N, "N open projects must add N listeners");

  // Destroy all.
  managers.forEach(function (sm) { sm.destroy(); });
  homes.forEach(function (h) { fs.rmSync(h, { recursive: true, force: true }); });

  var finalCount = process.listenerCount("exit");
  assert.equal(finalCount, baseline, "all listeners must be removed after destroy");
});

// ---------------------------------------------------------------------------
// Test 3: sm.destroy() is idempotent — calling it twice does not throw and
// does not undercount below baseline (removeListener on an absent handler
// is a safe no-op in Node.js, but the count should never go negative).
// ---------------------------------------------------------------------------
test("lr-daca: sm.destroy() is idempotent — double-destroy does not throw or under-count", function () {
  var tmpHome = makeTempHome();
  try {
    var baseline = process.listenerCount("exit");
    var sm = makeSessionManager(tmpHome);
    sm.destroy();
    assert.doesNotThrow(function () { sm.destroy(); }, "second destroy must not throw");
    var afterDouble = process.listenerCount("exit");
    assert.ok(afterDouble >= baseline,
      "listener count must not drop below baseline after double destroy; got " + afterDouble);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4: flush behavior is preserved — exit handler still drains write
// buffers before being deregistered. The handler must write buffered lines to
// disk when 'exit' fires. We verify this via the file on disk; the internal
// _writeBuffers map is a private closure variable and cannot be inspected
// directly from test code (correctly encapsulated).
// ---------------------------------------------------------------------------
test("lr-daca: exit handler flushes session write buffers when process exits", function (t, done) {
  var tmpHome = makeTempHome();
  var sm = makeSessionManager(tmpHome);
  var sess = sm.createSessionRaw({});
  sess.cliSessionId = "lr-daca-flush-check";

  // Queue records into the async buffer without an explicit save.
  // sendAndRecord routes through appendToSessionFile which pushes to the
  // module-level _writeBuffers[session.localId] buffer.
  sm.sendAndRecord(sess, { type: "human", text: "flush-test-a" });
  sm.sendAndRecord(sess, { type: "human", text: "flush-test-b" });

  // Simulate process exit — the registered exit handler must drain the buffer
  // synchronously. process.emit('exit') is synchronous; the handler runs inline.
  process.emit("exit", 0);

  // The session file must exist and contain the flushed records.
  // If the exit handler is absent or broken, the file either won't exist
  // or won't contain the queued records (they were only in the in-memory buffer).
  var sessionsBase = path.join(tmpHome, "console", "sessions");
  var sessionFile = null;
  if (fs.existsSync(sessionsBase)) {
    fs.readdirSync(sessionsBase).forEach(function (dir) {
      var candidate = path.join(sessionsBase, dir, "lr-daca-flush-check.jsonl");
      if (fs.existsSync(candidate)) sessionFile = candidate;
    });
  }
  assert.ok(sessionFile, "session file must exist after exit flush");

  var lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
  // Expect exactly the two records we queued (no meta line since we only used
  // appendToSessionFile via sendAndRecord, not saveSessionFile).
  assert.ok(lines.length >= 2, "exit handler must have flushed at least 2 buffered lines; got " + lines.length);

  sm.destroy();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  done();
});
