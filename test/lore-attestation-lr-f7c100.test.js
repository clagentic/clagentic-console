"use strict";
/**
 * Regression test for lr-f7c100: lib/lore-attestation.js must be fail-open.
 * A host without LORE installed (lore binary missing -> ENOENT) or any
 * other CLI failure must never throw, never reject a promise the caller is
 * expected to await (there is none — attestHumanSession is fire-and-forget
 * by contract), and must never affect the caller's control flow.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");

var { attestHumanSession } = require("../lib/lore-attestation");

test("lr-f7c100: attestHumanSession never throws when the lore binary does not exist on PATH", function () {
  var originalPath = process.env.PATH;
  // Point PATH somewhere with no `lore` binary — simulates "host without
  // LORE installed" (ACCEPTANCE: session create must be unaffected).
  process.env.PATH = path.join(__dirname, "fixtures");
  try {
    assert.doesNotThrow(function () {
      attestHumanSession("some-session-id");
    });
  } finally {
    process.env.PATH = originalPath;
  }
});

test("lr-f7c100: attestHumanSession is a no-op (does not throw) for a falsy/non-string session id", function () {
  assert.doesNotThrow(function () { attestHumanSession(null); });
  assert.doesNotThrow(function () { attestHumanSession(undefined); });
  assert.doesNotThrow(function () { attestHumanSession(""); });
  assert.doesNotThrow(function () { attestHumanSession(42); });
});
