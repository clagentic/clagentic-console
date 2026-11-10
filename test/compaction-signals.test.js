"use strict";
// Compaction signals: the compacting flag on the session list entry and its
// transitions, the trigger the vendor reports, the nearing-compaction state of
// the context meter, and the idleCompaction user setting.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { pathToFileURL } = require("url");

var COMPACTION_STATE_URL = pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "compaction-state.js")).href;

function makeProcessor(recorded, broadcasts) {
  var { attachMessageProcessor } = require("../lib/sdk-message-processor.js");
  var sm = {
    skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null,
    currentModel: null, _savedDefaultModel: null,
    sendAndRecord: function (session, obj) { recorded.push(obj); },
    sendToSession: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () { broadcasts.count++; },
    modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
  };
  return attachMessageProcessor({
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
}

function bareSession() {
  return {
    localId: "s1", cliSessionId: null, vendor: "claude", history: [],
    messageUUIDs: [], blocks: {}, sentToolResults: {}, pendingPermissions: {},
    pendingElicitations: {}, pendingAskUser: {}, activeTaskToolIds: {},
    taskIdMap: {}, streamedText: false, responsePreview: "", isProcessing: false,
    loop: null, lastActivityAt: 0,
  };
}

test("compacting is sent on and off, and the session list is rebroadcast on each change", function () {
  var recorded = [];
  var broadcasts = { count: 0 };
  var processor = makeProcessor(recorded, broadcasts);
  var session = bareSession();

  processor.processSDKMessage(session, { yokeType: "status", status: "compacting" });
  assert.deepEqual(recorded, [{ type: "compacting", active: true }]);
  assert.equal(session.compacting, true);
  assert.equal(broadcasts.count, 1);

  processor.processSDKMessage(session, { yokeType: "status", status: "compacting" });
  assert.equal(broadcasts.count, 1, "a repeated status is not a change");

  processor.processSDKMessage(session, { yokeType: "status", status: null });
  assert.deepEqual(recorded[recorded.length - 1], { type: "compacting", active: false });
  assert.equal(session.compacting, false);
  assert.equal(broadcasts.count, 2);
});

test("the session list entry carries the compacting flag", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-list-"));
  try {
    ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
    var previous = process.env.CLAGENTIC_CONSOLE_HOME;
    process.env.CLAGENTIC_CONSOLE_HOME = home;
    var sessionsModule;
    try { sessionsModule = require("../lib/sessions"); } finally {
      if (previous === undefined) delete process.env.CLAGENTIC_CONSOLE_HOME; else process.env.CLAGENTIC_CONSOLE_HOME = previous;
    }
    var sm = sessionsModule.createSessionManager({ cwd: home, send: function () {}, sendTo: function () {}, sendEach: function () {} });
    var s = sm.createSessionRaw({});
    assert.equal(sm.mapSessionForClient(s).compacting, false);
    s.compacting = true;
    assert.equal(sm.mapSessionForClient(s).compacting, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the compaction notice names only the trigger the vendor reported", function () {
  var cases = [
    [{ trigger: "manual" }, "Context compacted (manual)."],
    [{ trigger: "auto" }, "Context compacted (automatic)."],
    [{ trigger: "idle" }, "Context compacted."],
    [{}, "Context compacted."],
  ];
  cases.forEach(function (c) {
    var recorded = [];
    var processor = makeProcessor(recorded, { count: 0 });
    processor.processSDKMessage(bareSession(), Object.assign({ yokeType: "compact_boundary" }, c[0]));
    assert.equal(recorded[0].text, c[1]);
  });
});

test("nearing compaction: below margin, within margin, past it, auto off, fields absent", async function () {
  var { isNearingCompaction } = await import(COMPACTION_STATE_URL);
  var base = { isAutoCompactEnabled: true, autoCompactThreshold: 100000 };
  assert.equal(isNearingCompaction(Object.assign({ totalTokens: 50000 }, base)), false);
  assert.equal(isNearingCompaction(Object.assign({ totalTokens: 89999 }, base)), false);
  assert.equal(isNearingCompaction(Object.assign({ totalTokens: 90000 }, base)), true);
  assert.equal(isNearingCompaction(Object.assign({ totalTokens: 120000 }, base)), true);
  assert.equal(isNearingCompaction({ totalTokens: 95000, isAutoCompactEnabled: false, autoCompactThreshold: 100000 }), false);
  assert.equal(isNearingCompaction({ totalTokens: 95000, isAutoCompactEnabled: true }), false);
  assert.equal(isNearingCompaction({ totalTokens: 95000, autoCompactThreshold: 100000 }), false);
  assert.equal(isNearingCompaction({ isAutoCompactEnabled: true, autoCompactThreshold: 100000 }), false);
  assert.equal(isNearingCompaction({ totalTokens: 95000, isAutoCompactEnabled: true, autoCompactThreshold: 0 }), false);
  assert.equal(isNearingCompaction(null), false);
});

test("the active session's compacting state is read from the session list", async function () {
  var { compactingFromSessionList } = await import(COMPACTION_STATE_URL);
  var list = [{ id: 1, compacting: true }, { id: 2 }];
  assert.deepEqual(compactingFromSessionList(list, 1), { found: true, compacting: true });
  assert.deepEqual(compactingFromSessionList(list, 2), { found: true, compacting: false });
  assert.deepEqual(compactingFromSessionList(list, 3), { found: false, compacting: false });
});

// --- idleCompaction setting ---

var idle = require("../lib/idle-compaction-setting");

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "idle-compaction-")); }

test("idleCompaction: off then default keeps every other key and removes the key", function () {
  var dir = tmpDir();
  try {
    var file = path.join(dir, "settings.json");
    var original = { env: { A: "1" }, permissions: { allow: ["x"] }, model: "m" };
    fs.writeFileSync(file, JSON.stringify(original), { mode: 0o640 });
    fs.chmodSync(file, 0o640);

    assert.deepEqual(idle.readSetting(file), { ok: true, value: "default" });
    assert.deepEqual(idle.writeSetting(file, "off"), { ok: true, value: "off" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), Object.assign({ idleCompaction: false }, original));
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, "mode kept");
    assert.deepEqual(idle.readSetting(file), { ok: true, value: "off" });

    assert.deepEqual(idle.writeSetting(file, "default"), { ok: true, value: "default" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
    assert.deepEqual(fs.readdirSync(dir), ["settings.json"], "no temp file left behind");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("idleCompaction: never writes true, and rejects any other value", function () {
  var dir = tmpDir();
  try {
    var file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{}");
    assert.equal(idle.writeSetting(file, "on").ok, false);
    assert.equal(idle.writeSetting(file, true).ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), "{}");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("idleCompaction: a missing file reads as the default and off creates it", function () {
  var dir = tmpDir();
  try {
    var file = path.join(dir, ".claude", "settings.json");
    assert.deepEqual(idle.readSetting(file), { ok: true, value: "default" });
    assert.deepEqual(idle.writeSetting(file, "default"), { ok: true, value: "default" });
    assert.equal(fs.existsSync(file), false, "default on a missing file writes nothing");
    assert.deepEqual(idle.writeSetting(file, "off"), { ok: true, value: "off" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { idleCompaction: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("idleCompaction: an unreadable file is reported and never overwritten", function () {
  var dir = tmpDir();
  try {
    var file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{ not json");
    var read = idle.readSetting(file);
    assert.equal(read.ok, false);
    assert.ok(read.error);
    assert.equal(idle.writeSetting(file, "off").ok, false);
    assert.equal(idle.writeSetting(file, "default").ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json");

    fs.writeFileSync(file, "[1]");
    assert.equal(idle.writeSetting(file, "off").ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), "[1]");

    // A path that cannot be read as a file (a directory) is an error, not a default.
    var asDir = path.join(dir, "adir");
    fs.mkdirSync(asDir);
    assert.equal(idle.readSetting(asDir).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("idleCompaction: the file acted on is the owner's own", async function () {
  assert.equal(
    idle.settingsFileFor({ osUsers: true, osUserInfo: { home: "/home/alice" } }),
    path.join("/home/alice", ".claude", "settings.json")
  );
  assert.equal(idle.settingsFileFor({ osUsers: true, osUserInfo: null }), null);
  assert.equal(
    idle.settingsFileFor({ osUsers: false, homeDir: "/home/daemon", osUserInfo: { home: "/home/alice" } }),
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join("/home/daemon", ".claude"), "settings.json")
  );
  var res = await idle.applyForOwner("write", "off", { osUsers: true, osUserInfo: null });
  assert.equal(res.ok, false, "no owner identity means no file is touched");
});

test("idleCompaction: a FIFO is refused without blocking and without being written", function () {
  var dir = tmpDir();
  try {
    var fifo = path.join(dir, "settings.json");
    require("child_process").execFileSync("mkfifo", [fifo]);
    var read = idle.readSetting(fifo);
    assert.equal(read.ok, false);
    assert.match(read.error, /not a regular file/);
    assert.equal(idle.writeSetting(fifo, "off").ok, false);
    assert.ok(fs.statSync(fifo).isFIFO(), "the FIFO was not replaced");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session_switched carries the session's compacting flag and the client hydrates from it", function () {
  var server = fs.readFileSync(path.join(__dirname, "..", "lib", "sessions.js"), "utf8");
  var line = server.split("\n").filter(function (l) { return l.indexOf('type: "session_switched"') !== -1; })[0];
  assert.ok(line && line.indexOf("compacting: !!session.compacting") !== -1, "payload carries compacting");
  var client = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "app-messages.js"), "utf8");
  var idx = client.indexOf("session_switched: function");
  var seg = client.slice(idx, idx + 1500);
  assert.ok(seg.indexOf("sessionCompacting: !!msg.compacting") !== -1, "client sets chip from payload");
  assert.equal(seg.indexOf("sessionCompacting: false"), -1, "no unconditional reset");
});
