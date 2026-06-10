// daemon-bootstrap-guard.test.js — regression for lr-dec3
//
// Guard: when CLAGENTIC_HOME is set to ~/.clagentic/console (the socket
// subdirectory) and a real daemon.json exists one level up, the daemon must
// refuse to bootstrap an empty config and exit with a clear error message
// (EX_CONFIG = 78) rather than silently writing projects:[].
//
// The test spawns lib/daemon.js as a subprocess so we can set env vars and
// observe the exit code and stderr without side-effecting the test process.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");
var { spawnSync } = require("child_process");

var daemonScript = path.resolve(__dirname, "..", "lib", "daemon.js");

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Spawn lib/daemon.js with the given env vars added to a minimal safe
 * environment (no inherited HOME so the real ~/.clagentic is never touched).
 * Returns { status, stderr }.
 */
function spawnDaemon(extraEnv) {
  var env = Object.assign({
    PATH: process.env.PATH || "/usr/bin:/bin",
    // Prevent Node version check failure noise — we are on Node 20+
  }, extraEnv);

  var result = spawnSync(process.execPath, [daemonScript], {
    env: env,
    timeout: 5000,
    encoding: "utf8",
  });

  return {
    status: result.status,
    stderr: result.stderr || "",
    stdout: result.stdout || "",
  };
}

// ─── tests ─────────────────────────────────────────────────────────────────

test("daemon exits EX_CONFIG (78) when CLAGENTIC_HOME points at the socket subdir and a real config exists above", function () {
  if (process.platform === "win32") return; // guard is Unix-only (socket path structure)

  // Build an isolated temp tree:
  //   tmpDir/
  //     .clagentic/
  //       daemon.json   ← the real, populated config
  //       console/      ← where the user (erroneously) pointed CLAGENTIC_HOME
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-daemon-guard-test-"));
  var dotClagentic = path.join(tmpDir, ".clagentic");
  var consoleDir = path.join(dotClagentic, "console");
  fs.mkdirSync(consoleDir, { recursive: true });

  // Write a populated daemon.json at the real location
  var realConfig = {
    port: 2633,
    projects: [{ path: "/some/project", slug: "some-project" }],
    mode: "single",
    setupCompleted: true,
  };
  fs.writeFileSync(
    path.join(dotClagentic, "daemon.json"),
    JSON.stringify(realConfig, null, 2),
    { mode: 0o600 }
  );

  // Point CLAGENTIC_HOME at the socket subdir — this is the mis-configuration
  var result = spawnDaemon({
    CLAGENTIC_HOME: consoleDir,
    // Ensure no CLAGENTIC_CONFIG override so configPath() is derived from CLAGENTIC_HOME
    HOME: tmpDir,
  });

  // Must exit with EX_CONFIG (78), not 0 or 1
  assert.strictEqual(result.status, 78,
    "daemon must exit 78 (EX_CONFIG) when CLAGENTIC_HOME is mis-pointed at the socket subdir; got " + result.status + "\nstderr: " + result.stderr);

  // stderr must explain the problem clearly
  assert.ok(
    result.stderr.includes("CLAGENTIC_HOME") || result.stderr.includes("socket subdirectory") || result.stderr.includes("console"),
    "stderr should mention CLAGENTIC_HOME or socket subdirectory\nstderr: " + result.stderr
  );
  assert.ok(
    result.stderr.includes("ERROR") || result.stderr.includes("error"),
    "stderr should contain an error message\nstderr: " + result.stderr
  );

  // Crucially: must NOT have written a fresh empty daemon.json inside consoleDir
  assert.ok(
    !fs.existsSync(path.join(consoleDir, "daemon.json")),
    "daemon must NOT bootstrap an empty config inside the mis-pointed CLAGENTIC_HOME"
  );
});

test("daemon does NOT trigger the guard when CLAGENTIC_HOME is set correctly to .clagentic", function () {
  // When CLAGENTIC_HOME is correct (.clagentic directly, not .clagentic/console),
  // there is no sibling daemon.json one level up, so the guard must not fire.
  // Instead the daemon should bootstrap (or fail for a different reason — e.g.
  // missing users module context — but must not exit 78).
  //
  // We can't fully start the daemon in a test (it binds to ports, etc.), but we
  // can confirm that the guard itself is not the reason for failure by checking
  // the stderr does not contain the guard message.
  if (process.platform === "win32") return;

  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-daemon-guard-ok-test-"));
  var dotClagentic = path.join(tmpDir, ".clagentic");
  fs.mkdirSync(dotClagentic, { recursive: true });

  // No daemon.json present → fresh install path → guard must NOT fire
  var result = spawnDaemon({
    CLAGENTIC_HOME: dotClagentic,
    HOME: tmpDir,
  });

  // Guard exit code is 78 specifically — any other exit code (0, 1, etc.) is fine here
  assert.notStrictEqual(result.status, 78,
    "daemon must not exit 78 when CLAGENTIC_HOME is correctly set; the guard should not trigger\nstderr: " + result.stderr);

  // stderr must NOT contain the guard's specific error message
  assert.ok(
    !result.stderr.includes("CLAGENTIC_HOME appears to be set to the socket subdirectory"),
    "guard message must not appear when CLAGENTIC_HOME is correctly configured\nstderr: " + result.stderr
  );
});

test("daemon does NOT trigger the guard when there is no sibling config", function () {
  // Guard requires BOTH: basename === 'console' under .clagentic AND sibling
  // daemon.json present. If no sibling exists, the guard must not fire — the
  // daemon should proceed to normal bootstrap (fresh install).
  if (process.platform === "win32") return;

  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-daemon-guard-nosibling-test-"));
  var dotClagentic = path.join(tmpDir, ".clagentic");
  var consoleDir = path.join(dotClagentic, "console");
  fs.mkdirSync(consoleDir, { recursive: true });

  // No daemon.json in dotClagentic — guard must not fire even though basename === 'console'
  var result = spawnDaemon({
    CLAGENTIC_HOME: consoleDir,
    HOME: tmpDir,
  });

  assert.notStrictEqual(result.status, 78,
    "guard must not fire when no sibling daemon.json exists\nstderr: " + result.stderr);
  assert.ok(
    !result.stderr.includes("CLAGENTIC_HOME appears to be set to the socket subdirectory"),
    "guard message must not appear when no sibling config exists\nstderr: " + result.stderr
  );
});
