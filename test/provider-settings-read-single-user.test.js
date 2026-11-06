"use strict";
// Single-user host: the daemon reads its own Claude settings file, and a
// CLAUDE_CONFIG_DIR line in the project's text does not redirect the read. Its
// own file because the test harness holds process-wide user state per server.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var nodeModule = require("node:module");
var { pathToFileURL } = require("url");

nodeModule.register(pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "resolve-hook.mjs")).href);

var harness = require("./access-harness");
var { createEnvSettings } = require("../lib/daemon-env-settings");

var PROVIDER_VARS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CONFIG_DIR"];
var savedEnv = {};
var elsewhere = null;
var daemonDir = null;
var config = { sharedEnv: "", projects: [{ slug: "mine" }] };
var envSettings = createEnvSettings({
  getConfig: function () { return config; },
  saveConfig: function () {},
});

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function waitFor(predicate, label) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for " + label);
}

function bridgeBeforeServer() {
  var yoke = require("../lib/yoke");
  yoke.createAdapters = function (opts) {
    return { adapters: { claude: yoke.createAdapter({ vendor: "claude", cwd: opts.cwd }) }, auth: { claude: true } };
  };
}

test.before(function () {
  PROVIDER_VARS.forEach(function (n) { savedEnv[n] = process.env[n]; delete process.env[n]; });
  elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "settings-read-su-else-"));
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-read-su-daemon-"));
  fs.writeFileSync(path.join(elsewhere, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "x" } }));
  fs.writeFileSync(path.join(daemonDir, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p" } }));
  process.env.CLAUDE_CONFIG_DIR = daemonDir;
  config.projects[0].envrc = "CLAUDE_CONFIG_DIR=" + elsewhere;
});

test.after(function () {
  PROVIDER_VARS.forEach(function (n) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  });
  fs.rmSync(elsewhere, { recursive: true });
  fs.rmSync(daemonDir, { recursive: true });
});

test("single-user: the daemon's file is read and the project's CLAUDE_CONFIG_DIR is not", async function () {
  var server = await harness.start({
    serverOpts: envSettings,
    beforeServer: bridgeBeforeServer,
    users: [{ key: "admin", username: "admin", role: "admin" }],
    multiUser: false,
    projects: [{ slug: "mine", ownerKey: "admin" }],
  });
  var real = fs.readFileSync;
  var reads = [];
  try {
    var ctx = null;
    server.relay.forEachProject(function (c) { ctx = c; });
    await server.connect("mine", "admin");
    await sleep(400);
    fs.readFileSync = function (file) {
      reads.push(String(file));
      return real.apply(fs, arguments);
    };
    var session = ctx.sm.createSessionRaw({ ownerId: server.people.admin.id });
    session.isProcessing = true;
    await ctx.sdk.startQuery(session, "auth-error", null, null);
    await waitFor(function () {
      return session.history.some(function (m) { return m.type === "done"; });
    }, "the turn to end");
    if (session.queryInstance) session.queryInstance.close();
    var shown = session.history.filter(function (m) { return m.type === "error" || m.type === "auth_required"; });
    assert.match(shown.filter(function (m) { return m.type === "error"; })[0].text, /Google Vertex/);
    assert.equal(reads.some(function (f) { return f.indexOf(elsewhere) === 0; }), false);
  } finally {
    fs.readFileSync = real;
    await server.stop();
  }
});
