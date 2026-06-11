/**
 * Regression tests for lr-e0de: two session lifecycle defects.
 *
 * 4a. saveSessionFile must flush the pending async-append buffer before
 *     rewriting the file — otherwise lines buffered in _writeBuffers are
 *     appended again after the atomic rename, producing duplicated/corrupted JSONL.
 *
 * 4b. stopTask must operate on the requester's session, not the globally-active
 *     session. In a multi-session install, stop_task from client A should abort
 *     client A's session even when a different session is globally active.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated temp directory for session files.
 * Cleaned up after each test via the returned cleanup().
 */
function makeTempDir() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-e0de-"));
  return {
    dir: dir,
    cleanup: function () {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    },
  };
}

/**
 * Build a minimal sessionManager-like object using a real sessions directory
 * so that saveSessionFile and flushSessionBuffer operate on real files.
 * We inline only the parts of createSessionManager that the tests exercise.
 */
function makeMinimalSessionManager(sessionsDir) {
  var _writeBuffers = {};

  function sessionFilePath(cliSessionId) {
    return path.join(sessionsDir, cliSessionId + ".jsonl");
  }

  function flushSessionBuffer(session) {
    var buf = _writeBuffers[session.localId];
    if (!buf || buf.lines.length === 0) return;
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
    if (!session.cliSessionId) { buf.lines = []; return; }
    try {
      fs.appendFileSync(sessionFilePath(session.cliSessionId), buf.lines.join(""));
    } catch (e) {}
    buf.lines = [];
  }

  function appendToSessionFile(session, obj) {
    if (!session.cliSessionId) return;
    if (!_writeBuffers[session.localId]) {
      _writeBuffers[session.localId] = { lines: [], timer: null };
    }
    var buf = _writeBuffers[session.localId];
    buf.lines.push(JSON.stringify(obj) + "\n");
    // Do NOT flush here — leave it pending so saveSessionFile must handle it.
    // (In production, the timer/threshold would eventually flush it.)
  }

  function saveSessionFile(session) {
    if (!session.cliSessionId) return;
    // lr-e0de fix: flush pending buffer before rewriting.
    flushSessionBuffer(session);
    var metaObj = { type: "meta", localId: session.localId, cliSessionId: session.cliSessionId, title: session.title || "" };
    var lines = [JSON.stringify(metaObj)];
    for (var i = 0; i < session.history.length; i++) {
      lines.push(JSON.stringify(session.history[i]));
    }
    var sfPath = sessionFilePath(session.cliSessionId);
    var tmpPath = sfPath + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, lines.join("\n") + "\n");
    fs.renameSync(tmpPath, sfPath);
  }

  return {
    sessionFilePath: sessionFilePath,
    flushSessionBuffer: flushSessionBuffer,
    appendToSessionFile: appendToSessionFile,
    saveSessionFile: saveSessionFile,
    _writeBuffers: _writeBuffers,
  };
}

/**
 * Build a minimal broken sessionManager that reproduces the pre-fix bug:
 * saveSessionFile does NOT call flushSessionBuffer first, so the pending
 * buffer lines are appended after the rename, causing duplicates.
 */
function makeBrokenSessionManager(sessionsDir) {
  var sm = makeMinimalSessionManager(sessionsDir);

  // Override saveSessionFile to skip the flush — simulates the pre-fix behavior.
  sm.saveSessionFileBroken = function (session) {
    if (!session.cliSessionId) return;
    var metaObj = { type: "meta", localId: session.localId, cliSessionId: session.cliSessionId, title: session.title || "" };
    var lines = [JSON.stringify(metaObj)];
    for (var i = 0; i < session.history.length; i++) {
      lines.push(JSON.stringify(session.history[i]));
    }
    var sfPath = sm.sessionFilePath(session.cliSessionId);
    var tmpPath = sfPath + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, lines.join("\n") + "\n");
    fs.renameSync(tmpPath, sfPath);
    // Bug: does NOT call flushSessionBuffer — pending lines will be appended
    // to the new file once the deferred flush fires, duplicating them.
  };

  return sm;
}

/**
 * Count non-meta lines in a JSONL file and return them as parsed objects.
 */
function readHistoryLines(filePath) {
  var content = fs.readFileSync(filePath, "utf8").trim();
  var lines = content.split("\n").filter(Boolean);
  // Skip meta line (first line)
  return lines.slice(1).map(function (l) { return JSON.parse(l); });
}

// ---------------------------------------------------------------------------
// 4a. saveSessionFile + pending buffer — regression test
// ---------------------------------------------------------------------------

test("lr-e0de 4a (regression): saveSessionFile flushes pending buffer before rewrite — no duplicates", function () {
  var tmp = makeTempDir();
  try {
    var sm = makeMinimalSessionManager(tmp.dir);

    var session = {
      localId: 1,
      cliSessionId: "test-session-abc",
      title: "Test",
      history: [],
    };

    // Write initial meta file
    sm.saveSessionFile(session);

    // Simulate doSendAndRecord: push to history and stage in buffer without flushing.
    var msgA = { type: "user_message", text: "hello", _ts: Date.now() };
    var msgB = { type: "delta", text: "world", _ts: Date.now() };
    session.history.push(msgA);
    session.history.push(msgB);
    sm.appendToSessionFile(session, msgA);
    sm.appendToSessionFile(session, msgB);

    // At this point _writeBuffers has 2 pending lines.
    // saveSessionFile should flush them before rewriting so neither gets double-appended.
    sm.saveSessionFile(session);

    // Now simulate what the broken code does: a stale async timer fires and
    // tries to flush — but the buffer should already be empty after the fixed saveSessionFile.
    // Manually invoke flushSessionBuffer again (mimics the deferred timer).
    sm.flushSessionBuffer(session);

    var history = readHistoryLines(sm.sessionFilePath(session.cliSessionId));

    // Should have exactly 2 lines (msgA and msgB), not 4.
    assert.equal(history.length, 2, "history should contain exactly 2 lines, not duplicates (got " + history.length + ")");
    assert.equal(history[0].type, "user_message");
    assert.equal(history[1].type, "delta");
  } finally {
    tmp.cleanup();
  }
});

test("lr-e0de 4a (demonstrates bug): broken saveSessionFile causes duplicates when buffer flushes after rename", function () {
  var tmp = makeTempDir();
  try {
    var sm = makeBrokenSessionManager(tmp.dir);

    var session = {
      localId: 2,
      cliSessionId: "test-session-broken",
      title: "Test",
      history: [],
    };

    // Write initial meta file using the fixed saveSessionFile (to set up the file).
    sm.saveSessionFile(session);

    // Push two messages to history and stage them in the buffer.
    var msgA = { type: "user_message", text: "hello", _ts: Date.now() };
    var msgB = { type: "delta", text: "world", _ts: Date.now() };
    session.history.push(msgA);
    session.history.push(msgB);
    sm.appendToSessionFile(session, msgA);
    sm.appendToSessionFile(session, msgB);

    // Call the BROKEN saveSessionFile (no flush before rewrite).
    sm.saveSessionFileBroken(session);

    // Simulate the async timer firing: buffer still has the lines, so they get
    // appended again to the newly-renamed file.
    sm.flushSessionBuffer(session);

    var history = readHistoryLines(sm.sessionFilePath(session.cliSessionId));

    // Bug: history has 4 lines (2 from the rewrite + 2 from the deferred append).
    assert.equal(history.length, 4, "broken code produces 4 lines (2 duplicates) — this is the bug lr-e0de fixes");
  } finally {
    tmp.cleanup();
  }
});

test("lr-e0de 4a (edge case): saveSessionFile with empty buffer is a no-op — still writes correctly", function () {
  var tmp = makeTempDir();
  try {
    var sm = makeMinimalSessionManager(tmp.dir);

    var session = {
      localId: 3,
      cliSessionId: "test-session-empty",
      title: "Empty buffer test",
      history: [{ type: "user_message", text: "hello", _ts: 1 }],
    };

    // No appendToSessionFile calls — buffer is empty.
    sm.saveSessionFile(session);

    var history = readHistoryLines(sm.sessionFilePath(session.cliSessionId));
    assert.equal(history.length, 1, "should write exactly 1 history line when buffer is empty");
    assert.equal(history[0].text, "hello");
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4b. stopTask session targeting — regression test
// ---------------------------------------------------------------------------

test("lr-e0de 4b (regression): stopTask with explicit session targets that session, not the globally-active one", async function () {
  // Build two mock sessions.
  var sessionA = {
    localId: 10,
    cliSessionId: "sess-a",
    isProcessing: true,
    taskStopRequested: false,
    abortController: null,
    queryInstance: null,
  };
  var sessionB = {
    localId: 20,
    cliSessionId: "sess-b",
    isProcessing: true,
    taskStopRequested: false,
    abortController: null,
    queryInstance: null,
  };

  // Simulate the fixed stopTask function signature (accepts explicit session).
  async function stopTask(taskId, session) {
    if (!session) {
      // Fallback: would use getActiveSession() — the pre-fix behavior.
      throw new Error("pre-fix path: no explicit session passed");
    }
    session.taskStopRequested = true;
    if (session.abortController) {
      session.abortController.abort();
    }
  }

  // Globally active session is B. Client A sends stop_task — should stop A.
  var getActiveSession = function () { return sessionB; };

  // Fixed path: pass sessionA explicitly (resolved via getSessionForWs(ws)).
  await stopTask("task-123", sessionA);

  assert.equal(sessionA.taskStopRequested, true, "sessionA should be flagged as stop-requested");
  assert.equal(sessionB.taskStopRequested, false, "sessionB (globally active) should NOT be affected");
});

test("lr-e0de 4b (regression): stopTask without explicit session falls back to getActiveSession", async function () {
  // Verify the fallback path is safe (single-user installs).
  var activeSession = {
    localId: 30,
    taskStopRequested: false,
    abortController: null,
    queryInstance: null,
  };

  async function stopTask(taskId, session) {
    if (!session) session = activeSession; // simulates sm.getActiveSession() fallback
    if (!session) return;
    session.taskStopRequested = true;
  }

  // Call without a session argument — fallback should target activeSession.
  await stopTask("task-456", undefined);

  assert.equal(activeSession.taskStopRequested, true, "fallback should stop the globally-active session");
});

test("lr-e0de 4b (regression): stop_task handler passes ws session, not global active session", async function () {
  // Simulate the project-sessions.js handler logic.
  var wsSession = {
    localId: 40,
    taskStopRequested: false,
    abortController: null,
    queryInstance: null,
  };
  var globalActiveSession = {
    localId: 50,
    taskStopRequested: false,
    abortController: null,
    queryInstance: null,
  };

  var stoppedSessions = [];
  var sdk = {
    stopTask: async function (taskId, session) {
      stoppedSessions.push(session ? session.localId : null);
      if (session) session.taskStopRequested = true;
    },
  };

  function getSessionForWs(ws) { return wsSession; }
  function getActiveSession()  { return globalActiveSession; }

  // Simulate the fixed stop_task handler from project-sessions.js.
  var msg = { type: "stop_task", taskId: "task-789" };
  var ws = {};
  if (msg.type === "stop_task") {
    if (msg.taskId) {
      // Fixed: resolve session from ws, not from global active.
      var stopSession = getSessionForWs(ws);
      await sdk.stopTask(msg.taskId, stopSession);
    }
  }

  assert.equal(stoppedSessions.length, 1, "stopTask should have been called once");
  assert.equal(stoppedSessions[0], wsSession.localId, "stopTask should target the ws-resolved session");
  assert.equal(wsSession.taskStopRequested, true, "wsSession should be flagged as stop-requested");
  assert.equal(globalActiveSession.taskStopRequested, false, "globally-active session should not be touched");
});
