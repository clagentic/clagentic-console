"use strict";
/**
 * Operator-set per-session keep-alive: the idle reaper skips a pinned session,
 * unpinning restores reaping, memory shedding still reclaims a pinned session
 * with its notice, the pin survives a daemon restart, and a vendor compaction
 * leaves a visible notice without moving the idle clock.
 *
 * Drives the real bridge, session manager, memory shedder, adapter flattening
 * and message processor.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { shedMemory, _resetRateLimitForTest } = require("../lib/memory-shed");
var { _test_flattenEvent: flattenEvent } = require("../lib/yoke/adapters/claude");

var TICK_MS = 60 * 1000;

function freshSdkBridge() {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  return require("../lib/sdk-bridge");
}

function makeSm() {
  return {
    sessions: new Map(),
    currentModel: null,
    currentPermissionMode: null,
    currentEffort: null,
    currentBetas: [],
    modelsByVendor: {},
    availableVendors: [],
    installedVendors: [],
    defaultVendor: "claude",
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    getActiveSession: function () { return null; },
    setSlashCommandsForVendor: function () {},
    sendAndRecord: function () {},
    sendToSession: function () {},
    notifications: null,
  };
}

function makeIdleSession(localId, overrides) {
  var closed = { value: false };
  return Object.assign({
    localId: localId,
    queryInstance: { close: function () { closed.value = true; } },
    messageQueue: null,
    isProcessing: false,
    singleTurn: false,
    destroying: false,
    lastActivityAt: Date.now() - 40 * 60 * 1000,
    history: [],
    _closed: closed,
  }, overrides || {});
}

function makeBridge(sm) {
  return freshSdkBridge().createSDKBridge({
    cwd: "/tmp",
    slug: "proj",
    sessionManager: sm,
    send: function () {},
    adapter: { vendor: "claude" },
    adapters: {},
  });
}

test("a pinned session idle past the timeout is not reaped; unpinning restores reaping", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sm = makeSm();
    var bridge = makeBridge(sm);
    var pinned = makeIdleSession(1, { keepAlive: true });
    var unpinned = makeIdleSession(2);
    sm.sessions.set(1, pinned);
    sm.sessions.set(2, unpinned);

    bridge.startIdleReaper();
    t.mock.timers.tick(TICK_MS * 90); // three times the idle timeout
    assert.equal(pinned._closed.value, false, "a pinned session must outlive the idle timeout");
    assert.equal(unpinned._closed.value, true, "an unpinned idle session is still reaped");

    pinned.keepAlive = false;
    t.mock.timers.tick(TICK_MS * 2);
    assert.equal(pinned._closed.value, true, "unpinning makes the session reapable again");
    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr605a66-"));
}

function makeSessionManager(tmpHome) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
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

function persistedSession(sm, suffix, extra) {
  var s = sm.createSessionRaw({});
  s.cliSessionId = "sess-" + suffix;
  s.history = [{ type: "user_message", text: "hi-" + suffix }];
  s._historyLoaded = true;
  Object.assign(s, extra || {});
  sm.saveSessionFile(s);
  sm.loadSessionHistory(s);
  return s;
}

function findByCliId(sm, cliId) {
  var found = null;
  sm.sessions.forEach(function (s) { if (s.cliSessionId === cliId) found = s; });
  return found;
}

test("the pin is written to session meta and restored by a fresh session manager", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var s = persistedSession(sm, "pin");
    assert.deepEqual(sm.setSessionKeepAlive(s.localId, true), { ok: true });

    var restarted = makeSessionManager(tmpHome);
    var reloaded = findByCliId(restarted, "sess-pin");
    assert.ok(reloaded, "session must exist after restart");
    assert.equal(reloaded.keepAlive, true, "the pin must survive a daemon restart");

    restarted.setSessionKeepAlive(reloaded.localId, false);
    var again = findByCliId(makeSessionManager(tmpHome), "sess-pin");
    assert.equal(again.keepAlive, false, "an unpin must be persisted too");
    assert.equal(sm.setSessionKeepAlive(9999, true).error, "Session not found");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("memory shedding still reclaims a pinned session with a live agent and tells the operator", function () {
  _resetRateLimitForTest();
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var s = persistedSession(sm, "shed", { keepAlive: true, activeTaskToolIds: { "task-1": true } });
    sm.saveSessionFile(s);
    sm.LRU_HISTORY_LIMIT = 0;

    var diagnostics = [];
    var result = shedMemory({ projects: [{ slug: "p", sm: sm, send: function (o) { diagnostics.push(o); } }] });

    assert.equal(result.liveChildReclaimed, 1, "the pin is not a memory-shed exemption");
    assert.equal(s._historyLoaded, false);
    assert.equal(s.keepAlive, true, "shedding does not unpin");
    assert.equal(diagnostics.filter(function (d) { return d.source === "memory-reclaim"; }).length, 1);
    sm.loadSessionHistory(s);
    var notices = s.history.filter(function (h) { return h.type === "error" && /memory pressure/i.test(h.text); });
    assert.equal(notices.length, 1, "the reclaim notice is recorded in the session");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("memory shedding evicts a pinned session with no live agent", function () {
  _resetRateLimitForTest();
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var s = persistedSession(sm, "plainpin", { keepAlive: true });
    sm.LRU_HISTORY_LIMIT = 0;
    shedMemory({ projects: [{ slug: "p", sm: sm, send: function () {} }] });
    assert.equal(s._historyLoaded, false);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("a compact_boundary system event becomes a recorded notice and does not move the idle clock", async function () {
  var parsed = flattenEvent({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 214000, post_tokens: 31000, duration_ms: 9000 },
  });
  assert.equal(parsed.yokeType, "compact_boundary");
  assert.equal(parsed.trigger, "auto");
  assert.equal(parsed.preTokens, 214000);
  assert.equal(parsed.postTokens, 31000);

  var { attachMessageProcessor } = await import("../lib/sdk-message-processor.js");
  var recorded = [];
  var sm = {
    skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null,
    currentModel: null, _savedDefaultModel: null,
    sendAndRecord: function (session, obj) { recorded.push(obj); },
    sendToSession: function () {},
    saveSessionFile: function () {}, broadcastSessionList: function () {},
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
  };
  var processor = attachMessageProcessor({
    sm: sm, send: function () {}, slug: "test-slug", cwd: "/tmp", pushModule: null,
    getNotificationsModule: function () { return null; },
    adapter: { vendor: "claude" },
    onProcessingChanged: function () {}, onTurnDone: null, onAutoTitle: null,
    opts: {},
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
    discoverWorkflows: function () { return []; },
    discoverSkillsWithMeta: function () { return []; },
    mergeSkillsWithMeta: function () { return []; },
    getSDK: null,
  });
  var before = Date.now() - 45 * 60 * 1000;
  var session = {
    localId: "s1", cliSessionId: null, vendor: "claude", history: [],
    messageUUIDs: [], blocks: {}, sentToolResults: {}, pendingPermissions: {},
    pendingElicitations: {}, pendingAskUser: {}, activeTaskToolIds: {},
    taskIdMap: {}, streamedText: false, responsePreview: "", isProcessing: false,
    loop: null, lastActivityAt: before,
  };

  processor.processSDKMessage(session, parsed);

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, "system_info");
  assert.equal(recorded[0].text, "Context compacted (automatic): 214k to 31k tokens.");
  assert.equal(session.lastActivityAt, before, "a compaction is not session activity");
});
