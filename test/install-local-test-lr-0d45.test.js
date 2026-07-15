// Regression test for lr-0d45 — the install:local-test npm script used to be
// `sh -c 'f=$(npm pack) && npm install -g "$f" && rm -f "$f"'`. $(npm pack)
// captures npm's multi-line human-readable notices, so `$f` was a garbage
// multi-line string and `npm install -g "$f"` failed EINVALIDPACKAGENAME.
// This surfaced for real when NAOMI's post-merge hardening (this same task)
// started running install:local-test with on_failure: fail instead of warn.
//
// The fix moved the logic into scripts/install-local-test.js, which shells
// out to `npm pack --json` and parses the tarball filename out of npm's
// output. `npm pack --json`'s own stdout is ALSO not clean — the prepack
// lifecycle hook (scripts/write-build-sha.js) writes a log line ahead of the
// JSON array, and that log line itself starts with a literal '[' (its
// "[write-build-sha] wrote ..." prefix), which broke a naive
// raw.indexOf('[') scan. These tests exercise extractTarballFilename against
// captured/synthetic npm output shapes directly, without shelling out to a
// real npm pack, so a regression in the parsing logic fails here instead of
// only being caught by an interactive install run. The parser itself scans
// every line-leading '[' as a candidate array start and takes the first one
// that parses as a non-empty array of objects with a "filename" field —
// tolerant of both pretty-printed and single-line npm output.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var { extractTarballFilename } = require("../scripts/install-local-test");

test("lr-0d45: extracts filename from clean npm pack --json output", function () {
  var raw = JSON.stringify([{ filename: "@clagentic/console-1.7.0-beta.1.tgz" }]);
  assert.equal(extractTarballFilename(raw), "@clagentic-console-1.7.0-beta.1.tgz");
});

test("lr-0d45: extracts filename when prepack hook stdout precedes the JSON array", function () {
  // Reproduces the real failure mode: write-build-sha.js's own console.log
  // line lands on stdout before npm's JSON array, and that line's own "["
  // prefix must not be mistaken for the array's opening bracket.
  var raw =
    "[write-build-sha] wrote /repo/lib/build-sha.json (sha=abc123)\n" +
    JSON.stringify([{ filename: "@clagentic/console-1.7.0-beta.1.tgz" }], null, 2) +
    "\n";
  assert.equal(extractTarballFilename(raw), "@clagentic-console-1.7.0-beta.1.tgz");
});

test("lr-0d45: extracts filename when npm warnings precede the JSON array", function () {
  var raw =
    "npm warn deprecated something@1.0.0: use something-else instead\n" +
    JSON.stringify([{ filename: "@clagentic/console-1.7.0-beta.1.tgz" }], null, 2) +
    "\n";
  assert.equal(extractTarballFilename(raw), "@clagentic-console-1.7.0-beta.1.tgz");
});

test("lr-0d45: throws (does not silently return garbage) when no JSON array is present", function () {
  // This is the shape of the ORIGINAL bug: npm's human-readable notice text
  // with no machine-parseable filename anywhere in it. The old `$(npm pack)`
  // form would have handed this whole string to `npm install -g` as a single
  // corrupt argument; the fix must fail loudly instead.
  var raw =
    "npm notice \n" +
    "npm notice package: @clagentic/console@1.7.0-beta.1\n" +
    "npm notice Tarball Contents\n";
  assert.throws(function () {
    extractTarballFilename(raw);
  }, /could not locate a valid `npm pack --json` array/);
});

test("lr-0d45: throws on malformed JSON that merely starts with '['", function () {
  var raw = "[not actually json}";
  assert.throws(function () {
    extractTarballFilename(raw);
  }, /could not locate a valid `npm pack --json` array/);
});

test("lr-0d45: throws when the only JSON array present has no filename field", function () {
  var raw = JSON.stringify([{ name: "@clagentic/console" }]);
  assert.throws(function () {
    extractTarballFilename(raw);
  }, /could not locate a valid `npm pack --json` array/);
});

test("lr-0d45: skips a non-array/no-filename '[' candidate and finds the real array later in the stream", function () {
  // Regression guard for the line-scan approach itself: a spurious '['-led
  // line earlier in the stream (e.g. from an unrelated hook or warning) must
  // not cause a false failure when a valid array follows it.
  var raw =
    "[irrelevant-tool] some other message\n" +
    JSON.stringify([{ filename: "@clagentic/console-1.7.0-beta.1.tgz" }], null, 2) +
    "\n";
  assert.equal(extractTarballFilename(raw), "@clagentic-console-1.7.0-beta.1.tgz");
});
