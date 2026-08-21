/**
 * Regression/behavioral tests for lr-8b476f: an agent-readable retrieval
 * path for the lr-58c813 server-side activity-divergence probe.
 *
 * THE PROBLEM this closes: the probe (lib/sdk-bridge.js) was reachable ONLY
 * through the process_stats WebSocket message (lib/project-sessions.js:668-709),
 * which requires a live WS client — unreachable by a read-only crew agent
 * holding Bash+Read only. This adds a second retrieval path over the
 * EXISTING daemon.sock Unix IPC socket (lib/daemon.js's "get_activity_diagnostics"
 * command), which a Bash-only agent can reach via:
 *
 *   clagentic-console --activity-diagnostics
 *
 * SCOPE: this file proves the RETRIEVAL PATH actually returns the probe
 * data — not that the probe itself is correct (that is lr-58c813's own test
 * file, test/activity-divergence-probe-lr-58c813.test.js, left untouched).
 *
 * Per repo convention (docs/guides/TESTING_CONVENTIONS.md): daemon.js has no
 * module.exports and cannot be safely required in-process (it binds real
 * sockets/HTTP servers as a side effect of being loaded), so the actual
 * response-building logic lives in lib/sdk-bridge.js's
 * buildActivityDiagnosticsResponse() — a plain, directly testable function —
 * and daemon.js's IPC "get_activity_diagnostics" case is a one-line call
 * into it. Test 1 below proves that function genuinely surfaces data
 * recorded by a live probe tick (not a hardcoded/stubbed shape); test 2
 * source-checks daemon.js's case body is wired to call the SAME function
 * (not a fabricated inline duplicate that could drift from it).
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var sessionActivity = require("../lib/session-activity");

function makeSessionManager() {
  return {
    sessions: new Map(),
    currentModel: null,
    currentPermissionMode: null,
    currentEffort: null,
    currentBetas: [],
    modelsByVendor: {},
    availableVendors: [],
    installedVendors: [],
    defaultVendor: "claude",
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    getActiveSession: function () { return null; },
    setSlashCommandsForVendor: function () {},
    sendAndRecord: function (session, obj) {
      if (!session.history) session.history = [];
      session.history.push(obj);
    },
    sendToSession: function () {},
  };
}

var _localIdSeq = 1;
function makeSession(overrides) {
  return Object.assign({
    localId: "diagsess-" + (_localIdSeq++),
    queryInstance: null,
    messageQueue: null,
    abortController: null,
    isProcessing: false,
    cliSessionId: null,
    history: [],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingAskUser: {},
    pendingElicitations: {},
    activeTaskToolIds: {},
    singleTurn: false,
    destroying: false,
    lastActivityAt: Date.now(),
  }, overrides || {});
}

function freshSdkBridge() {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  return require("../lib/sdk-bridge");
}

function makeBridge(sdkBridgeMod) {
  var sm = makeSessionManager();
  var bridge = sdkBridgeMod.createSDKBridge({
    cwd: "/tmp",
    slug: "test",
    sessionManager: sm,
    send: function () {},
    adapter: { vendor: "claude" },
    adapters: {},
    onProcessingChanged: function () {},
  });
  return { sm: sm, bridge: bridge };
}

// ---------------------------------------------------------------------------
// 1. buildActivityDiagnosticsResponse() genuinely surfaces a divergence
//    recorded by a live idle-reaper tick — this is the test that would FAIL
//    against pre-fix code, since buildActivityDiagnosticsResponse did not
//    exist before this change (confirmed by stash-testing: reverting
//    lib/sdk-bridge.js to HEAD~ makes this throw TypeError, not merely
//    return a wrong value — see PR body).
// ---------------------------------------------------------------------------

test("lr-8b476f: buildActivityDiagnosticsResponse() surfaces a divergence recorded by a real idle-reaper tick, not a stubbed/hardcoded shape", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sdkBridgeMod = freshSdkBridge();
    var setup = makeBridge(sdkBridgeMod);
    var sm = setup.sm;
    var bridge = setup.bridge;

    assert.equal(typeof sdkBridgeMod.buildActivityDiagnosticsResponse, "function",
      "lib/sdk-bridge.js must export buildActivityDiagnosticsResponse");

    var before = sdkBridgeMod.buildActivityDiagnosticsResponse();
    assert.equal(before.ok, true);
    assert.equal(typeof before.activityDivergenceCount, "number");
    assert.ok(Array.isArray(before.activityDivergenceRecentSamples));

    // Construct exactly one genuine divergence: isProcessing=true, no matching
    // activity token — mirrors the concrete raise path lr-5edd64 names.
    var session = makeSession({ isProcessing: true, queryInstance: {} });
    sm.sessions.set(session.localId, session);

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 1); // one reaper tick

    var after = sdkBridgeMod.buildActivityDiagnosticsResponse();

    assert.equal(after.activityDivergenceCount, before.activityDivergenceCount + 1,
      "the retrieval path must reflect the exact divergence just recorded by the probe, not a cached/stale/stubbed count");
    assert.equal(after.activityDivergenceRecentSamples[0].rawIsProcessing, true);
    assert.equal(after.activityDivergenceRecentSamples[0].derivedIsActive, false);
    assert.equal(typeof after.activeLiveCount, "number");

    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// 2. No sessionId leaks through the new retrieval path either — this is the
//    SAME BOBBIE-remediated shape process_stats already carries; a second
//    retrieval path must not quietly reintroduce it.
// ---------------------------------------------------------------------------

test("lr-8b476f: a sample returned by buildActivityDiagnosticsResponse() never includes a sessionId field", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var sdkBridgeMod = freshSdkBridge();
    var setup = makeBridge(sdkBridgeMod);
    var sm = setup.sm;
    var bridge = setup.bridge;

    var session = makeSession({ isProcessing: true, queryInstance: {} });
    sm.sessions.set(session.localId, session);

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 1);

    var stats = sdkBridgeMod.buildActivityDiagnosticsResponse();
    assert.ok(stats.activityDivergenceRecentSamples.length >= 1, "expected at least one recorded sample");
    assert.equal(Object.prototype.hasOwnProperty.call(stats.activityDivergenceRecentSamples[0], "sessionId"), false,
      "the IPC retrieval path must not carry a session identifier either — same posture as process_stats");

    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// 3. daemon.js's "get_activity_diagnostics" IPC case is wired to call the
//    SAME function tested above, rather than a hand-duplicated inline copy
//    that could drift from it or silently reintroduce a field BOBBIE
//    required removed. Source-level check only (daemon.js cannot be
//    required in-process — see file header comment); paired with the
//    behavioral tests above, not a substitute for them (per lr-58c813's own
//    "source inspection alone cannot prove correctness" lesson).
// ---------------------------------------------------------------------------

test("lib/daemon.js: get_activity_diagnostics IPC case calls buildActivityDiagnosticsResponse() from lib/sdk-bridge.js", function () {
  var daemonSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  assert.match(daemonSrc, /require\(["']\.\/sdk-bridge["']\)/, "daemon.js must require lib/sdk-bridge.js");
  assert.match(daemonSrc, /buildActivityDiagnosticsResponse/, "daemon.js must reference buildActivityDiagnosticsResponse");

  var caseStart = daemonSrc.indexOf('case "get_activity_diagnostics"');
  assert.ok(caseStart !== -1, 'expected a "get_activity_diagnostics" IPC case in lib/daemon.js');
  var caseEnd = daemonSrc.indexOf("case ", caseStart + 1);
  var caseBody = daemonSrc.slice(caseStart, caseEnd === -1 ? caseStart + 400 : caseEnd);

  assert.match(caseBody, /buildActivityDiagnosticsResponse\(\)/,
    "the get_activity_diagnostics case must call the shared, unit-tested buildActivityDiagnosticsResponse() rather than duplicating its logic inline");
});

// ---------------------------------------------------------------------------
// 4. The CLI subcommand (the actual command a Bash-only agent runs) sends
//    the right IPC cmd and exits non-interactively.
// ---------------------------------------------------------------------------

test("lib/cli/ipc-subcommands.js: handleActivityDiagnostics sends {cmd: \"get_activity_diagnostics\"} over the daemon socket", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "cli", "ipc-subcommands.js"), "utf8");
  assert.match(src, /function handleActivityDiagnostics\(/, "expected handleActivityDiagnostics to be defined");
  var start = src.indexOf("function handleActivityDiagnostics");
  var end = src.indexOf("\nfunction ", start + 1);
  var body = src.slice(start, end === -1 ? src.length : end);
  assert.match(body, /cmd:\s*["']get_activity_diagnostics["']/,
    "handleActivityDiagnostics must send the get_activity_diagnostics IPC command");
  assert.match(body, /console\.log\(JSON\.stringify/,
    "handleActivityDiagnostics must print JSON to stdout (the point is machine readability for a Bash-only agent)");
  assert.match(src, /handleActivityDiagnostics:\s*handleActivityDiagnostics/, "handleActivityDiagnostics must be exported");
});

test("bin/cli.js: --activity-diagnostics flag is wired to handleActivityDiagnostics", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "bin", "cli.js"), "utf8");
  assert.match(src, /--activity-diagnostics/, "expected a --activity-diagnostics flag in bin/cli.js");
  assert.match(src, /handleActivityDiagnostics\(\)/, "the flag must call handleActivityDiagnostics()");
});
