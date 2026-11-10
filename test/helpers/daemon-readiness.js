// Shared readiness helpers for tests that spawn the real daemon on a probed port.
//
// findFreePort() closes its probe socket before the daemon binds, so under
// full-suite load (many parallel daemons) another process can take the port in
// that window. The daemon then logs "in use, retrying", and an HTTP-only
// readiness check is satisfied by whatever foreign server owns the port, so
// assertions would run against the wrong server. Readiness here means the
// spawned daemon itself printed its listen line; a bind collision is reported
// as an error with portInUse: true so the caller can start over on a fresh port.

"use strict";

var net = require("net");
var http = require("http");

var LISTEN_LINE = /\[daemon\] Listening on /;
var PORT_IN_USE_LINE = /\[daemon\] Port \d+ in use, retrying/;

function findFreePort() {
  return new Promise(function (resolve, reject) {
    var srv = net.createServer();
    srv.listen(0, "127.0.0.1", function () {
      var p = srv.address().port;
      srv.close(function () { resolve(p); });
    });
    srv.on("error", reject);
  });
}

// HTTP liveness probe. Only meaningful after waitForDaemonListening has
// confirmed the daemon owns the port.
function waitForServer(port, timeoutMs) {
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    function attempt() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error("daemon did not respond within " + timeoutMs + " ms"));
        return;
      }
      var req = http.get("http://127.0.0.1:" + port + "/", function (res) {
        res.resume();
        if (res.statusCode) { resolve(); }
        else { setTimeout(attempt, 250); }
      });
      req.on("error", function () { setTimeout(attempt, 250); });
      req.setTimeout(500, function () { req.destroy(); });
    }
    attempt();
  });
}

// opts.fromOffset: only log text after this character offset counts, so a
//   restarted daemon cannot be satisfied by the previous boot's listen line.
// opts.tolerateInUse: ignore "in use, retrying" lines and keep waiting for the
//   daemon's own retry to bind. For a restart on a fixed port, where moving to a
//   fresh port is not an option; a foreign owner still never yields a listen
//   line, so it ends in a timeout or an exit, never in readiness.
// A timeout says whether the daemon exited or never bound, with its log.
function waitForDaemonListening(proc, getLog, timeoutMs, opts) {
  var fromOffset = (opts && opts.fromOffset) || 0;
  var tolerateInUse = !!(opts && opts.tolerateInUse);
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    var finished = false;
    function finish(err, value) {
      if (finished) { return; }
      finished = true;
      proc.removeListener("exit", onExit);
      if (err) { reject(err); } else { resolve(value); }
    }
    function onExit(code) {
      finish(new Error("daemon exited with code " + code + " before listening:\n" + getLog()));
    }
    proc.once("exit", onExit);
    (function poll() {
      if (finished) { return; }
      var log = getLog();
      var scoped = fromOffset ? log.slice(fromOffset) : log;
      if (!tolerateInUse && PORT_IN_USE_LINE.test(scoped)) {
        var e = new Error("daemon port was taken before the daemon bound it");
        e.portInUse = true;
        finish(e);
        return;
      }
      if (LISTEN_LINE.test(scoped)) { finish(null); return; }
      if (Date.now() - start > timeoutMs) {
        finish(new Error("daemon never bound: still running, but logged no listen line within " + timeoutMs + " ms:\n" + log));
        return;
      }
      setTimeout(poll, 50);
    })();
  });
}

function killAndWait(proc) {
  return new Promise(function (resolve) {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.once("exit", resolve);
    try { proc.kill("SIGTERM"); } catch (_) {}
    setTimeout(function () {
      try { proc.kill("SIGKILL"); } catch (_) {}
      resolve();
    }, 4000);
  });
}

// A bind collision on the probed port is a setup race, not a test result:
// stop the collided daemon, pick a fresh port and start over, at most
// `attempts` times. Any other failure rejects immediately. Callers run their
// assertions only after this resolves, so they never see a collided setup.
//   startOn(port)  -> Promise resolving once the daemon on `port` is ready
//   getProc()      -> the daemon process most recently spawned by startOn
function startOnFreePort(startOn, getProc, attempts) {
  return findFreePort().then(startOn).catch(function (err) {
    if (err && err.portInUse && attempts > 1) {
      var proc = getProc();
      var stopped = proc ? killAndWait(proc) : Promise.resolve();
      return stopped.then(function () { return startOnFreePort(startOn, getProc, attempts - 1); });
    }
    throw err;
  });
}

module.exports = {
  findFreePort: findFreePort,
  waitForServer: waitForServer,
  waitForDaemonListening: waitForDaemonListening,
  killAndWait: killAndWait,
  startOnFreePort: startOnFreePort,
};
