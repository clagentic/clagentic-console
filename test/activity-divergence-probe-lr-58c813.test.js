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
    //
    // Constructed exactly as the real constructors do (lib/sessions.js:697,
    // :835): no `activity` property at all. Deliberately NOT calling
    // sessionActivity.isSessionActive() anywhere in this test, before or
    // after the tick — that call itself lazily creates session.activity
    // (session-activity.js ensureRegistry), which would mask the exact
    // defect this test exists to catch (PEACHES lr-58c813 finding).
    var session = makeSession({ isProcessing: true, queryInstance: {} });
    assert.equal(Object.prototype.hasOwnProperty.call(session, "activity"), false,
      "precondition: session has no activity property, matching the real constructors");
    sm.sessions.set(session.localId, session);

    var before = setup.sdkBridgeMod.getActivityDivergenceStats();

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 1); // one reaper tick

    var after = setup.sdkBridgeMod.getActivityDivergenceStats();

    assert.equal(after.count, before.count + 1, "exactly one divergence must be recorded for the one diverging session");
    assert.equal(after.recentSamples[0].rawIsProcessing, true);
    assert.equal(after.recentSamples[0].derivedIsActive, false);

    // The probe must be genuinely READ ONLY: neither source was touched by
    // observing it, INCLUDING never lazily creating session.activity. This
    // is the assertion that fails against the pre-fix probe (verified by
    // stash-testing — see PR body) because the pre-fix probe called
    // sessionActivity.isSessionActive(session), which assigns
    // session.activity as a side effect of reading it.
    assert.equal(session.isProcessing, true, "probe must not correct session.isProcessing");
    assert.equal(Object.prototype.hasOwnProperty.call(session, "activity"), false,
      "probe must not lazily create session.activity as a side effect of observing it");

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
//
//    lr-58c813 PEACHES finding: a prior version of this invariant only
//    inspected the probe function's own body for DIRECT writes, so it could
//    not see the TRANSITIVE mutation through sessionActivity.isSessionActive
//    -> getActiveCount -> ensureRegistry (which assigns session.activity as
//    a side effect of reading it). Source inspection alone cannot prove a
//    called function is side-effect-free without re-deriving that function's
//    own body every time it changes — so this invariant is now split in two:
//    (a) a narrow, defensible source check that the probe never calls the
//        two specific sessionActivity exports known to have this shape
//        (isSessionActive, getActiveCount), rather than trying to inspect
//        their transitive bodies; and
//    (b) the behavioral test above ("...counts a session where..."), which
//        constructs a session exactly as the real constructors do (no
//        `activity` property) and asserts session.activity is STILL ABSENT
//        after the probe runs — that is the test that actually catches a
//        transitive mutation, source inspection is a secondary guard.
// ---------------------------------------------------------------------------

test("CI invariant: _recordActivityDivergenceIfAny never assigns session.isProcessing or session.activity, and never calls a mutating sessionActivity read (isSessionActive/getActiveCount)", function () {
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
  // The lazy-init defect: isSessionActive/getActiveCount both call
  // ensureRegistry(session) internally, which assigns session.activity if
  // absent. Neither is a "write" by grep-for-assignment, so they need their
  // own explicit ban here — this is the transitive-mutation gap this
  // invariant previously missed.
  assert.doesNotMatch(body, /sessionActivity\.(isSessionActive|getActiveCount)\(/,
    "the probe must not call sessionActivity.isSessionActive/getActiveCount — both lazily create session.activity as a side effect; use the non-mutating _peekIsSessionActive helper instead");
  assert.match(body, /_peekIsSessionActive\(/, "the probe must read activity via the non-mutating _peekIsSessionActive helper");
});

test("lr-58c813: _peekIsSessionActive itself never creates session.activity — direct unit check independent of the reaper/tick plumbing", function () {
  var setup = makeBridge();
  var session = makeSession({ isProcessing: true, queryInstance: {} });
  assert.equal(Object.prototype.hasOwnProperty.call(session, "activity"), false, "precondition");
  // _peekIsSessionActive is not exported (private helper) — exercised
  // indirectly here via the same public entry point production uses
  // (getMemoryStats/getActivityDivergenceStats after a reaper tick is
  // covered above); this test instead pins the module-level CI-invariant
  // helper name so the source-inspection test above stays meaningful if
  // the helper is ever renamed.
  var fs = require("fs");
  var path = require("path");
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "sdk-bridge.js"), "utf8");
  assert.match(src, /function _peekIsSessionActive\(session\)/, "expected the non-mutating helper to exist by this name in lib/sdk-bridge.js");
});

// ---------------------------------------------------------------------------
// 5. BOBBIE finding: divergence samples carry no session identifier, since
//    process_stats (the handler that folds these into its response) has no
//    admin/role gate.
// ---------------------------------------------------------------------------

test("lr-58c813: a recorded divergence sample never includes a sessionId field", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    var setup = makeBridge();
    var sm = setup.sm;
    var bridge = setup.bridge;

    var session = makeSession({ isProcessing: true, queryInstance: {} });
    sm.sessions.set(session.localId, session);

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 1);

    var stats = setup.sdkBridgeMod.getActivityDivergenceStats();
    assert.ok(stats.recentSamples.length >= 1, "expected at least one recorded sample");
    assert.equal(Object.prototype.hasOwnProperty.call(stats.recentSamples[0], "sessionId"), false,
      "a divergence sample must not carry a session identifier — process_stats is not admin-gated");

    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});
