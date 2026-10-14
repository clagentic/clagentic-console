"use strict";
// The console starts no query to title a session, for any vendor: no adapter
// and no bridge exposes or calls a title generator.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var iface = require("../lib/yoke/interface");
var { createClaudeAdapter } = require("../lib/yoke/adapters/claude");
var codexModule = require("../lib/yoke/adapters/codex");
var { createSDKBridge } = require("../lib/sdk-bridge");

test("the adapter interface declares no title generator", function () {
  assert.equal(iface.ADAPTER_OPTIONAL_METHODS.indexOf("generateTitle"), -1);
  assert.equal(iface.ADAPTER_METHODS.indexOf("generateTitle"), -1);
});

test("neither adapter exposes a title generator", function () {
  var claude = createClaudeAdapter({ cwd: os.tmpdir() });
  assert.equal(claude.generateTitle, undefined);
  var codex = codexModule.createCodexAdapter({ cwd: os.tmpdir(), slug: "p" });
  assert.equal(codex.generateTitle, undefined);
  assert.equal(codexModule._test_resolveTitleModel, undefined);
});

test("no module under lib names a title generator", function () {
  var root = path.join(__dirname, "..", "lib");
  var offenders = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      if (!/\.(js|mjs)$/.test(e.name)) return;
      if (/generateTitle|autoGenerateTitle|onAutoTitle/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(root, full));
    });
  })(root);
  assert.deepEqual(offenders, []);
});

test("the bridge exports no title generator", function () {
  assert.equal(typeof createSDKBridge, "function");
  assert.equal(require("../lib/sdk-bridge").generateTitle, undefined);
});

// Behavioural counterpart to the scan above: turns complete, first and later,
// and nothing is asked of an adapter and no child process is started.
test("completing first and later turns starts no query and no process", function () {
  var childProcess = require("child_process");
  var { attachMessageProcessor } = require("../lib/sdk-message-processor");
  var adapterCalls = [];
  var adapter = new Proxy({ vendor: "claude" }, {
    get: function (target, prop) {
      if (prop === "vendor") return target.vendor;
      adapterCalls.push(String(prop));
      return function () {};
    },
  });
  var spawned = [];
  var realSpawn = childProcess.spawn;
  var realExec = childProcess.exec;
  var realFork = childProcess.fork;
  childProcess.spawn = function () { spawned.push("spawn"); throw new Error("no process may start"); };
  childProcess.exec = function () { spawned.push("exec"); throw new Error("no process may start"); };
  childProcess.fork = function () { spawned.push("fork"); throw new Error("no process may start"); };
  try {
    var sm = {
      skillMeta: [], workflowMeta: [], skillNames: [], slashCommands: null, currentModel: null,
      _savedDefaultModel: null, permissionRequestIndex: {},
      sendAndRecord: function () {}, sendToSession: function () {},
      saveSessionFile: function () {}, broadcastSessionList: function () {},
      modelsByVendor: {}, availableModels: [], availableVendors: [], installedVendors: [],
    };
    var processor = attachMessageProcessor({
      sm: sm, send: function () {}, slug: "p", cwd: os.tmpdir(), pushModule: null,
      getNotificationsModule: function () { return null; }, adapter: adapter,
      onProcessingChanged: function () {}, onTurnDone: null, opts: {},
      discoverSkillDirs: function () { return []; }, mergeSkills: function () { return []; },
      discoverWorkflows: function () { return []; }, discoverSkillsWithMeta: function () { return []; },
      mergeSkillsWithMeta: function () { return []; }, getSDK: null,
    });
    var session = {
      localId: 1, cliSessionId: "sid-1", vendor: "claude", cwd: os.tmpdir(), history: [], messageUUIDs: [], blocks: {},
      sentToolResults: {}, pendingPermissions: {}, pendingElicitations: {}, pendingAskUser: {},
      activeTaskToolIds: {}, taskIdMap: {}, streamedText: false, responsePreview: "", isProcessing: true,
      loop: null, title: "first line", turnCount: 0,
    };
    for (var turn = 0; turn < 3; turn++) {
      session.isProcessing = true;
      processor.processSDKMessage(session, { yokeType: "result", cost: 0.1, duration: 1, sessionId: "sid-1" });
    }
  } finally {
    childProcess.spawn = realSpawn;
    childProcess.exec = realExec;
    childProcess.fork = realFork;
  }
  assert.deepEqual(spawned, []);
  assert.deepEqual(adapterCalls, []);
});
