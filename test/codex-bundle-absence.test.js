"use strict";
// Only a genuinely absent bundled Codex binary falls back to the PATH lookup.
// Any other failure while locating it is a defect and is surfaced, not read as
// "not installed".

var test = require("node:test");
var assert = require("node:assert/strict");
var appServer = require("../lib/yoke/codex-app-server");
var yoke = require("../lib/yoke");
var authChecks = require("../lib/yoke/auth-checks");

function absent() {
  var err = new Error("Could not find codex binary: Cannot find module");
  err.code = "CODEX_BUNDLE_ABSENT";
  return err;
}

function withFindCodexPath(replacement, fn) {
  var real = appServer.findCodexPath;
  appServer.findCodexPath = replacement;
  try {
    return fn();
  } finally {
    appServer.findCodexPath = real;
  }
}

test("the real locator marks only a missing bundle as absent", function () {
  assert.equal(appServer.isBundleAbsent(absent()), true);
  assert.equal(appServer.isBundleAbsent(new Error("boom")), false);
  assert.equal(appServer.isBundleAbsent(Object.assign(new Error("denied"), { code: "EACCES" })), false);
  assert.equal(appServer.isBundleAbsent(null), false);
});

test("install probe: an absent bundle falls back to PATH, anything else is surfaced", function () {
  var probe = yoke.registry.get("codex").probeInstalled;
  var lookups = [];
  var ctx = { lookupBinary: function (name) { lookups.push(name); return true; } };

  withFindCodexPath(function () { throw absent(); }, function () {
    assert.equal(probe(ctx), true);
  });
  assert.deepEqual(lookups, ["codex"], "the PATH lookup ran");

  lookups.length = 0;
  withFindCodexPath(function () { throw new Error("internal defect"); }, function () {
    assert.throws(function () { probe(ctx); }, /internal defect/);
  });
  assert.deepEqual(lookups, [], "no silent fallback");
});

test("auth check: an unexpected failure locating the binary is logged, not swallowed", function () {
  var logged = [];
  var realError = console.error;
  console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
  try {
    withFindCodexPath(function () { throw new Error("internal defect"); }, function () {
      assert.equal(authChecks.checkCodexAuth(), false);
    });
  } finally {
    console.error = realError;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /internal defect/);

  logged.length = 0;
  console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
  try {
    withFindCodexPath(function () { throw absent(); }, function () {
      authChecks.checkCodexAuth();
    });
  } finally {
    console.error = realError;
  }
  assert.deepEqual(logged, [], "an absent bundle is expected and quiet");
});
