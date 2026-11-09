"use strict";
// The MCP bridge is admitted by a per-project credential, never by the peer
// address. Covers the helper, the server request path (a loopback socket with a
// proxy header and no credential is refused, as is a credential for another
// project), and the Codex adapter's hand-over of the credential in the
// app-server environment rather than in its argv-bound config.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var cred = require("../lib/mcp-bridge-credential");
var codexAppServerModule = require("../lib/yoke/codex-app-server");
// Patched before anything loads the adapter, which binds the class on require.
var servers = [];
function FakeAppServer(executablePath, opts) {
  this.opts = opts || {};
  this.resolution = { path: "/usr/local/bin/codex", version: "0.162.1", source: "path" };
  servers.push(this);
}
FakeAppServer.prototype.start = function () { return Promise.resolve(); };
FakeAppServer.prototype.stop = function () {};
FakeAppServer.prototype.notify = function () {};
FakeAppServer.prototype.respond = function () {};
FakeAppServer.prototype.send = function (method) {
  if (method === "initialize") return Promise.resolve({ userAgent: "clagentic-console/0.162.1 (Ubuntu 24.4.0; x86_64) test", codexHome: "/h/.codex", platformFamily: "unix", platformOs: "linux" });
  if (method === "model/list") return Promise.resolve({ data: [{ model: "m", displayName: "M", isDefault: true }] });
  if (method === "skills/list") return Promise.resolve({ data: [] });
  return Promise.resolve({});
};
FakeAppServer.prototype.addEventHandler = function () { return {}; };
FakeAppServer.prototype.removeEventHandler = function () {};
FakeAppServer.prototype.updateHandlerThreadId = function () {};
codexAppServerModule.CodexAppServer = FakeAppServer;

var harness = require("./access-harness");

// --- helper ---

test("a credential verifies for its own project only", function () {
  var a = cred.credentialFor("alpha");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(cred.verifyCredential("alpha", a), true);
  assert.equal(cred.verifyCredential("beta", a), false);
  assert.notEqual(a, cred.credentialFor("beta"));
});

test("verification refuses without throwing on any wrong input", function () {
  var inputs = [undefined, null, "", "x", "x".repeat(10000), 42, {}, ["a"], cred.credentialFor("alpha") + "0"];
  inputs.forEach(function (v) {
    assert.doesNotThrow(function () { assert.equal(cred.verifyCredential("alpha", v), false); });
  });
});

// --- server request path ---

var H = null;
var ACTION = { action: "no-such-action" };

test.before(async function () {
  H = await harness.start({
    users: [{ key: "admin", username: "owner-admin", role: "admin" }],
    projects: [
      { slug: "alpha", visibility: "public", ownerKey: "admin" },
      { slug: "beta", visibility: "public", ownerKey: "admin" },
    ],
  });
});

test.after(async function () {
  if (H) await H.stop();
});

test("a loopback socket with a proxy header and no credential is not admitted", async function () {
  var res = await H.request("POST", "/p/alpha/api/mcp-bridge", null, ACTION, { "X-Forwarded-For": "203.0.113.7" });
  assert.equal(res.status, 401);
});

test("a loopback socket with no credential and no proxy header is not admitted", async function () {
  var res = await H.request("POST", "/p/alpha/api/mcp-bridge", null, ACTION);
  assert.equal(res.status, 401);
});

test("a wrong credential is not admitted", async function () {
  var res = await H.request("POST", "/p/alpha/api/mcp-bridge", null, ACTION, { [cred.HEADER_NAME]: "nope" });
  assert.equal(res.status, 401);
});

test("the credential for the project is admitted to the bridge handler", async function () {
  var res = await H.request("POST", "/p/alpha/api/mcp-bridge", null, ACTION, { [cred.HEADER_NAME]: cred.credentialFor("alpha") });
  assert.equal(res.status, 400, "reached the handler, which rejects the unknown action");
});

test("the credential for another project is refused", async function () {
  var res = await H.request("POST", "/p/beta/api/mcp-bridge", null, ACTION, { [cred.HEADER_NAME]: cred.credentialFor("alpha") });
  assert.equal(res.status, 401);
});

// --- Codex adapter hand-over ---

test("the codex adapter hands the credential to the bridge child through the environment, not the config", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cred-"));
  var adapter;
  try {
    var codexModule = require("../lib/yoke/adapters/codex");
    adapter = codexModule.createCodexAdapter({ cwd: dir, slug: "alpha" });
    await adapter.init({ runtimeEnv: null });
    var server = servers[servers.length - 1];
    var token = cred.credentialFor("alpha");
    var bridge = server.opts.config.mcp_servers["clay-tools"];
    assert.equal(server.opts.secretEnv[cred.ENV_NAME], token);
    assert.equal(server.opts.env, undefined);
    assert.deepEqual(bridge.env_vars, [cred.ENV_NAME]);
    assert.equal(JSON.stringify(server.opts.config).includes(token), false, "the config becomes --config argv and is logged");
    assert.equal(JSON.stringify(bridge.args).includes(token), false);
  } finally {
    if (adapter) await adapter.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a server auth token never reaches the app-server argv or the bridge env", async function () {
  var secret = "server-auth-token-value-0123456789";
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cred-"));
  var adapter;
  try {
    var codexModule = require("../lib/yoke/adapters/codex");
    adapter = codexModule.createCodexAdapter({ cwd: dir, slug: "alpha" });
    await adapter.init({ runtimeEnv: null, clayAuthToken: secret });
    var server = servers[servers.length - 1];
    var argv = codexAppServerModule.serializeConfig(server.opts.config, "").join(" ");
    assert.equal(argv.includes(secret), false);
    assert.equal(argv.includes("CLAY_AUTH_TOKEN"), false);
    assert.equal(JSON.stringify(server.opts).includes(secret), false);
    assert.equal(server.opts.config.mcp_servers["clay-tools"].env, undefined);
  } finally {
    if (adapter) await adapter.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the bridge admitted on its credential alone, with no cookie", async function () {
  var res = await H.request("POST", "/p/alpha/api/mcp-bridge", null, { action: "list_tools" }, { [cred.HEADER_NAME]: cred.credentialFor("alpha") });
  assert.equal(res.status, 200);
});
