"use strict";

// A restart under a supervisor (systemd: INVOCATION_ID / NOTIFY_SOCKET) is an
// exit the supervisor answers. Before, the daemon spawned its own replacement
// and exited 120; with KillMode=mixed the unit then killed that replacement
// along with the rest of its cgroup and started another, so the restart worked
// only by accident. An unsupervised daemon still has to bring itself back.

var test = require("node:test");
var assert = require("node:assert/strict");

var { bootDaemon, waitForExit, pidAlive } = require("./fixtures/daemon-harness");
var { sendIPCCommand } = require("../lib/ipc");

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function waitUntil(predicate, ms, what) {
  var end = Date.now() + ms;
  while (Date.now() < end) {
    var v = await predicate();
    if (v) return v;
    await sleep(100);
  }
  throw new Error("timed out waiting for " + what);
}

async function livePid(d) {
  try {
    var r = await sendIPCCommand(d.sock, { cmd: "get_status" });
    return r && r.ok ? r.pid : null;
  } catch (e) {
    return null;
  }
}

async function restartViaWeb(d) {
  var sock = await d.openAdminSocket();
  sock.ws.send(JSON.stringify({ type: "restart_server" }));
  return sock;
}

function supervisedCase(name, env, restart) {
  test(name, { timeout: 90000 }, async function () {
    var d = await bootDaemon({ env: env });
    try {
      var firstPid = d.proc.pid;
      var sock = await restart(d);
      var code = await waitForExit(d.proc, 20000);
      if (sock) sock.ws.terminate();
      assert.equal(code, 120, "exit code; journal:\n" + d.journal().slice(-1500));
      assert.match(d.journal(), /Running under a supervisor/);
      assert.doesNotMatch(d.journal(), /Spawned new daemon/, "no self-spawned replacement");
      assert.equal(d.successorPid(), null, "no replacement pid is recorded");

      // Nothing else is serving: the port is free until the supervisor acts.
      await sleep(1500);
      assert.equal(await livePid(d), null, "no daemon answers before the supervisor starts one");

      // The supervisor starts exactly one daemon, and it is the one that answers.
      await d.respawn();
      var answering = await livePid(d);
      assert.equal(answering, d.proc.pid, "the daemon that answers is the supervisor's");
      assert.notEqual(answering, firstPid);
      assert.equal(pidAlive(firstPid), false, "the old daemon is gone");
    } finally {
      await d.cleanup();
    }
  });
}

supervisedCase("web-UI restart_server under INVOCATION_ID exits 120 and spawns nothing",
  { INVOCATION_ID: "0123456789abcdef0123456789abcdef" }, restartViaWeb);

supervisedCase("IPC restart under NOTIFY_SOCKET exits 120 and spawns nothing",
  { NOTIFY_SOCKET: "/run/systemd/notify" }, async function (d) {
    var r = await sendIPCCommand(d.sock, { cmd: "restart" });
    assert.equal(r.ok, true);
    return null;
  });

test("an unsupervised web-UI restart still brings the daemon back by itself", { timeout: 90000 }, async function () {
  var d = await bootDaemon();
  try {
    var sock = await restartViaWeb(d);
    var code = await waitForExit(d.proc, 20000);
    sock.ws.terminate();
    assert.equal(code, 120);
    assert.match(d.journal(), /Spawned new daemon/);
    var successor = d.successorPid();
    assert.ok(successor, "the replacement's pid is recorded");
    var answering = await waitUntil(function () { return livePid(d); }, 30000, "the self-spawned daemon");
    assert.equal(answering, successor);
  } finally {
    await d.cleanup();
  }
});
