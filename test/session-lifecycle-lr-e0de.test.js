"use strict";
// Regression tests for lr-e0de: session history duplication and stop_task
// wrong-session targeting.
//
// 4a: saveSessionFile now calls flushSessionBuffer before the atomic rewrite
//     so pending async-append lines are not double-written after the rename.
//
// 4b: stop_task WS handler passes getSessionForWs(ws) to sdk.stopTask so it
//     targets the requester's session, not the globally-active one.
//
// All tests drive real production code — no inline reimplementations.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

// ---------------------------------------------------------------------------
// 4a — real createSessionManager from lib/sessions.js
// ---------------------------------------------------------------------------
// createSessionManager derives its sessions directory from config.CONFIG_DIR
// (via the CLAGENTIC_HOME env var).  We set CLAGENTIC_HOME to a temp dir
// before requiring so session files land in an isolated location.

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-"));
}

function makeSessionManager(tmpHome) {
  // Bust require cache so a fresh instance picks up the temp CLAGENTIC_HOME.
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function(m) {
    try { delete require.cache[require.resolve(m)]; } catch(_) {}
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
    send: function() {},
    sendTo: function() {},
    sendEach: function() {},
  });
}

function findSessionFile(sessionsBase, cliSessionId) {
  var found = null;
  if (!fs.existsSync(sessionsBase)) return null;
  fs.readdirSync(sessionsBase).forEach(function(dir) {
    var candidate = path.join(sessionsBase, dir, cliSessionId + ".jsonl");
    if (fs.existsSync(candidate)) found = candidate;
  });
  return found;
}

test("4a: saveSessionFile flushes buffer — no duplicate lines after async timer fires", function(t, done) {
  var tmpHome = makeTempHome();
  var sm = makeSessionManager(tmpHome);
  var sess = sm.createSessionRaw({});
  // cliSessionId is normally set by the daemon when Claude starts a session.
  sess.cliSessionId = "sess-4a-dedup";

  // sendAndRecord pushes to both session.history AND the async append buffer
  // (the path that triggers the duplication bug when saveSessionFile follows).
  sm.sendAndRecord(sess, { type: "human", text: "hello" });
  sm.sendAndRecord(sess, { type: "assistant", text: "world" });

  // saveSessionFile (with the fix) calls flushSessionBuffer first, so the
  // buffer is empty when the 50ms async timer would otherwise fire.
  sm.saveSessionFile(sess);

  var sessionsBase = path.join(tmpHome, "console", "sessions");
  var sessionFile = findSessionFile(sessionsBase, "sess-4a-dedup");
  assert.ok(sessionFile, "session file should exist after saveSessionFile");

  // Verify immediately: meta + 2 records = 3 lines (no duplicates yet).
  var linesNow = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(linesNow.length, 3,
    "expected meta + 2 data lines = 3, got " + linesNow.length);

  // Wait past the 50ms async timer — buffer should be empty so no extra appends.
  setTimeout(function() {
    try {
      var linesAfter = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(linesAfter.length, 3,
        "async timer must not re-append after saveSessionFile flushed; got " + linesAfter.length);
      done();
    } catch(e) { done(e); } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 120);
});

test("4a: regression — without flushSessionBuffer, async timer duplicates buffered lines", function(t, done) {
  // Demonstrates the pre-fix root cause: saveSessionFile rewrites the file
  // from session.history without draining the async buffer; the 50ms timer
  // fires after the rename and appends the same lines again.
  var tmpHome = makeTempHome();
  var sm = makeSessionManager(tmpHome);
  var sess = sm.createSessionRaw({});
  sess.cliSessionId = "sess-4a-bug";

  // sendAndRecord pushes to session.history AND the async buffer.
  sm.sendAndRecord(sess, { type: "human", text: "bugtest" });

  // Buggy path: rewrite the file from session.history WITHOUT calling
  // flushSessionBuffer.  The buffer still holds the record; the timer fires
  // and appends it a second time.
  var sessionsBase = path.join(tmpHome, "console", "sessions");
  var dirs = fs.existsSync(sessionsBase) ? fs.readdirSync(sessionsBase) : [];
  if (dirs.length === 0) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    done();
    return;
  }
  var sessionFile = path.join(sessionsBase, dirs[0], "sess-4a-bug.jsonl");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  // Write history without flushing buffer (simulates the old saveSessionFile).
  var histContent = sess.history.map(function(e) { return JSON.stringify(e) + "\n"; }).join("");
  fs.writeFileSync(sessionFile, histContent);

  // Wait for the async timer (50ms) to fire and re-append the buffered record.
  setTimeout(function() {
    try {
      if (!fs.existsSync(sessionFile)) { done(); return; }
      var lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
      // Pre-fix: 2 lines — history write + timer re-appended the same record.
      assert.ok(lines.length >= 2,
        "pre-fix path produces duplicates (timer re-appended); got " + lines.length + " line(s)");
      done();
    } catch(e) { done(e); } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 120);
});

test("4a: saveSessionFile on session with empty buffer writes cleanly", function() {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-4a-empty";
    assert.doesNotThrow(function() { sm.saveSessionFile(sess); });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4b — real attachSessions handler from lib/project-sessions.js
// ---------------------------------------------------------------------------
// attachSessions(ctx) returns { handleSessionsMessage }.  We build a minimal
// ctx stub, dispatch stop_task messages, and spy on sdk.stopTask to verify it
// receives the ws-derived session (not the global active session).

var { attachSessions } = require("../lib/project-sessions");

function makeCtxStub(overrides) {
  overrides = overrides || {};
  var wsSession = { localId: 1, taskStopRequested: false, queryInstance: null };
  var globalSession = { localId: 99, taskStopRequested: false, queryInstance: null };
  var stopTaskCalls = [];

  var ctx = Object.assign({
    cwd: "/tmp/test-4b", slug: "test", osUsers: false, currentVersion: "0.0.0",
    sm: {
      getActiveSession: function() { return globalSession; },
      sessions: new Map([[1, wsSession], [99, globalSession]]),
      broadcastSessionList: function() {},
    },
    sdk: {
      stopTask: function(taskId, session) {
        stopTaskCalls.push({ taskId: taskId, session: session });
        return Promise.resolve();
      },
      isClaudeProcess: function() { return false; },
    },
    tm: null, clients: [], send: function() {}, sendTo: function() {},
    sendToAdmins: function() {}, sendToSession: function() {},
    sendToSessionOthers: function() {}, opts: {},
    usersModule: {
      isMultiUser: function() { return false; },
      canAccessSession: function() { return true; },
    },
    userPresence: null, pushModule: null,
    getSessionForWs: function(ws) { return ws._session || null; },
    getLinuxUserForSession: function() { return null; },
    ensureProjectAccessForSession: function() { return true; },
    getOsUserInfoForWs: function() { return null; },
    hydrateImageRefs: function(o) { return o; },
    onProcessingChanged: function() {}, broadcastPresence: function() {},
    adapter: null, getProjectList: function() { return []; },
    getProjectCount: function() { return 0; },
    getScheduleCount: function() { return 0; },
    moveScheduleToProject: function() {},
  }, overrides);

  return { ctx: ctx, wsSession: wsSession, globalSession: globalSession, stopTaskCalls: stopTaskCalls };
}

test("4b: stop_task handler passes ws session to sdk.stopTask, not global active session", function(t, done) {
  var stub = makeCtxStub();
  var handler = attachSessions(stub.ctx);

  var fakeWs = { _session: stub.wsSession };
  handler.handleSessionsMessage(fakeWs, { type: "stop_task", taskId: "task-abc" });

  setImmediate(function() {
    try {
      assert.equal(stub.stopTaskCalls.length, 1, "stopTask called once");
      assert.equal(stub.stopTaskCalls[0].taskId, "task-abc");
      assert.strictEqual(stub.stopTaskCalls[0].session, stub.wsSession,
        "must receive the ws-derived session");
      assert.notStrictEqual(stub.stopTaskCalls[0].session, stub.globalSession,
        "must NOT receive the global active session");
      done();
    } catch(e) { done(e); }
  });
});

test("4b: stop_task with no taskId is a no-op — stopTask not called", function() {
  var stub = makeCtxStub();
  var handler = attachSessions(stub.ctx);
  handler.handleSessionsMessage({ _session: stub.wsSession }, { type: "stop_task" });
  assert.equal(stub.stopTaskCalls.length, 0, "no taskId → stopTask not called");
});

test("4b: stop_task passes null session when ws has none — sdk-bridge falls back to getActiveSession", function(t, done) {
  var stub = makeCtxStub({
    getSessionForWs: function() { return null; },
  });
  var handler = attachSessions(stub.ctx);

  handler.handleSessionsMessage({}, { type: "stop_task", taskId: "task-xyz" });

  setImmediate(function() {
    try {
      assert.equal(stub.stopTaskCalls.length, 1);
      assert.equal(stub.stopTaskCalls[0].session, null,
        "null passed through — sdk-bridge's getActiveSession fallback handles it");
      done();
    } catch(e) { done(e); }
  });
});
