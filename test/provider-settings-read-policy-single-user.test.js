"use strict";
// Single-user host: the project's CLAUDE_CONFIG_DIR is honoured. Its own file
// because the test harness holds process-wide user state per server.
// (Which Claude settings file the daemon reads for provider and capability decisions.) A project's environment text is written by its owner,
// so in multi-user mode only an administrator's session may let it choose the
// directory; the daemon never reads a file on behalf of a session that runs as
// another OS user. Real server and SDK bridge; the Claude Agent SDK is the
// stand-in (test/fixtures/fake-agent-sdk).

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

async function startServer(spec) {
  var server = await harness.start(Object.assign({ serverOpts: envSettings, beforeServer: bridgeBeforeServer }, spec));
  var ctxs = {};
  server.relay.forEachProject(function (ctx, slug) { ctxs[slug] = ctx; });
  return { server: server, ctxs: ctxs };
}

// An auth-like failure on a session owned by `ownerId`; returns what was shown.
async function shownForAuthError(ctx, ownerId) {
  var session = ctx.sm.createSessionRaw({ ownerId: ownerId });
  session.isProcessing = true;
  await ctx.sdk.startQuery(session, "auth-error", null, null);
  await waitFor(function () {
    return session.history.some(function (m) { return m.type === "done"; });
  }, "the turn to end");
  if (session.queryInstance) session.queryInstance.close();
  return session.history.filter(function (m) { return m.type === "error" || m.type === "auth_required"; });
}

function spyOnSettingsReads() {
  var real = fs.readFileSync;
  var reads = [];
  fs.readFileSync = function (file) {
    reads.push(String(file));
    return real.apply(fs, arguments);
  };
  return {
    reads: reads,
    restore: function () { fs.readFileSync = real; },
    readElsewhere: function () { return reads.some(function (f) { return f.indexOf(elsewhere) === 0; }); },
  };
}


test.before(function () {
  PROVIDER_VARS.forEach(function (n) { savedEnv[n] = process.env[n]; delete process.env[n]; });
  elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "settings-policy-su-"));
  fs.writeFileSync(path.join(elsewhere, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "x" } }));
  config.projects[0].envrc = "CLAUDE_CONFIG_DIR=" + elsewhere;
});

test.after(function () {
  PROVIDER_VARS.forEach(function (n) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  });
  fs.rmSync(elsewhere, { recursive: true });
});

test("single-user: the project's CLAUDE_CONFIG_DIR is honoured as before", async function () {
  var s = await startServer({
    users: [{ key: "admin", username: "admin", role: "admin" }],
    multiUser: false,
    projects: [{ slug: "mine", ownerKey: "admin" }],
  });
  try {
    await s.server.connect("mine", "admin");
    await sleep(400);
    var shown = await shownForAuthError(s.ctxs.mine, s.server.people.admin.id);
    assert.match(shown.filter(function (m) { return m.type === "error"; })[0].text, /Amazon Bedrock/);
  } finally {
    await s.server.stop();
  }
});

