// boot-smoke-lr-1a5f.test.js
//
// Daemon boot smoke test (lr-1a5f).
//
// What this test proves (server-side only):
//   1. The daemon starts and its HTTP server responds on /info (boot success).
//   2. The frontend HTML is served with HTTP 200 (static asset pipeline works).
//   3. A WebSocket upgrade to the project endpoint succeeds (server-side WS
//      handler wired up, auth gate passes, relay code loaded without errors).
//
// What this test does NOT prove:
//   - That browser-side ESM (lib/public/*.js) loads without errors.
//     Browser ESM imports are NOT loaded by the daemon; they are served as
//     static assets. Broken browser imports (the lr-8657 failure class) are
//     caught by the static import-resolution check (lr-5e24), not here.
//   - That the full UI renders correctly (integration/E2E territory).
//
// The test FAILS if any of the three server-side checks fail.
// The test is isolated: uses an ephemeral port + a tmpdir home, never touches
// the real ~/.clagentic directory.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var http = require("http");
var { spawn } = require("child_process");
var WebSocket = require("ws");
var {
  waitForServer,
  waitForDaemonListening,
  killAndWait,
  startOnFreePort,
} = require("./helpers/daemon-readiness");

// ── constants ────────────────────────────────────────────────────────────────

var DAEMON_SCRIPT = path.resolve(__dirname, "..", "lib", "daemon.js");
var TEST_TIMEOUT_MS = 45000;
var DAEMON_READY_MS = 20000;
var HTTP_READY_MS = 10000; // after the listen line, HTTP must answer promptly
var WS_CONNECT_MS  = 10000;
var PORT_ATTEMPTS = 5;

// ── helpers ──────────────────────────────────────────────────────────────────

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

// ── test ─────────────────────────────────────────────────────────────────────

// Perform an HTTP POST and return { status, body, headers }.
function httpPost(url, body) {
  return new Promise(function (resolve, reject) {
    var parsed = new (require("url").URL)(url);
    var bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    var opts = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };
    var req = http.request(opts, function (res) {
      var b = "";
      res.setEncoding("utf8");
      res.on("data", function (c) { b += c; });
      res.on("end", function () {
        resolve({ status: res.statusCode, body: b, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

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

  var SMOKE_SETUP_CODE = "SMOKETEST";
  var SMOKE_PIN = "123456";
  var SMOKE_USERNAME = "smokeadmin";

  // ── 1. Isolated home + minimal config ──────────────────────────────────────
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-smoke-"));
  var projectDir = path.join(tmpHome, "smoke-project");
  fs.mkdirSync(projectDir, { recursive: true });

  var configFile = path.join(tmpHome, "daemon.json");

  // Pre-seed users.json with a known setup code so the smoke test can authenticate.
  // lr-ec2d: single-user mode removed; system always runs in multi-user mode.
  var usersFile = path.join(tmpHome, "console", "users.json");
  fs.mkdirSync(path.dirname(usersFile), { recursive: true });
  fs.writeFileSync(usersFile, JSON.stringify({
    multiUser: true,
    setupCode: SMOKE_SETUP_CODE,
    users: [],
    invites: [],
    smtp: null,
  }, null, 2), { mode: 0o600 });

  // ── 2. Spawn daemon on a probed port ────────────────────────────────────────
  // Readiness is the daemon's own listen line, then an HTTP check; a port taken
  // between probe and bind restarts this setup on a fresh port (bounded), so the
  // assertions below never run against a foreign server.
  function startDaemonOn(port) {
    daemonLog = [];
    fs.writeFileSync(configFile, JSON.stringify({
      port:            port,
      host:            "127.0.0.1",
      tls:             false,
      debug:           false,
      projects: [{ path: projectDir, slug: "smoke-project", addedAt: Date.now(), visibility: "public" }],
    }, null, 2), { mode: 0o600 });

    var proc = spawn(process.execPath, [DAEMON_SCRIPT], {
      env: Object.assign({}, process.env, {
        CLAGENTIC_HOME:   tmpHome,
        CLAGENTIC_CONFIG: configFile,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemonProc = proc;
    proc.stdout.on("data", function (d) { daemonLog.push(d.toString()); });
    proc.stderr.on("data", function (d) { daemonLog.push("[err] " + d.toString()); });
    proc.once("exit", function (code) {
      if (code !== 0 && code !== null) {
        t.diagnostic("daemon exited with code " + code);
        t.diagnostic("daemon log:\n" + daemonLog.slice(-30).join(""));
      }
    });

    // ── 3. Check 1 — daemon booted (listen line) and answers HTTP ─────────────
    return waitForDaemonListening(proc, function () { return daemonLog.join(""); }, DAEMON_READY_MS)
      .then(function () { return waitForServer(port, HTTP_READY_MS); })
      .then(function () { return port; });
  }

  startOnFreePort(startDaemonOn, function () { return daemonProc; }, PORT_ATTEMPTS).then(function (port) {
    // ── 4. Authenticate: create admin via /auth/setup ─────────────────────────
    return httpPost("http://127.0.0.1:" + port + "/auth/setup", {
      setupCode: SMOKE_SETUP_CODE,
      username:  SMOKE_USERNAME,
      pin:       SMOKE_PIN,
    }).then(function (setupRes) {
      assert.strictEqual(setupRes.status, 200, "admin setup should succeed, got: " + setupRes.status + " " + setupRes.body.slice(0, 200));
      var setCookie = setupRes.headers["set-cookie"];
      assert.ok(setCookie, "setup should set a session cookie");
      // Extract the cookie value (first cookie in the array)
      var cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      return cookieHeader;
    }).then(function (cookieHeader) {
      // Give the daemon a moment to finish writing users.json to disk.
      // The setup handler calls saveUsers() asynchronously via store.js; findUserById()
      // reads from disk, so there is a brief window where the user is in memory
      // but not yet on disk. A 150ms pause is enough for the atomic write to complete.
      // TODO(lr-ec2d): convert findUserById to use an in-memory user cache so this delay is unnecessary.
      return new Promise(function (resolve) {
        setTimeout(function () { resolve({ port: port, cookieHeader: cookieHeader }); }, 150);
      });
    });

  }).then(function (ctx) {
    var port = ctx.port;
    var cookieHeader = ctx.cookieHeader;

    // ── 5. Check 2 — /info responds 200 with valid cookie ────────────────────
    return new Promise(function (resolve, reject) {
      var req = http.get({
        hostname: "127.0.0.1",
        port: port,
        path: "/info",
        headers: { "Cookie": cookieHeader.split(";")[0] },
      }, function (res) {
        var b = "";
        res.setEncoding("utf8");
        res.on("data", function (c) { b += c; });
        res.on("end", function () {
          try {
            assert.strictEqual(res.statusCode, 200, "Expected HTTP 200 for /info, got " + res.statusCode);
            resolve({ port: port, cookieHeader: cookieHeader });
          } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
    });

  }).then(function (ctx) {
    var port = ctx.port;
    var cookieHeader = ctx.cookieHeader;
    var cookieValue = cookieHeader.split(";")[0]; // strip Path, HttpOnly etc.

    // ── 6. Check 3 — frontend HTML served with 200 ───────────────────────────
    return new Promise(function (resolve, reject) {
      var req = http.get({
        hostname: "127.0.0.1",
        port: port,
        path: "/p/smoke-project/",
        headers: { "Cookie": cookieValue },
      }, function (res) {
        var b = "";
        res.setEncoding("utf8");
        res.on("data", function (c) { b += c; });
        res.on("end", function () {
          try {
            assert.strictEqual(res.statusCode, 200,
              "Expected HTTP 200 for frontend page, got " + res.statusCode);
            assert.ok(
              b.includes("<html") || b.includes("<!DOCTYPE"),
              "Expected HTML response for frontend page"
            );
            resolve({ port: port, cookieValue: cookieValue });
          } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
    });

  }).then(function (ctx) {
    var port = ctx.port;
    var cookieValue = ctx.cookieValue;

    // ── 7. Check 4 — WebSocket upgrade succeeds (authenticated) ──────────────
    // lr-ec2d: single-user mode removed; WS requires a valid auth cookie.
    return new Promise(function (resolve, reject) {
      var wsUrl = "ws://127.0.0.1:" + port + "/p/smoke-project/ws";
      var ws = new WebSocket(wsUrl, { headers: { "Cookie": cookieValue } });
      var timer = setTimeout(function () {
        ws.terminate();
        reject(new Error(
          "WebSocket did not open within " + WS_CONNECT_MS + " ms. " +
          "Check that the daemon booted cleanly and the WS handler is registered. " +
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
        t.diagnostic("WS cookieValue: " + cookieValue.slice(0, 60));
        t.diagnostic("daemon log tail:\n" + daemonLog.slice(-10).join(""));
        reject(new Error("WebSocket error: " + err.message + " — URL: " + wsUrl));
      });
    });

  }).then(function () {
    t.diagnostic("boot smoke passed: daemon up, admin setup OK, /info 200, frontend 200, WS connected");

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

// Regression for the readiness defect: a foreign HTTP server already on the
// daemon's port must be reported as a collision, never as the daemon being ready.
test("boot smoke: a foreign server on the daemon port is a port collision, not readiness", { timeout: TEST_TIMEOUT_MS }, function (t, done) {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-smoke-collide-"));
  var foreign = http.createServer(function (req, res) { res.writeHead(404); res.end("foreign"); });
  var daemonProc = null;
  var log = [];

  function cleanup() {
    var p = daemonProc && daemonProc.exitCode === null ? killAndWait(daemonProc) : Promise.resolve();
    return p.then(function () {
      return new Promise(function (r) { foreign.close(function () { r(); }); });
    }).then(function () {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); }
      catch (e) { t.diagnostic("collision test tmpdir cleanup failed: " + e.message); }
    });
  }

  foreign.listen(0, "127.0.0.1", function () {
    var port = foreign.address().port;
    var configFile = path.join(tmpHome, "daemon.json");
    fs.writeFileSync(configFile, JSON.stringify({
      port: port, host: "127.0.0.1", tls: false, debug: false, projects: [],
    }), { mode: 0o600 });
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
      env: Object.assign({}, process.env, { CLAGENTIC_HOME: tmpHome, CLAGENTIC_CONFIG: configFile }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemonProc.stdout.on("data", function (d) { log.push(d.toString()); });
    daemonProc.stderr.on("data", function (d) { log.push("[err] " + d.toString()); });

    waitForDaemonListening(daemonProc, function () { return log.join(""); }, DAEMON_READY_MS).then(
      function () {
        cleanup().then(function () { done(new Error("readiness reported although a foreign server owns the port")); });
      },
      function (err) {
        cleanup().then(function () {
          try { assert.strictEqual(err.portInUse, true, "expected a portInUse rejection; got: " + err.message); done(); }
          catch (e) { done(e); }
        });
      }
    );
  });
});
