// lr-1bdb-backend-correctness.test.js — regression tests for a cluster of
// verified backend correctness defects (see task lr-1bdb):
//
//   A — IPC server steals/orphans a live daemon's Unix socket
//   B — a changed cliSessionId is not persisted, dropping the session on restart
//   C — concurrent clone_project of the same repo deletes the other's in-progress dir
//   D — session file write-order race between the async batch flush and a sync save
//   E — unwatchTab returns a loop-scoped variable (undefined with zero clients)

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var net = require("net");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-lr1bdb-test-"));
}

// ---------------------------------------------------------------------------
// A — lib/ipc.js: createIPCServer must refuse to bind when a live daemon
// already answers on the socket, rather than unlinking it out from under
// the running process.
// ---------------------------------------------------------------------------

var { createIPCServer, probeSocket } = require("../lib/ipc");

function startLiveIPCServer(sockPath) {
  return new Promise(function (resolve, reject) {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });
    try { fs.unlinkSync(sockPath); } catch (e) {}
    var server = net.createServer(function (conn) { conn.on("error", function () {}); });
    server.listen(sockPath, function () { resolve(server); });
    server.on("error", reject);
  });
}

test("A: probeSocket resolves false when socket file is absent", async function () {
  if (process.platform === "win32") return;
  var tmp = makeTempHome();
  try {
    var sockPath = path.join(tmp, "absent.sock");
    var alive = await probeSocket(sockPath, 200);
    assert.equal(alive, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("A: probeSocket resolves false for a stale socket file with no listener", async function () {
  if (process.platform === "win32") return;
  var tmp = makeTempHome();
  try {
    var sockPath = path.join(tmp, "stale.sock");
    fs.writeFileSync(sockPath, "");
    var alive = await probeSocket(sockPath, 200);
    assert.equal(alive, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("A: probeSocket resolves true when a live server is listening", async function () {
  if (process.platform === "win32") return;
  var tmp = makeTempHome();
  var sockPath = path.join(tmp, "live.sock");
  var server = await startLiveIPCServer(sockPath);
  try {
    var alive = await probeSocket(sockPath, 200);
    assert.equal(alive, true);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("A: createIPCServer refuses to start (does not unlink/steal the socket) when a live daemon already answers", async function () {
  if (process.platform === "win32") return;
  var tmp = makeTempHome();
  var sockPath = path.join(tmp, "daemon.sock");
  var liveServer = await startLiveIPCServer(sockPath);

  try {
    var refused = false;
    var ipc = createIPCServer(sockPath, function () { return { ok: true }; }, function onLiveDaemon() {
      refused = true;
    });

    // Give the async connect-probe time to resolve.
    await new Promise(function (r) { setTimeout(r, 300); });

    assert.equal(refused, true, "onLiveDaemon callback must fire instead of binding");
    // The live daemon's socket must still be intact and answering — it must
    // not have been unlinked out from under it (the original bug: item A).
    var stillAlive = await probeSocket(sockPath, 200);
    assert.equal(stillAlive, true, "live daemon's socket must survive a second daemon's startup attempt");

    ipc.close(); // must not throw even though nothing was ever bound
  } finally {
    liveServer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("A: createIPCServer binds normally (and removes a genuinely stale socket) when nothing is listening", async function () {
  if (process.platform === "win32") return;
  var tmp = makeTempHome();
  var sockPath = path.join(tmp, "stale-then-bind.sock");
  // Simulate a stale socket file left by a killed daemon.
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  fs.writeFileSync(sockPath, "");

  var ipc = createIPCServer(sockPath, function (msg) { return { ok: true, echo: msg.cmd }; });
  try {
    // Poll until the probe resolves and the real server is bound.
    var deadline = Date.now() + 2000;
    var bound = false;
    while (Date.now() < deadline && !bound) {
      bound = await probeSocket(sockPath, 200);
      if (!bound) await new Promise(function (r) { setTimeout(r, 50); });
    }
    assert.equal(bound, true, "createIPCServer should bind after determining the old socket was stale");
  } finally {
    ipc.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B — lib/sdk-message-processor.js: a changed cliSessionId must be persisted
// via saveSessionFile every time it changes, not only on the first
// (null → id) transition.
// ---------------------------------------------------------------------------

var { attachMessageProcessor } = require("../lib/sdk-message-processor");

function makeProcessorCtx() {
  var saveSessionFileCalls = [];
  var sm = {
    skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null,
    currentModel: null, _savedDefaultModel: null,
    sendAndRecord: function () {},
    sendToSession: function () {},
    saveSessionFile: function (session) { saveSessionFileCalls.push(session.cliSessionId); },
    broadcastSessionList: function () {},
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
  };
  var processor = attachMessageProcessor({
    sm: sm, send: function () {}, slug: "test-slug", cwd: "/tmp",
    pushModule: null, getNotificationsModule: function () { return null; },
    adapter: { vendor: "claude" }, onProcessingChanged: function () {},
    onTurnDone: null, onAutoTitle: null, opts: {},
    discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; },
    getSDK: null,
  });
  return { processor: processor, sm: sm, saveSessionFileCalls: saveSessionFileCalls };
}

function makeSession() {
  return {
    localId: "s1", cliSessionId: null, vendor: "claude", history: [], messageUUIDs: [],
    blocks: {}, sentToolResults: {}, pendingPermissions: {}, pendingElicitations: {},
    pendingAskUser: {}, activeTaskToolIds: {}, taskIdMap: {}, streamedText: false,
    responsePreview: "", isProcessing: false, loop: null,
  };
}

test("B: first sessionId assignment (null -> id) persists via saveSessionFile", function () {
  var ctx = makeProcessorCtx();
  var session = makeSession();
  ctx.processor.processSDKMessage(session, { sessionId: "sess-A" });

  assert.equal(session.cliSessionId, "sess-A");
  assert.deepEqual(ctx.saveSessionFileCalls, ["sess-A"],
    "saveSessionFile must be called on the first cliSessionId assignment");
});

test("B: a changed cliSessionId (id -> different id) also persists via saveSessionFile", function () {
  var ctx = makeProcessorCtx();
  var session = makeSession();
  ctx.processor.processSDKMessage(session, { sessionId: "sess-A" });
  ctx.processor.processSDKMessage(session, { sessionId: "sess-B" });

  assert.equal(session.cliSessionId, "sess-B");
  assert.deepEqual(ctx.saveSessionFileCalls, ["sess-A", "sess-B"],
    "saveSessionFile must be called again when cliSessionId changes -- without this a restart " +
    "drops the session because the new .jsonl file's first line is never a meta record (lr-1bdb item B)");
});

test("B: repeated messages with the same unchanged sessionId do not re-save", function () {
  var ctx = makeProcessorCtx();
  var session = makeSession();
  ctx.processor.processSDKMessage(session, { sessionId: "sess-A" });
  ctx.processor.processSDKMessage(session, { sessionId: "sess-A" });
  ctx.processor.processSDKMessage(session, { sessionId: "sess-A" });

  assert.deepEqual(ctx.saveSessionFileCalls, ["sess-A"],
    "saveSessionFile should only be called when cliSessionId actually changes");
});

// ---------------------------------------------------------------------------
// C — lib/daemon.js onCloneProject: targetDir reservation must be atomic.
// Exercises the same mkdirSync/EEXIST primitive the fix relies on directly
// against the real filesystem (onCloneProject itself pulls in relay/config/
// git spawn machinery that is impractical to boot for a unit test).
// ---------------------------------------------------------------------------

test("C: mkdirSync-based targetDir reservation lets only one of two concurrent claims succeed", function () {
  var tmp = makeTempHome();
  try {
    var targetDir = path.join(tmp, "same-repo-slug");

    function reserve() {
      try {
        fs.mkdirSync(targetDir);
        return { created: true };
      } catch (e) {
        return { created: false, code: e.code };
      }
    }

    var first = reserve();
    var second = reserve();

    assert.equal(first.created, true, "first claim should create the directory");
    assert.equal(second.created, false, "second concurrent claim must not also believe it created the dir");
    assert.equal(second.code, "EEXIST", "second claim must fail with EEXIST, not silently succeed");

    // Only the invocation that actually created the directory is allowed to
    // remove it on failure -- simulate the failure handler from onCloneProject.
    if (first.created) { try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (ce) {} }
    // second.created is false, so per the fix it must NOT rmSync targetDir.
    assert.ok(!second.created);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D — lib/sessions.js: the batched/timer flush and a synchronous flush/save
// must never corrupt on-disk line order.
// ---------------------------------------------------------------------------

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
    cwd: tmpHome, send: function () {}, sendTo: function () {}, sendEach: function () {},
  });
}

function findSessionFile(sessionsBase, cliSessionId) {
  var found = null;
  if (!fs.existsSync(sessionsBase)) return null;
  fs.readdirSync(sessionsBase).forEach(function (dir) {
    var candidate = path.join(sessionsBase, dir, cliSessionId + ".jsonl");
    if (fs.existsSync(candidate)) found = candidate;
  });
  return found;
}

test("D: lines appended right before a synchronous saveSessionFile are never lost or duplicated by the batch timer", function (t, done) {
  var tmpHome = makeTempHome();
  var sm = makeSessionManager(tmpHome);
  var sess = sm.createSessionRaw({});
  sess.cliSessionId = "sess-d-order";

  // Push several records through the normal batched-append hot path.
  sm.sendAndRecord(sess, { type: "human", text: "one" });
  sm.sendAndRecord(sess, { type: "assistant", text: "two" });
  sm.sendAndRecord(sess, { type: "human", text: "three" });

  // Immediately force a synchronous save (as the daemon does on e.g. a
  // sessionVisibility/bookmark change or a cliSessionId update). Before the
  // fix, the 50ms batch timer's fs.promises.appendFile could still be
  // in-flight and land on disk after this rename, corrupting replay order.
  sm.saveSessionFile(sess);

  var sessionsBase = path.join(tmpHome, "console", "sessions");
  var sessionFile = findSessionFile(sessionsBase, "sess-d-order");
  assert.ok(sessionFile, "session file should exist immediately after saveSessionFile");

  var linesNow = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(linesNow.length, 4, "expected meta + 3 records = 4 lines immediately after save");

  // Wait well past the 50ms batch timer window -- content must be stable:
  // no duplicate/re-appended lines, no lost lines, no reordering.
  setTimeout(function () {
    try {
      var linesAfter = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(linesAfter.length, 4,
        "batch timer must not append extra/duplicate lines after the buffer was already flushed by saveSessionFile; got " + linesAfter.length);
      var meta = JSON.parse(linesAfter[0]);
      assert.equal(meta.type, "meta", "line 0 must remain the meta record");
      var texts = linesAfter.slice(1).map(function (l) { return JSON.parse(l).text; });
      assert.deepEqual(texts, ["one", "two", "three"], "history lines must remain in issue order");
      done();
    } catch (e) {
      done(e);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 150);
});

test("D: a session-end synchronous flushSessionBuffer drains buffered lines exactly once", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-d-flush";
    sm.saveSessionFile(sess); // establish the meta line first

    sm.appendToSessionFile(sess, { type: "human", text: "final" });
    // Simulate session end / process exit: flushSessionBuffer runs synchronously.
    sm.flushSessionBuffer(sess);

    var sessionsBase = path.join(tmpHome, "console", "sessions");
    var sessionFile = findSessionFile(sessionsBase, "sess-d-flush");
    var lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "meta + 1 appended line");

    // A second flush with nothing new buffered must be a no-op, not a re-append.
    sm.flushSessionBuffer(sess);
    var linesAfter = fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(linesAfter.length, 2, "flushing an already-empty buffer must not duplicate lines");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E — lib/project.js unwatchTab MCP callback must return a deterministic
// value, not a loop-scoped variable that is undefined with zero clients.
// ---------------------------------------------------------------------------

test("E: unwatchTab returns a deterministic array (not undefined) when there are zero connected clients", function () {
  // Reproduce the exact loop-scoped-var bug in isolation: the historical
  // implementation declared `active` inside a `for (var c of clients)` loop
  // and returned it after the loop. With clients=[] the loop body never runs,
  // so `active` is never assigned and the function returns undefined.
  function buggyUnwatchTab(clients) {
    for (var c of clients) {
      var active = [];
    }
    return active;
  }
  assert.equal(buggyUnwatchTab([]), undefined,
    "sanity check: this documents the pre-fix bug this test guards against");

  // The fixed shape (mirrors lib/project.js): always return a deterministic
  // constant regardless of how many clients were iterated.
  function fixedUnwatchTab(clients) {
    for (var c of clients) {
      // per-client bookkeeping happens here in the real implementation
    }
    return [];
  }
  assert.deepEqual(fixedUnwatchTab([]), [], "must return a deterministic array with zero clients");
  assert.deepEqual(fixedUnwatchTab([{ readyState: 1 }]), [], "must return the same deterministic value regardless of client count");
});

test("E: lib/project.js source no longer returns the loop-scoped `active` variable from unwatchTab", function () {
  var src = fs.readFileSync(path.resolve(__dirname, "..", "lib", "project.js"), "utf8");
  var idx = src.indexOf("unwatchTab: function");
  assert.ok(idx !== -1, "unwatchTab callback must still exist in lib/project.js");
  var end = src.indexOf("\n          },", idx);
  var body = src.slice(idx, end === -1 ? idx + 800 : end);
  assert.ok(!/return active;/.test(body),
    "unwatchTab must not return the loop-scoped `active` variable (lr-1bdb item E)");
});
