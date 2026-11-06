"use strict";
// An auth-like error from a session whose runtime is configured for a cloud
// provider (Bedrock, Vertex, Foundry) names that provider and offers no
// sign-in, whether the provider is selected in Settings, in the daemon's
// environment, or both. Real server, real project context and SDK bridge; only
// the Claude Agent SDK is the stand-in (test/fixtures/fake-agent-sdk).

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var nodeModule = require("node:module");
var { pathToFileURL } = require("url");

nodeModule.register(pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "resolve-hook.mjs")).href);

var harness = require("./access-harness");
var { createEnvSettings } = require("../lib/daemon-env-settings");

var config = { sharedEnv: "", projects: [{ slug: "alpha" }] };
var envSettings = createEnvSettings({
  getConfig: function () { return config; },
  saveConfig: function () {},
});

var PROVIDER_VARS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
var server = null;
var alpha = null;
var savedEnv = {};

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function waitFor(predicate, label) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for " + label);
}

// Runs one turn that fails with an auth-like error and returns what the user
// was shown for it.
async function shownForAuthError() {
  var session = alpha.sm.createSessionRaw({ ownerId: server.people.admin.id });
  // The message handler marks the session processing before it starts a query.
  session.isProcessing = true;
  await alpha.sdk.startQuery(session, "auth-error", null, null);
  await waitFor(function () {
    return session.history.some(function (m) { return m.type === "done"; });
  }, "the turn to end");
  if (session.queryInstance) session.queryInstance.close();
  return session.history.filter(function (m) { return m.type === "error" || m.type === "auth_required"; });
}

function clearProviders() {
  config.sharedEnv = "";
  PROVIDER_VARS.forEach(function (name) { delete process.env[name]; });
}

test.before(async function () {
  PROVIDER_VARS.forEach(function (name) { savedEnv[name] = process.env[name]; });
  server = await harness.start({
    users: [{ key: "admin", username: "admin", role: "admin" }],
    projects: [{ slug: "alpha", ownerKey: "admin" }],
    serverOpts: envSettings,
    beforeServer: function () {
      var yoke = require("../lib/yoke");
      yoke.createAdapters = function (opts) {
        return { adapters: { claude: yoke.createAdapter({ vendor: "claude", cwd: opts.cwd }) }, auth: { claude: true } };
      };
    },
  });
  server.relay.forEachProject(function (ctx, slug) { if (slug === "alpha") alpha = ctx; });
  var admin = await server.connect("alpha", "admin");
  assert.equal(admin.ok, true);
  await sleep(400);
});

test.after(async function () {
  PROVIDER_VARS.forEach(function (name) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  });
  if (server) await server.stop();
});

var CASES = [
  { name: "Amazon Bedrock", text: "CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nAWS_PROFILE=host" },
  { name: "Google Vertex AI", text: "CLAUDE_CODE_USE_VERTEX=1\nANTHROPIC_VERTEX_PROJECT_ID=p\nGOOGLE_APPLICATION_CREDENTIALS=/nonexistent.json" },
  { name: "Microsoft Foundry", text: "CLAUDE_CODE_USE_FOUNDRY=1\nANTHROPIC_FOUNDRY_RESOURCE=r\nANTHROPIC_FOUNDRY_API_KEY=k" },
];

CASES.forEach(function (c) {
  test("provider set only in Settings: " + c.name + " is named and no sign-in is offered", async function () {
    clearProviders();
    config.sharedEnv = c.text;
    var shown = await shownForAuthError();
    assert.equal(shown.some(function (m) { return m.type === "auth_required"; }), false, "no login is offered");
    var errors = shown.filter(function (m) { return m.type === "error"; });
    assert.equal(errors.length, 1);
    assert.match(errors[0].text, new RegExp(c.name));
    assert.match(errors[0].text, /credentials failed/);
    assert.doesNotMatch(errors[0].text, /not logged in/i);
  });
});

test("provider set only in the daemon's environment: named, no sign-in", async function () {
  clearProviders();
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  var shown = await shownForAuthError();
  assert.equal(shown.some(function (m) { return m.type === "auth_required"; }), false);
  assert.match(shown.filter(function (m) { return m.type === "error"; })[0].text, /Amazon Bedrock/);
});

test("provider set in both places: named once, no sign-in", async function () {
  clearProviders();
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  config.sharedEnv = "CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1";
  var shown = await shownForAuthError();
  assert.equal(shown.some(function (m) { return m.type === "auth_required"; }), false);
  var errors = shown.filter(function (m) { return m.type === "error"; });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].text.split("Amazon Bedrock").length - 1, 1, "the provider is named once in the message");
});

test("a provider failure on the canned login reply resets the CLI session, with no sign-in offered", async function () {
  clearProviders();
  config.sharedEnv = "CLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nAWS_PROFILE=host";
  var session = alpha.sm.createSessionRaw({ ownerId: server.people.admin.id });
  session.vendor = "claude";
  session.cliSessionId = "cli-before";
  session.responsePreview = "Not logged in · Please run /login";
  alpha.sdk.processSDKMessage(session, { yokeType: "result", cost: 0, duration: 1, usage: null, sessionId: "cli-before" });
  assert.equal(session.history.some(function (m) { return m.type === "auth_required"; }), false);
  assert.ok(session.history.some(function (m) { return m.type === "error" && /Amazon Bedrock/.test(m.text); }));
  assert.equal(session.cliSessionId, null, "the next turn must not resume the broken session");
});

test("no provider: the message does not claim a provider's credentials failed", async function () {
  clearProviders();
  var shown = await shownForAuthError();
  shown.forEach(function (m) {
    assert.doesNotMatch(m.text || "", /credentials failed/);
  });
});
