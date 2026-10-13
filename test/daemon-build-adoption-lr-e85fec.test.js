"use strict";

// A real daemon over a throwaway install, driven through a reinstall.
//
// The stale-code warning used to key on the kernel's "(deleted)" mapping
// marker. The daemon keeps its native module mapped from the install, so ANY
// reinstall, even one that changes nothing, unlinks that inode; the marker then
// never clears and the warning repeated every minute. These cases pin what the
// verdict is now: sha plus content hash, with nothing restarting unless the
// operator confirms.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { execFileSync } = require("child_process");

var { bootDaemon, waitForExit } = require("./fixtures/daemon-harness");
var { makeInstall } = require("./fixtures/install-fixture");
var { sendIPCCommand } = require("../lib/ipc");

var REPO_ROOT = path.resolve(__dirname, "..");
var SHA_A = "a".repeat(40);
var SHA_B = "b".repeat(40);
var CHECK_MS = "300";

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

function status(d) { return sendIPCCommand(d.sock, { cmd: "get_build_status" }); }

function buildUpdateDiagnostics(sock) {
  return sock.messages.filter(function (m) { return m.type === "diagnostic" && m.source === "build-update"; });
}

function bootFromInstall(inst, extra) {
  return bootDaemon(Object.assign({
    script: inst.daemonScript,
    env: { CLAGENTIC_CONSOLE_BUILD_CHECK_MS: CHECK_MS },
  }, extra || {}));
}

test("a fresh daemon on the installed build is adopted and logs no stale warning", { timeout: 60000 }, async function () {
  var inst = makeInstall(SHA_A);
  var d = await bootFromInstall(inst);
  try {
    await sleep(2500); // several checks at CHECK_MS
    var s = await status(d);
    assert.equal(s.state, "adopted", JSON.stringify(s));
    assert.equal(s.loadedBuildSha, SHA_A);
    assert.equal(s.installedBuildSha, SHA_A);
    assert.doesNotMatch(d.journal(), /serving STALE/);
  } finally {
    await d.cleanup();
    inst.cleanup();
  }
});

test("an identical reinstall over a running daemon is still adopted and still logs nothing", { timeout: 60000 }, async function () {
  var inst = makeInstall(SHA_A);
  var d = await bootFromInstall(inst);
  try {
    var sock = await d.openAdminSocket();
    inst.reinstallIdentical();
    await sleep(2500);
    var s = await status(d);
    // The old signal: the reinstall unlinked a file the daemon maps.
    assert.equal(s.staleInodes, true, "the reinstall must leave a deleted mapping, or this case proves nothing");
    // The verdict does not depend on it.
    assert.equal(s.state, "adopted", JSON.stringify(s));
    assert.equal(s.loadedContentHash, s.installedContentHash);
    assert.doesNotMatch(d.journal(), /serving STALE/);
    assert.equal(buildUpdateDiagnostics(sock).length, 0, "no update is offered for an identical reinstall");
    sock.ws.terminate();
  } finally {
    await d.cleanup();
    inst.cleanup();
  }
});

test("a different installed build is stale, offered, and restarts nothing until the operator confirms", { timeout: 120000 }, async function () {
  // Real commits, so the offer's change list can be checked against git.
  var shaNew = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  var shaOld = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  var inst = makeInstall(shaOld);
  // INVOCATION_ID: the restart is an exit, so this test can observe it without a self-spawned process.
  var d = await bootDaemon({
    script: inst.daemonScript,
    env: { CLAGENTIC_CONSOLE_BUILD_CHECK_MS: CHECK_MS, INVOCATION_ID: "test-unit" },
    config: { buildSourceRepo: REPO_ROOT },
  });
  try {
    var sock = await d.openAdminSocket();
    assert.doesNotMatch(d.journal(), /BUILD-MARKER/);

    inst.installBuild(shaNew, "marker-new");

    var announced = await waitUntil(function () { return buildUpdateDiagnostics(sock)[0]; }, 15000, "the update offer");
    assert.equal(announced.actionable.action, "restart_for_build_update");
    assert.equal(announced.buildUpdate.loadedBuildSha, shaOld);
    assert.equal(announced.buildUpdate.installedBuildSha, shaNew);
    assert.equal(announced.buildUpdate.interruptions, undefined, "the broadcast carries no session content");
    assert.equal(announced.buildUpdate.token, undefined, "the broadcast carries no confirmation token");
    // The offer is shown at once; the change list refreshes it in place when git answers.
    var listed = await waitUntil(function () {
      return buildUpdateDiagnostics(sock).find(function (m) { return m.buildUpdate && m.buildUpdate.changes.available; });
    }, 15000, "the offer refreshed with its change list");
    assert.equal(listed.refresh, true, "the change list refreshes the offer rather than adding a second one");
    assert.equal(listed.actionable.action, "restart_for_build_update");
    assert.ok(listed.buildUpdate.changes.commits.length >= 1, "the commits between the builds are listed");
    assert.equal(
      sock.messages.filter(function (m) { return m.type === "diagnostic_retract" && m.source === "build-update"; }).length, 0,
      "the offer is not retracted while it is refreshed"
    );

    var s = await status(d);
    assert.equal(s.state, "stale");
    assert.equal(s.loadedBuildSha, shaOld);
    assert.equal(s.installedBuildSha, shaNew);
    assert.match(d.journal(), /serving STALE code/);

    // Time passes with the offer standing: nothing restarts by itself.
    await sleep(3000);
    assert.equal(d.proc.exitCode, null, "the daemon must not restart without a confirmed click");

    // First click: ask for the offer. It names what a restart would end and restarts nothing.
    sock.ws.send(JSON.stringify({ type: "restart_for_build_update" }));
    var offer = await waitUntil(function () {
      return buildUpdateDiagnostics(sock).find(function (m) { return m.buildUpdate && m.buildUpdate.token; });
    }, 10000, "the confirmation offer");
    assert.equal(offer.actionable.action, "confirm_build_update_restart");
    assert.match(offer.message, /No session is live/);
    assert.equal(offer.buildUpdate.interruptions.sessionCount, 0);
    await sleep(1500);
    assert.equal(d.proc.exitCode, null, "asking for the offer must not restart");

    // A token the daemon did not issue restarts nothing and returns a fresh offer.
    var before = buildUpdateDiagnostics(sock).length;
    sock.ws.send(JSON.stringify({ type: "restart_for_build_update", confirmToken: "forged" }));
    await waitUntil(function () { return buildUpdateDiagnostics(sock).length > before; }, 10000, "a fresh offer after a forged token");
    await sleep(1500);
    assert.equal(d.proc.exitCode, null, "a forged token must not restart");

    // The confirmed click restarts, as an exit the supervisor answers (no self-spawn).
    sock.ws.send(JSON.stringify({ type: "restart_for_build_update", confirmToken: offer.buildUpdate.token }));
    var code = await waitForExit(d.proc, 30000);
    assert.equal(code, 120, "exit code; journal:\n" + d.journal().slice(-1500));
    assert.equal(d.successorPid(), null, "a supervised restart spawns no replacement");
    assert.doesNotMatch(d.journal(), /Spawned new daemon/);

    // The supervisor starts the new build: it is adopted, and it ran different code.
    var before2 = d.journal().length;
    await d.respawn(inst.daemonScript);
    var after = await status(d);
    assert.equal(after.state, "adopted", JSON.stringify(after));
    assert.equal(after.loadedBuildSha, shaNew);
    var newRun = d.journal().slice(before2);
    assert.match(newRun, /BUILD-MARKER marker-new/, "the restarted process executes the newly installed code");
    assert.doesNotMatch(d.journal().slice(0, before2), /BUILD-MARKER/, "the process before the restart ran the old code");
    sock.ws.terminate();
  } finally {
    await d.cleanup();
    inst.cleanup();
  }
});
