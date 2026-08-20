"use strict";
// Fixture for test/check-test-count-delivery-lr-e551b9.test.js — NOT itself
// collected by `npm test` (package.json only globs test/*.test.js; this file
// lives under test/fixtures/ and does not match that pattern, and does not
// end in .test.js).
//
// Emits enough trivial passing node:test cases that the resulting TAP output
// comfortably exceeds a 64KB OS pipe buffer, which is what the delivery test
// needs to force process.stdout.write's async-queue behavior when stdout is
// a real pipe (see that test file for why this matters — lr-e551b9 reopen).
var test = require("node:test");
var assert = require("node:assert/strict");

for (var i = 0; i < 2000; i++) {
  test(
    "lr-e551b9 padding test number " + i + " — exists only to bulk up TAP " +
      "output past a 64KB pipe buffer so the delivery test can force the " +
      "async-write race this fixture is built to exercise",
    function () {
      assert.equal(1, 1);
    }
  );
}
