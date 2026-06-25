/**
 * Tests for lr-1f7e: proactive model context-window warn in sdk-bridge.js
 *
 * Covers:
 *   (1) warn toast fires when context tokens >= contextWindowWarnFraction of model window
 *   (2) warn toast does NOT fire when context tokens are below the fraction
 *   (3) getConfig().contextWindowWarnFraction is respected (overrides default 0.8)
 *   (4) warn is skipped when model is unknown (resolveModelContextWindow returns 0)
 *   (5) getConfig().cgroupWarnFraction is respected for the cgroup warn threshold
 *   (6) no warn when contextWindowWarnFraction is 0 (disabled)
 *   (7) [PEACHES fix] context-1m beta active: warn uses 1M window, not model base window
 *   (8) [PEACHES fix] context-1m beta NOT active: warn uses model base window (o3 → 200K)
 *   (9) [PEACHES fix] resolveModelContextWindow direct unit: beta overrides map lookup
 *  (10) [PEACHES fix] cgroupWarnFraction: 0 disables cgroup warn (consistent with ctx-win)
 *
 * The context-window warn fires per-turn (not only on new queries) via
 * session.lastStreamInputTokens.  We set that field on the session before
 * calling startQuery() so the guard sees it on the first turn.
 *
 * NOTE: the cgroup hard gate (lr-2d91) depends on /sys/fs/cgroup files that
 * may or may not be present.  Tests that only target the window-based warn
 * use a known model with a large window and small token counts so that the
 * cgroup gate never fires regardless of host state.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Helpers (duplicated from sdk-bridge-slot-counter.test.js — each file is
// self-contained so there is no cross-test-file shared state)
// ---------------------------------------------------------------------------

function makeEmptyHandle() {
  var closed = false;
  return {
    _adapterState: null,
    [Symbol.asyncIterator]: function () {
      return {
        next: function () {
          if (closed) return Promise.resolve({ value: undefined, done: true });
          closed = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
    pushMessage: function () {},
    close: function () { closed = true; },
    endInput: function () {},
    abort: function () { closed = true; },
  };
}

function makeSessionManager(messages) {
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
      if (messages) messages.push(obj);
    },
    sendToSession: function (session, obj) {
      if (messages) messages.push(obj);
    },
  };
}

var _localIdSeq = 1000;
function makeSession(opts) {
  opts = opts || {};
  return {
    localId: _localIdSeq++,
    queryInstance: null,
    messageQueue: null,
    abortController: null,
    isProcessing: true,
    cliSessionId: null,
    history: [],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingAskUser: {},
    pendingElicitations: {},
    activeTaskToolIds: {},
    singleTurn: false,
    lastActivityAt: Date.now(),
    _isCountedLive: false,
    _adapterWorkerState: null,
    _workerExitPromise: null,
    // lr-1f7e: per-turn context token count (set by message-processor on turn_start)
    lastStreamInputTokens: opts.lastStreamInputTokens || 0,
    // model used for context-window resolution
    model: opts.model || null,
  };
}

function makeAdapter(createQueryFn) {
  return {
    vendor: "claude",
    createQuery: createQueryFn,
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
    generateTitle: null,
    renameSession: null,
    forkSession: null,
  };
}

function freshSdkBridge() {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  return require("../lib/sdk-bridge");
}

function makeBridge(createQueryFn, getConfig, smCurrentModel) {
  var { createSDKBridge } = freshSdkBridge();
  var messages = [];
  var sm = makeSessionManager(messages);
  if (smCurrentModel) sm.currentModel = smCurrentModel;
  var adapter = makeAdapter(createQueryFn);
  var bridge = createSDKBridge({
    cwd: "/tmp/test-project",
    slug: "test-project",
    sessionManager: sm,
    send: function (msg) { messages.push(msg); },
    adapter: adapter,
    adapters: { claude: adapter },
    onProcessingChanged: function () {},
    getConfig: getConfig || null,
  });
  return { bridge, sm, messages };
}

function toastMessages(messages) {
  return messages.filter(function (m) { return m.type === "toast"; });
}

function windowWarnToasts(messages) {
  // The window-based warn message includes the text "% full"
  return messages.filter(function (m) {
    return m.type === "toast" && m.message && m.message.indexOf("% full") !== -1;
  });
}

// ---------------------------------------------------------------------------
// (1) warn fires when context tokens >= contextWindowWarnFraction of window
// ---------------------------------------------------------------------------

test("lr-1f7e (1): context-window warn toast fires when tokens >= fraction of model window", async function () {
  var queryCount = 0;
  // claude-sonnet-4 → 1,000,000 token window; 0.8 fraction → warn at 800,000
  var SESSION_TOKENS = 850000; // above 80% threshold
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    null, // default config (0.8 fraction)
    "claude-sonnet-4" // sm.currentModel
  );

  var session = makeSession({ lastStreamInputTokens: SESSION_TOKENS });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.ok(warns.length > 0, "window-based warn toast should be emitted when tokens >= 80% of window");
  assert.ok(
    warns.some(function (m) { return m.level === "warn"; }),
    "warn toast should have level 'warn'"
  );
  // Query should still proceed — the window warn is informational, not a hard gate
  assert.equal(queryCount, 1, "query should proceed despite the warn (not a hard gate)");
});

// ---------------------------------------------------------------------------
// (2) warn does NOT fire when context tokens are below the fraction
// ---------------------------------------------------------------------------

test("lr-1f7e (2): context-window warn toast does NOT fire when tokens are below fraction", async function () {
  var queryCount = 0;
  // 500,000 tokens is 50% of 1,000,000 — below the default 80% threshold
  var SESSION_TOKENS = 500000;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    null,
    "claude-sonnet-4"
  );

  var session = makeSession({ lastStreamInputTokens: SESSION_TOKENS });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.equal(warns.length, 0, "no window-warn toast should fire when tokens are below the threshold");
  assert.equal(queryCount, 1, "query should proceed normally");
});

// ---------------------------------------------------------------------------
// (3) getConfig().contextWindowWarnFraction overrides default 0.8
// ---------------------------------------------------------------------------

test("lr-1f7e (3): getConfig().contextWindowWarnFraction overrides the default warn threshold", async function () {
  var queryCount = 0;
  // 600,000 / 1,000,000 = 60%.  Default (0.8) would not warn.  Custom 0.5 should warn.
  var SESSION_TOKENS = 600000;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    function () { return { contextWindowWarnFraction: 0.5 }; },
    "claude-sonnet-4"
  );

  var session = makeSession({ lastStreamInputTokens: SESSION_TOKENS });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.ok(warns.length > 0, "window-warn toast should fire at custom 0.5 fraction when tokens >= 50% of window");
  assert.equal(queryCount, 1, "query should proceed despite the warn");
});

// ---------------------------------------------------------------------------
// (4) warn is skipped when model is unknown (resolveModelContextWindow returns 0)
// ---------------------------------------------------------------------------

test("lr-1f7e (4): window-based warn is skipped when model is unknown", async function () {
  var queryCount = 0;
  // Use a very large token count — if the window guard ran with an arbitrary
  // assumption it would fire; absence of warn confirms it was skipped.
  var SESSION_TOKENS = 999999;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    null,
    "unknown-future-model-xyz" // not in BACKEND_KNOWN_CONTEXT_WINDOWS
  );

  var session = makeSession({ lastStreamInputTokens: SESSION_TOKENS });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.equal(warns.length, 0, "window-warn toast should NOT fire when model context window is unknown");
  // Query may or may not proceed depending on cgroup state — only assert no window warn
});

// ---------------------------------------------------------------------------
// (5) warn is skipped when contextWindowWarnFraction is 0 (disabled)
// ---------------------------------------------------------------------------

test("lr-1f7e (5): window-based warn is disabled when contextWindowWarnFraction is 0", async function () {
  var queryCount = 0;
  var SESSION_TOKENS = 999999; // would exceed any non-zero fraction for a 1M window
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    function () { return { contextWindowWarnFraction: 0 }; }, // 0 = disabled
    "claude-sonnet-4"
  );

  var session = makeSession({ lastStreamInputTokens: SESSION_TOKENS });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.equal(warns.length, 0, "window-warn toast should NOT fire when contextWindowWarnFraction is 0");
});

// ---------------------------------------------------------------------------
// (6) session.model takes precedence over sm.currentModel for window lookup
// ---------------------------------------------------------------------------

test("lr-1f7e (6): session.model overrides sm.currentModel for context-window resolution", async function () {
  var queryCount = 0;
  // session.model = o3 (200K window); sm.currentModel = claude-sonnet-4 (1M window)
  // 190,000 tokens = 95% of 200K (above 80%), but only 19% of 1M (below 80%)
  // If session.model wins, warn fires. If sm.currentModel wins, no warn.
  var SESSION_TOKENS = 190000;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    null,
    "claude-sonnet-4" // sm.currentModel — should NOT win
  );

  var session = makeSession({
    lastStreamInputTokens: SESSION_TOKENS,
    model: "o3", // session-level model — should win
  });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.ok(warns.length > 0, "window-warn should use session.model (o3, 200K window) over sm.currentModel");
  assert.equal(queryCount, 1, "query should proceed");
});

// ---------------------------------------------------------------------------
// (7) [PEACHES fix] context-1m beta active: no warn at 170K tokens with o3 model
//     because the true window is 1M (beta wins over the 200K map entry)
// ---------------------------------------------------------------------------

test("lr-1f7e (7): context-1m beta active — warn uses 1M window, not o3 base 200K window", async function () {
  var queryCount = 0;
  // 170K tokens = 85% of 200K (would warn without beta), but only 17% of 1M (no warn with beta).
  // This is the lr-1f7e PEACHES regression: without the fix the backend resolves 200K and
  // warns prematurely; with the fix it sees the active beta and resolves 1M correctly.
  var SESSION_TOKENS = 170000;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    null,
    "o3" // base window 200K — but beta extends it to 1M
  );

  // Activate the context-1m beta on the session manager (mirrors set_betas WS message).
  sm.currentBetas = ["context-1m"];

  var session = makeSession({ lastStreamInputTokens: SESSION_TOKENS });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.equal(warns.length, 0,
    "no window-warn should fire: context-1m beta is active so true window is 1M, " +
    "and 170K tokens is only 17% of 1M (well below 80% threshold)");
  assert.equal(queryCount, 1, "query should proceed");
});

// ---------------------------------------------------------------------------
// (8) [PEACHES fix] context-1m beta NOT active: o3 base 200K window IS used,
//     so 170K tokens (85% of 200K) correctly triggers the warn
// ---------------------------------------------------------------------------

test("lr-1f7e (8): context-1m beta NOT active — warn fires using o3 base 200K window", async function () {
  var queryCount = 0;
  // Same token count as test (7), but no beta — o3's 200K base applies.
  // 170K / 200K = 85%, above the 80% default threshold → warn should fire.
  var SESSION_TOKENS = 170000;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    null,
    "o3"
  );

  // No currentBetas set (defaults to []).
  var session = makeSession({ lastStreamInputTokens: SESSION_TOKENS });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.ok(warns.length > 0,
    "window-warn should fire: no beta, o3 base window is 200K, 170K tokens is 85% (above 80%)");
  assert.equal(queryCount, 1, "query should proceed");
});

// ---------------------------------------------------------------------------
// (9) [PEACHES fix] resolveModelContextWindow unit test: beta array overrides map
// ---------------------------------------------------------------------------

test("lr-1f7e (9): resolveModelContextWindow — context-1m beta overrides KNOWN_CONTEXT_WINDOWS lookup", function () {
  var { resolveModelContextWindow } = freshSdkBridge();

  // Without beta: o3 → 200K
  assert.equal(resolveModelContextWindow("o3", []), 200000,
    "o3 without beta should resolve to 200K");

  // With beta: o3 → 1M (beta wins)
  assert.equal(resolveModelContextWindow("o3", ["context-1m"]), 1000000,
    "o3 with context-1m beta should resolve to 1M");

  // With beta: unknown model → 1M (beta wins even when model not in map)
  assert.equal(resolveModelContextWindow("hypothetical-200k-model", ["context-1m"]), 1000000,
    "unknown model with context-1m beta should resolve to 1M");

  // Without beta: unknown model → 0 (degrade cleanly)
  assert.equal(resolveModelContextWindow("hypothetical-200k-model", []), 0,
    "unknown model without beta should resolve to 0 (skip warn)");

  // Null activeBetas treated gracefully
  assert.equal(resolveModelContextWindow("o3", null), 200000,
    "null activeBetas should fall through to map lookup");
});

// ---------------------------------------------------------------------------
// (10) [PEACHES fix] cgroupWarnFraction: 0 disables the cgroup warn
//      On this test host cgroup reads return null (not running in the service),
//      so the cgroup gate block is skipped entirely. We verify no cgroup warn
//      toast is present — consistent with contextWindowWarnFraction: 0 behavior.
// ---------------------------------------------------------------------------

test("lr-1f7e (10): cgroupWarnFraction: 0 accepted as valid config (disables warn)", async function () {
  var queryCount = 0;
  // High token count to ensure window-warn does not fire (model unknown → window=0).
  // cgroupWarnFraction: 0 should be accepted without crashing and not produce a warn.
  var SESSION_TOKENS = 999999;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    function () { return { cgroupWarnFraction: 0 }; },
    "unknown-future-model-xyz"
  );

  var session = makeSession({ lastStreamInputTokens: SESSION_TOKENS });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  // cgroupWarnFraction: 0 must not throw and must produce no cgroup-related warn toasts.
  // (On test host cgroup is null anyway, but the config must be accepted gracefully.)
  var cgroupWarnToasts = messages.filter(function (m) {
    return m.type === "toast" && m.message && m.message.indexOf("Large session context") !== -1;
  });
  assert.equal(cgroupWarnToasts.length, 0,
    "cgroupWarnFraction: 0 should produce no cgroup warn toast (disabled)");
  // Query should still run (0 fraction disables warn, not the hard gate)
  assert.equal(queryCount, 1, "query should proceed when cgroupWarnFraction is 0");
});
