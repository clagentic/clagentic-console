"use strict";
// The shared worker harness must not outlive a worker that never becomes
// ready: it rejects promptly with the worker's stderr and leaves no handle open.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { spawnSync } = require("child_process");

var HELPER = path.join(__dirname, "helpers", "worker-process.js");

function bootFailingWorker(body) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-helper-test-"));
  var file = path.join(dir, "boot-failure.js");
  fs.writeFileSync(file, body);
  return { dir: dir, file: file };
}

test("a worker that exits before ready makes startWorkerProcess reject with its stderr and removes its temp dir", async function () {
  var { startWorkerProcess } = require(HELPER);
  var stub = bootFailingWorker("require('no-such-module-for-the-boot-failure-test');\n");
  try {
    var started = Date.now();
    await assert.rejects(
      startWorkerProcess({ prefix: "worker-helper-boot-", workerPath: stub.file, waitMs: 15000 }),
      function (err) {
        assert.match(err.message, /worker exited before ready/);
        assert.match(err.message, /MODULE_NOT_FOUND|Cannot find module/);
        return true;
      }
    );
    assert.ok(Date.now() - started < 10000, "rejected on the worker's exit, not on the wait timeout");
    var leftover = fs.readdirSync(os.tmpdir()).filter(function (n) { return n.indexOf("worker-helper-boot-") === 0; });
    assert.deepEqual(leftover, [], "the helper's temp dir was removed");
  } finally {
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("a process whose worker never becomes ready exits on its own after the helper rejects", function () {
  var stub = bootFailingWorker("setInterval(function () {}, 1000);\n");
  try {
    var script = "var h = require(" + JSON.stringify(HELPER) + ");" +
      "h.startWorkerProcess({ workerPath: " + JSON.stringify(stub.file) + ", waitMs: 500 })" +
      ".then(function () { process.exit(2); }, function (e) { process.stdout.write(e.message); });";
    var run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20000 });
    assert.equal(run.error, undefined, "the process exited within the bound: " + (run.error && run.error.message));
    assert.equal(run.status, 0);
    assert.match(run.stdout, /timed out waiting for ready/);
  } finally {
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});
