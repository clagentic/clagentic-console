"use strict";
// The auth cache answers from the Claude settings file the classification
// reads, so an edit to that file is picked up without a restart.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var NAMES = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_PROFILE", "AWS_REGION", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "PATH"];
var saved = {};
var dir = null;
var emptyBin = null;

test.before(function () {
  NAMES.forEach(function (n) { saved[n] = process.env[n]; delete process.env[n]; });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-cache-cfg-"));
  emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "auth-cache-bin-"));
  // No claude on PATH: only a provider in the environment can answer true.
  process.env.PATH = emptyBin;
  process.env.CLAUDE_CONFIG_DIR = dir;
});

test.after(function () {
  NAMES.forEach(function (n) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  });
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(emptyBin, { recursive: true });
});

test("a provider added to the settings file after a cached answer is seen by the next check", function () {
  var yoke = require("../lib/yoke");
  yoke.invalidateAuthCache();
  assert.equal(yoke.checkAuth(null, false).claude, false, "no provider anywhere");
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "host", AWS_REGION: "us-east-1" },
  }));
  assert.equal(yoke.checkAuth(null, false).claude, true, "the edited file is read without a restart");
  fs.writeFileSync(path.join(dir, "settings.json"), "{}");
  assert.equal(yoke.checkAuth(null, false).claude, false, "and its removal too");
});

test("under os-users mode the stamp is empty and the file is not consulted", function () {
  var claudeSettingsEnv = require("../lib/claude-settings-env");
  assert.equal(claudeSettingsEnv.settingsFileStamp({ osUsers: true }), "");
});
