"use strict";
// Permission safety for the beta gate:
//   - the read-only Bash auto-approve refuses redirection, newlines, a lone &
//     and entries that can write, and MCP auto-approve keys on the SDK's report
//     of the serving server, not the tool-name prefix;
//   - the server refuses any permission mode the vendor or the server does not
//     allow, and default-mode changes need an admin or the project owner;
//   - the canUseTool bypass reads the session's mode, and one session's worker
//     mode change or plan answer never becomes the project-wide mode.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");
var { claudeCapabilities } = require("../lib/yoke/adapters/claude-capabilities");
var policy = require("../lib/permission-mode-policy");
var relay = require("../lib/yoke/adapters/permission-relay");
var { createProjectAccess } = require("../lib/project-access");

var client = world.client;
var withServer = world.withServer;

// ---------------------------------------------------------------------------
// Bash auto-approve
// ---------------------------------------------------------------------------

function makeBridge(extra) {
  var sm = {
    sessions: new Map(), currentModel: null, currentPermissionMode: null, currentEffort: null,
    currentBetas: [], modelsByVendor: {}, availableVendors: [], installedVendors: [],
    defaultVendor: "claude", saveSessionFile: function () {}, broadcastSessionList: function () {},
    getActiveSession: function () { return null; }, setSlashCommandsForVendor: function () {},
    sendAndRecord: function () {}, sendToSession: function () {},
  };
  var adapter = {
    vendor: "claude",
    createQuery: function () { return Promise.resolve(null); },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
  };
  var opts = Object.assign({
    cwd: "/tmp/test-project", slug: "test-project", sessionManager: sm, send: function () {},
    adapter: adapter, adapters: { claude: adapter }, onProcessingChanged: function () {}, getConfig: null,
  }, extra || {});
  return require("../lib/sdk-bridge").createSDKBridge(opts);
}

var bashBridge = makeBridge();
function bash(command) { return bashBridge.checkToolWhitelist("Bash", { command: command }); }

var PROMPTS = [
  "echo x > ~/.bashrc",
  "echo x >> ~/.bashrc",
  "cat a > b",
  "cat < /etc/passwd",
  "cat <<EOF\nhi\nEOF",
  "ls &> out",
  "ls 2> out",
  "ls\nrm -rf x",
  "ls\rrm -rf x",
  "ls & rm -rf x",
  "ls &",
  "echo \"a > b\"",
  "sort -o f g",
  "sort a",
  "uniq in out",
  "time rm x",
  "time ls",
  "date -s now",
  "date -d tomorrow",
  "hostname newname",
  "ip link set eth0 down",
  "ip addr add 1.2.3.4 dev eth0",
  "ifconfig eth0 down",
  "timedatectl set-time 2020-01-01",
  "xxd -r hex out",
  "csplit f 3",
  "tail -f log",
  "tail -F log",
  "tail -n 5 log",
  "rg --pre rm x",
  "man ls",
  "top",
  "tree -o out",
  "yq -i x f",
  "GIT_EXTERNAL_DIFF=x git diff",
  "FOO=1 ls",
  "git diff --ext-diff",
  "git diff --textconv",
  "git -c core.pager=x log",
  "git diff -c",
  "git diff --output f",
  "git diff --output=f",
  "git --exec-path x log",
  "git log --exec-path",
  "git log --format=%H",
  "${X:---output}",
  "git diff {--output,f}",
  "git diff -\\-output f",
  "git diff \"--out\"\"put\" f",
  "git diff 'a'",
  "git diff *",
  "ls $HOME",
  "ls ${HOME}",
  "grep \"a b\" f",
  "ls *.js",
  "ls ?",
  "ls [a]",
  "echo !x",
  "ls # note",
  "ls café",
];

PROMPTS.forEach(function (cmd) {
  test("bash auto-approve falls through to the prompt for: " + JSON.stringify(cmd), function () {
    assert.equal(bash(cmd), null);
  });
});

["ls -la", "git status", "cat README.md | grep x", "ls && pwd", "date", "date +%Y", "hostname",
  "ip addr", "ip route", "ifconfig", "rg foo", "git log --oneline", "git diff",
  "git log -5", "ls -la src/", "cat README.md | grep foo"].forEach(function (cmd) {
  test("bash auto-approve still allows read-only: " + cmd, function () {
    var result = bash(cmd);
    assert.ok(result && result.behavior === "allow");
  });
});

// ---------------------------------------------------------------------------
// MCP auto-approve by server source
// ---------------------------------------------------------------------------

var mcpBridge = makeBridge({ getRemoteMcpServers: function () { return { "my-srv": {} }; } });
function mcp(toolName, mcpServer) {
  return mcpBridge.checkToolWhitelist(toolName, {}, mcpServer ? { mcpServer: mcpServer } : {});
}

test("an enabled in-process server's tool is auto-approved", function () {
  var result = mcp("mcp__my-srv__list", { name: "my-srv", source: "sdk" });
  assert.ok(result && result.behavior === "allow");
});

test("a same-named tool from a configured (not in-process) server prompts", function () {
  ["user", "project", "local", "plugin", "dynamic", "claudeai"].forEach(function (source) {
    assert.equal(mcp("mcp__my-srv__list", { name: "my-srv", source: source }), null, source);
  });
});

test("an in-process server the person did not enable prompts", function () {
  assert.equal(mcp("mcp__other__list", { name: "other", source: "sdk" }), null);
});

test("with no server report (older CLI, Codex approvals) an MCP tool prompts", function () {
  assert.equal(mcp("mcp__my-srv__list", null), null);
});

test("the report must name the server the tool belongs to", function () {
  assert.equal(mcp("mcp__other__list", { name: "my-srv", source: "sdk" }), null);
});

test("clay-datastore is no longer auto-approved by prefix", function () {
  assert.equal(mcp("mcp__clay-datastore__query", null), null);
  assert.equal(mcp("mcp__clay-datastore__query", { name: "clay-datastore", source: "sdk" }), null);
  assert.equal(mcp("mcp__clay-datastore__query", { name: "clay-datastore", source: "user" }), null);
});

test("browser watch and unwatch are auto-approved only from the console's own in-process server", function () {
  var own = { name: "clay-browser", source: "sdk" };
  assert.ok(mcp("mcp__clay-browser__browser_watch_tab", own));
  assert.ok(mcp("mcp__clay-browser__browser_unwatch_tab", own));
  assert.equal(mcp("mcp__clay-browser__browser_screenshot", own), null);
  assert.equal(mcp("mcp__clay-browser__browser_watch_tab", { name: "clay-browser", source: "user" }), null);
  assert.equal(mcp("mcp__evil__browser_watch_tab", { name: "evil", source: "sdk" }), null);
  assert.equal(mcp("mcp__evil__browser_watch_tab", null), null);
});

test("the server report survives the worker relay", function () {
  var msg = relay.toRequestMessage("r1", "mcp__my-srv__list", {}, { toolUseID: "t", mcpServer: { name: "my-srv", source: "sdk" } });
  var wire = JSON.parse(JSON.stringify(msg));
  var opts = relay.toCanUseToolOptions(wire, null);
  assert.deepEqual(opts.mcpServer, { name: "my-srv", source: "sdk" });
  assert.equal(relay.toCanUseToolOptions(JSON.parse(JSON.stringify(relay.toRequestMessage("r2", "Bash", {}, {}))), null).mcpServer, undefined);
  assert.equal(relay.toCanUseToolOptions({ mcpServer: "sdk" }, null).mcpServer, undefined, "a malformed report is dropped");
});

// ---------------------------------------------------------------------------
// The shared mode check
// ---------------------------------------------------------------------------

test("the mode check refuses unknown modes, bypass unless the server allows it, and gated modes the vendor lacks", function () {
  var claude = claudeCapabilities().permissionModes;
  assert.equal(policy.checkPermissionMode("bypassPermissions", {}).ok, false);
  assert.equal(policy.checkPermissionMode("bypassPermissions", { skipPermissionsAllowed: false, supportedModes: claude }).ok, false);
  assert.equal(policy.checkPermissionMode("bypassPermissions", { skipPermissionsAllowed: true }).ok, true);
  assert.equal(policy.checkPermissionMode("nonsense", { skipPermissionsAllowed: true }).ok, false);
  assert.equal(policy.checkPermissionMode("constructor", {}).ok, false);
  assert.equal(policy.checkPermissionMode(undefined, {}).ok, false);
  assert.equal(policy.checkPermissionMode("auto", { supportedModes: claude }).ok, true);
  assert.equal(policy.checkPermissionMode("auto", { supportedModes: [] }).ok, false);
  assert.equal(policy.checkPermissionMode("acceptEdits", { supportedModes: [] }).ok, true);
});

test("a saved default that fails the check falls back to default", function () {
  assert.deepEqual(policy.savedModeOrDefault("bypassPermissions", {}), { mode: "default", error: "The bypassPermissions mode is not enabled on this server" });
  assert.equal(policy.savedModeOrDefault("junk", {}).mode, "default");
  assert.deepEqual(policy.savedModeOrDefault("auto", {}), { mode: "auto", error: null });
  assert.equal(policy.savedModeOrDefault("bypassPermissions", { skipPermissionsAllowed: true }).mode, "bypassPermissions");
});

// ---------------------------------------------------------------------------
// WebSocket mode setters
// ---------------------------------------------------------------------------

function errors(c) { return c.inbox.filter(function (m) { return m.type === "error"; }); }

test("set_permission_mode refuses bypassPermissions and unknown modes", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var applied = [];
    server.session.queryInstance.setPermissionMode = function (mode) { applied.push(mode); return Promise.resolve(); };
    server.sm.capabilitiesByVendor = { claude: claudeCapabilities() };
    ["bypassPermissions", "nonsense"].forEach(function (mode) {
      server.handlers.handleSessionsMessage(c.ws, { type: "set_permission_mode", mode: mode });
    });
    await world.flush();
    assert.deepEqual(applied, []);
    assert.notEqual(server.session.permissionMode, "bypassPermissions");
    assert.equal(errors(c).length, 2, "the requester is told");
  });
});

function defaultSetters(server, extra) {
  var calls = [];
  var access = createProjectAccess({
    users: { canAccessProject: function () { return true; }, canAccessSession: function () { return true; } },
    isMultiUser: extra.multiUser === false ? function () { return false; } : function () { return true; },
  });
  var ctx = Object.assign({}, server.handlerContext, {
    projectAccess: access,
    getProjectOwnerId: function () { return "owner-1"; },
    opts: {
      onSetProjectDefaultMode: function (slug, mode) { calls.push(["project", mode]); },
      onSetServerDefaultMode: function (mode) { calls.push(["server", mode]); },
    },
  });
  var handlers = require("../lib/project-sessions").attachSessions(ctx);
  return { handlers: handlers, calls: calls };
}

test("default-mode setters need an admin or the project owner", async function () {
  await withServer(async function (server) {
    var s = defaultSetters(server, {});
    server.sm.capabilitiesByVendor = { claude: claudeCapabilities() };
    // ok is per message type: the server-wide default is an admin's alone.
    var cases = [
      { who: { id: "u9", role: "user" }, ok: { project: false, server: false } },
      { who: null, ok: { project: false, server: false } },
      { who: { id: "owner-1", role: "user" }, ok: { project: true, server: false } },
      { who: { id: "a1", role: "admin" }, ok: { project: true, server: true } },
    ];
    cases.forEach(function (k0) {
      ["set_project_default_mode", "set_server_default_mode"].forEach(function (type) {
        var k = { who: k0.who, ok: k0.ok[type === "set_server_default_mode" ? "server" : "project"] };
        var c = client();
        c.ws._clagenticUser = k.who;
        c.ws._clagenticAuthenticated = true;
        server.connect(c.ws);
        c.inbox.length = 0;
        s.calls.length = 0;
        server.sm.currentPermissionMode = "default";
        s.handlers.handleSessionsMessage(c.ws, { type: type, mode: "acceptEdits" });
        assert.equal(s.calls.length, k.ok ? 1 : 0, type + " " + JSON.stringify(k.who));
        assert.equal(server.sm.currentPermissionMode, k.ok ? "acceptEdits" : "default");
        assert.equal(errors(c).length, k.ok ? 0 : 1);
      });
    });
  });
});

test("default-mode setters refuse bypassPermissions even for an admin", async function () {
  await withServer(async function (server) {
    var s = defaultSetters(server, {});
    var c = client();
    c.ws._clagenticUser = { id: "a1", role: "admin" };
    c.ws._clagenticAuthenticated = true;
    server.connect(c.ws);
    c.inbox.length = 0;
    ["set_project_default_mode", "set_server_default_mode"].forEach(function (type) {
      s.handlers.handleSessionsMessage(c.ws, { type: type, mode: "bypassPermissions" });
    });
    assert.deepEqual(s.calls, []);
    assert.notEqual(server.sm.currentPermissionMode, "bypassPermissions");
    assert.equal(errors(c).length, 2);
  });
});

test("in single-user mode the authenticated connection may set the default; an unauthenticated one may not", async function () {
  await withServer(async function (server) {
    var s = defaultSetters(server, { multiUser: false });
    var authed = client();
    authed.ws._clagenticAuthenticated = true;
    server.connect(authed.ws);
    s.handlers.handleSessionsMessage(authed.ws, { type: "set_project_default_mode", mode: "plan" });
    assert.deepEqual(s.calls, [["project", "plan"]]);
    s.calls.length = 0;
    var anon = client();
    server.connect(anon.ws);
    s.handlers.handleSessionsMessage(anon.ws, { type: "set_project_default_mode", mode: "default" });
    assert.deepEqual(s.calls, []);
  });
});

// ---------------------------------------------------------------------------
// The canUseTool bypass reads the session's mode
// ---------------------------------------------------------------------------

test("a project default of bypassPermissions does not approve a session whose own mode is default", async function () {
  await withServer(async function (server) {
    server.sm.currentPermissionMode = "bypassPermissions";
    server.session.permissionMode = "default";
    var r = server.ask("Write", { file_path: "/srv/app/b.txt" });
    assert.equal(r.opened.length, 1, "the session's own mode governs: this asks");
    server.sm.prompts.respond(r.id, { decision: "deny" });
    await r.promise;
  });
});

test("a session whose own mode is bypassPermissions is still approved, and one with none falls back to the default", async function () {
  await withServer(async function (server) {
    server.sm.currentPermissionMode = "default";
    server.session.permissionMode = "bypassPermissions";
    var own = server.ask("Write", { file_path: "/srv/app/b.txt" });
    assert.equal(own.opened.length, 0);
    assert.equal((await own.promise).behavior, "allow");
    server.session.permissionMode = null;
    server.sm.currentPermissionMode = "bypassPermissions";
    var fallback = server.ask("Write", { file_path: "/srv/app/b.txt" });
    assert.equal(fallback.opened.length, 0, "no session mode: the start-up fallback applies");
    server.session.permissionMode = "default";
  });
});

// ---------------------------------------------------------------------------
// A stored or loop mode the server does not allow is not started with
// ---------------------------------------------------------------------------

test("a stored bypassPermissions, or a loop's, does not start a query while the server forbids it", async function () {
  var server = await world.createServer();
  try {
    server.session.permissionMode = "bypassPermissions";
    await server.startQuery();
    var first = server.queryOptions[server.queryOptions.length - 1];
    assert.notEqual(first.adapterOptions.CLAUDE.permissionMode, "bypassPermissions");
    assert.equal(server.session.permissionMode, "default", "the session's own mode agrees");
    await server.endQuery();

    server.session.permissionMode = "default";
    server.session.loopSettings = { permissionMode: "bypassPermissions" };
    await server.startQuery();
    var second = server.queryOptions[server.queryOptions.length - 1];
    assert.notEqual(second.adapterOptions.CLAUDE.permissionMode, "bypassPermissions");
    await server.endQuery();

    server.session.loopSettings = { permissionMode: "acceptEdits" };
    await server.startQuery();
    var third = server.queryOptions[server.queryOptions.length - 1];
    assert.equal(third.adapterOptions.CLAUDE.permissionMode, "acceptEdits", "an allowed loop mode still applies");
    await server.endQuery();
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

// ---------------------------------------------------------------------------
// A worker's mode change stays on its own session
// ---------------------------------------------------------------------------

test("a stored auto mode on a vendor without auto starts in default", async function () {
  var server = await world.createServer();
  try {
    server.sm.capabilitiesByVendor = { claude: Object.assign({}, claudeCapabilities(), { permissionModes: ["default", "acceptEdits", "plan"] }) };
    server.session.permissionMode = "auto";
    await server.startQuery();
    var opts = server.queryOptions[server.queryOptions.length - 1];
    assert.notEqual(opts.adapterOptions.CLAUDE.permissionMode, "auto");
    assert.equal(server.session.permissionMode, "default");
    await server.endQuery();
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("a worker's refused permission_mode_changed is not stored", async function () {
  var server = await world.createServer();
  try {
    var events = [{ type: "_worker_meta", subtype: "permission_mode_changed", data: { mode: "bypassPermissions" } }];
    var adapter = {
      vendor: "claude",
      init: function () { return Promise.resolve({ models: [], skills: [] }); },
      supportedModels: function () { return Promise.resolve([]); },
      createQuery: function () {
        var handle = { pushMessage: function () {}, endInput: function () {}, close: function () {}, abort: function () {}, setPermissionMode: function () { return Promise.resolve(); } };
        handle[Symbol.asyncIterator] = function () {
          return { next: function () { return Promise.resolve(events.length ? { value: events.shift(), done: false } : { value: undefined, done: true }); } };
        };
        return Promise.resolve(handle);
      },
    };
    var bridge = require(world.LIB_ROOT + "/sdk-bridge").createSDKBridge({
      cwd: server.home, slug: "harness", sessionManager: server.sm, send: function () {},
      adapter: adapter, adapters: { claude: adapter }, onProcessingChanged: function () {},
    });
    server.session.permissionMode = "default";
    await bridge.startQuery(server.session, "go", null, null);
    await world.flush();
    if (server.session.streamPromise) await server.session.streamPromise;
    assert.equal(server.session.permissionMode, "default", "the previous mode stands");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("a worker's permission_mode_changed changes that session only, not the project mode", async function () {
  var server = await world.createServer();
  try {
    var events = [{ type: "_worker_meta", subtype: "permission_mode_changed", data: { mode: "plan" } }];
    var adapter = {
      vendor: "claude",
      init: function () { return Promise.resolve({ models: [], skills: [] }); },
      supportedModels: function () { return Promise.resolve([]); },
      createQuery: function () {
        var handle = { pushMessage: function () {}, endInput: function () {}, close: function () {}, abort: function () {}, setPermissionMode: function () { return Promise.resolve(); } };
        handle[Symbol.asyncIterator] = function () {
          return { next: function () { return Promise.resolve(events.length ? { value: events.shift(), done: false } : { value: undefined, done: true }); } };
        };
        return Promise.resolve(handle);
      },
    };
    var bridge = require(world.LIB_ROOT + "/sdk-bridge").createSDKBridge({
      cwd: server.home, slug: "harness", sessionManager: server.sm, send: function () {},
      adapter: adapter, adapters: { claude: adapter }, onProcessingChanged: function () {},
    });
    var other = server.sm.createSessionRaw({});
    other.permissionMode = "default";
    server.sm.sessions.set(other.localId, other);
    server.sm.currentPermissionMode = "default";
    await bridge.startQuery(server.session, "go", null, null);
    await world.flush();
    if (server.session.streamPromise) await server.session.streamPromise;
    assert.equal(server.session.permissionMode, "plan", "the session whose worker changed");
    assert.equal(server.sm.currentPermissionMode, "default", "the project mode is untouched");
    assert.equal(other.permissionMode, "default", "so is every other session's");
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

// ---------------------------------------------------------------------------
// A plan answer changes only its own session's mode
// ---------------------------------------------------------------------------

test("a plan answer changes the answering session's mode (and the new session's), never the project mode", async function () {
  await withServer(async function (server) {
    var { attachPromptResponses } = require("../lib/project-prompt-responses");
    var started = [];
    var noop = function () {};
    var sdkStub = {
      setPermissionMode: noop,
      pushMessage: noop,
      startQuery: function (s) { started.push(s); },
    };
    var bystander = server.sm.createSessionRaw({});
    server.sm.sessions.set(bystander.localId, bystander);
    var responses = attachPromptResponses({
      sm: server.sm, sdk: sdkStub, send: noop, sendTo: noop, sendToSession: noop,
      getSessionForWs: function () { return server.session; },
      ensureProjectAccessForSession: function () { return null; },
    });
    server.sm.currentPermissionMode = "default";

    var accept = server.sm.prompts.open(server.session, "plan", { toolName: "ExitPlanMode", toolInput: { plan: "p" } });
    responses.handlePromptMessage({}, { type: "prompt_response", kind: "plan", requestId: accept.requestId, decision: "allow_accept_edits" });
    assert.equal(server.session.permissionMode, "acceptEdits");
    assert.equal(server.sm.currentPermissionMode, "default");
    assert.equal(bystander.permissionMode, undefined);
    await accept.answer;

    server.session.permissionMode = "plan";
    var clear = server.sm.prompts.open(server.session, "plan", { toolName: "ExitPlanMode", toolInput: { plan: "p" } });
    responses.handlePromptMessage({}, { type: "prompt_response", kind: "plan", requestId: clear.requestId, decision: "allow_clear_context", planContent: "step one" });
    assert.equal(server.session.permissionMode, "acceptEdits");
    assert.equal(server.sm.currentPermissionMode, "default");
    var deadline = Date.now() + 5000;
    while (started.length === 0 && Date.now() < deadline) await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(started.length, 1);
    assert.equal(started[0].permissionMode, "acceptEdits", "the new session runs with edits accepted");
    assert.equal(server.sm.currentPermissionMode, "default");
    assert.equal(bystander.permissionMode, undefined);
    await clear.answer;
  });
});
