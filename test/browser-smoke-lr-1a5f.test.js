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
//   8. Assert: at least one WebSocket open event within WS_WAIT_MS ms.
//   9. Kill daemon, close browser, clean up temp dir.
//
// CI note: after `npm ci`, run `npx playwright install chromium` before this
// test suite to ensure the Chromium binary is available.
//
// Skip conditions (not failures):
//   - Playwright package unavailable (not installed as devDependency).
//   - Chromium binary not found by Playwright (run: npx playwright install chromium).
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

var DAEMON_SCRIPT = path.resolve(__dirname, "..", "lib", "daemon.js");

// Total time the test is allowed to run (daemon startup + browser + assertions).
var TEST_TIMEOUT_MS = 60000;

// All sub-timeouts are derived from a single budget so they stay coherent.
// Daemon startup polling uses half the total budget (30 s).
var DAEMON_READY_MS = 30000;

// How long to wait for a WebSocket to open after page load.
var WS_WAIT_MS = 15000;

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

  // Prefer the module-graph installation (devDependency). Allow PLAYWRIGHT_PATH
  // as an optional env override for unusual setups (e.g. pre-installed monorepo
  // tooling) — but the default is now the local devDependency.
  var playwrightPath = process.env.PLAYWRIGHT_PATH || "playwright";

  var playwright;
  try {
    playwright = require(playwrightPath);
  } catch (e) {
    t.diagnostic("Playwright package not available — skipping browser smoke test. Error: " + e.message);
    t.diagnostic("Fix: run `npm ci` followed by `npx playwright install chromium`");
    t.skip("playwright not available");
    done();
    return;
  }

  var chromium = playwright.chromium;
  if (!chromium) {
    t.diagnostic("playwright.chromium not available — skipping browser smoke test");
    t.diagnostic("Fix: run `npx playwright install chromium`");
    t.skip("playwright.chromium not available");
    done();
    return;
  }

  // ── Mutable cleanup state (shared between t.after and the promise chain) ──

  var tmpHome = null;
  var daemonProc = null;
  var browserRef = null;

  // t.after registers cleanup that fires even if the 60 s test timeout kills
  // the test. The .then/.catch chain below also cleans up as belt-and-suspenders.
  t.after(function () {
    var tasks = [];
    if (daemonProc && daemonProc.exitCode === null) {
      tasks.push(killAndWait(daemonProc).catch(function (e) {
        t.diagnostic("t.after: daemon kill error: " + e.message);
      }));
    }
    if (browserRef) {
      tasks.push(browserRef.close().catch(function (e) {
        t.diagnostic("t.after: browser close error: " + e.message);
      }));
    }
    return Promise.all(tasks).then(function () {
      if (tmpHome) {
        try {
          fs.rmSync(tmpHome, { recursive: true, force: true });
        } catch (e) {
          t.diagnostic("t.after: tmpdir removal failed: " + e.message + " (leaked: " + tmpHome + ")");
        }
      }
    });
  });

  // ── 1–4. Start daemon ─────────────────────────────────────────────────────

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

    // Wait up to DAEMON_READY_MS for the HTTP server to be ready.
    return waitForServer(port, DAEMON_READY_MS).then(function () {
      return { port: port, projectDir: projectDir };
    });

  }).then(function (ctx) {
    var port = ctx.port;

    // ── 5–8. Headless browser assertions ────────────────────────────────────

    var page;
    var pageErrors = [];
    var wsEvents = [];

    return chromium.launch({ headless: true }).catch(function (launchErr) {
      // Binary not installed — visible skip, not a silent pass.
      t.diagnostic("Chromium launch failed — Playwright binary likely not installed. Error: " + launchErr.message);
      t.diagnostic("Fix: run `npx playwright install chromium`");
      t.skip("chromium binary not available");
      return null;
    }).then(function (b) {
      if (!b) return null; // skipped above
      browserRef = b;
      return b.newPage();
    }).then(function (p) {
      if (!p) return null;
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
    }).then(function (navResult) {
      if (!navResult) return null; // skipped
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
      if (!wsResult) return; // skipped
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
      if (browserRef) {
        return browserRef.close().catch(function () {});
      }
    });

  }).then(function () {
    // ── 9. Cleanup (belt-and-suspenders; t.after is the reliable path) ─────
    var cleanupProcs = [];
    if (daemonProc && daemonProc.exitCode === null) {
      cleanupProcs.push(killAndWait(daemonProc));
    }
    return Promise.all(cleanupProcs).then(function () {
      if (tmpHome) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {
          t.diagnostic("cleanup: tmpdir removal failed: " + e.message + " (leaked: " + tmpHome + ")");
        }
      }
      done();
    });
  }).catch(function (err) {
    // Clean up on failure, then propagate.
    var cleanupProcs = [];
    if (daemonProc && daemonProc.exitCode === null) {
      cleanupProcs.push(killAndWait(daemonProc).catch(function (e) {
        t.diagnostic("error-path cleanup: daemon kill error: " + e.message);
      }));
    }
    Promise.all(cleanupProcs).then(function () {
      if (tmpHome) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {
          t.diagnostic("error-path cleanup: tmpdir removal failed: " + e.message + " (leaked: " + tmpHome + ")");
        }
      }
      done(err);
    });
  });
});
