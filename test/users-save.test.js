"use strict";

// saveUsers has one write path: a synchronous atomic write, nothing queued
// behind it. Every row goes through the real lib/users.js module.

var test = require("node:test");
var assert = require("node:assert/strict");
var os = require("os");
var path = require("path");
var fs = require("fs");

var SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-users-save-"));
var HOME = path.join(SANDBOX, "data");
process.env.CLAGENTIC_CONSOLE_HOME = HOME;

var users = require("../lib/users");
var { CONFIG_DIR } = require("../lib/config");

test.after(function () { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

function settle() {
  // Several event-loop turns and timers, long enough for any queued write.
  return new Promise(function (resolve) {
    setTimeout(function () { setImmediate(function () { setTimeout(resolve, 100); }); }, 50);
  });
}

// Reads users.json on every event-loop turn while pending I/O settles and
// returns each distinct text seen, so a write that lands later and puts an
// older save back over a newer one is visible even when the file ends right.
function observeWhileSettling() {
  return new Promise(function (resolve) {
    var seen = [];
    var end = Date.now() + 250;
    function look() {
      var text;
      try { text = fs.readFileSync(users.USERS_FILE, "utf8"); } catch (e) { text = "<unreadable: " + e.code + ">"; }
      if (seen.indexOf(text) === -1) seen.push(text);
      if (Date.now() < end) setImmediate(look); else resolve(seen);
    }
    look();
  });
}

function data(tag) {
  return { multiUser: true, setupCode: null, users: [{ id: tag, username: tag }], invites: [], smtp: null };
}

function tempLeftovers() {
  return fs.readdirSync(CONFIG_DIR).filter(function (n) { return n.indexOf("users.json.tmp.") === 0; });
}

var ROWS = [
  ["two saves in one tick leave the second data and no temp file", async function () {
    users.saveUsers(data("seed"));
    users.saveUsers(data("first"));
    users.saveUsers(data("second"));
    var seen = await observeWhileSettling();
    assert.deepEqual(seen.map(function (t) { return JSON.parse(t); }), [data("second")], "users.json never held anything but the second save");
    await settle();
    var onDisk = JSON.parse(fs.readFileSync(users.USERS_FILE, "utf8"));
    assert.deepEqual(onDisk, data("second"));
    assert.deepEqual(tempLeftovers(), []);
  }],
  ["loadUsers reads the saved data back synchronously", async function () {
    users.saveUsers(data("readback"));
    assert.deepEqual(users.loadUsers(), data("readback"));
    await settle();
    assert.deepEqual(users.loadUsers(), data("readback"));
  }],
  ["a missing config directory is created and users.json is owner-only", async function () {
    fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
    users.saveUsers(data("fresh"));
    await settle();
    assert.deepEqual(JSON.parse(fs.readFileSync(users.USERS_FILE, "utf8")), data("fresh"));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(users.USERS_FILE).mode & 0o777, 0o600);
    }
    assert.deepEqual(tempLeftovers(), []);
  }],
];

ROWS.forEach(function (row) {
  test("saveUsers: " + row[0], row[1]);
});
