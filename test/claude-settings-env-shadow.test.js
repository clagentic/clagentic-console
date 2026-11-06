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
var savedConfigDir;

function writeSettings(obj) {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), typeof obj === "string" ? obj : JSON.stringify(obj));
}

test.beforeEach(function () {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-shadow-"));
});

test.afterEach(function () {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  fs.rmSync(home, { recursive: true });
});

test("names set in both the Settings text and the settings file are reported", function () {
  writeSettings({ env: { CLAUDE_CODE_USE_BEDROCK: "1", OTHER: "x" } });
  var keys = claudeSettingsEnv.shadowedKeys("export CLAUDE_CODE_USE_BEDROCK=0\nexport AWS_REGION=us-east-1", { homeDir: home });
  assert.deepEqual(keys, ["CLAUDE_CODE_USE_BEDROCK"]);
});

test("a name only in the Settings text is not reported", function () {
  writeSettings({ env: { OTHER: "x" } });
  assert.deepEqual(claudeSettingsEnv.shadowedKeys("AWS_REGION=us-east-1", { homeDir: home }), []);
});

test("no settings file, an unreadable one, or one without an env block reports nothing", function () {
  assert.deepEqual(claudeSettingsEnv.shadowedKeys("A=1", { homeDir: home }), []);
  writeSettings("{ not json");
  assert.deepEqual(claudeSettingsEnv.shadowedKeys("A=1", { homeDir: home }), []);
  writeSettings({ model: "x" });
  assert.deepEqual(claudeSettingsEnv.shadowedKeys("A=1", { homeDir: home }), []);
});

test("the daemon's own CLAUDE_CONFIG_DIR names the directory the settings file is read from", function () {
  var other = fs.mkdtempSync(path.join(os.tmpdir(), "settings-shadow-cfg-"));
  try {
    fs.writeFileSync(path.join(other, "settings.json"), JSON.stringify({ env: { A: "1" } }));
    process.env.CLAUDE_CONFIG_DIR = other;
    assert.deepEqual(claudeSettingsEnv.shadowedKeys("A=2", { homeDir: home }), ["A"]);
  } finally {
    fs.rmSync(other, { recursive: true });
  }
});

test("a name repeated in the text is reported once, and no value is returned", function () {
  writeSettings({ env: { A: "secret-file-value" } });
  var keys = claudeSettingsEnv.shadowedKeys("A=1\nA=2", { homeDir: home });
  assert.deepEqual(keys, ["A"]);
  assert.equal(JSON.stringify(keys).indexOf("secret"), -1);
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

// The daemon reads the settings file on its own account, so the path must never
// come from text someone edited (CWE-22: probing key names in another account's
// file).
function spyReads(fn) {
  var real = fs.readFileSync;
  var read = [];
  fs.readFileSync = function (file) {
    read.push(String(file));
    return real.apply(fs, arguments);
  };
  try { fn(); } finally { fs.readFileSync = real; }
  return read;
}

test("an edited CLAUDE_CONFIG_DIR is never read, whoever edited it", function () {
  var elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "settings-shadow-elsewhere-"));
  try {
    fs.writeFileSync(path.join(elsewhere, "settings.json"), JSON.stringify({ env: { A: "1", B: "1" } }));
    writeSettings({ env: { B: "1" } });
    var keys;
    var read = spyReads(function () {
      keys = claudeSettingsEnv.shadowedKeys("CLAUDE_CONFIG_DIR=" + elsewhere + "\nA=2\nB=2", { homeDir: home });
    });
    assert.deepEqual(keys, ["B"], "only the daemon user's file is consulted");
    assert.equal(read.some(function (f) { return f.indexOf(elsewhere) === 0; }), false, "the edited path is never opened");
    assert.equal(claudeSettingsEnv.setsConfigDir("A=1\nexport CLAUDE_CONFIG_DIR=/x"), true);
    assert.equal(claudeSettingsEnv.setsConfigDir("A=1"), false);
  } finally {
    fs.rmSync(elsewhere, { recursive: true });
  }
});

test("os-users mode reads no settings file, for the warning or for the environment", function () {
  writeSettings({ env: { A: "1", CLAUDE_CODE_USE_BEDROCK: "1" } });
  var out;
  var keys;
  var read = spyReads(function () {
    keys = claudeSettingsEnv.shadowedKeys("A=2", { homeDir: home, osUsers: true });
    out = claudeSettingsEnv.applyUserSettingsEnv({ B: "x" }, { homeDir: home, osUsers: true });
  });
  assert.deepEqual(keys, []);
  assert.deepEqual(out, { B: "x" });
  assert.deepEqual(read.filter(function (f) { return /settings\.json$/.test(f); }), []);
});

test("the home directory file is read when the daemon has no CLAUDE_CONFIG_DIR", function () {
  writeSettings({ env: { A: "1" } });
  assert.deepEqual(claudeSettingsEnv.shadowedKeys("A=2", { homeDir: home }), ["A"]);
});

// Names such as constructor and toString exist on every plain object; they are
// ordinary variable names here and must be reported like any other.
var OBJECT_PROTOTYPE_NAMES = ["constructor", "toString", "hasOwnProperty", "valueOf"];

test("names that exist on Object.prototype are reported when both the text and the file set them", function () {
  var fileEnv = JSON.parse("{" + OBJECT_PROTOTYPE_NAMES.map(function (n) { return JSON.stringify(n) + ':"1"'; }).join(",") + "}");
  writeSettings({ env: fileEnv });
  var text = OBJECT_PROTOTYPE_NAMES.map(function (n) { return n + "=2"; }).join("\n");
  assert.deepEqual(claudeSettingsEnv.shadowedKeys(text, { homeDir: home }), OBJECT_PROTOTYPE_NAMES);
  assert.deepEqual(claudeSettingsEnv.shadowedKeys(text + "\n" + text, { homeDir: home }), OBJECT_PROTOTYPE_NAMES, "each once");
});

test("names on Object.prototype are not reported when the file does not set them", function () {
  writeSettings({ env: { OTHER: "1" } });
  var text = OBJECT_PROTOTYPE_NAMES.map(function (n) { return n + "=2"; }).join("\n");
  assert.deepEqual(claudeSettingsEnv.shadowedKeys(text, { homeDir: home }), []);
});
