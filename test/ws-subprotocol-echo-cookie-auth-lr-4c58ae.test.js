// ws-subprotocol-echo-cookie-auth-lr-4c58ae.test.js
//
// Regression coverage for lr-4c58ae (P1 live regression: both desktop and
// mobile clients stuck on "reconnecting to server").
//
// ROOT CAUSE: lr-de5fcb (PR #358) made app-connection.js's connect() ALWAYS
// fetch a ws-ticket and ALWAYS offer it as a Sec-WebSocket-Protocol
// subprotocol (["clagentic.auth." + ticket]) — even on desktop, which is
// cookie-authed and does not need a ticket. On the server, the upgrade
// handler only parsed/consumed the offered ticket inside
// `if (!wsCookieUser)`, so a cookie-authed request never learned what
// subprotocol was offered, and `req._clagenticAcceptedProtocol` was only ever set
// on the wsTicketUser branch. The WebSocketServer's handleProtocols hook
// therefore returned `false` for a cookie-authed+ticket-offered upgrade, so
// the 101 response omitted Sec-WebSocket-Protocol entirely.
//
// Per RFC 6455 §4.1, when a client's opening handshake lists one or more
// subprotocols and the server's response omits Sec-WebSocket-Protocol, the
// client MUST fail the WebSocket connection. Browsers enforce exactly that
// (WebSocket never fires onopen), so desktop's cookie-authed upgrade — the
// only auth path desktop has — silently failed on every connect, hence the
// stuck "reconnecting to server" spinner on BOTH desktop and mobile.
//
// FIX (server.js, fix-forward — does not revert lr-de5fcb, which fixes a
// real mobile cookie-drop gap): the offered subprotocol is now parsed
// unconditionally (extractWsTicketFromHeader has no side effect — pure
// parse), and `req._clagenticAcceptedProtocol` is set whenever a subprotocol was
// offered AND auth succeeded via EITHER path. On the cookie-authed path the
// offered ticket is echoed back as-is but never passed to
// auth.consumeWsTicket() — the cookie already authenticated the request, so
// consuming would needlessly burn the client's single-use ticket.
//
// This test spawns the real daemon and drives raw TCP upgrade requests
// (same harness as shell-asset-public-before-auth-lr-2895ea.test.js /
// project-asset-auth-fallback-lr-e33776.test.js), inspecting the literal 101
// response headers — a source-regex test would not have caught this, since
// the pre-fix code was internally consistent (it just gated the wrong
// variable), and the existing ws-ticket-auth-lr-de5fcb.test.js only drove the
// ticket-only and no-ticket-no-cookie paths, never cookie+ticket-offered.
//
// Cases:
//   1. cookie-authed, no subprotocol offered      -> 101, no Sec-WebSocket-Protocol
//   2. cookie-authed + subprotocol offered         -> 101, ECHOED Sec-WebSocket-Protocol  <- THE REGRESSION
//   3. ticket-only (no cookie) + subprotocol offered -> 101, echoed (preexisting behavior)
//   4. no cookie, no ticket                        -> 401

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var net = require("net");
var http = require("http");
var crypto = require("crypto");
var { spawn } = require("child_process");

// ── constants ────────────────────────────────────────────────────────────────

var DAEMON_SCRIPT = path.resolve(__dirname, "..", "lib", "daemon.js");
var TEST_TIMEOUT_MS = 45000;
var DAEMON_READY_MS = 20000;
var PROJECT_SLUG = "ws-echo-project";
var SESSION_COOKIE_NAME = "relay_auth_user";
var SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // matches server-auth.js TOKEN_TTL_MS

// ── helpers (mirrors shell-asset-public-before-auth-lr-2895ea.test.js) ─────

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

// Raw WS upgrade over a plain TCP socket. Reads only the response headers
// (up to the blank line terminating them) — sufficient to assert the 101
// status line and Sec-WebSocket-Protocol presence/absence without pulling in
// a full WebSocket client. Optional cookie/subprotocol are added as headers.
function wsUpgradeRaw(port, urlPath, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    var socket = net.connect(port, "127.0.0.1", function () {
      var headerLines = [
        "GET " + urlPath + " HTTP/1.1",
        "Host: 127.0.0.1:" + port,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
      ];
      if (opts.cookie) headerLines.push("Cookie: " + opts.cookie);
      if (opts.subprotocol) headerLines.push("Sec-WebSocket-Protocol: " + opts.subprotocol);
      var req = headerLines.join("\r\n") + "\r\n\r\n";
      socket.write(req);
    });
    var data = "";
    socket.on("data", function (chunk) {
      data += chunk.toString("utf8");
      var headerEnd = data.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        var headerBlock = data.slice(0, headerEnd);
        var lines = headerBlock.split("\r\n");
        var statusLine = lines[0];
        var headers = {};
        for (var i = 1; i < lines.length; i++) {
          var idx = lines[i].indexOf(":");
          if (idx === -1) continue;
          var name = lines[i].slice(0, idx).trim().toLowerCase();
          var value = lines[i].slice(idx + 1).trim();
          headers[name] = value;
        }
        socket.destroy();
        resolve({ statusLine: statusLine, headers: headers });
      }
    });
    socket.on("error", reject);
    socket.setTimeout(5000, function () {
      socket.destroy();
      reject(new Error("wsUpgradeRaw timeout"));
    });
  });
}

// ── test ─────────────────────────────────────────────────────────────────────

test("lr-4c58ae: a cookie-authed upgrade that also offers a ticket subprotocol echoes it in the 101 (RFC 6455 requires this or the browser fails the connection)", { timeout: TEST_TIMEOUT_MS }, function (t, done) {
  var tmpHome = null;
  var daemonProc = null;
  var daemonLog = [];
  var sessionToken = null;

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
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-4c58ae-"));
    var projectDir = path.join(tmpHome, PROJECT_SLUG);
    fs.mkdirSync(projectDir, { recursive: true });

    var configFile = path.join(tmpHome, "daemon.json");
    fs.writeFileSync(configFile, JSON.stringify({
      port: port,
      host: "127.0.0.1",
      tls: false,
      debug: false,
      projects: [{ path: projectDir, slug: PROJECT_SLUG, addedAt: Date.now(), visibility: "public" }],
    }, null, 2), { mode: 0o600 });

    var consoleDir = path.join(tmpHome, "console");
    fs.mkdirSync(consoleDir, { recursive: true });

    // Pre-create a real user record (shape matches users.js createUser()).
    var userId = crypto.randomUUID();
    var usersFile = path.join(consoleDir, "users.json");
    fs.writeFileSync(usersFile, JSON.stringify({
      multiUser: true,
      setupCode: null,
      users: [{
        id: userId,
        username: "desktop-user",
        email: null,
        displayName: "Desktop User",
        pinHash: "unused-in-this-test",
        role: "admin",
        mustChangePin: false,
        createdAt: Date.now(),
        linuxUser: null,
        profile: { name: "Desktop User", lang: "en-US", avatarColor: "#7c3aed", avatarStyle: "thumbs", avatarSeed: "abcd1234" },
      }],
      invites: [],
      smtp: null,
    }, null, 2), { mode: 0o600 });

    // Pre-seed a valid session token bound to that user, in the exact shape
    // server-auth.js's loadTokens()/getMultiUserFromReq() expect — this is
    // the same mechanism createMultiUserSession() would produce from a real
    // PIN login, without driving the full login HTTP flow (this bug is in
    // the WS-upgrade handler, not login).
    sessionToken = crypto.randomBytes(32).toString("hex");
    var authTokensFile = path.join(consoleDir, "auth-tokens.json");
    var now = Date.now();
    var tokens = {};
    tokens[sessionToken] = { userId: userId, issuedAt: now, expiresAt: now + SESSION_TOKEN_TTL_MS };
    fs.writeFileSync(authTokensFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });

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
    var cookie = SESSION_COOKIE_NAME + "=" + sessionToken;

    // ── Case 1: cookie-authed, NO subprotocol offered ───────────────────────
    // Must not fabricate a Sec-WebSocket-Protocol header when none was offered.
    return wsUpgradeRaw(port, "/p/" + PROJECT_SLUG + "/ws", { cookie: cookie }).then(function (res) {
      assert.match(res.statusLine, /101/,
        "cookie-authed upgrade with no subprotocol offered must succeed with 101; got: " + res.statusLine);
      assert.strictEqual(res.headers["sec-websocket-protocol"], undefined,
        "must never fabricate a Sec-WebSocket-Protocol header when the client offered none");
      return port;
    });

  }).then(function (port) {
    var cookie = SESSION_COOKIE_NAME + "=" + sessionToken;

    // ── Case 2: cookie-authed AND ticket subprotocol offered — THE REGRESSION
    // Pre-fix: handleProtocols returned false (req._clagenticAcceptedProtocol was
    // never set on the cookie path), so the 101 omitted
    // Sec-WebSocket-Protocol entirely — which, per RFC 6455 §4.1, makes a
    // real browser fail the connection outright even though the upgrade
    // itself succeeded at the HTTP layer. This is the exact "stuck on
    // reconnecting to server" bug on desktop.
    return wsUpgradeRaw(port, "/p/" + PROJECT_SLUG + "/ws", {
      cookie: cookie,
      subprotocol: "clagentic.auth.some-offered-ticket-value",
    }).then(function (res) {
      assert.match(res.statusLine, /101/,
        "cookie-authed upgrade with a subprotocol offered must succeed with 101; got: " + res.statusLine);
      assert.strictEqual(res.headers["sec-websocket-protocol"], "clagentic.auth.some-offered-ticket-value",
        "the 101 response must echo exactly the subprotocol the client offered when auth succeeded via the " +
        "cookie — omitting it forces a real browser to fail the connection (RFC 6455 4.1), which is the " +
        "lr-4c58ae desktop regression");
      return port;
    });

  }).then(function (port) {
    // ── Case 3: ticket-only (no cookie), subprotocol offered — preexisting ──
    // behavior from lr-de5fcb must still hold: mint a real ticket via the
    // live daemon's HTTP API (using the cookie), then offer it with NO
    // cookie on the upgrade — the ticket-auth fallback path.
    return new Promise(function (resolve, reject) {
      var cookie = SESSION_COOKIE_NAME + "=" + sessionToken;
      var req = http.get({
        hostname: "127.0.0.1",
        port: port,
        path: "/api/ws-ticket",
        headers: { Cookie: cookie },
      }, function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          try {
            var body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(body.ticket);
          } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
    }).then(function (ticket) {
      assert.ok(ticket && typeof ticket === "string" && ticket.length > 0,
        "test setup: /api/ws-ticket must mint a real ticket for the cookie-authed request");
      return wsUpgradeRaw(port, "/p/" + PROJECT_SLUG + "/ws", {
        subprotocol: "clagentic.auth." + ticket,
        // Deliberately no cookie — this is the ticket-only auth path.
      }).then(function (res) {
        assert.match(res.statusLine, /101/,
          "ticket-only upgrade with a valid offered ticket must succeed with 101; got: " + res.statusLine);
        assert.strictEqual(res.headers["sec-websocket-protocol"], "clagentic.auth." + ticket,
          "ticket-authed upgrade must echo the accepted ticket subprotocol (preexisting lr-de5fcb behavior)");
      });
    }).then(function () { return port; });

  }).then(function (port) {
    // ── Case 4: unauthenticated — no cookie, no ticket ──────────────────────
    return wsUpgradeRaw(port, "/p/" + PROJECT_SLUG + "/ws", {}).then(function (res) {
      assert.match(res.statusLine, /401/,
        "an upgrade with neither a cookie nor a ticket must be rejected with 401; got: " + res.statusLine);
    });

  }).then(function () {
    t.diagnostic("lr-4c58ae regression test passed: cookie-authed + ticket-offered upgrade now echoes the subprotocol");

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
