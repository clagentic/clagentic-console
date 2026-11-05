"use strict";
// check-test-count.js hands node --test a timeout, so a file that hangs is
// reported by name as a failure and the run ends instead of stalling.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { spawnSync } = require("child_process");

var SCRIPT = path.join(__dirname, "..", "scripts", "check-test-count.js");

test("a test file that never finishes fails by name within the configured timeout", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-count-timeout-"));
  try {
    var hung = path.join(dir, "hung-file.test.js");
    fs.writeFileSync(hung, "require('node:test')('never', function () { return new Promise(function () { setInterval(function () {}, 1000); }); });\n");
    var started = Date.now();
    var run = spawnSync(process.execPath, [SCRIPT, hung], {
      encoding: "utf8",
      timeout: 30000,
      env: Object.assign({}, process.env, { CHECK_TEST_COUNT_TEST_TIMEOUT_MS: "2000" }),
    });
    assert.equal(run.error, undefined, "the run ended within the bound");
    assert.notEqual(run.status, 0);
    assert.ok(Date.now() - started < 25000);
    assert.match(run.stdout + run.stderr, /FAIL[\s\S]*hung-file\.test\.js/, "the hung file is named in the failure");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
