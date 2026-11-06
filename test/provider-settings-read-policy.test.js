"use strict";
// Which Claude settings file the daemon reads for a session's provider
// decisions: exactly one, located from the daemon's own environment.
// Environment text saved in Settings never chooses the path, whoever wrote it,
// and under os-users mode no file is read. Real server and SDK bridge; the
// Claude Agent SDK is the stand-in (test/fixtures/fake-agent-sdk).

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
var emptyDir = null;
var config = { sharedEnv: "", projects: [{ slug: "mine" }, { slug: "admins" }] };
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
  elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "settings-policy-"));
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-policy-daemon-"));
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-policy-empty-"));
  // The directory the edited text names holds a Bedrock file; the daemon's own
  // directory holds a Vertex one, so which was read shows in the message.
  fs.writeFileSync(path.join(elsewhere, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "x" } }));
  fs.writeFileSync(path.join(daemonDir, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p" } }));
  process.env.CLAUDE_CONFIG_DIR = daemonDir;
  config.projects[0].envrc = "CLAUDE_CONFIG_DIR=" + elsewhere;
  config.projects[1].envrc = "CLAUDE_CONFIG_DIR=" + elsewhere;
});

test.after(function () {
  PROVIDER_VARS.forEach(function (n) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  });
  [elsewhere, daemonDir, emptyDir].forEach(function (d) { fs.rmSync(d, { recursive: true }); });
});

test("multi-user: the daemon's file is read for owner and administrator alike; an edited CLAUDE_CONFIG_DIR never is", async function () {
  var s = await startServer({
    users: [
      { key: "admin", username: "admin", role: "admin" },
      { key: "owner", username: "owner", role: "user" },
    ],
    projects: [{ slug: "mine", ownerKey: "owner" }, { slug: "admins", ownerKey: "admin" }],
  });
  try {
    await s.server.connect("mine", "owner");
    await s.server.connect("admins", "admin");
    await sleep(400);

    var spy = spyOnSettingsReads();
    var asOwner;
    var asAdmin;
    try {
      asOwner = await shownForAuthError(s.ctxs.mine, s.server.people.owner.id);
      asAdmin = await shownForAuthError(s.ctxs.admins, s.server.people.admin.id);
      assert.equal(spy.readElsewhere(), false, "the edited path is never opened");
      assert.ok(spy.reads.some(function (f) { return f.indexOf(daemonDir) === 0; }), "the daemon's file is read");
    } finally { spy.restore(); }
    [asOwner, asAdmin].forEach(function (shown) {
      assert.equal(shown.some(function (m) { return m.type === "auth_required"; }), false);
      assert.match(shown.filter(function (m) { return m.type === "error"; })[0].text, /Google Vertex/);
    });
  } finally {
    await s.server.stop();
  }
});

test("os-users: the daemon reads no settings file for the session", async function () {
  var s = await startServer({
    users: [{ key: "admin", username: "admin", role: "admin" }],
    osUsers: true,
    projects: [{ slug: "mine", ownerKey: "admin" }],
  });
  try {
    var spy = spyOnSettingsReads();
    try {
      var session = s.ctxs.mine.sm.createSessionRaw({ ownerId: s.server.people.admin.id });
      var shown = await shownForAuthError(s.ctxs.mine, s.server.people.admin.id);
      assert.ok(shown.length > 0);
      assert.deepEqual(spy.reads.filter(function (f) { return /settings\.json$/.test(f); }), []);
      assert.ok(session);
    } finally { spy.restore(); }
  } finally {
    await s.server.stop();
  }
});
