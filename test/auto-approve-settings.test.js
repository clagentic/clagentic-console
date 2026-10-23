"use strict";
// The "Auto-approve read-only tools" server setting and the per-loop "Approve
// tools automatically during this loop" setting. Both default to on, which is
// the behaviour before they existed; off sends the call to the normal prompt.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");

// A bridge over the harness's session manager whose server settings and
// remote-MCP list the test controls.
function bridgeWith(server, current, extra) {
  var adapter = {
    vendor: "claude",
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
  };
  return require(world.LIB_ROOT + "/sdk-bridge").createSDKBridge(Object.assign({
    cwd: server.home, slug: "harness", sessionManager: server.sm, send: function () {},
    adapter: adapter, adapters: { claude: adapter }, onProcessingChanged: function () {},
    getPermissionSettings: function () { return current.settings; },
  }, extra || {}));
}

// handleCanUseTool as the SDK makes it; returns the promise and the prompts it opened.
function call(server, bridge, toolName, input, hints) {
  var before = server.heldPromptIds();
  var promise = bridge.handleCanUseTool(server.session, toolName, input, Object.assign({
    toolUseID: "tu-" + Math.random().toString(36).slice(2), signal: new AbortController().signal,
  }, hints || {}));
  var opened = server.heldPromptIds().filter(function (id) { return before.indexOf(id) === -1; });
  return { promise: promise, opened: opened };
}

function denyAll(server, c) {
  c.opened.forEach(function (id) { server.sm.prompts.respond(id, { decision: "deny" }); });
}

var READ_ONLY_CALLS = [
  ["Read", { file_path: "/srv/app/a.txt" }],
  ["Glob", { pattern: "*.js" }],
  ["Grep", { pattern: "x" }],
  ["WebFetch", { url: "https://example.com" }],
  ["WebSearch", { query: "x" }],
  ["Bash", { command: "ls -la" }],
  ["Bash", { command: "git status" }],
];

test("with the setting at its default (absent, or on) the read-only list is approved without a prompt", async function () {
  var server = await world.createServer();
  try {
    [undefined, null, { autoApproveReadOnly: true }].forEach(function (settings) {
      var bridge = bridgeWith(server, { settings: settings });
      READ_ONLY_CALLS.forEach(function (c) {
        var r = call(server, bridge, c[0], c[1]);
        assert.equal(r.opened.length, 0, c[0] + " " + JSON.stringify(c[1]));
        r.promise.then(function (v) { assert.equal(v.behavior, "allow"); });
      });
    });
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("with the setting off every item of the read-only list goes to the prompt", async function () {
  var server = await world.createServer();
  try {
    var bridge = bridgeWith(server, { settings: { autoApproveReadOnly: false } });
    for (var i = 0; i < READ_ONLY_CALLS.length; i++) {
      var c = READ_ONLY_CALLS[i];
      var r = call(server, bridge, c[0], c[1]);
      assert.equal(r.opened.length, 1, c[0] + " " + JSON.stringify(c[1]) + " asks");
      denyAll(server, r);
      assert.equal((await r.promise).behavior, "deny");
    }
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("with the setting off the browser watch tools and the enabled MCP servers ask too", function () {
  var server = null;
  return world.createServer().then(function (s) {
    server = s;
    var remote = function () { return { "my-srv": {} }; };
    var on = bridgeWith(s, { settings: { autoApproveReadOnly: true } }, { getRemoteMcpServers: remote });
    var off = bridgeWith(s, { settings: { autoApproveReadOnly: false } }, { getRemoteMcpServers: remote });
    var own = { name: "clay-browser", source: "sdk" };
    var mine = { name: "my-srv", source: "sdk" };
    assert.ok(on.checkToolWhitelist("mcp__clay-browser__browser_watch_tab", {}, { mcpServer: own }));
    assert.ok(on.checkToolWhitelist("mcp__my-srv__list", {}, { mcpServer: mine }));
    assert.equal(off.checkToolWhitelist("mcp__clay-browser__browser_watch_tab", {}, { mcpServer: own }), null);
    assert.equal(off.checkToolWhitelist("mcp__clay-browser__browser_unwatch_tab", {}, { mcpServer: own }), null);
    assert.equal(off.checkToolWhitelist("mcp__my-srv__list", {}, { mcpServer: mine }), null);
  }).finally(function () {
    if (server) { server.shutdown(); world.removeHome(server.home); }
  });
});

test("the setting is read at decision time: a change needs no restart", async function () {
  var server = await world.createServer();
  try {
    var current = { settings: { autoApproveReadOnly: true } };
    var bridge = bridgeWith(server, current);
    assert.equal(call(server, bridge, "Read", { file_path: "/a" }).opened.length, 0);
    current.settings = { autoApproveReadOnly: false };
    var asks = call(server, bridge, "Read", { file_path: "/a" });
    assert.equal(asks.opened.length, 1);
    denyAll(server, asks);
    await asks.promise;
    current.settings = { autoApproveReadOnly: true };
    assert.equal(call(server, bridge, "Read", { file_path: "/a" }).opened.length, 0);
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("an ask the person's own rule forced is unchanged by the setting", async function () {
  var server = await world.createServer();
  try {
    for (var on of [true, false]) {
      var bridge = bridgeWith(server, { settings: { autoApproveReadOnly: on } });
      var r = call(server, bridge, "Read", { file_path: "/a" }, { matchedAskRule: "Read(/a)" });
      assert.equal(r.opened.length, 1, "a rule-forced ask is a prompt with the setting " + on);
      denyAll(server, r);
      await r.promise;
    }
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("sleep is no longer on the auto-approved shell list, with the setting on or off", async function () {
  var server = await world.createServer();
  try {
    var bridge = bridgeWith(server, { settings: { autoApproveReadOnly: true } });
    assert.equal(bridge.checkToolWhitelist("Bash", { command: "sleep infinity" }), null);
    assert.equal(bridge.checkToolWhitelist("Bash", { command: "sleep 1" }), null);
    var r = call(server, bridge, "Bash", { command: "sleep infinity" });
    assert.equal(r.opened.length, 1, "it asks");
    denyAll(server, r);
    await r.promise;
    assert.ok(bridge.checkToolWhitelist("Bash", { command: "ls -la" }), "the rest of the list is untouched");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

// ---------------------------------------------------------------------------
// Approve tools automatically during this loop
// ---------------------------------------------------------------------------

function loopSession(server, flag) {
  var loop = { active: true, role: "coder", loopId: "loop_1", iteration: 1 };
  if (flag !== undefined) loop.approveTools = flag;
  server.session.loop = loop;
}

test("a loop run approves every tool when its record never carried the setting, or says on", async function () {
  var server = await world.createServer();
  try {
    var bridge = bridgeWith(server, { settings: { autoApproveReadOnly: false } });
    for (var flag of [undefined, true]) {
      loopSession(server, flag);
      var write = call(server, bridge, "Write", { file_path: "/srv/app/b.txt" });
      assert.equal(write.opened.length, 0, "flag " + flag);
      assert.equal((await write.promise).behavior, "allow");
    }
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("a loop run with the setting off takes the normal path: the read-only list, then a prompt", async function () {
  var server = await world.createServer();
  try {
    loopSession(server, false);
    var on = bridgeWith(server, { settings: { autoApproveReadOnly: true } });
    assert.equal(call(server, on, "Read", { file_path: "/a" }).opened.length, 0, "a read-only tool is still approved by its own setting");
    var write = call(server, on, "Write", { file_path: "/srv/app/b.txt" });
    assert.equal(write.opened.length, 1, "a write asks");
    denyAll(server, write);
    assert.equal((await write.promise).behavior, "deny");

    var off = bridgeWith(server, { settings: { autoApproveReadOnly: false } });
    var read = call(server, off, "Read", { file_path: "/a" });
    assert.equal(read.opened.length, 1, "with both off, even a read asks");
    denyAll(server, read);
    await read.promise;
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("the loop's refusal of questions and plan mode, and of MCP elicitations, does not depend on the setting", async function () {
  var server = await world.createServer();
  try {
    var bridge = bridgeWith(server, { settings: null });
    for (var flag of [true, false]) {
      loopSession(server, flag);
      var ask = await call(server, bridge, "AskUserQuestion", { questions: [] }).promise;
      assert.equal(ask.behavior, "deny", "AskUserQuestion, flag " + flag);
      var plan = await call(server, bridge, "EnterPlanMode", {}).promise;
      assert.equal(plan.behavior, "deny", "EnterPlanMode, flag " + flag);
      var elicitation = await bridge.handleElicitation(server.session, { message: "m" }, {});
      assert.deepEqual(elicitation, { action: "reject" }, "elicitation, flag " + flag);
    }
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("a crafting session is interactive and is not a loop run for this setting", async function () {
  var server = await world.createServer();
  try {
    server.session.loop = { active: true, role: "crafting", loopId: "loop_1", approveTools: false };
    var bridge = bridgeWith(server, { settings: null });
    var write = call(server, bridge, "Write", { file_path: "/srv/app/b.txt" });
    assert.equal(write.opened.length, 1);
    denyAll(server, write);
    await write.promise;
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("a loop record: a new record approves, the field is only set by a boolean, and an old record without it approves", async function () {
  var server = await world.createServer();
  try {
    var { createLoopRegistry } = require(world.LIB_ROOT + "/scheduler");
    var registry = createLoopRegistry({ cwd: server.home, onTrigger: function () {}, onChange: function () {} });
    var fresh = registry.register({ name: "a", task: "t" });
    assert.equal(fresh.approveToolsAutomatically, true);
    var off = registry.register({ name: "b", task: "t", approveToolsAutomatically: false });
    assert.equal(off.approveToolsAutomatically, false);

    registry.update(fresh.id, { approveToolsAutomatically: "no" });
    assert.equal(registry.getById(fresh.id).approveToolsAutomatically, true, "a non-boolean is not stored");
    registry.update(fresh.id, { approveToolsAutomatically: false });
    assert.equal(registry.getById(fresh.id).approveToolsAutomatically, false);
    registry.update(fresh.id, { name: "renamed" });
    assert.equal(registry.getById(fresh.id).approveToolsAutomatically, false, "other edits leave it");

    // A record written before the field existed.
    var legacy = registry.register({ name: "c", task: "t" });
    delete registry.getById(legacy.id).approveToolsAutomatically;
    registry.save();
    var reloaded = createLoopRegistry({ cwd: server.home, onTrigger: function () {}, onChange: function () {} });
    reloaded.load();
    var back = reloaded.getById(legacy.id);
    assert.equal(back.approveToolsAutomatically, undefined);
    assert.equal(!(back && back.approveToolsAutomatically === false), true, "an absent field means on");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});
