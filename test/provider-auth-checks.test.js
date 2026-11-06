"use strict";
// The auth probes and the provider message read the composed runtime
// environment (Settings over the daemon's), the one the spawn is given.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var authChecks = require("../lib/yoke/auth-checks");
var providerCredentials = require("../lib/yoke/provider-credentials");
var runtimeEnv = require("../lib/runtime-env");
var vendorAuth = require("../lib/vendor-auth");
var claudeSettingsEnv = require("../lib/claude-settings-env");

// An actor whose environment text may choose the settings directory.
function trusting(env) {
  return claudeSettingsEnv.settingsReadPolicy({ baseEnv: {}, composedEnv: env, trustComposed: true });
}

var NAMES = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_PROFILE", "AWS_REGION", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "PATH"];
var saved = {};
var emptyBin = null;

test.before(function () {
  NAMES.forEach(function (n) { saved[n] = process.env[n]; delete process.env[n]; });
  // No claude on PATH: the login probe then has nothing to report, so a true
  // answer can only come from a provider in the environment.
  emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "provider-auth-"));
  process.env.PATH = emptyBin;
});

test.after(function () {
  NAMES.forEach(function (n) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  });
  fs.rmSync(emptyBin, { recursive: true });
});

var BEDROCK = { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "host", AWS_REGION: "us-east-1" };

test("Bedrock set only in the Settings overlay counts as authenticated", function () {
  assert.equal(authChecks.checkClaudeAuth(BEDROCK), true);
});

test("Bedrock set only in the daemon's environment counts as authenticated", function () {
  Object.assign(process.env, BEDROCK);
  try {
    assert.equal(authChecks.checkClaudeAuth(null), true);
  } finally {
    Object.keys(BEDROCK).forEach(function (k) { delete process.env[k]; });
  }
});

test("Bedrock set in both places counts as authenticated", function () {
  Object.assign(process.env, BEDROCK);
  try {
    assert.equal(authChecks.checkClaudeAuth(BEDROCK), true);
  } finally {
    Object.keys(BEDROCK).forEach(function (k) { delete process.env[k]; });
  }
});

test("no provider anywhere: the login probe decides, and finds none", function () {
  assert.equal(authChecks.checkClaudeAuth(null), false);
});

test("the Settings overlay wins over the daemon's value for the same name", function () {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "host";
  try {
    assert.equal(authChecks.checkClaudeAuth({ CLAUDE_CODE_USE_BEDROCK: "0" }), false);
  } finally {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.AWS_PROFILE;
  }
});

test("hasThirdPartyProviderAuth on the composed env gives the answer the spawn's env implies", function () {
  var composed = runtimeEnv.composeRuntimeEnv({ PATH: "x" }, BEDROCK);
  assert.equal(authChecks.hasThirdPartyProviderAuth(composed), "bedrock");
  assert.equal(authChecks.hasThirdPartyProviderAuth(runtimeEnv.composeRuntimeEnv({ PATH: "x" }, null)), null);
});

test("configuredProvider names the selected provider even with an incomplete credential set", function () {
  assert.equal(providerCredentials.configuredProvider({ CLAUDE_CODE_USE_BEDROCK: "1" }), "bedrock");
  assert.equal(providerCredentials.configuredProvider({ CLAUDE_CODE_USE_VERTEX: "1" }), "vertex");
  assert.equal(providerCredentials.configuredProvider({ CLAUDE_CODE_USE_FOUNDRY: "1" }), "foundry");
  assert.equal(providerCredentials.configuredProvider({}), null);
  assert.equal(providerCredentials.configuredProvider(null), null);
});

test("providerAuthFailure names each provider for the agent that owns its credentials", function () {
  var cases = [
    ["CLAUDE_CODE_USE_BEDROCK", "Amazon Bedrock"],
    ["CLAUDE_CODE_USE_VERTEX", "Google Vertex AI"],
    ["CLAUDE_CODE_USE_FOUNDRY", "Microsoft Foundry"],
  ];
  cases.forEach(function (c) {
    var env = {};
    env[c[0]] = "1";
    var failure = vendorAuth.providerAuthFailure("claude", env);
    assert.match(failure.message, new RegExp(c[1]));
    assert.doesNotMatch(failure.message, /not logged in/i);
  });
});

test("providerAuthFailure is null with no provider, and for an agent that does not own the provider's credentials", function () {
  assert.equal(vendorAuth.providerAuthFailure("claude", {}), null);
  assert.equal(vendorAuth.providerAuthFailure("codex", { CLAUDE_CODE_USE_BEDROCK: "1" }), null);
});

// The Claude CLI applies the user settings file's env block over what it is
// handed, so the provider it talks to is decided from that.
function withSettingsFile(env, run) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-auth-cfg-"));
  try {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ env: env }));
    return run({ CLAUDE_CONFIG_DIR: dir });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

["0", ""].forEach(function (off) {
  test("a settings file setting CLAUDE_CODE_USE_BEDROCK to '" + off + "' over a Settings Bedrock flag is not authenticated or attributed", function () {
    withSettingsFile({ CLAUDE_CODE_USE_BEDROCK: off }, function (cfg) {
      var overlay = Object.assign({}, BEDROCK, cfg);
      assert.equal(authChecks.checkClaudeAuth(overlay, trusting(overlay)), false);
      var composed = runtimeEnv.composeRuntimeEnv(process.env, overlay);
      assert.equal(vendorAuth.providerAuthFailure("claude", composed, trusting(composed)), null);
    });
  });
});

test("a settings file selecting Bedrock with a credential source is authenticated although Settings does not", function () {
  withSettingsFile({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "host" }, function (cfg) {
    assert.equal(authChecks.checkClaudeAuth(cfg, trusting(cfg)), true);
    var composed = runtimeEnv.composeRuntimeEnv(process.env, cfg);
    assert.equal(vendorAuth.providerAuthFailure("claude", composed, trusting(composed)).provider, "bedrock");
  });
});

test("a settings directory chosen by untrusted text is not read for the provider decision", function () {
  withSettingsFile({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "host" }, function (cfg) {
    var untrusted = claudeSettingsEnv.settingsReadPolicy({ baseEnv: {}, composedEnv: cfg, trustComposed: false });
    assert.equal(authChecks.checkClaudeAuth(cfg, untrusted), false);
    var osUsers = claudeSettingsEnv.settingsReadPolicy({ baseEnv: {}, composedEnv: cfg, trustComposed: true, osUsers: true });
    assert.equal(authChecks.checkClaudeAuth(cfg, osUsers), false);
    var composed = runtimeEnv.composeRuntimeEnv(process.env, cfg);
    assert.equal(vendorAuth.providerAuthFailure("claude", composed, untrusted), null);
  });
});
