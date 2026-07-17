// project-asset-auth-fallback-lr-e33776.test.js
//
// Regression coverage for lr-e33776 (MILLER, live-verified root cause).
//
// Bug: lib/server.js's project-route auth gate returned HTTP 200 with the
// login HTML page (Content-Type: text/html) for ANY unauthenticated request
// under /p/{slug}/... — including .js/.css/module/API sub-resource requests
// — because that branch ran before serveStatic and had no notion of
// "asset vs. document navigation".
//
// Because index.html boots via <script type="module" src="app.js"> and the
// server sets X-Content-Type-Options: nosniff, an unauthenticated app.js
// request returning 200 text/html makes the browser hard-reject the module
// script: the app never boots, the shell renders unstyled ("raw HTML flash"),
// and the dead client shows "reconnecting to server". This was proven to
// hit mobile clients that withhold the session cookie on post-login
// sub-resource requests (see lr-de5fcb).
//
// Fix (server.js): the unauthed project-route branch now classifies the
// requested path — an asset/module/API path (by extension, /modules/ prefix,
// or /api/ prefix) gets a non-HTML 401 instead of the 200 login page. A
// top-level document navigation (e.g. /p/{slug}/) still gets the login page.
//
// SUPERSEDED IN PART BY lr-2895ea: the classification above was necessary
// but not sufficient — MILLER later proved (lr-2895ea, conf 0.9) that mobile
// browsers withhold the SameSite=Lax session cookie on subresource requests
// even on an authed session, so gating the real app.js/style.css/modules/*
// shell assets behind auth at all (401 or otherwise) broke mobile app boot.
// lr-2895ea moved these PUBLIC, identical-for-every-user shell files to be
// served by serveStatic() BEFORE the auth gate, so they now return 200 with
// the real asset even when unauthenticated. Cases 1 and 3 below (a real,
// on-disk app.js and modules/app-connection.js) were updated to assert 200 +
// correct MIME instead of "not 200" to reflect that. Case 2 (a path that
// does not exist on disk) still falls through to the pre-existing 401
// behavior asserted here, since serveStatic() has nothing to serve.
// /api/* (case 4) was never made public and keeps the original assertion.
//
// This test spawns the real daemon (same harness as boot-smoke-lr-1a5f) and
// issues real unauthenticated HTTP requests against project-scoped routes —
// the bug is an HTTP-response-shape bug that only reproduces end-to-end.

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

// ── helpers (mirrors boot-smoke-lr-1a5f.test.js) ───────────────────────────

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

test("lr-e33776: unauthed project asset/module/API requests never get 200 text/html; navigation still shows the login page", { timeout: TEST_TIMEOUT_MS }, function (t, done) {
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
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-e33776-"));
    var projectDir = path.join(tmpHome, "asset-auth-project");
    fs.mkdirSync(projectDir, { recursive: true });

    var configFile = path.join(tmpHome, "daemon.json");
    fs.writeFileSync(configFile, JSON.stringify({
      port: port,
      host: "127.0.0.1",
      tls: false,
      debug: false,
      projects: [{ path: projectDir, slug: "asset-auth-project", addedAt: Date.now(), visibility: "public" }],
    }, null, 2), { mode: 0o600 });

    // Multi-user mode with no admin set up yet — every project route is
    // unauthenticated for the duration of this test (matches the bug's
    // "not authenticated" precondition).
    var usersFile = path.join(tmpHome, "console", "users.json");
    fs.mkdirSync(path.dirname(usersFile), { recursive: true });
    fs.writeFileSync(usersFile, JSON.stringify({
      multiUser: true,
      setupCode: "LRE33776",
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
    // ── Case 1: unauthenticated GET to a project-scoped .js asset path ──────
    // lr-2895ea: app.js is a PUBLIC shell asset (identical for every user, no
    // per-user data) now served ahead of the auth gate — real 200 + JS MIME,
    // not the 401 this test previously asserted, and never text/html.
    return httpGetRaw(port, "/p/asset-auth-project/app.js").then(function (res) {
      assert.strictEqual(res.status, 200,
        "unauthenticated request for the public shell asset app.js must return the real 200 asset (lr-2895ea); got " + res.status);
      assert.match(res.contentType, /application\/javascript/,
        "unauthenticated app.js must return a JS Content-Type; got " + res.contentType);
      assert.ok(
        !/text\/html/.test(res.contentType),
        "unauthenticated .js request must never return Content-Type text/html (nosniff + module script breaks app boot); got " + res.contentType
      );
      return port;
    });

  }).then(function (port) {
    // ── Case 2: unauthenticated GET to a nonexistent project-scoped asset ──
    // Same invariant must hold even for a path that doesn't exist on disk —
    // this was the daemon's live-proven catch-all failure mode.
    return httpGetRaw(port, "/p/asset-auth-project/nonexistent-asset-xyz.js").then(function (res) {
      assert.notEqual(res.status, 200,
        "unauthenticated nonexistent .js path must not return 200; got " + res.status);
      assert.ok(
        !/text\/html/.test(res.contentType),
        "unauthenticated nonexistent .js path must never return Content-Type text/html; got " + res.contentType
      );
      return port;
    });

  }).then(function (port) {
    // ── Case 3: unauthenticated GET to a project-scoped module path ────────
    // lr-2895ea: /modules/*.js chunks are PUBLIC shell assets, same as
    // app.js — real 200 + JS MIME, served ahead of the auth gate.
    return httpGetRaw(port, "/p/asset-auth-project/modules/app-connection.js").then(function (res) {
      assert.strictEqual(res.status, 200,
        "unauthenticated request for the public shell module modules/app-connection.js must return the real 200 asset (lr-2895ea); got " + res.status);
      assert.match(res.contentType, /application\/javascript/,
        "unauthenticated /modules/ path must return a JS Content-Type; got " + res.contentType);
      assert.ok(
        !/text\/html/.test(res.contentType),
        "unauthenticated /modules/ path must never return Content-Type text/html; got " + res.contentType
      );
      return port;
    });

  }).then(function (port) {
    // ── Case 4: unauthenticated GET to a project-scoped API path ───────────
    return httpGetRaw(port, "/p/asset-auth-project/api/whatever").then(function (res) {
      assert.notEqual(res.status, 200,
        "unauthenticated /api/ path must not return 200; got " + res.status);
      assert.ok(
        !/text\/html/.test(res.contentType),
        "unauthenticated /api/ path must never return Content-Type text/html; got " + res.contentType
      );
      return port;
    });

  }).then(function (port) {
    // ── Case 5: unauthenticated top-level navigation still shows login HTML ─
    // The fix must not break the intended behavior for document navigation.
    return httpGetRaw(port, "/p/asset-auth-project/").then(function (res) {
      assert.strictEqual(res.status, 200,
        "unauthenticated top-level project navigation must still return 200; got " + res.status);
      assert.match(res.contentType, /text\/html/,
        "unauthenticated top-level project navigation must still return the login HTML page; got " + res.contentType);
      return port;
    });

  }).then(function () {
    t.diagnostic("lr-e33776 regression test passed: asset/module/API paths never 200-text/html unauthed; navigation still shows login page");

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
