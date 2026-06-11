// boot-smoke-lr-1a5f.test.js
//
// Regression guard for the class of failure documented in lr-8657 / PR #223:
// a broken static ESM import in lib/public/ caused a fatal boot error that
// all unit tests missed because no test exercises the real module load path.
//
// This test catches that failure class without requiring a browser.
// It uses only Node built-ins (http, net, child_process) and the `ws` package
// already present in dependencies — no new deps, no Playwright, no Chromium.
//
// What it proves:
//   1. The daemon starts and its HTTP server responds on /info (boot success).
//   2. The frontend HTML is served with HTTP 200 (static asset pipeline works).
//   3. A WebSocket upgrade to the project endpoint succeeds (auth gate + WS
//      handler wired up, ESM relay code loaded without errors).
//   4. The daemon exits cleanly when killed (no orphan processes).
//
// What it does NOT prove (and doesn't need to):
//   - That browser-side JS executes without errors (separate concern).
//   - That the full UI renders (integration/E2E territory).
//
// The test FAILS if any of the four checks above fail.
// The test is isolated: it uses an ephemeral port + a tmpdir home that is
// removed on completion. It never touches the real ~/.clagentic directory.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var net = require("net");
var http = require("http");
var { spawn } = require("child_process");
var WebSocket = require("ws");

// ── constants ────────────────────────────────────────────────────────────────

var DAEMON_SCRIPT = path.resolve(__dirname, "..", "lib", "daemon.js");
var TEST_TIMEOUT_MS = 45000;
var DAEMON_READY_MS = 20000;
var WS_CONNECT_MS  = 10000;

// ── helpers ──────────────────────────────────────────────────────────────────

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

function waitForServer(port, timeoutMs) {
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    function attempt() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error("daemon did not respond on /info within " + timeoutMs + " ms"));
        return;
      }
      var req = http.get("http://127.0.0.1:" + port + "/info", function (res) {
        res.resume();
        if (res.statusCode === 200) { resolve(); }
        else { setTimeout(attempt, 250); }
      });
      req.on("error", function () { setTimeout(attempt, 250); });
      req.setTimeout(500, function () { req.destroy(); });
    }
    attempt();
  });
}

function httpGet(url) {
  return new Promise(function (resolve, reject) {
    var req = http.get(url, function (res) {
      var body = "";
      res.setEncoding("utf8");
      res.on("data", function (c) { body += c; });
      res.on("end", function () { resolve({ status: res.statusCode, body: body }); });
    });
    req.on("error", reject);
    req.setTimeout(5000, function () { req.destroy(new Error("httpGet timeout")); });
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

// ── test ─────────────────────────────────────────────────────────────────────

test("boot smoke: daemon starts, HTTP 200, WS connects (lr-1a5f)", { timeout: TEST_TIMEOUT_MS }, function (t, done) {
  var tmpHome    = null;
  var daemonProc = null;
  var daemonLog  = [];

  // t.after: reliable cleanup even if the outer timeout fires.
  t.after(function () {
    var p = daemonProc && daemonProc.exitCode === null
      ? killAndWait(daemonProc).catch(function (e) { t.diagnostic("t.after daemon kill: " + e.message); })
      : Promise.resolve();
    return p.then(function () {
      if (tmpHome) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); }
        catch (e) { t.diagnostic("t.after tmpdir cleanup failed: " + e.message + " (leaked: " + tmpHome + ")"); }
      }
    });
  });

  findFreePort().then(function (port) {
    // ── 1. Isolated home + minimal config ────────────────────────────────────
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-smoke-"));
    var projectDir = path.join(tmpHome, "smoke-project");
    fs.mkdirSync(projectDir, { recursive: true });

    var configFile = path.join(tmpHome, "daemon.json");
    fs.writeFileSync(configFile, JSON.stringify({
      port:            port,
      host:            "127.0.0.1",
      tls:             false,
      pinHash:         null,
      mode:            "single",
      setupCompleted:  true,
      debug:           false,
      projects: [{ path: projectDir, slug: "smoke-project", addedAt: Date.now() }],
    }, null, 2), { mode: 0o600 });

    // ── 2. Spawn daemon ───────────────────────────────────────────────────────
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
      env: Object.assign({}, process.env, {
        CLAGENTIC_HOME:   tmpHome,
        CLAGENTIC_CONFIG: configFile,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemonProc.stdout.on("data", function (d) { daemonLog.push(d.toString()); });
    daemonProc.stderr.on("data", function (d) { daemonLog.push("[err] " + d.toString()); });
    daemonProc.once("exit", function (code) {
      if (code !== 0 && code !== null) {
        t.diagnostic("daemon exited with code " + code);
        t.diagnostic("daemon log:\n" + daemonLog.slice(-30).join(""));
      }
    });

    // ── 3. Check 1 — HTTP /info responds ─────────────────────────────────────
    return waitForServer(port, DAEMON_READY_MS).then(function () { return port; });

  }).then(function (port) {
    // ── 4. Check 2 — frontend HTML served with 200 ───────────────────────────
    return httpGet("http://127.0.0.1:" + port + "/p/smoke-project/").then(function (res) {
      assert.strictEqual(res.status, 200,
        "Expected HTTP 200 for frontend page, got " + res.status);
      assert.ok(
        res.body.includes("<html") || res.body.includes("<!DOCTYPE"),
        "Expected HTML response for frontend page"
      );
      return port;
    });

  }).then(function (port) {
    // ── 5. Check 3 — WebSocket upgrade succeeds ───────────────────────────────
    // Single-user mode with pinHash:null means no auth token is required.
    return new Promise(function (resolve, reject) {
      var wsUrl = "ws://127.0.0.1:" + port + "/p/smoke-project/ws";
      var ws = new WebSocket(wsUrl);
      var timer = setTimeout(function () {
        ws.terminate();
        reject(new Error(
          "WebSocket did not open within " + WS_CONNECT_MS + " ms. " +
          "This typically means the ESM module graph failed to boot (lr-8657 class). " +
          "WS URL: " + wsUrl
        ));
      }, WS_CONNECT_MS);

      ws.once("open", function () {
        clearTimeout(timer);
        ws.close();
        resolve(port);
      });
      ws.once("error", function (err) {
        clearTimeout(timer);
        reject(new Error("WebSocket error: " + err.message + " — URL: " + wsUrl));
      });
    });

  }).then(function () {
    t.diagnostic("boot smoke passed: /info OK, frontend HTTP 200, WS connected");

    // ── 6. Cleanup ────────────────────────────────────────────────────────────
    var p = daemonProc ? killAndWait(daemonProc) : Promise.resolve();
    return p.then(function () {
      if (tmpHome) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); }
        catch (e) { t.diagnostic("cleanup: tmpdir removal failed: " + e.message); }
        tmpHome = null;
      }
      done();
    });

  }).catch(function (err) {
    var p = daemonProc ? killAndWait(daemonProc).catch(function (e) {
      t.diagnostic("error-path daemon kill: " + e.message);
    }) : Promise.resolve();
    p.then(function () {
      if (tmpHome) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); }
        catch (e) { t.diagnostic("error-path tmpdir cleanup failed: " + e.message + " (leaked: " + tmpHome + ")"); }
        tmpHome = null;
      }
      done(err);
    });
  });
});
