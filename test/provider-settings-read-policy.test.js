"use strict";
// Which Claude settings file the daemon reads for a session's provider and
// capability decisions. A project's environment text is written by its owner,
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
  fs.writeFileSync(path.join(elsewhere, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "x" } }));
  config.projects[0].envrc = "CLAUDE_CONFIG_DIR=" + elsewhere;
  config.projects[1].envrc = "CLAUDE_CONFIG_DIR=" + elsewhere;
});

test.after(function () {
  PROVIDER_VARS.forEach(function (n) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  });
  fs.rmSync(elsewhere, { recursive: true });
});

test("multi-user: a non-admin owner's CLAUDE_CONFIG_DIR is not read; an administrator's is", async function () {
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
    try {
      asOwner = await shownForAuthError(s.ctxs.mine, s.server.people.owner.id);
      assert.equal(spy.readElsewhere(), false, "the owner-edited path is never opened");
    } finally { spy.restore(); }
    assert.ok(asOwner.some(function (m) { return m.type === "auth_required"; }), "no provider is seen, so sign-in is still offered");

    var asAdmin = await shownForAuthError(s.ctxs.admins, s.server.people.admin.id);
    assert.equal(asAdmin.some(function (m) { return m.type === "auth_required"; }), false);
    assert.match(asAdmin.filter(function (m) { return m.type === "error"; })[0].text, /Amazon Bedrock/);
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
    var policy = s.ctxs.mine.sdk.getSettingsReadPolicy(null);
    assert.equal(policy.osUsers, true);
    var spy = spyOnSettingsReads();
    try {
      var session = s.ctxs.mine.sm.createSessionRaw({ ownerId: s.server.people.admin.id });
      assert.equal(s.ctxs.mine.sdk.getSettingsReadPolicy(session).osUsers, true);
      require("../lib/claude-settings-env").applyUserSettingsEnv(
        s.ctxs.mine.sdk.getEffectiveRuntimeEnv(session), { readPolicy: s.ctxs.mine.sdk.getSettingsReadPolicy(session) });
      assert.deepEqual(spy.reads.filter(function (f) { return /settings\.json$/.test(f); }), []);
    } finally { spy.restore(); }
  } finally {
    await s.server.stop();
  }
});

// The capability ledger is one entry per vendor and every client reads it, so
// it must not depend on which session reported last. The project's text reaches
// only its owner's sessions in multi-user mode, so the environments differ.
test("capabilities are recorded from the environment no session owns, so one owner's provider does not decide them", async function () {
  var savedProject = config.projects[0].envrc;
  config.projects[0].envrc = "CLAUDE_CODE_USE_BEDROCK=1\nAWS_PROFILE=x";
  var s = await startServer({
    users: [
      { key: "admin", username: "admin", role: "admin" },
      { key: "owner", username: "owner", role: "user" },
    ],
    projects: [{ slug: "mine", ownerKey: "owner" }],
  });
  try {
    await s.server.connect("mine", "owner");
    await sleep(400);
    var ctx = s.ctxs.mine;
    var ownerSession = ctx.sm.createSessionRaw({ ownerId: s.server.people.owner.id });
    var otherSession = ctx.sm.createSessionRaw({ ownerId: s.server.people.admin.id });
    assert.equal(ctx.sdk.getEffectiveRuntimeEnv(ownerSession).CLAUDE_CODE_USE_BEDROCK, "1");
    assert.equal(ctx.sdk.getEffectiveRuntimeEnv(otherSession).CLAUDE_CODE_USE_BEDROCK, undefined, "the two sessions' environments differ");
    // A session on a vendor whose models are not yet known reports that
    // vendor's capabilities when its turn starts.
    ownerSession.vendor = "claude";
    if (ctx.sm.modelsByVendor) delete ctx.sm.modelsByVendor.claude;
    ownerSession.isProcessing = true;
    await ctx.sdk.startQuery(ownerSession, "auth-error", null, null);
    await waitFor(function () {
      return ownerSession.history.some(function (m) { return m.type === "done"; });
    }, "the turn to end");
    if (ownerSession.queryInstance) ownerSession.queryInstance.close();
    assert.equal(ctx.sm.capabilitiesByVendor.claude.webSearch, true, "the owner's session did not narrow the shared ledger");
  } finally {
    config.projects[0].envrc = savedProject;
    await s.server.stop();
  }
});
