// The session verbs always answer with a JSON result object, including when
// the IPC exchange itself fails.

var test = require("node:test");
var assert = require("node:assert/strict");

var { requestDaemon } = require("../lib/cli/session-subcommands");

test("requestDaemon: a rejected IPC call becomes an error result", async function () {
  var res = await requestDaemon({ cmd: "open_session" }, {
    isDaemonAlive: function () { return Promise.resolve(true); },
    sendIPC: function () { return Promise.reject(new Error("socket reset")); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.result, "error");
  assert.match(res.reason, /socket reset/);
});

test("requestDaemon: a failing liveness probe becomes an error result", async function () {
  var res = await requestDaemon({}, {
    isDaemonAlive: function () { return Promise.reject(new Error("probe failed")); },
    sendIPC: function () { throw new Error("must not be called"); },
  });
  assert.equal(res.result, "error");
  assert.match(res.reason, /probe failed/);
});

test("requestDaemon: no daemon is an error result", async function () {
  var res = await requestDaemon({}, {
    isDaemonAlive: function () { return Promise.resolve(false); },
    sendIPC: function () { throw new Error("must not be called"); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no running daemon");
});

test("requestDaemon: the IPC layer's own failure shape gets a result", async function () {
  var res = await requestDaemon({}, {
    isDaemonAlive: function () { return Promise.resolve(true); },
    sendIPC: function () { return Promise.resolve({ ok: false, error: "timeout" }); },
  });
  assert.equal(res.result, "error");
  assert.equal(res.reason, "timeout");
});

test("requestDaemon: the daemon's result passes through unchanged", async function () {
  var daemonResult = { ok: true, result: "opened", sessionId: "s1" };
  var res = await requestDaemon({}, {
    isDaemonAlive: function () { return Promise.resolve(true); },
    sendIPC: function () { return Promise.resolve(daemonResult); },
  });
  assert.deepEqual(res, daemonResult);
});
