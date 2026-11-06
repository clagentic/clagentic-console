"use strict";
// The Claude user settings file wins over a Settings environment value for the
// same name, so the editors are told which names are set in both places.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var claudeSettingsEnv = require("../lib/claude-settings-env");

var home = null;

function writeSettings(obj) {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), typeof obj === "string" ? obj : JSON.stringify(obj));
}

test.beforeEach(function () {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-shadow-"));
});

test.afterEach(function () {
  fs.rmSync(home, { recursive: true });
});

test("names set in both the Settings text and the settings file are reported", function () {
  writeSettings({ env: { CLAUDE_CODE_USE_BEDROCK: "1", OTHER: "x" } });
  var keys = claudeSettingsEnv.shadowedKeys("export CLAUDE_CODE_USE_BEDROCK=0\nexport AWS_REGION=us-east-1", { homeDir: home, env: {} });
  assert.deepEqual(keys, ["CLAUDE_CODE_USE_BEDROCK"]);
});

test("a name only in the Settings text is not reported", function () {
  writeSettings({ env: { OTHER: "x" } });
  assert.deepEqual(claudeSettingsEnv.shadowedKeys("AWS_REGION=us-east-1", { homeDir: home, env: {} }), []);
});

test("no settings file, an unreadable one, or one without an env block reports nothing", function () {
  assert.deepEqual(claudeSettingsEnv.shadowedKeys("A=1", { homeDir: home, env: {} }), []);
  writeSettings("{ not json");
  assert.deepEqual(claudeSettingsEnv.shadowedKeys("A=1", { homeDir: home, env: {} }), []);
  writeSettings({ model: "x" });
  assert.deepEqual(claudeSettingsEnv.shadowedKeys("A=1", { homeDir: home, env: {} }), []);
});

test("CLAUDE_CONFIG_DIR names the directory the settings file is read from", function () {
  var other = fs.mkdtempSync(path.join(os.tmpdir(), "settings-shadow-cfg-"));
  try {
    fs.writeFileSync(path.join(other, "settings.json"), JSON.stringify({ env: { A: "1" } }));
    assert.deepEqual(claudeSettingsEnv.shadowedKeys("A=2", { homeDir: home, env: { CLAUDE_CONFIG_DIR: other } }), ["A"]);
  } finally {
    fs.rmSync(other, { recursive: true });
  }
});

test("a name repeated in the text is reported once, and no value is returned", function () {
  writeSettings({ env: { A: "secret-file-value" } });
  var keys = claudeSettingsEnv.shadowedKeys("A=1\nA=2", { homeDir: home, env: {} });
  assert.deepEqual(keys, ["A"]);
  assert.equal(JSON.stringify(keys).indexOf("secret"), -1);
});

test("CLAUDE_CONFIG_DIR set in the edited text, not the base, picks the settings file read", function () {
  var other = fs.mkdtempSync(path.join(os.tmpdir(), "settings-shadow-edited-"));
  var base = fs.mkdtempSync(path.join(os.tmpdir(), "settings-shadow-base-"));
  try {
    fs.writeFileSync(path.join(other, "settings.json"), JSON.stringify({ env: { A: "1" } }));
    fs.writeFileSync(path.join(base, "settings.json"), JSON.stringify({ env: { B: "1" } }));
    var keys = claudeSettingsEnv.shadowedKeys("CLAUDE_CONFIG_DIR=" + other + "\nA=2\nB=2", { homeDir: home, env: { CLAUDE_CONFIG_DIR: base } });
    assert.deepEqual(keys, ["A"]);
  } finally {
    fs.rmSync(other, { recursive: true });
    fs.rmSync(base, { recursive: true });
  }
});

test("applyUserSettingsEnv puts the settings file's env block over the given environment", function () {
  writeSettings({ env: { A: "file", N: 0, T: true, SKIP: { x: 1 } } });
  var out = claudeSettingsEnv.applyUserSettingsEnv({ A: "given", B: "kept" }, { homeDir: home });
  assert.equal(out.A, "file");
  assert.equal(out.B, "kept");
  assert.equal(out.N, "0");
  assert.equal(out.T, "true");
  assert.equal("SKIP" in out, false);
});
