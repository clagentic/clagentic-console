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

// lr-b5d62f: the daemon-under-test exits via the very first synchronous
// config-read branch in lib/daemon.js (no server start, no SDK load, no
// async I/O) — the actual work between spawn and exit is on the order of a
// few filesystem stat/read calls. A fixed 5000ms spawnSync budget was
// observed failing 3/8 consecutive full-suite runs with status: null, which
// is consistent with spawnSync's OWN timeout firing under contention (~101
// files sharing one Node --test process), not the daemon being slow.
// DAEMON_GUARD_TEST_TIMEOUT_MS lets that budget be raised (default) or,
// deliberately, driven down to reproduce/demonstrate the timeout mechanism
// without relying on load-dependent luck (see the "confirms mechanism" test
// below).
var DEFAULT_SPAWN_TIMEOUT_MS = 15000;
var SPAWN_TIMEOUT_MS = process.env.DAEMON_GUARD_TEST_TIMEOUT_MS
  ? parseInt(process.env.DAEMON_GUARD_TEST_TIMEOUT_MS, 10)
  : DEFAULT_SPAWN_TIMEOUT_MS;

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Spawn lib/daemon.js with the given env vars added to a minimal safe
 * environment (no inherited HOME so the real ~/.clagentic is never touched).
 *
 * Returns { status, signal, spawnError, stderr, stdout }. `status` and
 * `signal` mirror Node's own child_process contract: exactly one of them is
 * non-null for a process that actually ran (docs.child_process.spawnSync).
 * `spawnError` is set when spawnSync itself reports a failure distinct from
 * an ordinary exit — this covers BOTH a genuine launch failure (e.g. ENOENT)
 * AND, confirmed empirically (lr-b5d62f — see describeSpawnOutcome), the
 * case where spawnSync's own `timeout` option fires so early that libuv
 * never gets to report a child status at all: Node then synchronously
 * throws/returns an ETIMEDOUT Error as `result.error` with status/signal
 * both null, rather than the "child ran, then got SIGTERM'd mid-flight"
 * shape (status: null, signal: 'SIGTERM', no error) that a slower timeout
 * produces. Both are spawnSync's own timeout; only the exact race between
 * "did the child get far enough to report a signal-kill" differs.
 */
function spawnDaemon(extraEnv, timeoutMs) {
  var env = Object.assign({
    PATH: process.env.PATH || "/usr/bin:/bin",
    // Prevent Node version check failure noise — we are on Node 20+
  }, extraEnv);

  var result = spawnSync(process.execPath, [daemonScript], {
    env: env,
    timeout: timeoutMs || SPAWN_TIMEOUT_MS,
    encoding: "utf8",
  });

  return {
    status: result.status,
    signal: result.signal,
    spawnError: result.error,
    stderr: result.stderr || "",
    stdout: result.stdout || "",
  };
}

/**
 * Builds a clear failure message for a status-78 assertion that distinguishes
 * spawnSync's own timeout — in EITHER of the two shapes Node produces for it
 * (see spawnDaemon's comment) — from a genuine non-78 exit, instead of
 * asserting on `status` alone (lr-b5d62f — a bare status-78 assertion
 * collapsed all these cases into one indistinguishable failure).
 */
function describeSpawnOutcome(result) {
  if (result.spawnError && result.spawnError.code === "ETIMEDOUT") {
    return (
      "spawnSync's own timeout (" + SPAWN_TIMEOUT_MS + "ms budget) fired before the daemon " +
      "subprocess could be observed exiting at all (ETIMEDOUT, no status/signal) — this is spawnSync " +
      "timing out under contention, not the daemon returning some other exit code. See lr-b5d62f."
    );
  }
  if (result.spawnError) {
    return "spawnSync failed to launch the daemon subprocess at all: " + result.spawnError.message;
  }
  if (result.status === null) {
    return (
      "daemon subprocess did not exit normally — killed by signal " + result.signal +
      ". With no spawnError and status: null this is spawnSync's own timeout " +
      "(" + (SPAWN_TIMEOUT_MS) + "ms budget) delivering SIGTERM to the child, not " +
      "necessarily the daemon failing to exit 78 — see lr-b5d62f.\nstderr: " + result.stderr
    );
  }
  return "daemon exited " + result.status + " (expected 78)\nstderr: " + result.stderr;
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

  // Must exit with EX_CONFIG (78), not 0 or 1 — and not merely fail to exit
  // in time (see describeSpawnOutcome for why status alone is not enough).
  assert.strictEqual(result.status, 78, describeSpawnOutcome(result));

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

// lr-b5d62f: demonstrates that describeSpawnOutcome() actually distinguishes
// a spawnSync timeout from a real (non-78) daemon exit, rather than shipping
// a diagnostic that was never exercised. A live 3/8-under-load flake cannot
// be reproduced on demand deterministically (that is the nature of a
// contention-dependent timing flake) — so this constrains the spawn's own
// timeout budget down to an amount no real daemon process can beat (the
// daemon does real fs.readFileSync/fs.writeFileSync work before it can exit,
// so 1ms guarantees spawnSync's timeout wins the race), forcing spawnSync's
// own timeout mechanism to fire on every run instead of depending on
// suite-wide contention to show up.
//
// EMPIRICAL CORRECTION (found running this very test): at a 1ms budget the
// timeout fires before libuv reports ANY child status at all, so Node
// surfaces it as `result.error` (an ETIMEDOUT Error, status/signal both
// null) — NOT the "child ran, got SIGTERM'd mid-flight" shape (status: null,
// signal: 'SIGTERM', no error) originally hypothesized from the flake's
// status:null observation alone. Both are spawnSync's own timeout; which
// shape you get depends on exactly how much of the race the child won
// before the timer fired. describeSpawnOutcome() and spawnDaemon() above
// were corrected to recognize both.
test("spawnDaemon timeout diagnostic identifies spawnSync's own timeout, not a real daemon exit", function () {
  if (process.platform === "win32") return;

  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-daemon-guard-timeout-test-"));
  var dotClagentic = path.join(tmpDir, ".clagentic");
  var consoleDir = path.join(dotClagentic, "console");
  fs.mkdirSync(consoleDir, { recursive: true });

  fs.writeFileSync(
    path.join(dotClagentic, "daemon.json"),
    JSON.stringify({ port: 2633, projects: [{ path: "/some/project", slug: "some-project" }], mode: "single", setupCompleted: true }, null, 2),
    { mode: 0o600 }
  );

  // 1ms is below any real daemon startup time (fs I/O + module require) —
  // this deterministically reproduces spawnSync's own timeout rather than
  // waiting on full-suite contention to trigger it by chance.
  var result = spawnDaemon({ CLAGENTIC_HOME: consoleDir, HOME: tmpDir }, 1);

  assert.strictEqual(result.status, null,
    "expected spawnSync's own 1ms timeout to leave status null; got status " + result.status);
  assert.ok(result.spawnError && result.spawnError.code === "ETIMEDOUT",
    "expected spawnSync to report ETIMEDOUT as result.error at a 1ms budget; got " +
    (result.spawnError ? result.spawnError.code : "no spawnError") + " (signal: " + result.signal + ")");

  // The diagnostic must name this as a timeout, not silently print a bare
  // "expected 78, got null" — that ambiguity is exactly what let this flake
  // go unrecognized/untracked (lr-b5d62f).
  var message = describeSpawnOutcome(result);
  assert.ok(message.includes("timeout") || message.includes("ETIMEDOUT"),
    "describeSpawnOutcome should identify an ETIMEDOUT result as spawnSync's own timeout: " + message);
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
