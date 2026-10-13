"use strict";

// The harness must not hide a daemon it cannot account for: an unreadable
// daemon.json, or a restart case with no recorded successor, fails the test.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var { bootDaemon } = require("./fixtures/daemon-harness");

test("a partial daemon.json fails cleanup, naming the path", { timeout: 60000 }, async function () {
  var d = await bootDaemon();
  var file = path.join(d.consoleDir, "daemon.json");
  fs.writeFileSync(file, '{"pid": 12');
  await assert.rejects(d.cleanup(), function (e) {
    assert.ok(e.message.indexOf(file) !== -1, e.message);
    return true;
  });
  assert.equal(fs.existsSync(d.home), false, "the daemon is still stopped and its home removed");
});

test("a restart case that recorded no successor pid fails cleanup", { timeout: 60000 }, async function () {
  var d = await bootDaemon();
  d.expectSelfSpawn();
  await assert.rejects(d.cleanup(), /no successor pid/);
});

test("a case that expects no self-spawn cleans up quietly", { timeout: 60000 }, async function () {
  var d = await bootDaemon();
  await d.cleanup();
});
