// Tables keyed by names and ids that come from outside (a client, a worker, an
// MCP server, a config file) have no prototype to answer for "constructor" or
// "__proto__", and the MCP bridge accepts a result only from the socket the
// call went to.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-hostile-keys-"));
process.env.CLAGENTIC_CONSOLE_HOME = path.join(SANDBOX, "data");
process.env.HOME = path.join(SANDBOX, "home");

var { createSessionManager } = require("../lib/sessions");
var { promptsFor } = require("../lib/prompt-registry");
var { sanitizeAllowedTools } = require("../lib/utils");
var { attachMcp } = require("../lib/project-mcp");
var { createLocalMcp } = require("../lib/mcp-local");

test.after(function () { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

var NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"];

function isMap(obj) {
  return Object.getPrototypeOf(obj) === null;
}

function newManager() {
  return createSessionManager({ cwd: path.join(SANDBOX, "project"), send: function () {}, sendTo: function () {}, sendEach: function () {} });
}

// --- session stores ---------------------------------------------------------

test("a session's prompt stores, grants and the request index have no prototype", function () {
  var sm = newManager();
  var created = sm.createSessionRaw({});
  var resumed = sm.resumeSession("hostile-keys-resume", { history: [], title: "r" }, null);
  [created, resumed].forEach(function (s) {
    assert.ok(isMap(s.pendingPermissions), "pendingPermissions");
    assert.ok(isMap(s.pendingAskUser), "pendingAskUser");
    assert.ok(isMap(s.allowedTools), "allowedTools");
  });
  assert.ok(isMap(sm.permissionRequestIndex), "the request index");
});

test("a registry that builds its own stores builds them without a prototype", function () {
  var sm = { sessions: new Map(), sendAndRecord: function () {}, saveSessionFile: function () {} };
  var s = { localId: 1, history: [] };
  sm.sessions.set(1, s);
  var prompts = promptsFor(sm);
  assert.ok(isMap(sm.permissionRequestIndex));
  prompts.taskStarted(s, "task");
  prompts.noteSubagentTool(s, "tool", "task");
  assert.ok(isMap(s.activeTaskToolIds));
  assert.ok(isMap(s.subagentToolOwners));
  prompts.grant(s, "Bash", { command: "ls" });
  assert.ok(isMap(s.allowedTools));
});

test("looking up a hostile name finds nothing, in the stores and in the index", function () {
  var sm = newManager();
  var s = sm.createSessionRaw({});
  var prompts = promptsFor(sm);
  NAMES.forEach(function (name) {
    assert.equal(s.pendingPermissions[name], undefined, name);
    assert.equal(sm.permissionRequestIndex[name], undefined, name);
    assert.equal(prompts.lookup(name), null, name);
    assert.deepEqual(prompts.respond(name, { decision: "allow" }), { status: "stale" }, name);
  });
});

test("a persisted grant map keeps only true-valued tool names and has no prototype", function () {
  var parsed = JSON.parse('{"Bash": true, "__proto__": true, "constructor": true, "Edit": "yes"}');
  var clean = sanitizeAllowedTools(parsed);
  assert.ok(isMap(clean));
  assert.deepEqual(Object.keys(clean).sort(), ["Bash", "__proto__", "constructor"]);
  assert.equal(Object.getPrototypeOf(clean), null, "the __proto__ entry is data, not a prototype");
  assert.equal({}.Bash, undefined);
  assert.ok(isMap(sanitizeAllowedTools(null)));
});

// --- MCP bridge -------------------------------------------------------------

function bridge(extensionSocket) {
  var sent = [];
  var mcp = attachMcp({
    send: function () {},
    sendTo: function (ws, msg) { sent.push({ ws: ws, msg: msg }); },
    slug: "p",
    getExtensionWs: function () { return extensionSocket; },
    getEnabledMcpServers: function () { return ["srv", "__proto__"]; },
    setEnabledMcpServers: function () {},
    localMcp: null,
  });
  return { mcp: mcp, sent: sent };
}

async function offerServer(b, ws) {
  b.mcp.handleMcpMessage(ws, { type: "mcp_servers_available", hostConnected: true, servers: [
    { name: "srv", tools: [{ name: "t", description: "d", inputSchema: { properties: {} } }] },
  ] });
}

test("the MCP bridge's server and call tables have no prototype", async function () {
  var ext = { readyState: 1 };
  var b = bridge(ext);
  await offerServer(b, ext);
  assert.ok(isMap(b.mcp.getMcpServers()));
  assert.ok(b.mcp.getMcpServers().srv, "the offered server is there");
  assert.equal(b.mcp.getMcpServers().constructor, undefined, "and a hostile name is not");
  assert.equal(b.mcp.getMcpServers().__proto__, undefined);
});

test("hostile mcp_servers_available payloads are skipped, not thrown on", function () {
  var ext = { readyState: 1 };
  var b = bridge(ext);
  var payloads = [
    { servers: null }, { servers: 5 }, { servers: { length: 3 } }, { servers: "text" },
    { servers: [null, 7, "x", {}, { name: 5 }, { name: { toString: 1 } }, { name: "__proto__", tools: "no" }, { name: "constructor", tools: [1] }] },
  ];
  payloads.forEach(function (p) {
    assert.doesNotThrow(function () {
      b.mcp.handleMcpMessage(ext, Object.assign({ type: "mcp_servers_available" }, p));
    }, JSON.stringify(p));
  });
  assert.equal({}.polluted, undefined);
});

test("a tool result is accepted only from the socket the call went to", async function () {
  var ext = { readyState: 1 };
  var other = { readyState: 1 };
  var b = bridge(ext);
  await offerServer(b, ext);
  var tool = b.mcp.getMcpServers().srv.instance._registeredTools.t;
  var settled = null;
  var call = tool.handler({}).then(function (r) { settled = { ok: r }; }, function (e) { settled = { err: e.message }; });
  var request = b.sent.filter(function (s) { return s.msg.type === "mcp_tool_call"; })[0];
  assert.equal(request.ws, ext, "the call went to the extension socket");
  var callId = request.msg.callId;

  b.mcp.handleMcpMessage(other, { type: "mcp_tool_result", callId: callId, result: { content: [{ type: "text", text: "forged" }] } });
  b.mcp.handleMcpMessage(other, { type: "mcp_tool_error", callId: callId, error: "forged failure" });
  NAMES.concat([5, null, {}, [callId], { toString: 1 }]).forEach(function (id) {
    assert.doesNotThrow(function () {
      b.mcp.handleMcpMessage(ext, { type: "mcp_tool_result", callId: id, result: {} });
      b.mcp.handleMcpMessage(ext, { type: "mcp_tool_error", callId: id, error: "x" });
    }, JSON.stringify(id));
  });
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(settled, null, "nothing the wrong socket or a hostile id sent settled the call");

  b.mcp.handleMcpMessage(ext, { type: "mcp_tool_result", callId: callId, result: { content: [{ type: "text", text: "real" }] } });
  await call;
  assert.equal(settled.ok.content[0].text, "real");
});

test("a hostile name toggled on or off changes nothing", function () {
  var ext = { readyState: 1 };
  var enabled = [];
  var mcp = attachMcp({
    send: function () {}, sendTo: function () {}, slug: "p",
    getExtensionWs: function () { return ext; },
    getEnabledMcpServers: function () { return enabled; },
    setEnabledMcpServers: function (list) { enabled = list; },
  });
  [5, null, {}, [], { toString: 1 }, ""].forEach(function (name) {
    assert.doesNotThrow(function () { mcp.handleMcpMessage(ext, { type: "mcp_toggle_server", name: name, enabled: true }); });
  });
  assert.deepEqual(enabled, []);
  mcp.handleMcpMessage(ext, { type: "mcp_toggle_server", name: "srv", enabled: true });
  assert.deepEqual(enabled, ["srv"]);
});

// --- local MCP process manager ------------------------------------------------

test("removing or calling a server named like an inherited property does not throw", async function () {
  var local = createLocalMcp();
  NAMES.forEach(function (name) {
    assert.doesNotThrow(function () { local.removeServer(name); }, name);
  });
  for (var i = 0; i < NAMES.length; i++) {
    await assert.rejects(local.callTool(NAMES[i], "t", {}), /not running/);
  }
  assert.equal({}.polluted, undefined);
  local.shutdown();
});
