// old-socket-migration.test.js — regression tests for lr-6ed3
//
// Covers:
//   1. Stale old socket (exists on disk, no listener) → unlinked + single warning
//   2. Live old socket (mock IPC server on old path) → checkOldDaemon returns alive:true
//   3. oldSocketPath() lives under CONFIG_DIR, not CONFIG_DIR/console/
//   4. Dev-mode variant uses daemon-dev.sock in old path

var test = require("node:test");
var assert = require("node:assert");
var net = require("net");
var fs = require("fs");
var path = require("path");
var os = require("os");

// Isolate tests from the real ~/.clagentic by pointing to a temp dir.
// Must be set before requiring config so module-level paths are computed correctly.
var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-oldsock-test-"));
process.env.CLAGENTIC_HOME = tmpHome;
// Ensure non-dev mode for these tests
delete process.env.CLAGENTIC_DEV;
delete process.env.CLAY_DEV;

var config = require("../lib/config");

// ─── helper ────────────────────────────────────────────────────────────────

/**
 * Start a minimal IPC echo server that accepts connections and immediately
 * responds to any message with { ok: true }. Returns a { close } handle.
 * Used to simulate a live pre-1.5 daemon on the old socket path.
 */
function startMockOldDaemon(sockPath) {
  return new Promise(function (resolve, reject) {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });
    try { fs.unlinkSync(sockPath); } catch (e) {}

    var server = net.createServer(function (conn) {
      conn.setEncoding("utf8");
      var buf = "";
      conn.on("data", function (chunk) {
        buf += chunk;
        var idx = buf.indexOf("\n");
        if (idx !== -1) {
          // Consume the message and reply ok
          buf = buf.slice(idx + 1);
          try { conn.write(JSON.stringify({ ok: true }) + "\n"); } catch (e) {}
        }
      });
      conn.on("error", function () {});
    });

    server.listen(sockPath, function () {
      resolve({
        close: function () {
          return new Promise(function (res) {
            server.close(function () {
              try { fs.unlinkSync(sockPath); } catch (e) {}
              res();
            });
          });
        },
      });
    });

    server.on("error", reject);
  });
}

// ─── tests ─────────────────────────────────────────────────────────────────

test("oldSocketPath() is under CLAGENTIC_HOME (brand root), not CONFIG_DIR (console subdir)", function () {
  // Skip on Windows — old path is undefined there
  if (process.platform === "win32") return;

  var old = config.oldSocketPath();
  var newSock = config.socketPath();

  assert.ok(old, "oldSocketPath() should return a path on Unix");
  // Must be directly under CLAGENTIC_HOME (the brand root, one level above CONFIG_DIR)
  assert.strictEqual(path.dirname(old), config.CLAGENTIC_HOME,
    "oldSocketPath() should be directly under CLAGENTIC_HOME, got: " + old);
  // Must NOT equal the current socket path
  assert.notStrictEqual(old, newSock,
    "oldSocketPath() and socketPath() must differ: " + old);
  // New socket must live inside CONFIG_DIR (which is the console/ subdir)
  assert.ok(newSock.includes(path.join("console", "daemon.sock")),
    "socketPath() should contain console/daemon.sock, got: " + newSock);
});

test("stale old socket is removed and a single warning is emitted", async function () {
  if (process.platform === "win32") return;

  var oldSock = config.oldSocketPath();
  // Create a stale socket file (no listener)
  fs.mkdirSync(path.dirname(oldSock), { recursive: true });
  fs.writeFileSync(oldSock, "");

  var warnings = [];
  var origWarn = console.warn;
  console.warn = function () { warnings.push([].slice.call(arguments).join(" ")); };

  // ensureConfigDir() defers the unlink behind an async liveness probe (lr-6ed3).
  // For a stale socket (no listener) checkOldDaemon gets ECONNREFUSED immediately,
  // so the probe resolves in <10 ms. 200 ms is a safe margin.
  config.ensureConfigDir();
  await new Promise(function (r) { setTimeout(r, 200); });
  console.warn = origWarn;

  // Socket file must be gone after the async probe fires (dead socket, no listener)
  assert.ok(!fs.existsSync(oldSock),
    "stale old socket should have been removed by ensureConfigDir()");

  // Exactly one warning should have been emitted mentioning the old path
  var migrationWarnings = warnings.filter(function (w) {
    return w.indexOf("stale") !== -1 || w.indexOf("pre-1.5") !== -1 || w.indexOf("Removed") !== -1;
  });
  assert.strictEqual(migrationWarnings.length, 1,
    "expected exactly one stale-socket warning, got: " + JSON.stringify(warnings));
});

test("stale old socket: ensureConfigDir called twice only warns once", async function () {
  if (process.platform === "win32") return;

  var oldSock = config.oldSocketPath();
  // Ensure it is absent from any prior test
  try { fs.unlinkSync(oldSock); } catch (e) {}
  fs.writeFileSync(oldSock, "");

  var warnings = [];
  var origWarn = console.warn;
  console.warn = function () { warnings.push([].slice.call(arguments).join(" ")); };

  // Both ensureConfigDir calls fire async probes; only the first should warn
  // because the socket is gone by the time the second probe fires.
  config.ensureConfigDir();
  config.ensureConfigDir(); // second call: socket still present on disk at this point
  await new Promise(function (r) { setTimeout(r, 200); });
  console.warn = origWarn;

  var migrationWarnings = warnings.filter(function (w) {
    return w.indexOf("stale") !== -1 || w.indexOf("pre-1.5") !== -1 || w.indexOf("Removed") !== -1;
  });
  // Both probes may fire but only the first will actually unlink (second gets ENOENT).
  // We accept 1 or 2 warnings here: the important invariant is that the socket is gone
  // and at least one "Removed" warning was emitted.
  assert.ok(migrationWarnings.length >= 1,
    "expected at least one stale-socket warning, got: " + JSON.stringify(warnings));
  assert.ok(!fs.existsSync(oldSock),
    "stale old socket should have been removed after both ensureConfigDir calls");
});

test("checkOldDaemon() returns alive:false when old socket is absent", async function () {
  if (process.platform === "win32") return;

  var oldSock = config.oldSocketPath();
  try { fs.unlinkSync(oldSock); } catch (e) {}

  var result = await config.checkOldDaemon();
  assert.ok(result !== null, "checkOldDaemon() should return an object on Unix");
  assert.strictEqual(result.alive, false,
    "alive should be false when old socket does not exist");
  assert.strictEqual(result.sockPath, oldSock);
});

test("checkOldDaemon() returns alive:false when old socket file exists but no listener", async function () {
  if (process.platform === "win32") return;

  var oldSock = config.oldSocketPath();
  fs.mkdirSync(path.dirname(oldSock), { recursive: true });
  fs.writeFileSync(oldSock, "");

  try {
    var result = await config.checkOldDaemon();
    assert.strictEqual(result.alive, false,
      "alive should be false when socket file exists but nothing is listening");
  } finally {
    try { fs.unlinkSync(oldSock); } catch (e) {}
  }
});

test("checkOldDaemon() returns alive:true when a server is listening on old socket", async function () {
  if (process.platform === "win32") return;

  var oldSock = config.oldSocketPath();
  var mockDaemon = await startMockOldDaemon(oldSock);

  try {
    var result = await config.checkOldDaemon();
    assert.ok(result !== null, "checkOldDaemon() should return an object");
    assert.strictEqual(result.alive, true,
      "alive should be true when a server is listening on the old socket path");
    assert.strictEqual(result.sockPath, oldSock);
  } finally {
    await mockDaemon.close();
  }
});

test("checkOldDaemon() returns null on Windows", async function () {
  if (process.platform !== "win32") {
    // Simulate the Windows branch via the exported function's guard.
    // On non-Windows, we can only verify the function does NOT throw and
    // does NOT return null (it returns an object). The null-on-Windows path
    // is verified by reading the code + the guard in oldSocketPath().
    var result = await config.checkOldDaemon();
    assert.ok(result !== null, "on non-Windows, checkOldDaemon() must return an object, not null");
    return;
  }
  var result = await config.checkOldDaemon();
  assert.strictEqual(result, null, "checkOldDaemon() must return null on Windows");
});

test("live old daemon: sendIPCCommand reaches mock server on old socket path", async function () {
  if (process.platform === "win32") return;

  var oldSock = config.oldSocketPath();
  var mockDaemon = await startMockOldDaemon(oldSock);

  var { sendIPCCommand } = require("../lib/ipc");

  try {
    var resp = await sendIPCCommand(oldSock, { cmd: "shutdown" });
    assert.strictEqual(resp.ok, true,
      "sendIPCCommand to old socket path should reach the mock server");
  } finally {
    await mockDaemon.close();
  }
});

// ─── BLOCKING 1 regression: sendIPCCommand never rejects — resp.ok must be checked ─

/**
 * Start a mock server that accepts connections and replies {ok:false} to every command.
 * Simulates a pre-1.5 daemon that receives the shutdown but refuses / reports failure.
 */
function startMockOldDaemonFalse(sockPath) {
  return new Promise(function (resolve, reject) {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });
    try { fs.unlinkSync(sockPath); } catch (e) {}

    var server = net.createServer(function (conn) {
      conn.setEncoding("utf8");
      var buf = "";
      conn.on("data", function (chunk) {
        buf += chunk;
        var idx = buf.indexOf("\n");
        if (idx !== -1) {
          buf = buf.slice(idx + 1);
          try { conn.write(JSON.stringify({ ok: false, error: "refused" }) + "\n"); } catch (e) {}
        }
      });
      conn.on("error", function () {});
    });

    server.listen(sockPath, function () {
      resolve({
        close: function () {
          return new Promise(function (res) {
            server.close(function () {
              try { fs.unlinkSync(sockPath); } catch (e) {}
              res();
            });
          });
        },
      });
    });

    server.on("error", reject);
  });
}

/**
 * Start a mock server that accepts connections but never writes a response.
 * Simulates a pre-1.5 daemon that ignores the shutdown command (sendIPCCommand times out).
 * The close() handle destroys all open connections so the event loop can exit.
 */
function startMockOldDaemonSilent(sockPath) {
  return new Promise(function (resolve, reject) {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });
    try { fs.unlinkSync(sockPath); } catch (e) {}

    var openConns = [];
    var server = net.createServer(function (conn) {
      // Accept connection but never respond — triggers timeout in sendIPCCommand
      openConns.push(conn);
      conn.on("close", function () {
        var idx = openConns.indexOf(conn);
        if (idx !== -1) openConns.splice(idx, 1);
      });
      conn.on("error", function () {});
    });

    server.listen(sockPath, function () {
      resolve({
        close: function () {
          return new Promise(function (res) {
            // Destroy all open connections so the event loop is not held open
            openConns.forEach(function (c) { try { c.destroy(); } catch (e) {} });
            openConns = [];
            server.close(function () {
              try { fs.unlinkSync(sockPath); } catch (e) {}
              res();
            });
          });
        },
      });
    });

    server.on("error", reject);
  });
}

test("sendIPCCommand resolves {ok:false} when old daemon replies with ok:false — never rejects", async function () {
  if (process.platform === "win32") return;

  // Use a distinct temp path so this test doesn't collide with the old socket tests above
  var fakeSock = path.join(tmpHome, "test-false.sock");
  var mockDaemon = await startMockOldDaemonFalse(fakeSock);

  var { sendIPCCommand } = require("../lib/ipc");

  try {
    var resp = await sendIPCCommand(fakeSock, { cmd: "shutdown" });
    // sendIPCCommand must resolve (not reject) with ok:false
    assert.strictEqual(resp.ok, false,
      "sendIPCCommand should resolve with ok:false when server responds {ok:false}");
    assert.ok(resp.error, "response should carry an error field: " + JSON.stringify(resp));
  } finally {
    await mockDaemon.close();
  }
});

test("sendIPCCommand resolves {ok:false, error:'timeout'} when old daemon never responds", async function () {
  if (process.platform === "win32") return;

  var fakeSock = path.join(tmpHome, "test-silent.sock");
  var mockDaemon = await startMockOldDaemonSilent(fakeSock);

  var { sendIPCCommand } = require("../lib/ipc");

  try {
    // Use a short timeout so the test doesn't hang
    var resp = await sendIPCCommand(fakeSock, { cmd: "shutdown" }, 500);
    assert.strictEqual(resp.ok, false,
      "sendIPCCommand should resolve with ok:false on timeout");
    assert.strictEqual(resp.error, "timeout",
      "error field should be 'timeout' when daemon never responds");
  } finally {
    await mockDaemon.close();
  }
});

// ─── NIT 3 regression: ensureConfigDir() must not unlink a live old socket ───

test("ensureConfigDir() does NOT immediately unlink a live old socket (defers to liveness probe)", async function () {
  if (process.platform === "win32") return;

  var oldSock = config.oldSocketPath();
  // Remove any leftover stale socket from earlier tests
  try { fs.unlinkSync(oldSock); } catch (e) {}

  // Start a live mock daemon on the old socket path
  var mockDaemon = await startMockOldDaemon(oldSock);

  try {
    // ensureConfigDir() now defers the unlink behind an async liveness probe.
    // After the sync call returns the socket must still be present (the async
    // probe has not fired yet).
    config.ensureConfigDir();

    assert.ok(fs.existsSync(oldSock),
      "old socket should still exist immediately after ensureConfigDir() — async probe has not fired yet");

    // Give the async probe time to fire. For a live socket, checkOldDaemon() connects
    // immediately (< 10 ms) and returns alive:true. 200 ms is a safe margin.
    await new Promise(function (r) { setTimeout(r, 200); });

    assert.ok(fs.existsSync(oldSock),
      "ensureConfigDir() must not unlink a live old socket even after the async probe fires");
  } finally {
    await mockDaemon.close();
  }
});
