// shell-asset-public-before-auth-lr-2895ea.test.js
//
// Regression coverage for lr-2895ea (MILLER, authenticated-session repro,
// confidence 0.9).
//
// SYMPTOM: mobile browser (plain tab, Firefox), after successful login,
// flashes the unstyled app shell then sits on "Reconnecting to server".
// Desktop unaffected.
//
// ROOT CAUSE: the app-shell assets — style.css, app.js, and app.js's
// ~70 ./modules/*.js imports — were served BEHIND the project-route auth
// gate (server.js), ahead of serveStatic(). The session cookie is
// SameSite=Lax with no Secure (daemon tls:false). Mobile browsers send the
// Lax cookie on the top-level document navigation (so the shell HTML serves
// authed) but WITHHOLD it on script/style SUBRESOURCE requests — so each
// asset request arrived unauthenticated, 401'd, and:
//   - the stylesheet never applied (the unstyled "raw HTML flash"), and
//   - app.js was nosniff-rejected (X-Content-Type-Options) so the module
//     script never ran and the app never booted past the static
//     "Reconnecting to server" overlay.
// Desktop sends the cookie on subresource requests too, so it escaped.
//
// This superseded PR #359 / lr-e33776, which only changed the unauthed
// asset response body from 200 text/html to 401 JSON — the asset was still
// unauthenticated either way, so the outcome (CSS unapplied, module
// unbooted) did not change.
//
// FIX (server.js): app.js, style.css, /modules/*.js, and any other static
// file under lib/public/ matching the existing asset-extension allowlist
// (js/mjs/css/map/json/fonts/images/wasm) or the /modules/ prefix — MINUS
// /api/* — are now served by serveStatic() BEFORE the project-route auth
// gate runs. These files are public and identical for every user, so
// serving them unauthenticated is safe. The auth gate is untouched for:
// the top-level document navigation (GET /p/{slug}/), all /api/* endpoints,
// and the /ws upgrade.
//
// This test spawns the real daemon (same harness as
// project-asset-auth-fallback-lr-e33776.test.js) and issues real
// unauthenticated HTTP + WS requests against project-scoped routes — the
// bug is an HTTP-response-shape / cookie-transport bug that only
// reproduces end-to-end.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var net = require("net");
var http = require("http");
var { spawn } = require("child_process");

// ── constants ────────────────────────────────────────────────────────────────

var DAEMON_SCRIPT = path.resolve(__dirname, "..", "lib", "daemon.js");
var TEST_TIMEOUT_MS = 45000;
var DAEMON_READY_MS = 20000;

// ── helpers (mirrors project-asset-auth-fallback-lr-e33776.test.js) ────────

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

function httpGetRaw(port, urlPath) {
  return new Promise(function (resolve, reject) {
    var req = http.get({
      hostname: "127.0.0.1",
      port: port,
      path: urlPath,
      // Deliberately no Cookie header — this is the unauthenticated case.
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({
          status: res.statusCode,
          contentType: res.headers["content-type"] || "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, function () { req.destroy(new Error("httpGetRaw timeout")); });
  });
}

// Raw unauthenticated WS upgrade attempt — no Cookie header, no ticket
// subprotocol offered. Resolves with the raw HTTP status line the server
// wrote before destroying the socket (mirrors ws-ticket-auth-lr-de5fcb.test.js
// expectations for a rejected upgrade).
function wsUpgradeRaw(port, urlPath) {
  return new Promise(function (resolve, reject) {
    var socket = net.connect(port, "127.0.0.1", function () {
      var req =
        "GET " + urlPath + " HTTP/1.1\r\n" +
        "Host: 127.0.0.1:" + port + "\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "\r\n";
      socket.write(req);
    });
    var data = "";
    socket.on("data", function (chunk) {
      data += chunk.toString("utf8");
      if (data.indexOf("\r\n") !== -1) {
        var statusLine = data.split("\r\n")[0];
        socket.destroy();
        resolve(statusLine);
      }
    });
    socket.on("error", reject);
    socket.setTimeout(5000, function () {
      socket.destroy();
      reject(new Error("wsUpgradeRaw timeout"));
    });
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

test("lr-2895ea: unauth GET of the app-shell static assets returns the real asset; document/api/ws stay gated", { timeout: TEST_TIMEOUT_MS }, function (t, done) {
  var tmpHome = null;
  var daemonProc = null;
  var daemonLog = [];

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
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-2895ea-"));
    var projectDir = path.join(tmpHome, "shell-asset-project");
    fs.mkdirSync(projectDir, { recursive: true });

    var configFile = path.join(tmpHome, "daemon.json");
    fs.writeFileSync(configFile, JSON.stringify({
      port: port,
      host: "127.0.0.1",
      tls: false,
      debug: false,
      projects: [{ path: projectDir, slug: "shell-asset-project", addedAt: Date.now(), visibility: "public" }],
    }, null, 2), { mode: 0o600 });

    // Multi-user mode with no admin set up yet — every project route is
    // unauthenticated for the duration of this test.
    var usersFile = path.join(tmpHome, "console", "users.json");
    fs.mkdirSync(path.dirname(usersFile), { recursive: true });
    fs.writeFileSync(usersFile, JSON.stringify({
      multiUser: true,
      setupCode: "LR2895EA",
      users: [],
      invites: [],
      smtp: null,
    }, null, 2), { mode: 0o600 });

    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
      env: Object.assign({}, process.env, {
        CLAGENTIC_HOME: tmpHome,
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

    return waitForServer(port, DAEMON_READY_MS).then(function () { return port; });

  }).then(function (port) {
    // ── Case 1: unauthenticated GET /p/{slug}/app.js → 200 real JS asset ───
    return httpGetRaw(port, "/p/shell-asset-project/app.js").then(function (res) {
      assert.strictEqual(res.status, 200,
        "unauthenticated app.js must return 200 (public shell asset, lr-2895ea); got " + res.status);
      assert.match(res.contentType, /application\/javascript/,
        "unauthenticated app.js must return a JS Content-Type; got " + res.contentType);
      assert.ok(res.body.length > 0, "unauthenticated app.js body must not be empty");
      return port;
    });

  }).then(function (port) {
    // ── Case 2: unauthenticated GET /p/{slug}/style.css → 200 real CSS ─────
    return httpGetRaw(port, "/p/shell-asset-project/style.css").then(function (res) {
      assert.strictEqual(res.status, 200,
        "unauthenticated style.css must return 200 (public shell asset, lr-2895ea); got " + res.status);
      assert.match(res.contentType, /text\/css/,
        "unauthenticated style.css must return a CSS Content-Type; got " + res.contentType);
      assert.ok(res.body.length > 0, "unauthenticated style.css body must not be empty");
      return port;
    });

  }).then(function (port) {
    // ── Case 3: unauthenticated GET /p/{slug}/modules/app-connection.js ────
    return httpGetRaw(port, "/p/shell-asset-project/modules/app-connection.js").then(function (res) {
      assert.strictEqual(res.status, 200,
        "unauthenticated modules/app-connection.js must return 200 (public shell asset, lr-2895ea); got " + res.status);
      assert.match(res.contentType, /application\/javascript/,
        "unauthenticated modules/app-connection.js must return a JS Content-Type; got " + res.contentType);
      return port;
    });

  }).then(function (port) {
    // ── Case 4: unauthenticated document navigation still 200 login HTML ───
    // The primary fix must not widen the gate beyond the public shell
    // assets — top-level navigation is still auth-gated.
    return httpGetRaw(port, "/p/shell-asset-project/").then(function (res) {
      assert.strictEqual(res.status, 200,
        "unauthenticated top-level project navigation must still return 200; got " + res.status);
      assert.match(res.contentType, /text\/html/,
        "unauthenticated top-level project navigation must still return the login HTML page; got " + res.contentType);
      return port;
    });

  }).then(function (port) {
    // ── Case 5: unauthenticated /api/* still 401 ────────────────────────────
    return httpGetRaw(port, "/p/shell-asset-project/api/whatever").then(function (res) {
      assert.strictEqual(res.status, 401,
        "unauthenticated /api/* must still be rejected; got " + res.status);
      assert.ok(
        !/text\/html/.test(res.contentType),
        "unauthenticated /api/* must never return Content-Type text/html; got " + res.contentType
      );
      return port;
    });

  }).then(function (port) {
    // ── Case 6: unauthenticated /ws upgrade still rejected ──────────────────
    return wsUpgradeRaw(port, "/p/shell-asset-project/ws").then(function (statusLine) {
      assert.match(statusLine, /401/,
        "unauthenticated /ws upgrade must still be rejected with 401; got status line: " + statusLine);
    });

  }).then(function () {
    t.diagnostic("lr-2895ea regression test passed: shell static assets serve 200 unauthed; document/api/ws stay gated");

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
