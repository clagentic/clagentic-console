"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var { isSupervised, unsupervisedEnv, RESTART_EXIT_CODE } = require("../lib/supervisor");

test("a daemon is supervised when systemd set INVOCATION_ID or NOTIFY_SOCKET", function () {
  assert.equal(isSupervised({ INVOCATION_ID: "0123" }), true);
  assert.equal(isSupervised({ NOTIFY_SOCKET: "/run/systemd/notify" }), true);
  assert.equal(isSupervised({}), false);
  assert.equal(isSupervised({ INVOCATION_ID: "" }), false);
});

test("unsupervisedEnv drops the supervisor's variables and keeps the rest", function () {
  var source = { INVOCATION_ID: "x", NOTIFY_SOCKET: "/s", PATH: "/bin", CLAGENTIC_CONSOLE_HOME: "/h" };
  var env = unsupervisedEnv(source);
  assert.equal(isSupervised(env), false);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CLAGENTIC_CONSOLE_HOME, "/h");
  assert.equal(source.INVOCATION_ID, "x", "the source environment is not modified");
});

test("the restart exit code is the one the dev watcher respawns on", function () {
  assert.equal(RESTART_EXIT_CODE, 120);
});
