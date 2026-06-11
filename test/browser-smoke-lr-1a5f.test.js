// browser-smoke-lr-1a5f.test.js
//
// Regression guard: headless browser boots the daemon, loads the frontend,
// asserts no `pageerror` events fire, and asserts a WebSocket opens.
//
// Motivation (lr-8657 retro): PR #217 shipped a stale ESM import that halted
// app boot for every authenticated user. All unit tests passed because no test
// loads the real browser module graph. This test catches that class of failure.
//
// Test plan:
//   1. Allocate a free port.
//   2. Write a minimal daemon config to an isolated temp home (no TLS, no auth).
//   3. Spawn lib/daemon.js as a subprocess with that config.
//   4. Poll until the HTTP /info endpoint responds (server is up).
//   5. Launch headless Chromium via Playwright.
//   6. Load http://127.0.0.1:{port}/p/smoke-project/
//   7. Assert: zero `pageerror` events during and after load.
//   8. Assert: at least one WebSocket open event within 8 s.
//   9. Kill daemon, close browser, clean up temp dir.
//
// Skip conditions (not failures):
//   - Playwright package unavailable at PLAYWRIGHT_PATH (env or default).
//   - Chromium binary not found by Playwright.
//
// The test FAILS (not skips) if the daemon starts but the page errors.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var net = require("net");
var http = require("http");
var { spawn } = require("child_process");

// ─── constants ─────────────────────────────────────────────────────────────

// Where we look for Playwright. CI can override with PLAYWRIGHT_PATH env var.
var PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_PATH
  || path.join(__dirname, "..", "..", "local-scripts", "headless-browser", "node_modules", "playwright");

var DAEMON_SCRIPT = path.resolve(__dirname, "..", "lib", "daemon.js");

// Total time the test is allowed to run (daemon startup + browser + assertions).
var TEST_TIMEOUT_MS = 60000;

// How long to wait for a WebSocket to open after page load.
var WS_WAIT_MS = 8000;

// ─── helpers ───────────────────────────────────────────────────────────────

/** Return a free TCP port on 127.0.0.1. */
function findFreePort() {
  return new Promise(function (resolve, reject) {
    var srv = net.createServer();
    srv.listen(0, "127.0.0.1", function () {
      var port = srv.address().port;
      srv.close(function () { resolve(port); });
    });
    srv.on("error", reject);
  });
}

/** Poll GET http://127.0.0.1:{port}/info until 200 or timeout. */
function waitForServer(port, timeoutMs) {
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    function attempt() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error("daemon did not respond on port " + port + " within " + timeoutMs + " ms"));
        return;
      }
      var req = http.get("http://127.0.0.1:" + port + "/info", function (res) {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(attempt, 200);
        }
      });
      req.on("error", function () { setTimeout(attempt, 200); });
      req.setTimeout(500, function () { req.destroy(); });
    }
    attempt();
  });
}

/** Kill a process and wait for it to exit. Returns a promise. */
function killAndWait(proc, signal) {
  signal = signal || "SIGTERM";
  return new Promise(function (resolve) {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }
    proc.once("exit", function () { resolve(); });
    try { proc.kill(signal); } catch (e) {}
    // Force after 5 s
    setTimeout(function () {
      try { proc.kill("SIGKILL"); } catch (e) {}
      resolve();
    }, 5000);
  });
}

// ─── main test ─────────────────────────────────────────────────────────────

test("browser smoke: no pageerror on boot, WebSocket opens (lr-1a5f)", { timeout: TEST_TIMEOUT_MS }, function (t, done) {
  // ── 0. Check Playwright availability ──────────────────────────────────────

  var playwright;
  try {
    playwright = require(PLAYWRIGHT_PATH);
  } catch (e) {
    t.diagnostic("Playwright not available at " + PLAYWRIGHT_PATH + " — skipping browser smoke test");
    t.diagnostic("Install hint: cd /workspace/local-scripts/headless-browser && npm install");
    done(); // skip, not fail
    return;
  }

  var chromium = playwright.chromium;
  if (!chromium) {
    t.diagnostic("playwright.chromium not available — skipping browser smoke test");
    done();
    return;
  }

  // ── 1–4. Start daemon ─────────────────────────────────────────────────────

  var tmpHome, daemonProc;

  findFreePort().then(function (port) {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-smoke-lr-1a5f-"));

    // Create a real project directory the daemon can register.
    var projectDir = path.join(tmpHome, "smoke-project");
    fs.mkdirSync(projectDir, { recursive: true });

    // Write minimal daemon config: no TLS, no auth, one project.
    var configFile = path.join(tmpHome, "daemon.json");
    var config = {
      port: port,
      host: "127.0.0.1",
      tls: false,
      pinHash: null,
      mode: "single",
      setupCompleted: true,
      debug: false,
      projects: [
        { path: projectDir, slug: "smoke-project", addedAt: Date.now() },
      ],
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });

    // Spawn the daemon in isolation.
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
      env: Object.assign({}, process.env, {
        CLAGENTIC_HOME: tmpHome,
        CLAGENTIC_CONFIG: configFile,
        // Prevent daemon from touching real home-dir auth-tokens or sessions.
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    var daemonLog = [];
    daemonProc.stdout.on("data", function (d) { daemonLog.push(d.toString()); });
    daemonProc.stderr.on("data", function (d) { daemonLog.push("[err] " + d.toString()); });

    daemonProc.once("exit", function (code, signal) {
      // If the daemon exits before the test completes, log the tail for diagnosis.
      if (code !== 0 && code !== null) {
        t.diagnostic("daemon exited unexpectedly: code=" + code + " signal=" + signal);
        t.diagnostic("daemon log tail:\n" + daemonLog.slice(-20).join(""));
      }
    });

    // Wait up to 15 s for the HTTP server to be ready.
    return waitForServer(port, 15000).then(function () {
      return { port: port, projectDir: projectDir };
    });

  }).then(function (ctx) {
    var port = ctx.port;

    // ── 5–8. Headless browser assertions ────────────────────────────────────

    var browser, page;
    var pageErrors = [];
    var wsEvents = [];

    return chromium.launch({ headless: true }).then(function (b) {
      browser = b;
      return browser.newPage();
    }).then(function (p) {
      page = p;

      // Collect all pageerror events.
      page.on("pageerror", function (err) {
        pageErrors.push(err.message || String(err));
      });

      // Collect WebSocket open events.
      page.on("websocket", function (ws) {
        wsEvents.push({ event: "open", url: ws.url() });
        ws.on("socketerror", function (err) {
          wsEvents.push({ event: "socketerror", url: ws.url(), error: String(err) });
        });
      });

      // Load the project page. waitUntil: "load" (not networkidle — fonts/CDN
      // will time out in a sandboxed environment).
      return page.goto(
        "http://127.0.0.1:" + port + "/p/smoke-project/",
        { waitUntil: "load", timeout: 20000 }
      );
    }).then(function () {
      // Wait for the WS to open (up to WS_WAIT_MS).
      var wsCheckStart = Date.now();
      return new Promise(function (resolve) {
        function checkWs() {
          if (wsEvents.some(function (e) { return e.event === "open"; })) {
            resolve("ws_found");
            return;
          }
          if (Date.now() - wsCheckStart > WS_WAIT_MS) {
            resolve("ws_timeout");
            return;
          }
          setTimeout(checkWs, 100);
        }
        checkWs();
      });
    }).then(function (wsResult) {
      // ── Assertions ──────────────────────────────────────────────────────

      // 1. No pageerrors during or after boot.
      assert.deepEqual(
        pageErrors,
        [],
        "Expected no pageerror events on boot. Got:\n  " + pageErrors.join("\n  ")
      );

      // 2. WebSocket opened.
      assert.strictEqual(
        wsResult,
        "ws_found",
        "Expected a WebSocket to open within " + WS_WAIT_MS + " ms. " +
        "WS events: " + JSON.stringify(wsEvents) + "\n" +
        "This usually means the ESM module graph failed to boot before connect()."
      );

      t.diagnostic("browser smoke passed — pageerrors=0, wsEvents=" + JSON.stringify(wsEvents));

    }).finally(function () {
      // Close browser regardless of assertion outcome.
      if (browser) return browser.close().catch(function () {});
    });

  }).then(function () {
    // ── 9. Cleanup ─────────────────────────────────────────────────────────
    return killAndWait(daemonProc).then(function () {
      if (tmpHome) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}
      }
      done();
    });
  }).catch(function (err) {
    // Clean up on failure, then propagate.
    var cleanupProcs = [];
    if (daemonProc && daemonProc.exitCode === null) {
      cleanupProcs.push(killAndWait(daemonProc));
    }
    Promise.all(cleanupProcs).then(function () {
      if (tmpHome) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}
      }
      done(err);
    });
  });
});
