"use strict";
// The test-failure verdict of scripts/check-test-count.js must name every
// failing test, because the CI annotation is the only failure detail a crew
// agent can read back from GitHub Actions.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var checkTestCount = require("../scripts/check-test-count.js");

var FLOOR = 1300;

var FIXTURE_TAP = [
  "TAP version 13",
  "# Subtest: suite one",
  "    # Subtest: inner passes",
  "    ok 1 - inner passes",
  "    # Subtest: ws upgrade echoes subprotocol",
  "    not ok 2 - ws upgrade echoes subprotocol",
  "      ---",
  "      duration_ms: 1.5",
  "      failureType: 'testCodeFailure'",
  "      error: |-",
  "        Expected values to be strictly equal:",
  "      code: 'ERR_ASSERTION'",
  "      ...",
  "not ok 1 - suite one",
  "ok 2 - skipped one # SKIP not today",
  "not ok 3 - top level failing test",
  "not ok 4",
  "1..4",
  "",
].join("\n");

function failingRun(stdout) {
  var file = "test/some-file.test.js";
  var byFile = {};
  byFile[path.resolve(file)] = 5;
  return checkTestCount.classifyRun(
    { status: 1, signal: null, error: undefined, stdout: stdout },
    [file], byFile, FLOOR + 5, FLOOR
  );
}

test("extractFailedTests lists every not ok line, ignoring SKIP and indentation", function () {
  assert.deepEqual(checkTestCount.extractFailedTests(FIXTURE_TAP), [
    "ws upgrade echoes subprotocol",
    "suite one",
    "top level failing test",
    "(unnamed)",
  ]);
});

test("test-failure verdict names the failing tests", function () {
  var verdict = failingRun(FIXTURE_TAP);
  assert.equal(verdict.kind, "test-failure");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.exitCode, 1);
  assert.ok(verdict.reason.indexOf("ws upgrade echoes subprotocol") !== -1, verdict.reason);
  assert.ok(verdict.reason.indexOf("top level failing test") !== -1, verdict.reason);
  assert.ok(verdict.reason.indexOf("inner passes") === -1, "passing tests must not be named");
});

test("test-failure verdict carries the error detail of the failing test", function () {
  var verdict = failingRun(FIXTURE_TAP);
  assert.ok(verdict.reason.indexOf("Expected values to be strictly equal:") !== -1, verdict.reason);
  assert.ok(verdict.reason.indexOf("code: 'ERR_ASSERTION'") !== -1, verdict.reason);
});

test("test-failure verdict caps the number and length of named tests", function () {
  var lines = [];
  for (var i = 1; i <= 40; i++) lines.push("not ok " + i + " - " + (i === 1 ? "x".repeat(500) : "failing " + i));
  var verdict = failingRun(lines.join("\n"));
  assert.ok(verdict.reason.indexOf("x".repeat(201)) === -1, "long names must be clipped");
  assert.ok(verdict.reason.indexOf("... and 15 more") !== -1, verdict.reason);
  assert.ok(verdict.reason.indexOf("failing 40") === -1, "names past the cap are summarised, not listed");
});

test("test-failure verdict without any parseable not ok line still fails", function () {
  var verdict = failingRun("");
  assert.equal(verdict.kind, "test-failure");
  assert.equal(verdict.ok, false);
});

test("annotation carries the failing test names on one escaped line", function () {
  var fs = require("fs");
  var chunks = [];
  var originalWriteSync = fs.writeSync;
  fs.writeSync = function (fd, chunk) {
    if (fd === 1) {
      chunks.push(chunk);
      return chunk.length;
    }
    return originalWriteSync.apply(fs, arguments);
  };
  try {
    var verdict = failingRun(FIXTURE_TAP);
    checkTestCount.emitAnnotation("[check-test-count] FAIL (" + verdict.kind + "): " + verdict.reason);
  } finally {
    fs.writeSync = originalWriteSync;
  }
  var written = Buffer.concat(chunks).toString("utf8");
  assert.ok(written.indexOf("::error::") === 0);
  assert.equal(written.trimEnd().split("\n").length, 1, "annotation must be a single physical line");
  assert.ok(written.indexOf("ws upgrade echoes subprotocol") !== -1);
});
