/**
 * Regression/behavioral tests for lr-58c813: instrumentation-only baseline
 * for the lr-5edd64 redesign. See that task's description for the full
 * two-source diagnosis (session.isProcessing, a plain mutable boolean with
 * ~14 raw writers, vs sessionActivity.isSessionActive(session), the
 * registry-derived value, agree at exactly one write site).
 *
 * SCOPE: this file proves the PROBE is correct and non-mutating — it does
 * NOT fix the divergence (out of scope, see lr-58c813 description). Every
 * test here either:
 *   (1) proves the probe counts a genuine, constructed divergence without
 *       correcting session.isProcessing or the registry itself, or
 *   (2) proves the probe stays silent (count unchanged) when the two
 *       sources already agree, or
 *   (3) proves the sampling/bound behavior (ring buffer cap, once-per-tick
 *       via the existing idle-reaper interval, not a new hot-path cost).
 */

var test = require("node:test");
var assert = require("node:assert/strict");

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
    localId: "divsess-" + (_localIdSeq++),
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

function makeBridge() {
  var sdkBridgeMod = freshSdkBridge();
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
  return { sdkBridgeMod: sdkBridgeMod, sm: sm, bridge: bridge };
}

// ---------------------------------------------------------------------------
// 1. The probe counts a genuine divergence without correcting either source.
// ---------------------------------------------------------------------------

test("lr-58c813: idle-reaper tick counts a session where isProcessing=true but the registry has no live token (raw writer set it true with no matching token acquire)", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var setup = makeBridge();
    var sm = setup.sm;
    var bridge = setup.bridge;

    // Mirrors the exact concrete raise path lr-5edd64 names (project.js:724):
    // isProcessing set true directly, no token ever acquired. queryInstance
    // is set so the reaper's own sweepStaleTokens/reap branches (which only
    // fire when isProcessing && !queryInstance, or !isProcessing) do not
    // themselves mutate isProcessing or the registry this tick — isolating
    // what this test is asserting to the probe alone.
    var session = makeSession({ isProcessing: true, queryInstance: {} });
    sm.sessions.set(session.localId, session);

    assert.equal(sessionActivity.isSessionActive(session), false, "precondition: registry has no token for this session");

    var before = setup.sdkBridgeMod.getActivityDivergenceStats();

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 1); // one reaper tick

    var after = setup.sdkBridgeMod.getActivityDivergenceStats();

    assert.equal(after.count, before.count + 1, "exactly one divergence must be recorded for the one diverging session");
    assert.equal(after.recentSamples[0].sessionId, session.localId);
    assert.equal(after.recentSamples[0].rawIsProcessing, true);
    assert.equal(after.recentSamples[0].derivedIsActive, false);

    // The probe must be READ ONLY: neither source was touched by observing it.
    assert.equal(session.isProcessing, true, "probe must not correct session.isProcessing");
    assert.equal(sessionActivity.isSessionActive(session), false, "probe must not mutate the registry");

    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

test("lr-58c813: idle-reaper tick records NO divergence when the two sources already agree (both false)", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var setup = makeBridge();
    var sm = setup.sm;
    var bridge = setup.bridge;

    var session = makeSession({ isProcessing: false, queryInstance: {} });
    sm.sessions.set(session.localId, session);

    var before = setup.sdkBridgeMod.getActivityDivergenceStats();

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 1);

    var after = setup.sdkBridgeMod.getActivityDivergenceStats();
    assert.equal(after.count, before.count, "agreeing sources must not be counted as a divergence");

    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

test("lr-58c813: idle-reaper tick records NO divergence when the two sources already agree (both true, via a real acquired token)", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var setup = makeBridge();
    var sm = setup.sm;
    var bridge = setup.bridge;

    var session = makeSession({ isProcessing: true, queryInstance: {} });
    sessionActivity.acquireToken(session, "toolu_agree", { source: "task" });
    sm.sessions.set(session.localId, session);

    assert.equal(sessionActivity.isSessionActive(session), true, "precondition: registry agrees with isProcessing");

    var before = setup.sdkBridgeMod.getActivityDivergenceStats();

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 1);

    var after = setup.sdkBridgeMod.getActivityDivergenceStats();
    assert.equal(after.count, before.count, "agreeing sources (both true) must not be counted as a divergence");

    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// 2. Bound: the ring buffer of recent samples never grows past its cap, even
//    though the total count keeps incrementing exactly.
// ---------------------------------------------------------------------------

test("lr-58c813: recentSamples is capped even when many sessions diverge across many ticks; the total count is not", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var setup = makeBridge();
    var sm = setup.sm;
    var bridge = setup.bridge;

    var CAP = 20; // mirrors ACTIVITY_DIVERGENCE_SAMPLE_CAP in lib/sdk-bridge.js
    var SESSION_COUNT = CAP + 15;
    for (var i = 0; i < SESSION_COUNT; i++) {
      var session = makeSession({ isProcessing: true, queryInstance: {} }); // no token acquired -> diverges
      sm.sessions.set(session.localId, session);
    }

    var before = setup.sdkBridgeMod.getActivityDivergenceStats();

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 1); // one tick observes every session once

    var after = setup.sdkBridgeMod.getActivityDivergenceStats();

    assert.equal(after.count, before.count + SESSION_COUNT, "the total count must be exact, not capped");
    assert.ok(after.recentSamples.length <= CAP, "the retained sample detail must be bounded regardless of how many sessions diverge");

    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// 3. getMemoryStats (already the process_stats plumbing point) folds the
//    divergence totals in, matching the shape project-sessions.js reads.
// ---------------------------------------------------------------------------

test("lr-58c813: bridge.getMemoryStats() exposes activityDivergenceCount and activityDivergenceRecentSamples", function () {
  var setup = makeBridge();
  var stats = setup.bridge.getMemoryStats();
  assert.equal(typeof stats.activityDivergenceCount, "number");
  assert.ok(Array.isArray(stats.activityDivergenceRecentSamples));
});

// ---------------------------------------------------------------------------
// 4. CI invariant: the probe call site is READ ONLY source-text — no
//    assignment to session.isProcessing or session.activity anywhere in the
//    probe helper function, so a future edit cannot silently turn this
//    baseline measurement into a fix.
// ---------------------------------------------------------------------------

test("CI invariant: _recordActivityDivergenceIfAny never assigns session.isProcessing or session.activity", function () {
  var fs = require("fs");
  var path = require("path");
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "sdk-bridge.js"), "utf8");
  var start = src.indexOf("function _recordActivityDivergenceIfAny");
  assert.ok(start !== -1, "expected _recordActivityDivergenceIfAny to exist in lib/sdk-bridge.js");
  var end = src.indexOf("\n}", start) + 2;
  var body = src.slice(start, end);
  assert.doesNotMatch(body, /session\.isProcessing\s*=/, "the probe must never write session.isProcessing");
  assert.doesNotMatch(body, /session\.activity\s*=/, "the probe must never write session.activity");
  assert.doesNotMatch(body, /sessionActivity\.(acquireToken|releaseToken|bumpGeneration|sweepStaleTokens|replaceRegistry)\(/, "the probe must never call a registry-mutating export");
});
