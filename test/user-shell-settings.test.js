"use strict";
// The ! mode settings: the defaults are the documented ones (on, 10 minutes,
// 256 KiB), a value outside its range is not stored, and a value equal to its
// default is removed from daemon.json.

var test = require("node:test");
var assert = require("node:assert/strict");

var settings = require("../lib/user-shell-settings");

// The own-key lookups the settings use are loaded by the daemon at start-up
// (lib/prompt-registry.js); a unit test loads them itself.
test.before(function () { return require("../lib/prompt-kinds/codecs").load(); });

test("with nothing set, the mode is on with a 10 minute timeout and a 256 KiB cap", function () {
  [null, undefined, {}].forEach(function (config) {
    var s = settings.readUserShellSettings(config);
    assert.equal(s.enabled, true);
    assert.equal(s.timeoutMinutes, 10);
    assert.equal(s.timeoutMs, 600000);
    assert.equal(s.maxOutputKiB, 256);
    assert.equal(s.maxOutputBytes, 262144);
  });
});

test("only an explicit false turns the mode off", function () {
  assert.equal(settings.readUserShellSettings({ userShellEnabled: false }).enabled, false);
  ["no", 0, null, "false"].forEach(function (v) {
    assert.equal(settings.readUserShellSettings({ userShellEnabled: v }).enabled, true, String(v));
  });
});

test("a stored timeout and cap are read; a value out of range reads as the default", function () {
  var s = settings.readUserShellSettings({ userShellTimeoutMinutes: 2, userShellMaxOutputKiB: 4 });
  assert.equal(s.timeoutMs, 120000);
  assert.equal(s.maxOutputBytes, 4096);
  [0, -1, 1.5, "5", 100000, NaN].forEach(function (v) {
    assert.equal(settings.readUserShellSettings({ userShellTimeoutMinutes: v }).timeoutMinutes, 10, "timeout " + String(v));
    assert.equal(settings.readUserShellSettings({ userShellMaxOutputKiB: v }).maxOutputKiB, 256, "cap " + String(v));
  });
});

test("a change request keeps known settings of the right type and names the rest", function () {
  var picked = settings.pickSettingChanges({ type: "set_user_shell_settings", userShellEnabled: false, userShellTimeoutMinutes: 30 });
  assert.deepEqual(picked.values, { userShellEnabled: false, userShellTimeoutMinutes: 30 });
  assert.deepEqual(picked.rejected, []);
  var bad = settings.pickSettingChanges({ userShellEnabled: "off", userShellTimeoutMinutes: 0, userShellMaxOutputKiB: 99999, other: 1, constructor: 1 });
  assert.deepEqual(bad.values, {});
  assert.deepEqual(bad.rejected.sort(), ["constructor", "other", "userShellEnabled", "userShellMaxOutputKiB", "userShellTimeoutMinutes"]);
});

test("applying changes stores what differs from the default and removes what equals it", function () {
  var config = {};
  settings.applySettingChanges(config, { userShellEnabled: false, userShellTimeoutMinutes: 30, userShellMaxOutputKiB: 64 });
  assert.deepEqual(config, { userShellEnabled: false, userShellTimeoutMinutes: 30, userShellMaxOutputKiB: 64 });
  settings.applySettingChanges(config, { userShellEnabled: true, userShellTimeoutMinutes: 10, userShellMaxOutputKiB: 256 });
  assert.deepEqual(config, {});
});

test("the settings message carries the three values under their config names", function () {
  assert.deepEqual(settings.settingsMessage(settings.readUserShellSettings({})), {
    type: "user_shell_settings", userShellEnabled: true, userShellTimeoutMinutes: 10, userShellMaxOutputKiB: 256,
  });
});
