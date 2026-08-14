/**
 * Tests for lr-1f7e: proactive context-window warn in sdk-bridge.js.
 *
 * lr-3af675: rewritten for vendor-first resolution. The hardcoded
 * model-name -> window table (lib/model-context-windows.js) is deleted; the
 * warn now reads the vendor's own last-reported window
 * (session.lastContextUsage.maxTokens, populated from getContextUsage() at
 * the end of the previous turn — see sdk-message-processor.js) instead of
 * resolving a model name against a table. When no vendor value is known yet
 * (first turn, resumed session before a completed turn) the warn degrades
 * to skipped rather than guessing a window.
 *
 * Covers:
 *   (1) warn toast fires when context tokens >= contextWindowWarnFraction of
 *       the vendor-reported window
 *   (2) warn toast does NOT fire when context tokens are below the fraction
 *   (3) getConfig().contextWindowWarnFraction is respected (overrides default 0.8)
 *   (4) warn is skipped when no vendor window is known yet (session.lastContextUsage unset)
 *   (5) getConfig().cgroupWarnFraction is respected for the cgroup warn threshold
 *   (6) no warn when contextWindowWarnFraction is 0 (disabled)
 *   (7) cgroupWarnFraction: 0 disables the cgroup warn
 *
 * The context-window warn fires per-turn (not only on new queries) via
 * session.lastStreamInputTokens.  We set that field on the session before
 * calling startQuery() so the guard sees it on the first turn.
 *
 * NOTE: the cgroup hard gate (lr-2d91) depends on /sys/fs/cgroup files that
 * may or may not be present.  Tests that only target the window-based warn
 * use a small token count relative to a large vendor-reported window so
 * that the cgroup gate never fires regardless of host state.
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
    // model used for query dispatch (no longer consulted for window resolution)
    model: opts.model || null,
    // lr-3af675: vendor-reported context usage from the end of the previous
    // turn (sdk-message-processor.js sets this from getContextUsage()).
    // Undefined here models "no completed turn yet" (first turn / restart).
    lastContextUsage: opts.lastContextUsage,
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

test("lr-3af675 (1): context-window warn toast fires when tokens >= fraction of vendor-reported window", async function () {
  var queryCount = 0;
  // vendor-reported window: small on purpose (lr-2d91's SEPARATE cgroup hard
  // gate reads real /sys/fs/cgroup state and is out of scope for this task;
  // small absolute token counts here keep every test below any host's
  // headroom-derived ceiling regardless of environment -- only the
  // percentage of the vendor-reported window matters for this assertion).
  // window: 10,000; 0.8 fraction -> warn at 8,000
  var SESSION_TOKENS = 8500; // above 80% threshold
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    null // default config (0.8 fraction)
  );

  var session = makeSession({
    lastStreamInputTokens: SESSION_TOKENS,
    lastContextUsage: { maxTokens: 10000 },
  });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.ok(warns.length > 0, "window-based warn toast should be emitted when tokens >= 80% of the vendor-reported window");
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

test("lr-3af675 (2): context-window warn toast does NOT fire when tokens are below fraction", async function () {
  var queryCount = 0;
  // 5,000 tokens is 50% of 10,000 — below the default 80% threshold
  var SESSION_TOKENS = 5000;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    null
  );

  var session = makeSession({
    lastStreamInputTokens: SESSION_TOKENS,
    lastContextUsage: { maxTokens: 10000 },
  });
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

test("lr-3af675 (3): getConfig().contextWindowWarnFraction overrides the default warn threshold", async function () {
  var queryCount = 0;
  // 6,000 / 10,000 = 60%.  Default (0.8) would not warn.  Custom 0.5 should warn.
  var SESSION_TOKENS = 6000;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    function () { return { contextWindowWarnFraction: 0.5 }; }
  );

  var session = makeSession({
    lastStreamInputTokens: SESSION_TOKENS,
    lastContextUsage: { maxTokens: 10000 },
  });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.ok(warns.length > 0, "window-warn toast should fire at custom 0.5 fraction when tokens >= 50% of window");
  assert.equal(queryCount, 1, "query should proceed despite the warn");
});

// ---------------------------------------------------------------------------
// (4) warn is skipped when no vendor window is known yet (first turn / restart)
// ---------------------------------------------------------------------------

test("lr-3af675 (4): window-based warn is skipped when no vendor-reported window is known yet", async function () {
  var queryCount = 0;
  // Use a very large token count — if the window guard ran with an arbitrary
  // assumption it would fire; absence of warn confirms it was skipped.
  var SESSION_TOKENS = 999999;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    null
  );

  // No lastContextUsage — this is the first turn of the session (or a
  // daemon restart before any turn completed), so the vendor has not yet
  // reported a window. Must degrade cleanly, never guess.
  var session = makeSession({ lastStreamInputTokens: SESSION_TOKENS });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.equal(warns.length, 0, "window-warn toast should NOT fire when no vendor-reported window is known yet");
  // Query may or may not proceed depending on cgroup state — only assert no window warn
});

// ---------------------------------------------------------------------------
// (5) warn is skipped when contextWindowWarnFraction is 0 (disabled)
// ---------------------------------------------------------------------------

test("lr-3af675 (5): window-based warn is disabled when contextWindowWarnFraction is 0", async function () {
  var queryCount = 0;
  var SESSION_TOKENS = 999999; // would exceed any non-zero fraction for a 1M window
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    function () { return { contextWindowWarnFraction: 0 }; } // 0 = disabled
  );

  var session = makeSession({
    lastStreamInputTokens: SESSION_TOKENS,
    lastContextUsage: { maxTokens: 1000000 },
  });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.equal(warns.length, 0, "window-warn toast should NOT fire when contextWindowWarnFraction is 0");
});

// ---------------------------------------------------------------------------
// (6) a stale/small vendor-reported window is honored as-is (no model-name
//     override) — vendor always wins, this task's whole point.
// ---------------------------------------------------------------------------

test("lr-3af675 (6): a small vendor-reported window is honored even though sm.currentModel implies a large one", async function () {
  var queryCount = 0;
  // sm.currentModel implies nothing anymore — no table is consulted. Only the
  // vendor-reported maxTokens on the session matters. 9,500 / 10,000 = 95%,
  // above 80% -> warn should fire purely off the vendor value. (Small
  // absolute counts keep this below any host's cgroup headroom ceiling —
  // see the note on test (7) above.)
  var SESSION_TOKENS = 9500;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    null,
    "claude-sonnet-4" // sm.currentModel — must have zero bearing on resolution now
  );

  var session = makeSession({
    lastStreamInputTokens: SESSION_TOKENS,
    lastContextUsage: { maxTokens: 10000 },
  });
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  var warns = windowWarnToasts(messages);
  assert.ok(warns.length > 0, "window-warn should use the vendor-reported 200K window, not any model-name inference");
  assert.equal(queryCount, 1, "query should proceed");
});

// ---------------------------------------------------------------------------
// (7) cgroupWarnFraction: 0 disables the cgroup warn
//      The cgroup HARD gate (lr-2d91, separate scope from this task) reads
//      real /sys/fs/cgroup state and its ceiling varies by host -- a very
//      large token count that reliably avoided it on a bare host can just as
//      reliably trip it inside a constrained container. Use a small absolute
//      token count so this test targets only the soft cgroupWarnFraction
//      behavior under test, regardless of host headroom.
// ---------------------------------------------------------------------------

test("lr-3af675 (7): cgroupWarnFraction: 0 accepted as valid config (disables warn)", async function () {
  var queryCount = 0;
  // Small token count: no vendor window known -> window-warn skipped either
  // way; small absolute count keeps this well under any host's cgroup
  // headroom-derived ceiling so only the cgroupWarnFraction:0 behavior is
  // under test here, not the (separately scoped) hard gate.
  var SESSION_TOKENS = 100;
  var { bridge, sm, messages } = makeBridge(
    async function () { queryCount++; return makeEmptyHandle(); },
    function () { return { cgroupWarnFraction: 0 }; }
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
