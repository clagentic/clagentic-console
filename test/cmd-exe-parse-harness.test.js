"use strict";
// The emulation in cmd-exe-parse-harness.js decides whether the Windows shim
// escaping holds, so its own rules are pinned here on hand-written inputs.

var test = require("node:test");
var assert = require("node:assert/strict");
var harness = require("./cmd-exe-parse-harness");

test("a caret removes itself and keeps the next character, outside quotes only", function () {
  assert.deepEqual(harness.cmdLayer("a^&b"), { text: "a&b", operators: [] });
  assert.deepEqual(harness.cmdLayer("a^^b"), { text: "a^b", operators: [] });
  assert.deepEqual(harness.cmdLayer('"a^&b"'), { text: '"a^&b"', operators: [] }, "a caret inside quotes is a plain character");
  assert.deepEqual(harness.cmdLayer('^"a&b^"').operators, ["&"], "an escaped quote does not open a quoted region");
});

test("an unescaped operator outside quotes is reported, one inside quotes is not", function () {
  assert.deepEqual(harness.cmdLayer("a&b|c<d>e(f)").operators, ["&", "|", "<", ">", "(", ")"]);
  assert.deepEqual(harness.cmdLayer('"a&b"').operators, []);
});

test("%name% is expanded for a defined variable in a command line and kept for an undefined one", function () {
  var env = { Path: "X" };
  assert.equal(harness.cmdLayer("%PATH%", { percent: true, env: env }).text, "X");
  assert.equal(harness.cmdLayer("%NOPE%", { percent: true, env: env }).text, "%NOPE%");
  assert.equal(harness.cmdLayer("100%", { percent: true, env: env }).text, "100%");
  assert.equal(harness.cmdLayer("%PATH%", { percent: false, env: env }).text, "%PATH%");
});

test("argv follows the C runtime rules for quotes and backslashes", function () {
  assert.deepEqual(harness.parseArgv('a "b c" d'), ["a", "b c", "d"]);
  assert.deepEqual(harness.parseArgv('"" x'), ["", "x"]);
  assert.deepEqual(harness.parseArgv('"say \\"hi\\""'), ['say "hi"']);
  assert.deepEqual(harness.parseArgv('"tail\\\\"'), ["tail\\"]);
  assert.deepEqual(harness.parseArgv("C:\\a\\b c"), ["C:\\a\\b", "c"]);
  assert.deepEqual(harness.parseArgv('a\\\\\\"b'), ['a\\"b']);
});

test("a command line that is not cmd.exe /d /s /c <one quoted string> is refused", function () {
  assert.throws(function () { harness.receivedArgs({ args: ["/c", "x"] }, "x"); }, /expected cmd\.exe/);
  assert.throws(function () { harness.receivedArgs({ args: ["/d", "/s", "/c", "no quotes"] }, "no"); }, /one pair of quotes/);
});
