"use strict";
// The runtime environment builder: what the Settings texts mean, how they are
// laid over the runtime's own environment, and that none of it ever carries a
// value into a log line.

var test = require("node:test");
var assert = require("node:assert/strict");
var runtimeEnv = require("../lib/runtime-env");

function sink() {
  var lines = [];
  return { warn: function (line) { lines.push(line); }, lines: lines, warned: new Set() };
}

test("a text is read as KEY=VALUE lines, with the export prefix the Settings pages write", function () {
  var overlay = runtimeEnv.buildRuntimeEnvOverlay([{
    label: "shared",
    text: "# a comment\n\nexport OPENAI_BASE_URL=https://api.example.invalid/v1\nPLAIN=value\n  SPACED = not-a-key\nQUOTED=\"two words\"\nSINGLE='a;b'\nEMPTY=",
  }], sink());
  assert.equal(overlay.OPENAI_BASE_URL, "https://api.example.invalid/v1");
  assert.equal(overlay.PLAIN, "value");
  assert.equal(overlay.QUOTED, "two words", "surrounding quotes are not part of the value");
  assert.equal(overlay.SINGLE, "a;b");
  assert.equal(overlay.EMPTY, "");
  assert.equal(Object.keys(overlay).some(function (k) { return k.indexOf("SPACED") === 0; }), false, "a malformed line is skipped");
});

test("the project text overrides the shared text, and a later duplicate overrides an earlier one", function () {
  var overlay = runtimeEnv.buildRuntimeEnvOverlay([
    { label: "shared", text: "A=shared\nB=shared\nB=shared-later" },
    { label: "project alpha", text: "A=project" },
  ], sink());
  assert.deepEqual(overlay, { A: "project", B: "shared-later" });
});

test("a malformed line is skipped and reported once, and the lines around it still apply", function () {
  var out = sink();
  var text = "GOOD=1\nnot an assignment\nALSO_GOOD=2";
  var first = runtimeEnv.buildRuntimeEnvOverlay([{ label: "shared", text: text }], out);
  runtimeEnv.buildRuntimeEnvOverlay([{ label: "shared", text: text }], out);
  assert.deepEqual(first, { GOOD: "1", ALSO_GOOD: "2" });
  assert.equal(out.lines.length, 1);
  assert.ok(out.lines[0].indexOf("not an assignment") === -1, "the line's content is not logged");
});

test("no settings, or settings that are not text, add nothing", function () {
  assert.deepEqual(runtimeEnv.buildRuntimeEnvOverlay([], sink()), {});
  assert.deepEqual(runtimeEnv.buildRuntimeEnvOverlay(undefined, sink()), {});
  assert.deepEqual(runtimeEnv.buildRuntimeEnvOverlay([{ label: "shared", text: "" }, { label: "project x", text: undefined }, { label: "p", text: 42 }], sink()), {});
});

test("the environment handed to the SDK is the complete environment: PATH and HOME survive next to the additions", function () {
  var base = { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/alice", LANG: "C.UTF-8", USER: "alice" };
  var before = JSON.stringify(base);
  var env = runtimeEnv.composeRuntimeEnv(base, { OPENAI_BASE_URL: "https://x.invalid", LANG: "en_US.UTF-8" }, sink());
  assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(env.HOME, "/home/alice");
  assert.equal(env.USER, "alice");
  assert.equal(env.OPENAI_BASE_URL, "https://x.invalid");
  assert.equal(env.LANG, "en_US.UTF-8", "a variable that is not protected can be overridden");
  assert.equal(JSON.stringify(base), before, "the base is not modified");
  assert.notEqual(env, base);
});

test("an empty overlay still yields the complete base environment", function () {
  var base = { PATH: "/usr/bin", HOME: "/h" };
  assert.deepEqual(runtimeEnv.composeRuntimeEnv(base, {}, sink()), base);
  assert.deepEqual(runtimeEnv.composeRuntimeEnv(base, undefined, sink()), base);
});

test("an unset base variable is not turned into the string \"undefined\"", function () {
  var env = runtimeEnv.composeRuntimeEnv({ A: "1", B: undefined }, { C: "3", D: undefined }, sink());
  assert.deepEqual(env, { A: "1", C: "3" });
});

test("the real process environment composes with an overlay and keeps PATH and HOME", function () {
  var env = runtimeEnv.composeRuntimeEnv(process.env, { SETTINGS_ONLY_VARIABLE: "yes" }, sink());
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.SETTINGS_ONLY_VARIABLE, "yes");
  assert.equal(process.env.SETTINGS_ONLY_VARIABLE, undefined);
});

test("a signature tells a settings change from none, whatever the order, and is empty for no variables", function () {
  assert.equal(runtimeEnv.envSignature({}), "");
  assert.equal(runtimeEnv.envSignature(undefined), "");
  var a = runtimeEnv.envSignature({ A: "1", B: "2" });
  assert.equal(a, runtimeEnv.envSignature({ B: "2", A: "1" }));
  assert.notEqual(a, runtimeEnv.envSignature({ A: "1", B: "3" }));
  assert.notEqual(a, runtimeEnv.envSignature({ A: "1" }));
  assert.match(a, /^[0-9a-f]{64}$/, "a digest, not the values");
  assert.equal(runtimeEnv.hasOverlay({}), false);
  assert.equal(runtimeEnv.hasOverlay({ A: "1" }), true);
});

test("the checks the pages already had still hold", function () {
  assert.equal(runtimeEnv.validateEnvText(""), null);
  assert.equal(runtimeEnv.validateEnvText("  "), null);
  assert.equal(runtimeEnv.validateEnvText("FOO=bar\n# c\nBAZ=\"a;b\""), null);
  assert.match(runtimeEnv.validateEnvText("123BAD=value"), /Invalid variable name at line 1/);
  assert.match(runtimeEnv.validateEnvText("BAD KEY=value"), /Invalid variable name at line 1/);
  assert.match(runtimeEnv.validateEnvText("FOO=$(rm -rf /)"), /unsafe value at line 1/);
  assert.match(runtimeEnv.validateEnvText("NOEQUALSSIGN"), /expected KEY=VALUE/);
  assert.match(runtimeEnv.validateEnvText("export "), /Invalid format|expected KEY=VALUE/);
});

test("a project's text applies to every session in single-user mode, and only to the owner's in multi-user mode", function () {
  var applies = runtimeEnv.projectEnvApplies;
  assert.equal(applies({ multiUser: false, projectOwnerId: null, sessionOwnerId: null }), true);
  assert.equal(applies({ multiUser: false, projectOwnerId: "a", sessionOwnerId: "b" }), true);
  assert.equal(applies({ multiUser: true, projectOwnerId: "a", sessionOwnerId: "a" }), true);
  assert.equal(applies({ multiUser: true, projectOwnerId: "a", sessionOwnerId: "b" }), false);
});

test("in multi-user mode a missing owner on either side, or an unknown mode, applies the project's text to no one", function () {
  var applies = runtimeEnv.projectEnvApplies;
  assert.equal(applies({ multiUser: true, projectOwnerId: null, sessionOwnerId: null }), false);
  assert.equal(applies({ multiUser: true, projectOwnerId: "a", sessionOwnerId: null }), false);
  assert.equal(applies({ multiUser: true, projectOwnerId: null, sessionOwnerId: "a" }), false);
  assert.equal(applies({ multiUser: undefined, projectOwnerId: "a", sessionOwnerId: "b" }), false, "only an explicit false is single-user");
  assert.equal(applies({ projectOwnerId: "a", sessionOwnerId: "b" }), false, "no mode given is treated as multi-user");
  assert.equal(applies(undefined), false);
});

test("NUL and carriage return are refused when saved, in names and values, quoted or not", function () {
  ["A=b\u0000c", "A=b\rc", "A=\"x\u0000y\"", "A=\"x\ry\"", "A\u0000B=1", "A\rB=1"].forEach(function (text) {
    assert.match(runtimeEnv.validateEnvText(text), /Invalid character at line 1/, JSON.stringify(text));
  });
  assert.match(runtimeEnv.validateEnvText("OK=1\nBAD=a\u0000b"), /line 2/);
});

test("a quoted value with shell characters is still accepted", function () {
  assert.equal(runtimeEnv.validateEnvText("URL=\"https://api.example.invalid/v1?a=1&b=2\""), null);
});

test("NUL and carriage return are dropped when built, with the lines around them kept and no value logged", function () {
  var out = sink();
  var overlay = runtimeEnv.buildRuntimeEnvOverlay([{ label: "shared", text: "KEEP=1\nBAD_NUL=secret\u0000value\nBAD_CR=\"secret\rvalue\"\nALSO_KEEP=2" }], out);
  assert.deepEqual(overlay, { KEEP: "1", ALSO_KEEP: "2" });
  assert.equal(out.lines.length, 2);
  out.lines.forEach(function (line) { assert.equal(line.indexOf("secret"), -1, "a warning never carries a value"); });
});

test("an overlay handed straight to the composer loses NUL and carriage return too", function () {
  var out = sink();
  var env = runtimeEnv.composeRuntimeEnv({ PATH: "/bin" }, { GOOD: "1", NUL_VALUE: "a\u0000b", CR_VALUE: "a\rb", "NUL\u0000NAME": "1" }, out);
  assert.deepEqual(env, { PATH: "/bin", GOOD: "1" });
  assert.equal(out.lines.length, 3);
});
