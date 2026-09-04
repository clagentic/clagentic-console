// daemon-ipc-memory-setter-parity-lr-553d27.test.js
//
// Regression tests for lr-553d27: the raw IPC socket cases for
// set_mem_available_threshold / set_tokens_per_mb_headroom used to silently
// CLAMP an out-of-range value to the default and report ok:true -- the same
// defect lr-93e3c8 already fixed on the WS/web path
// (onSetMemAvailableThreshold / onSetTokensPerMbHeadroom). The raw socket
// path is the documented operator escape hatch used when the UI can't save
// (see docs/guides/architecture.md "CLI <-> Daemon"), so a lying ok:true
// there is worse than no escape hatch at all -- BOBBIE judged this a
// genuine integrity issue, not cosmetic (see task comment #1).
//
// TEST DISCIPLINE (tome #845 -- "reports success while nothing happened" is
// this repo's dominant failure mode, and the FIX for each prior instance
// introduced the next): plumbing coverage ("the validator function exists
// and returns the right shape") is NOT reachability coverage ("a caller
// sending a real message over the real raw IPC socket actually receives
// that shape, and nothing was silently persisted instead"). Per repo
// convention, lib/daemon.js has no module.exports and cannot be required
// in-process (it binds real sockets/HTTP servers as a side effect of being
// loaded) -- see test/activity-diagnostics-retrieval-lr-8b476f.test.js's
// header comment for the established precedent. Unlike that probe (whose
// response-building logic already lived in a separate, requirable module),
// this defect is specifically about the CASE BODY in daemon.js's IPC
// switch, not just the validator it calls -- so genuine reachability
// coverage here means driving a REAL lib/ipc.js Unix socket server (the
// exact transport daemon.js binds) with a handler function that reproduces
// daemon.js's own case bodies verbatim (same validator import, same
// config-mutation shape, same response shape), then asserting over the
// real socket. Test 3 below then source-checks that daemon.js's actual case
// bodies match this reproduction, so the two cannot silently drift apart.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createIPCServer, sendIPCCommand } = require("../lib/ipc");
var {
  validateMemAvailableThresholdMB,
  validateTokensPerMbHeadroom,
} = require("../lib/memory-setting-validate");
var { DEFAULT_MEM_AVAILABLE_MIN_MB, DEFAULT_TOKENS_PER_MB_HEADROOM } = require("../lib/sdk-bridge");

// Reproduces daemon.js's own "set_mem_available_threshold" /
// "set_tokens_per_mb_headroom" IPC case bodies exactly (same validator call,
// same config mutation, same response shape) against an injected in-memory
// config + save function, so the test drives the real transport (lib/ipc.js)
// with the real case logic instead of a hand-waved stand-in.
function makeDaemonIpcHandler(config, saveConfig) {
  return function (msg) {
    switch (msg.cmd) {
      case "set_mem_available_threshold": {
        var memResult = validateMemAvailableThresholdMB(msg.value);
        if (!memResult.ok) {
          return { ok: false, error: memResult.error, memAvailableMinMB: config.memAvailableMinMB !== undefined ? config.memAvailableMinMB : DEFAULT_MEM_AVAILABLE_MIN_MB };
        }
        config.memAvailableMinMB = memResult.value;
        saveConfig(config);
        return { ok: true, memAvailableMinMB: memResult.value };
      }
      case "set_tokens_per_mb_headroom": {
        var tpmResult = validateTokensPerMbHeadroom(msg.value);
        if (!tpmResult.ok) {
          return { ok: false, error: tpmResult.error, tokensPerMbHeadroom: config.tokensPerMbHeadroom !== undefined ? config.tokensPerMbHeadroom : DEFAULT_TOKENS_PER_MB_HEADROOM };
        }
        config.tokensPerMbHeadroom = tpmResult.value;
        saveConfig(config);
        return { ok: true, tokensPerMbHeadroom: tpmResult.value };
      }
      default:
        return { ok: false, error: "unknown command: " + msg.cmd };
    }
  };
}

function withRealIpcServer(config, fn) {
  var sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-ipc-test-")), "daemon.sock");
  var saveCalls = [];
  var saveConfig = function (cfg) { saveCalls.push(Object.assign({}, cfg)); };
  var handler = makeDaemonIpcHandler(config, saveConfig);
  var server = createIPCServer(sockPath, handler);

  // createIPCServer's own connect-probe + bind is async; poll until the
  // socket file actually exists (bounded, since this transport binds a
  // Unix socket file synchronously inside listen()'s callback chain).
  return new Promise(function (resolve, reject) {
    var waited = 0;
    var poll = setInterval(function () {
      waited += 10;
      if (fs.existsSync(sockPath)) {
        clearInterval(poll);
        Promise.resolve(fn(sockPath, saveCalls))
          .then(function (result) {
            server.close();
            resolve(result);
          })
          .catch(function (err) {
            server.close();
            reject(err);
          });
      } else if (waited > 5000) {
        clearInterval(poll);
        server.close();
        reject(new Error("IPC server never bound socket at " + sockPath));
      }
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// set_mem_available_threshold: real out-of-range caller over the real socket
// ---------------------------------------------------------------------------

test("lr-553d27: raw IPC set_mem_available_threshold rejects a negative value with ok:false naming the band, over the real socket", function () {
  var config = { memAvailableMinMB: 256 };
  return withRealIpcServer(config, function (sockPath, saveCalls) {
    return sendIPCCommand(sockPath, { cmd: "set_mem_available_threshold", value: -5 }).then(function (resp) {
      assert.equal(resp.ok, false, "an out-of-range value must be rejected, not silently clamped and reported as success");
      assert.match(resp.error, />=\s*0/, "the error must name the valid band (>= 0)");
      assert.equal(config.memAvailableMinMB, 256, "the persisted value must be UNCHANGED after a rejected write");
      assert.equal(saveCalls.length, 0, "saveConfig must never be called for a rejected value");
    });
  });
});

test("lr-553d27: raw IPC set_mem_available_threshold rejects a non-numeric value with ok:false, persisted value unchanged", function () {
  var config = { memAvailableMinMB: 128 };
  return withRealIpcServer(config, function (sockPath, saveCalls) {
    return sendIPCCommand(sockPath, { cmd: "set_mem_available_threshold", value: "not-a-number" }).then(function (resp) {
      assert.equal(resp.ok, false);
      assert.equal(config.memAvailableMinMB, 128, "persisted value must be UNCHANGED, not silently reset to the default");
      assert.equal(saveCalls.length, 0);
    });
  });
});

test("lr-553d27: raw IPC set_mem_available_threshold still accepts an in-range value (no regression on legitimate callers)", function () {
  var config = { memAvailableMinMB: 128 };
  return withRealIpcServer(config, function (sockPath, saveCalls) {
    return sendIPCCommand(sockPath, { cmd: "set_mem_available_threshold", value: 512 }).then(function (resp) {
      assert.equal(resp.ok, true);
      assert.equal(resp.memAvailableMinMB, 512);
      assert.equal(config.memAvailableMinMB, 512, "an in-range value must still persist");
      assert.equal(saveCalls.length, 1);
    });
  });
});

test("lr-553d27: raw IPC set_mem_available_threshold still accepts the legitimate 'disable this gate' value of 0", function () {
  var config = { memAvailableMinMB: 512 };
  return withRealIpcServer(config, function (sockPath) {
    return sendIPCCommand(sockPath, { cmd: "set_mem_available_threshold", value: 0 }).then(function (resp) {
      assert.equal(resp.ok, true, "0 is a legitimate value (lr-93e3c8 finding 1) and must not be rejected");
      assert.equal(config.memAvailableMinMB, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// set_tokens_per_mb_headroom: real out-of-range caller over the real socket
// ---------------------------------------------------------------------------

test("lr-553d27: raw IPC set_tokens_per_mb_headroom rejects an out-of-range value (1000) with ok:false naming the 10-500 band, over the real socket", function () {
  // 1000 is the exact plausible-operator-instinct value named in the task
  // description as landing squarely in the pre-fix trap.
  var config = { tokensPerMbHeadroom: 240 };
  return withRealIpcServer(config, function (sockPath, saveCalls) {
    return sendIPCCommand(sockPath, { cmd: "set_tokens_per_mb_headroom", value: 1000 }).then(function (resp) {
      assert.equal(resp.ok, false, "an out-of-range value must be rejected, not silently clamped to the default and reported ok:true");
      assert.match(resp.error, /10-500/, "the error must name the valid band (10-500)");
      assert.equal(config.tokensPerMbHeadroom, 240, "the persisted value must be UNCHANGED after a rejected write -- this is the exact trap: the default used to silently land here instead");
      assert.equal(saveCalls.length, 0, "saveConfig must never be called for a rejected value");
    });
  });
});

test("lr-553d27: raw IPC set_tokens_per_mb_headroom rejects a value below the band (5) with ok:false, persisted value unchanged", function () {
  var config = { tokensPerMbHeadroom: 300 };
  return withRealIpcServer(config, function (sockPath, saveCalls) {
    return sendIPCCommand(sockPath, { cmd: "set_tokens_per_mb_headroom", value: 5 }).then(function (resp) {
      assert.equal(resp.ok, false);
      assert.match(resp.error, /10-500/);
      assert.equal(config.tokensPerMbHeadroom, 300);
      assert.equal(saveCalls.length, 0);
    });
  });
});

test("lr-553d27: raw IPC set_tokens_per_mb_headroom still accepts an in-range value (no regression on legitimate callers)", function () {
  var config = { tokensPerMbHeadroom: 240 };
  return withRealIpcServer(config, function (sockPath, saveCalls) {
    return sendIPCCommand(sockPath, { cmd: "set_tokens_per_mb_headroom", value: 300 }).then(function (resp) {
      assert.equal(resp.ok, true);
      assert.equal(resp.tokensPerMbHeadroom, 300);
      assert.equal(config.tokensPerMbHeadroom, 300, "an in-range value must still persist");
      assert.equal(saveCalls.length, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// Source-parity check: daemon.js's actual case bodies must call the SAME
// shared validator this test drives, not a hand-duplicated inline copy that
// could silently drift back to the clamp-and-report-success shape. Mirrors
// the established convention in
// test/activity-diagnostics-retrieval-lr-8b476f.test.js (source inspection
// paired with, never substituting for, the behavioral tests above).
// ---------------------------------------------------------------------------

test("lib/daemon.js: set_mem_available_threshold and set_tokens_per_mb_headroom IPC cases call the shared memory-setting-validate.js functions", function () {
  var daemonSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  assert.match(daemonSrc, /require\(["']\.\/memory-setting-validate["']\)/, "daemon.js must require lib/memory-setting-validate.js");

  var memCaseStart = daemonSrc.indexOf('case "set_mem_available_threshold"');
  assert.ok(memCaseStart !== -1, 'expected a "set_mem_available_threshold" IPC case in lib/daemon.js');
  var memCaseEnd = daemonSrc.indexOf("case ", memCaseStart + 1);
  var memCaseBody = daemonSrc.slice(memCaseStart, memCaseEnd);
  assert.match(memCaseBody, /validateMemAvailableThresholdMB\(/, "the IPC case must call the shared validator, not an inline duplicate");
  assert.match(memCaseBody, /ok:\s*false/, "the IPC case must be able to return ok:false on rejection");
  assert.doesNotMatch(memCaseBody, /=\s*DEFAULT_MEM_AVAILABLE_MIN_MB;/, "must not silently clamp the value to the default on the out-of-range branch");

  var tpmCaseStart = daemonSrc.indexOf('case "set_tokens_per_mb_headroom"');
  assert.ok(tpmCaseStart !== -1, 'expected a "set_tokens_per_mb_headroom" IPC case in lib/daemon.js');
  var tpmCaseEnd = daemonSrc.indexOf("case ", tpmCaseStart + 1);
  var tpmCaseBody = daemonSrc.slice(tpmCaseStart, tpmCaseEnd);
  assert.match(tpmCaseBody, /validateTokensPerMbHeadroom\(/, "the IPC case must call the shared validator, not an inline duplicate");
  assert.match(tpmCaseBody, /ok:\s*false/, "the IPC case must be able to return ok:false on rejection");
  assert.doesNotMatch(tpmCaseBody, /=\s*DEFAULT_TOKENS_PER_MB_HEADROOM;/, "must not silently clamp the value to the default on the out-of-range branch");
});

test("lib/daemon.js: onSetMemAvailableThreshold and onSetTokensPerMbHeadroom (WS/web path) also call the shared validators (single-contract check)", function () {
  var daemonSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");

  var webMemStart = daemonSrc.indexOf("onSetMemAvailableThreshold: function");
  assert.ok(webMemStart !== -1);
  var webMemEnd = daemonSrc.indexOf("\n  },", webMemStart);
  var webMemBody = daemonSrc.slice(webMemStart, webMemEnd);
  assert.match(webMemBody, /validateMemAvailableThresholdMB\(/, "the WS/web handler must call the same shared validator as the raw IPC path, not a second independent copy");

  var webTpmStart = daemonSrc.indexOf("onSetTokensPerMbHeadroom: function");
  assert.ok(webTpmStart !== -1);
  var webTpmEnd = daemonSrc.indexOf("\n  },", webTpmStart);
  var webTpmBody = daemonSrc.slice(webTpmStart, webTpmEnd);
  assert.match(webTpmBody, /validateTokensPerMbHeadroom\(/, "the WS/web handler must call the same shared validator as the raw IPC path, not a second independent copy");
});
