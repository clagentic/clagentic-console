"use strict";
// Lifecycle, activity, login and agent-identity behaviour is driven by an
// agent's registered capabilities and descriptor, never by its name: a vendor
// registered here behaves by what it declares, and the shipped agents behave
// as before.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var world = require("./prompt-harness-world");

function lib(name) { return require(path.join(world.LIB_ROOT, name)); }

function fakeAdapter(vendor) {
  return {
    vendor: vendor,
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
    createToolServer: function () { return {}; },
    createQuery: function () { return Promise.resolve({}); },
  };
}

function fakeDescriptor(overrides) {
  return Object.assign({
    id: "fake",
    displayName: "Fake Agent",
    icon: "/fake-avatar.png",
    priority: 99,
    binaryNames: ["fake-agent"],
    probeInstalled: function () { return true; },
    checkAuth: function () { return true; },
    installHint: "Install fake-agent.",
    loginCommand: "fake-agent signin",
    osUsersSupported: false,
    needsRuntimeEnv: false,
    ownedEnvNames: [],
    nativeInstructionFiles: [],
    interruptMessage: "Stopped the fake agent.",
    activityTokens: true,
    capabilities: { agentInjection: true },
    createAdapter: function () { return fakeAdapter("fake"); },
  }, overrides || {});
}

async function withHarness(fn) {
  var server = await world.createServer();
  try {
    await fn(server);
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
}

function historyOf(session, type) {
  return session.history.filter(function (m) { return m.type === type; });
}

test("an agent declaring activityTokens holds a token per tool block, released at tool_result; one that does not, holds none", async function () {
  await withHarness(async function (server) {
    var registry = lib("yoke").registry;
    var activity = lib("session-activity");
    registry.register(fakeDescriptor());
    try {
      var session = server.sm.createSessionRaw({});
      session.vendor = "fake";
      server.bridge.processSDKMessage(session, { yokeType: "tool_start", blockId: "blk_1", toolId: "tool-1", toolName: "Bash" });
      assert.equal(activity.isSessionActive(session), true, "the fake agent's tool block is activity");
      server.bridge.processSDKMessage(session, { yokeType: "tool_result", toolId: "tool-1", content: "ok", isError: false });
      assert.equal(activity.isSessionActive(session), false, "released at its result");

      server.bridge.processSDKMessage(session, { yokeType: "thinking_start", blockId: "blk_2" });
      assert.equal(activity.isSessionActive(session), true, "a thinking block too");
      server.bridge.processSDKMessage(session, { yokeType: "result", cost: 0.01, duration: 1, usage: null, sessionId: "s" });
      assert.equal(activity.isSessionActive(session), false, "the turn's result releases whatever is still held");

      var claude = server.sm.createSessionRaw({});
      claude.vendor = "claude";
      server.bridge.processSDKMessage(claude, { yokeType: "tool_start", blockId: "blk_1", toolId: "tool-2", toolName: "Bash" });
      assert.equal(activity.isSessionActive(claude), false, "Claude does not declare activityTokens");
    } finally {
      registry.unregister("fake");
    }
  });
});

test("the trait, not the name, decides: switching Codex's activityTokens trait off turns its tokens off", async function () {
  await withHarness(async function (server) {
    var registry = lib("yoke").registry;
    var activity = lib("session-activity");
    var codex = registry.get("codex");
    var session = server.sm.createSessionRaw({});
    session.vendor = "codex";
    server.bridge.processSDKMessage(session, { yokeType: "tool_start", blockId: "blk_1", toolId: "tool-1", toolName: "Bash" });
    assert.equal(activity.isSessionActive(session), true, "Codex declares activityTokens");

    codex.activityTokens = false;
    try {
      var other = server.sm.createSessionRaw({});
      other.vendor = "codex";
      server.bridge.processSDKMessage(other, { yokeType: "tool_start", blockId: "blk_1", toolId: "tool-9", toolName: "Bash" });
      assert.equal(activity.isSessionActive(other), false);
    } finally {
      codex.activityTokens = true;
    }
  });
});

test("a not-logged-in reply names the agent and its login command from the registry, for a registered fake agent", async function () {
  await withHarness(async function (server) {
    var registry = lib("yoke").registry;
    registry.register(fakeDescriptor());
    try {
      var session = server.sm.createSessionRaw({});
      session.vendor = "fake";
      session.responsePreview = "Not logged in · Please run /login";
      server.bridge.processSDKMessage(session, { yokeType: "result", cost: 0, duration: 1, usage: null, sessionId: "s" });
      var auth = historyOf(session, "auth_required");
      assert.equal(auth.length, 1);
      assert.equal(auth[0].text, "Fake Agent is not logged in.");
      assert.equal(auth[0].loginCommand, "fake-agent signin");
      assert.equal(auth[0].vendor, "fake");
    } finally {
      registry.unregister("fake");
    }
  });
});

test("the shipped agents keep their titles and login commands", async function () {
  await withHarness(async function (server) {
    ["claude", "codex"].forEach(function (vendor) {
      var session = server.sm.createSessionRaw({});
      session.vendor = vendor;
      session.responsePreview = "Not logged in · Please run /login";
      server.bridge.processSDKMessage(session, { yokeType: "result", cost: 0, duration: 1, usage: null, sessionId: "s" });
      var auth = historyOf(session, "auth_required")[0];
      assert.equal(auth.text, vendor === "claude" ? "Claude Code is not logged in." : "Codex is not logged in.");
      assert.equal(auth.loginCommand, vendor === "claude" ? "claude login" : "codex login --device-auth");
    });
  });
});

test("a notification for a registered fake agent is titled from the registry", async function () {
  await withHarness(async function (server) {
    var registry = lib("yoke").registry;
    registry.register(fakeDescriptor());
    try {
      server.notifications.notify("auth_required", { vendor: "fake", loginCommand: "fake-agent signin", slug: "harness" });
      var state = null;
      server.notifications.sendConnectionState({}, function (ws, msg) { state = msg; });
      var created = state.notifications.filter(function (n) { return n.type === "auth_required"; });
      assert.equal(created[0].title, "Fake Agent is not logged in");
      assert.equal(created[0].meta.loginCommand, "fake-agent signin");
    } finally {
      registry.unregister("fake");
    }
  });
});

test("a session bound to an agent that is not registered is stopped with a named error, not started on a default", async function () {
  await withHarness(async function (server) {
    var session = server.sm.createSessionRaw({});
    session.vendor = "ghost";
    await server.bridge.startQuery(session, "hello", null, null);
    var errors = historyOf(session, "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].text, /Unknown agent: ghost/);
    assert.equal(historyOf(session, "done")[0].code, 1);
    assert.equal(server.queryOptions.length, 0, "no query was created");
  });
});

test("agent identity follows the RESOLVED agentInjection of the default agent: declared true, live false sends no agent option", async function () {
  await withHarness(async function (server) {
    var registry = lib("yoke").registry;
    var caps = lib("session-capabilities");

    var withAgent = server.sm.createSessionRaw({});
    withAgent.vendor = "claude";
    withAgent.agentName = "Helper";
    await server.bridge.startQuery(withAgent, "hi", null, null);
    assert.equal(server.queryOptions[0].adapterOptions.CLAUDE.agent, "Helper", "declared and live agree: injected");

    // The live session withdraws the capability; the declaration is untouched.
    caps.recordCapabilities(server.sm, "claude", { agentInjection: false });
    assert.equal(registry.declaredCapabilities("claude").agentInjection, true, "still declared");
    var without = server.sm.createSessionRaw({});
    without.vendor = "claude";
    without.agentName = "Helper";
    await server.bridge.startQuery(without, "hi", null, null);
    assert.equal(server.queryOptions[1].adapterOptions.CLAUDE.agent, undefined, "the guard reads the resolved set");
  });
});

async function fakeSessionAgentOption(advertised) {
  var option;
  var registryMsg;
  await withHarness(async function (server) {
    var registry = lib("yoke").registry;
    registry.register(fakeDescriptor());
    try {
      assert.equal(registry.declaredCapabilities("fake").agentInjection, true, "declared");
      var served = world.serveVendor(server, "fake", advertised);
      var session = server.sm.createSessionRaw({});
      session.vendor = "fake";
      session.agentName = "Helper";
      await served.bridge.startQuery(session, "hi", null, null);
      assert.equal(served.created.length, 1, "the query started on the fake agent");
      option = served.created[0].adapterOptions.CLAUDE.agent;
      registryMsg = served.sent.filter(function (m) { return m.type === "vendor_registry"; }).pop();
    } finally {
      registry.unregister("fake");
    }
  });
  return { agent: option, registry: registryMsg };
}

test("agent identity follows the RESOLVED agentInjection of a NON-default agent: declared true, live false sends no agent option", async function () {
  var withdrawn = await fakeSessionAgentOption({ agentInjection: false });
  assert.equal(withdrawn.agent, undefined, "its live session withdrew injection: no agent option");
  assert.ok(withdrawn.registry, "recording the live capabilities re-sends the registry");
  assert.equal(withdrawn.registry.vendors.filter(function (v) { return v.id === "fake"; })[0].capabilities.agentInjection, false);

  var silent = await fakeSessionAgentOption({});
  assert.equal(silent.agent, "Helper", "a live session that says nothing leaves the declaration");
});

test("binding a session to an agent decides agent identity on the same resolved set as the query guard", async function () {
  await withHarness(async function (server) {
    var registry = lib("yoke").registry;
    var caps = lib("session-capabilities");
    registry.register(fakeDescriptor());
    try {
      var c = world.client();
      server.connect(c.ws);
      server.session.cliSessionId = null; // not yet bound to a CLI

      server.session.agentName = "Helper";
      server.handlers.handleSessionsMessage(c.ws, { type: "set_vendor", vendor: "codex" });
      assert.equal(server.session.vendor, "codex");
      assert.equal(server.session.agentName, null, "Codex has no agentInjection");

      caps.seedCapabilities(server.sm);
      server.session.vendor = null;
      server.session.agentName = "Helper";
      server.handlers.handleSessionsMessage(c.ws, { type: "set_vendor", vendor: "fake" });
      assert.equal(server.session.vendor, "fake");
      assert.equal(server.session.agentName, "Helper", "resolved: the fake agent injects");

      // Declared true, live false: set_vendor clears, exactly where the guard would skip.
      caps.recordCapabilities(server.sm, "fake", { agentInjection: false });
      server.session.vendor = null;
      server.session.agentName = "Helper";
      server.handlers.handleSessionsMessage(c.ws, { type: "set_vendor", vendor: "fake" });
      assert.equal(server.session.agentName, null, "resolved: the fake agent no longer injects");

      server.handlers.handleSessionsMessage(c.ws, { type: "set_vendor", vendor: "ghost" });
      assert.equal(server.session.vendor, "fake", "an unregistered agent is never bound");
    } finally {
      registry.unregister("fake");
    }
  });
});

test("lazy adapter creation hands the init result to the caller, which records the live capabilities", async function () {
  await withHarness(async function (server) {
    var registry = lib("yoke").registry;
    registry.register(fakeDescriptor({
      createAdapter: function () {
        var adapter = fakeAdapter("fake");
        adapter.init = function () { return Promise.resolve({ models: [], skills: [], capabilities: { agentInjection: false } }); };
        return adapter;
      },
    }));
    try {
      var yoke = lib("yoke");
      var adapters = {};
      var recorded = null;
      await yoke.lazyCreateAdapter(adapters, "fake", { cwd: server.home }, function (initResult) { recorded = initResult; });
      assert.deepEqual(recorded.capabilities, { agentInjection: false }, "lazy creation hands the init result to the caller");
      assert.ok(adapters.fake, "the adapter is kept");
    } finally {
      registry.unregister("fake");
    }
  });
});

test("warmup records every registered agent's capabilities, so a Claude session in a Codex-default project keeps Auto and Don't ask", async function () {
  await withHarness(async function (server) {
    var yoke = lib("yoke");
    var codexCaps = yoke.registry.declaredCapabilities("codex");
    var codexDefault = {
      vendor: "codex",
      init: function () { return Promise.resolve({ models: [], skills: [], capabilities: codexCaps }); },
      supportedModels: function () { return Promise.resolve([]); },
    };
    var sent = [];
    var bridge = lib("sdk-bridge").createSDKBridge({
      cwd: server.home,
      slug: "codex-default",
      sessionManager: server.sm,
      send: function (m) { sent.push(m); },
      adapter: codexDefault,
      adapters: { codex: codexDefault },
      onProcessingChanged: function () {},
    });
    await bridge.warmup();

    var byVendor = server.sm.capabilitiesByVendor;
    assert.deepEqual(byVendor.claude.permissionModes, ["default", "plan", "acceptEdits", "dontAsk", "auto"], "Claude is not the default, and still declares its modes");
    assert.deepEqual(byVendor.codex.permissionModes, []);

    var c = world.client();
    server.connect(c.ws);
    server.session.vendor = "claude";
    server.handlers.handleSessionsMessage(c.ws, { type: "set_permission_mode", mode: "auto" });
    await world.flush();
    assert.equal(c.inbox.filter(function (m) { return m.type === "error"; }).length, 0, "Auto is not refused for the Claude session");

    var registryMsg = sent.filter(function (m) { return m.type === "vendor_registry"; })[0];
    assert.ok(registryMsg, "the browser is sent the registry");
    assert.deepEqual(registryMsg.vendors.map(function (v) { return v.id; }), ["claude", "codex"]);
  });
});

test("the default agent's recorded capabilities are what its live session advertises, narrowed from the declaration", async function () {
  await withHarness(async function (server) {
    var advertising = {
      vendor: "claude",
      init: function () { return Promise.resolve({ models: [], skills: [], capabilities: { effort: false, steering: true, permissionModes: ["default", "auto"] } }); },
      supportedModels: function () { return Promise.resolve([]); },
    };
    var bridge = lib("sdk-bridge").createSDKBridge({
      cwd: server.home,
      slug: "narrow",
      sessionManager: server.sm,
      send: function () {},
      adapter: advertising,
      adapters: { claude: advertising },
      onProcessingChanged: function () {},
    });
    await bridge.warmup();
    var caps = server.sm.capabilitiesByVendor.claude;
    assert.equal(caps.effort, false, "narrowed by the session");
    assert.deepEqual(caps.permissionModes, ["default", "auto"], "intersected with the session's list");
    assert.equal(caps.rewind, true, "left as declared where the session says nothing");
  });
});

test("recheck_vendors looks again and tells every client which agents are installed now", async function () {
  await withHarness(async function (server) {
    var registry = lib("yoke").registry;
    var present = false;
    registry.register(fakeDescriptor({ probeInstalled: function () { return present; } }));
    try {
      var c = world.client();
      server.connect(c.ws);
      await server.bridge.warmup();
      var first = c.inbox.filter(function (m) { return m.type === "vendor_registry"; }).pop();
      assert.equal(first.vendors.filter(function (v) { return v.id === "fake"; })[0].installed, false);

      present = true;
      c.inbox.length = 0;
      server.handlers.handleSessionsMessage(c.ws, { type: "recheck_vendors" });
      var after = c.inbox.filter(function (m) { return m.type === "vendor_registry"; }).pop();
      assert.ok(after, "the registry is re-sent");
      var fake = after.vendors.filter(function (v) { return v.id === "fake"; })[0];
      assert.equal(fake.installed, true, "the newly installed agent is no longer disabled");
      assert.equal(fake.installHint, "Install fake-agent.");
    } finally {
      registry.unregister("fake");
    }
  });
});
