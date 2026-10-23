"use strict";
// The server-wide permission settings (lib/permission-settings.js): defaults
// equal the behaviour before the settings existed, only known settings of the
// right type are accepted, and a session opened by the CLI or a trigger takes
// its mode from the request, then the setting, then accept edits.

var test = require("node:test");
var assert = require("node:assert/strict");
var settings = require("../lib/permission-settings");
var policy = require("../lib/permission-mode-policy");

// The own-key lookups the settings and the mode check use are loaded by the
// daemon at start-up (lib/prompt-registry.js); a unit test loads them itself.
test.before(function () { return require("../lib/prompt-kinds/codecs").load(); });

test("with nothing stored the settings are today's behaviour", function () {
  assert.deepEqual(settings.readPermissionSettings(null), { autoApproveReadOnly: true, openedSessionMode: "acceptEdits" });
  assert.deepEqual(settings.readPermissionSettings({}), { autoApproveReadOnly: true, openedSessionMode: "acceptEdits" });
});

test("only an explicit false turns read-only auto-approval off", function () {
  assert.equal(settings.readPermissionSettings({ autoApproveReadOnly: false }).autoApproveReadOnly, false);
  [undefined, null, 0, "false", true].forEach(function (v) {
    assert.equal(settings.readPermissionSettings({ autoApproveReadOnly: v }).autoApproveReadOnly, true, String(v));
  });
});

test("a stored opened-session mode is read back; an empty or non-string one is the default", function () {
  assert.equal(settings.readPermissionSettings({ openedSessionMode: "plan" }).openedSessionMode, "plan");
  [undefined, "", 7, {}].forEach(function (v) {
    assert.equal(settings.readPermissionSettings({ openedSessionMode: v }).openedSessionMode, "acceptEdits");
  });
});

test("a change request keeps known settings of the right type and names the rest", function () {
  var picked = settings.pickSettingChanges({ type: "set_permission_settings", autoApproveReadOnly: false, openedSessionMode: "plan" });
  assert.deepEqual(picked, { values: { autoApproveReadOnly: false, openedSessionMode: "plan" }, rejected: [] });
  var bad = settings.pickSettingChanges({ autoApproveReadOnly: "no", openedSessionMode: 3, other: true, constructor: 1 });
  assert.deepEqual(bad.values, {});
  assert.deepEqual(bad.rejected.sort(), ["autoApproveReadOnly", "constructor", "openedSessionMode", "other"]);
});

function checkWith(opts) {
  return function (mode) { return policy.checkPermissionMode(mode, opts); };
}

test("opened-session mode: the request wins over the setting, the setting over accept edits", function () {
  var check = checkWith({});
  assert.deepEqual(settings.resolveOpenedSessionMode({ requested: "plan", setting: "default", check: check }), { mode: "plan" });
  assert.deepEqual(settings.resolveOpenedSessionMode({ requested: undefined, setting: "default", check: check }), { mode: "default" });
  assert.deepEqual(settings.resolveOpenedSessionMode({ requested: null, setting: "plan", check: check }), { mode: "plan" });
  assert.deepEqual(settings.resolveOpenedSessionMode({ requested: undefined, setting: "acceptEdits", check: check }), { mode: "acceptEdits" });
  assert.deepEqual(settings.resolveOpenedSessionMode({ requested: undefined, setting: undefined, check: check }), { mode: "acceptEdits" });
});

test("opened-session mode: a mode the request names that fails the check is refused, not replaced", function () {
  var check = checkWith({});
  var bypass = settings.resolveOpenedSessionMode({ requested: "bypassPermissions", setting: "plan", check: check });
  assert.match(bypass.error, /bypassPermissions/);
  assert.equal(bypass.mode, undefined);
  assert.match(settings.resolveOpenedSessionMode({ requested: "nonsense", setting: "plan", check: check }).error, /Unknown/);
  var gated = settings.resolveOpenedSessionMode({ requested: "auto", setting: "plan", check: checkWith({ supportedModes: [] }) });
  assert.match(gated.error, /does not support the auto/);
});

test("opened-session mode: a stored setting that fails the check falls back to accept edits and says why", function () {
  var told = [];
  var out = settings.resolveOpenedSessionMode({
    requested: undefined, setting: "bypassPermissions", check: checkWith({}), onFallback: function (why) { told.push(why); },
  });
  assert.deepEqual(out, { mode: "acceptEdits" });
  assert.equal(told.length, 1);
  assert.match(told[0], /bypassPermissions/);
});

test("the settings message carries both values", function () {
  assert.deepEqual(settings.settingsMessage({ autoApproveReadOnly: false, openedSessionMode: "plan" }),
    { type: "permission_settings", autoApproveReadOnly: false, openedSessionMode: "plan" });
});
