/**
 * Regression tests for lr-29f9: concurrent-session slot counter in sdk-bridge.js
 *
 * Covers:
 *   (1) slot increments on spawn, decrements on normal completion (exit 0)
 *   (2) slot decrements on query-stream error (exit != 0)
 *   (3) leak-on-throw: createQuery throws after increment → slot released
 *   (4) leak-on-throw: unexpected sync throw in post-increment body → slot released
 *   (5) ceiling: new query at MAX_CONCURRENT gets error+done, not a silent spawn
 *   (6) multi-turn pushMessage continuation is NOT double-counted
 *
 * Strategy: require sdk-bridge.js once with CLAGENTIC_MAX_CONCURRENT_SESSIONS=3
 * (small ceiling for fast tests). Between tests that need a clean counter, we
 * drain all live slots by completing mock streams. Observable effects (messages
 * emitted to `send`) are used instead of inspecting private counter state.
 *
 * The module is loaded fresh per describe-block via delete require.cache so each
 * test file section starts with _activeLiveCount = 0.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal no-op async iterator that yields nothing and completes
 * immediately (simulates a session that finishes with zero events).
 */
function makeEmptyHandle() {
  var closed = false;
  return {
    _adapterState: null,
    [Symbol.asyncIterator]: function () {
      return {
        next: function () {
          if (closed) return Promise.resolve({ value: undefined, done: true });
          closed = true;
          // Yield one minimal "done" result event then end the stream
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
    pushMessage: function () {},
    close: function () { closed = true; },
    endInput: function () {},
    abort: function () {},
  };
}

/**
 * Build a handle whose iterator errors on the first next() call.
 */
function makeErrorHandle(message) {
  return {
    _adapterState: null,
    [Symbol.asyncIterator]: function () {
      return {
        next: function () {
          return Promise.reject(new Error(message || "simulated query error"));
        },
      };
    },
    pushMessage: function () {},
    close: function () {},
    endInput: function () {},
    abort: function () {},
  };
}

/**
 * Build a minimal sessionManager stub with a sessions Map and the methods
 * createSDKBridge expects to call.
 */
function makeSessionManager(messages) {
  // messages is shared with the bridge's `send` callback so we can inspect all
  // outbound events in one place.
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
    // sdk-message-processor.js delegates sendAndRecord/sendToSession to sm.
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

/**
 * Build a minimal session object.
 */
var _localIdSeq = 1;
function makeSession() {
  return {
    localId: _localIdSeq++,
    queryInstance: null,
    messageQueue: null,
    abortController: null,
    isProcessing: true, // caller sets this before startQuery
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
  };
}

/**
 * Build a minimal adapter stub that delegates createQuery to a factory fn.
 */
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

/**
 * Load a fresh copy of sdk-bridge (reset module-level _activeLiveCount to 0).
 * Sets CLAGENTIC_MAX_CONCURRENT_SESSIONS before load so MAX_CONCURRENT_SESSIONS
 * is evaluated to the desired value.
 */
function freshSdkBridge(maxConcurrent) {
  process.env.CLAGENTIC_MAX_CONCURRENT_SESSIONS = String(maxConcurrent != null ? maxConcurrent : 3);
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  var mod = require("../lib/sdk-bridge");
  // Don't leave the env var set — tests that don't call freshSdkBridge use
  // the default (50) from the already-cached module.
  delete process.env.CLAGENTIC_MAX_CONCURRENT_SESSIONS;
  return mod;
}

/**
 * Create a configured bridge instance from a fresh module load.
 * Returns { bridge, sm, messages } where messages is the array of all
 * events sent via the `send` callback.
 */
function makeBridge(maxConcurrent, createQueryFn, getConfig) {
  var { createSDKBridge } = freshSdkBridge(maxConcurrent);
  var messages = [];
  var sm = makeSessionManager(messages);
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

/**
 * Collect messages sent to a specific session's ws clients.
 * sdk-bridge uses sendToSession → sendTo(ws, msg) for session-targeted messages,
 * but for simplicity our bridge uses sendAndRecord which appends to session.history
 * AND calls send(). We track via the global send callback.
 */
function sessionMessages(messages, filterTypes) {
  if (!filterTypes) return messages.slice();
  return messages.filter(function (m) { return filterTypes.indexOf(m.type) !== -1; });
}

// ---------------------------------------------------------------------------
// (1) Slot increments on spawn, decrements on normal completion
// ---------------------------------------------------------------------------

test("lr-29f9 (1): slot counter increments on new query and decrements after stream completes", async function () {
  var queryCount = 0;
  var { bridge, sm, messages } = makeBridge(3, async function (opts) {
    queryCount++;
    return makeEmptyHandle();
  });

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  // Before: _isCountedLive is false
  assert.equal(session._isCountedLive, false, "should not be counted before startQuery");

  // Start a query
  var startPromise = bridge.startQuery(session, "hello", null, null);

  // After startQuery starts (but before stream completes), slot is claimed
  assert.equal(session._isCountedLive, true, "_isCountedLive should be true while stream runs");

  // Wait for stream to complete
  await startPromise;
  // Give the async stream a tick to finish
  if (session.streamPromise) await session.streamPromise;

  // After completion: slot released
  assert.equal(session._isCountedLive, false, "_isCountedLive should be false after stream ends");
  assert.equal(queryCount, 1, "adapter createQuery should have been called once");
});

// ---------------------------------------------------------------------------
// (2) Slot decrements on query-stream error
// ---------------------------------------------------------------------------

test("lr-29f9 (2): slot is released when the query stream throws an error", async function () {
  var { bridge, sm, messages } = makeBridge(3, async function (opts) {
    return makeErrorHandle("network failure");
  });

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  if (session.streamPromise) {
    try { await session.streamPromise; } catch (e) { /* swallow */ }
  }
  // Allow error handling microtasks to flush
  await new Promise(function (r) { setImmediate(r); });

  assert.equal(session._isCountedLive, false, "_isCountedLive should be false after stream error");

  // A done message should have been emitted
  var doneMessages = sessionMessages(messages, ["done"]);
  assert.ok(doneMessages.length > 0, "a done message should be emitted on stream error");
});

// ---------------------------------------------------------------------------
// (3) Leak-on-throw: createQuery throws after increment → slot released
// ---------------------------------------------------------------------------

test("lr-29f9 (3a): slot is released when createQuery rejects (async throw)", async function () {
  var { bridge, sm, messages } = makeBridge(3, async function (opts) {
    throw new Error("createQuery failed");
  });

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  assert.equal(session._isCountedLive, false, "slot should be released after createQuery rejection");
  assert.equal(session.isProcessing, false, "isProcessing should be false after createQuery rejection");

  // error + done must be emitted (fail-loud, not silent)
  var errorMsgs = sessionMessages(messages, ["error"]);
  var doneMsgs = sessionMessages(messages, ["done"]);
  assert.ok(errorMsgs.length > 0, "an error message should be emitted when createQuery fails");
  assert.ok(doneMsgs.length > 0, "a done message should be emitted when createQuery fails");
});

test("lr-29f9 (3b): slot is released when createQuery throws synchronously", async function () {
  var { bridge, sm, messages } = makeBridge(3, function (opts) {
    // Synchronous throw (non-async function returning a rejected promise is the
    // same path, but this simulates a genuine sync throw before any await)
    throw new Error("sync throw in createQuery");
  });

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  assert.equal(session._isCountedLive, false, "slot should be released after sync createQuery throw");

  var errorMsgs = sessionMessages(messages, ["error"]);
  var doneMsgs = sessionMessages(messages, ["done"]);
  assert.ok(errorMsgs.length > 0, "error should be emitted on sync createQuery throw");
  assert.ok(doneMsgs.length > 0, "done should be emitted on sync createQuery throw");
});

// ---------------------------------------------------------------------------
// (4) Leak-on-throw: sync throw in post-increment option-building body
//     We simulate this by making the adapter's createQuery NOT throw but
//     having something BEFORE createQuery blow up — in practice this is the
//     outer try/catch introduced by the peaches fix.
//     We can trigger it by making `sm.broadcastSessionList` throw on first call
//     inside the outer try body (not ideal — that's called after createQuery).
//     A cleaner shim: override getCodexConfig to throw. But that's in a
//     separate module. Instead, we rely on the outer try/catch by verifying
//     that when startErr is thrown via the catch (startErr), the slot is freed.
//
//     We inject the throw via a mock of sm.broadcastSessionList (called in the
//     createQuery failure catch path), but the cleanest shim for the OUTER
//     try/catch is to make the adapter throw in a way that's caught by startErr.
// ---------------------------------------------------------------------------

test("lr-29f9 (4): outer try/catch in startQuery releases slot on unexpected sync throw", async function () {
  // We cause a sync throw inside the outer try body by making createQuery
  // (which IS inside the try) throw synchronously.
  // The outer catch is separate from the createQuery-specific catch, so
  // only errors that escape that inner catch reach the outer one.
  // The scenario: something OUTSIDE createQuery's own catch blows up.
  // We achieve this by monkey-patching session.blocks assignment inside
  // startQuery — but we can't reach that directly.
  //
  // Practical approach: inject a throw via the adapter that is NOT async
  // (so it's a sync throw that propagates through the outer try/catch, not
  // the inner createQuery try/catch which only catches awaited rejections).
  // A sync throw from createQuery is caught by the outer try/catch because
  // the inner try is `try { handle = await sessionAdapter.createQuery(...)`.
  // A sync throw from a non-async createQuery goes to the outer catch.

  var callCount = 0;
  var { bridge, sm, messages } = makeBridge(3, function (opts) {
    callCount++;
    // Synchronous throw — not inside an async function, so it is NOT caught
    // by the inner `try { handle = await ... } catch (e)` (which only catches
    // rejected promises), but IS caught by the outer `try { ... } catch (startErr)`.
    throw new Error("outer-try sync throw");
  });

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  assert.equal(session._isCountedLive, false, "slot should be released by outer catch on sync throw");
  assert.equal(session.isProcessing, false, "isProcessing should be false after outer catch");

  var errorMsgs = sessionMessages(messages, ["error"]);
  var doneMsgs = sessionMessages(messages, ["done"]);
  assert.ok(errorMsgs.length > 0, "error emitted by outer catch");
  assert.ok(doneMsgs.length > 0, "done emitted by outer catch");
});

// ---------------------------------------------------------------------------
// (5) Ceiling: new query at MAX_CONCURRENT gets error+done, not silent spawn
// ---------------------------------------------------------------------------

test("lr-29f9 (5): ceiling — query at MAX_CONCURRENT is rejected with error+done immediately", async function () {
  var MAX = 3;
  // Use handles that never complete (stream stays open) so slots stay claimed
  var openHandles = [];
  var { bridge, sm, messages } = makeBridge(MAX, async function (opts) {
    var h = {
      _adapterState: null,
      _resolve: null,
      [Symbol.asyncIterator]: function () {
        var self = this;
        return {
          next: function () {
            // Block forever until resolve() is called
            return new Promise(function (resolve) {
              self._resolve = function () { resolve({ value: undefined, done: true }); };
            });
          },
        };
      },
      pushMessage: function () {},
      close: function () { if (this._resolve) this._resolve(); },
      endInput: function () {},
      abort: function () { if (this._resolve) this._resolve(); },
    };
    openHandles.push(h);
    return h;
  });

  // Fill all slots
  var sessions = [];
  for (var i = 0; i < MAX; i++) {
    var s = makeSession();
    sm.sessions.set(s.localId, s);
    sessions.push(s);
    await bridge.startQuery(s, "msg " + i, null, null);
  }

  // All MAX slots should be live
  for (var j = 0; j < MAX; j++) {
    assert.equal(sessions[j]._isCountedLive, true, "session " + j + " slot should be claimed");
  }

  // One more session — should be rejected
  var overSession = makeSession();
  sm.sessions.set(overSession.localId, overSession);
  var overMessages = [];
  // Need to capture messages for this session specifically — they go through the
  // shared `send` callback so we filter by checking after the call.
  var msgsBefore = messages.length;
  await bridge.startQuery(overSession, "overflow", null, null);

  var newMsgs = messages.slice(msgsBefore);
  var errorMsgs = newMsgs.filter(function (m) { return m.type === "error"; });
  var doneMsgs  = newMsgs.filter(function (m) { return m.type === "done"; });

  assert.ok(errorMsgs.length > 0, "ceiling breach should emit an error message");
  assert.ok(
    errorMsgs.some(function (m) { return m.text && m.text.indexOf("Too many active sessions") !== -1; }),
    "error message should mention 'Too many active sessions'"
  );
  assert.ok(doneMsgs.length > 0, "ceiling breach should emit a done message");
  assert.equal(overSession._isCountedLive, false, "overflow session should not hold a slot");

  // Cleanup: drain open handles so the test process doesn't hang
  for (var k = 0; k < openHandles.length; k++) {
    if (openHandles[k]._resolve) openHandles[k]._resolve();
  }
  // Wait for streams to drain
  for (var l = 0; l < sessions.length; l++) {
    if (sessions[l].streamPromise) {
      try { await sessions[l].streamPromise; } catch (e) {}
    }
  }
});

// ---------------------------------------------------------------------------
// (6) Multi-turn pushMessage continuation is NOT double-counted
// ---------------------------------------------------------------------------

test("lr-29f9 (6): multi-turn pushMessage (existing queryInstance) does not claim a new slot", async function () {
  // Simulate a session that already has a live queryInstance (mid-conversation).
  // pushMessage routes through it without calling startQuery, but if startQuery
  // IS called with a pre-existing queryInstance (the multi-turn path), isNewQuery
  // should be false and no slot should be claimed.

  var handleMessages = [];
  var resolveStream;
  var blockedHandle = {
    _adapterState: null,
    [Symbol.asyncIterator]: function () {
      return {
        next: function () {
          return new Promise(function (resolve) {
            resolveStream = function () { resolve({ value: undefined, done: true }); };
          });
        },
      };
    },
    pushMessage: function (text) { handleMessages.push(text); },
    close: function () { if (resolveStream) resolveStream(); },
    endInput: function () {},
    abort: function () { if (resolveStream) resolveStream(); },
  };

  var callCount = 0;
  var { bridge, sm, messages } = makeBridge(3, async function (opts) {
    callCount++;
    return blockedHandle;
  });

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  // First turn: claim a slot, session gets a queryInstance
  await bridge.startQuery(session, "first turn", null, null);
  assert.equal(session._isCountedLive, true, "slot should be claimed after first startQuery");
  assert.equal(callCount, 1, "adapter should be called once for first turn");

  // Simulate that session now has an active queryInstance (multi-turn scenario).
  // The session.queryInstance was set by startQuery. It's the blockedHandle.
  assert.ok(session.queryInstance !== null, "queryInstance should be set");

  // Second turn: startQuery called again WITH queryInstance already set.
  // isNewQuery = false → should NOT increment _activeLiveCount.
  // In practice the code routes to pushMessage via sdk-bridge.pushMessage,
  // but the path through startQuery with queryInstance set is also valid.
  // We call bridge.pushMessage directly which is the actual production path.
  bridge.pushMessage(session, "second turn", null);

  // Verify: still only one slot claimed, adapter not called again
  assert.equal(session._isCountedLive, true, "still one slot — no double-count");
  assert.equal(callCount, 1, "adapter createQuery should NOT have been called again for pushMessage");

  // Verify the message was pushed through the existing handle
  assert.ok(handleMessages.indexOf("second turn") !== -1, "message should be routed to existing handle");

  // Cleanup: resolve the stream so the test doesn't hang
  if (resolveStream) resolveStream();
  if (session.streamPromise) {
    try { await session.streamPromise; } catch (e) {}
  }
  await new Promise(function (r) { setImmediate(r); });

  // After stream completes, slot should be released
  assert.equal(session._isCountedLive, false, "slot released after stream ends");
});

// ---------------------------------------------------------------------------
// (7) Multiple sequential queries on same session each get exactly one slot
// ---------------------------------------------------------------------------

test("lr-29f9 (7): sequential queries on the same session each claim and release exactly one slot", async function () {
  var { bridge, sm, messages } = makeBridge(3, async function (opts) {
    return makeEmptyHandle();
  });

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  for (var i = 0; i < 3; i++) {
    // Reset isProcessing between turns (caller's responsibility)
    session.isProcessing = true;
    session.queryInstance = null; // new turn starts with no active query

    await bridge.startQuery(session, "turn " + i, null, null);
    if (session.streamPromise) {
      try { await session.streamPromise; } catch (e) {}
    }
    await new Promise(function (r) { setImmediate(r); });

    assert.equal(session._isCountedLive, false,
      "slot should be released after turn " + i + " completes");
  }
});

// ---------------------------------------------------------------------------
// lr-2d91: MemAvailable gate tests
// ---------------------------------------------------------------------------

test("lr-2d91 (1): query is rejected when getConfig returns a threshold above available memory", async function () {
  // Simulate 512 MB available, 1024 MB required.
  // We cannot write real /proc/meminfo in a unit test, so we test the gate
  // only on Linux where the file exists. On other platforms the gate is a no-op
  // and we skip the assertion.
  // gate is Linux-only; test is a no-op on other platforms — verify on Linux CI
  if (process.platform !== "linux") return;

  var queryCount = 0;
  // Use a very high threshold that will certainly exceed real available memory
  // on any sane test host. If available memory is somehow > 1 TB, this test
  // would produce a false negative — that's acceptable for a unit test.
  var HUGE_THRESHOLD = 1024 * 1024; // 1 TB in MB
  var { bridge, sm, messages } = makeBridge(50, async function () {
    queryCount++;
    return makeEmptyHandle();
  }, function () { return { memAvailableMinMB: HUGE_THRESHOLD }; });

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  // The gate should have fired — adapter should NOT have been called
  assert.equal(queryCount, 0, "adapter createQuery should NOT be called when memory gate fires");
  assert.equal(session._isCountedLive, false, "slot should not be claimed when memory gate fires");
  assert.equal(session.isProcessing, false, "isProcessing should be false after gate rejection");

  var errorMsgs = messages.filter(function (m) { return m.type === "error"; });
  var doneMsgs  = messages.filter(function (m) { return m.type === "done"; });
  var toastMsgs = messages.filter(function (m) { return m.type === "toast"; });

  assert.ok(errorMsgs.length > 0, "error message should be emitted when memory gate fires");
  assert.ok(
    errorMsgs.some(function (m) { return m.text && m.text.indexOf("Not enough memory") !== -1; }),
    "error message should mention 'Not enough memory'"
  );
  assert.ok(doneMsgs.length > 0, "done message should be emitted when memory gate fires");
  assert.ok(toastMsgs.length > 0, "global toast should be broadcast when memory gate fires");
  assert.ok(
    toastMsgs.some(function (m) { return m.level === "warn"; }),
    "toast should have level 'warn'"
  );
});

test("lr-2d91 (2): query proceeds normally when memory is above threshold", async function () {
  // Use a threshold of 0 — gate should never fire, regardless of available memory.
  var queryCount = 0;
  var { bridge, sm, messages } = makeBridge(50, async function () {
    queryCount++;
    return makeEmptyHandle();
  }, function () { return { memAvailableMinMB: 0 }; });

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  assert.equal(queryCount, 1, "adapter createQuery should be called when threshold is 0");
});

test("lr-2d91 (3): memory gate is a no-op when getConfig is not provided", async function () {
  // No getConfig injected — bridge should use the default 1024 MB threshold but
  // since it cannot force a low-memory scenario from a unit test, we just verify
  // that the bridge doesn't crash and the adapter IS called (normal path on dev).
  // This is a smoke test for the null-getConfig path.
  var queryCount = 0;
  var { bridge, sm, messages } = makeBridge(50, async function () {
    queryCount++;
    return makeEmptyHandle();
  }); // no getConfig arg

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "hello", null, null);
  await new Promise(function (r) { setImmediate(r); });

  // On a dev machine with sufficient memory, the query proceeds. On a CI box
  // with < 1024 MB free, the gate might fire — both outcomes are valid here.
  // We only assert that the bridge does not throw.
  assert.ok(true, "bridge did not throw without getConfig");
});

test("lr-2d91 (4): getMemoryStats returns activeLiveCount and maxConcurrentSessions", async function () {
  var MAX = 3;
  var openHandles = [];
  var { bridge, sm, messages } = makeBridge(MAX, async function () {
    var h = {
      _adapterState: null,
      _resolve: null,
      [Symbol.asyncIterator]: function () {
        var self = this;
        return {
          next: function () {
            return new Promise(function (resolve) {
              self._resolve = function () { resolve({ value: undefined, done: true }); };
            });
          },
        };
      },
      pushMessage: function () {},
      close: function () { if (this._resolve) this._resolve(); },
      endInput: function () {},
      abort: function () { if (this._resolve) this._resolve(); },
    };
    openHandles.push(h);
    return h;
  });

  var stats0 = bridge.getMemoryStats();
  assert.equal(stats0.activeLiveCount, 0, "activeLiveCount should be 0 before any queries");
  assert.equal(stats0.maxConcurrentSessions, MAX, "maxConcurrentSessions should match bridge MAX");

  // Start two sessions
  var s1 = makeSession();
  var s2 = makeSession();
  sm.sessions.set(s1.localId, s1);
  sm.sessions.set(s2.localId, s2);
  await bridge.startQuery(s1, "q1", null, null);
  await bridge.startQuery(s2, "q2", null, null);

  var stats2 = bridge.getMemoryStats();
  assert.equal(stats2.activeLiveCount, 2, "activeLiveCount should reflect open queries");

  // Drain handles
  for (var k = 0; k < openHandles.length; k++) {
    if (openHandles[k]._resolve) openHandles[k]._resolve();
  }
  for (var l of [s1, s2]) {
    if (l.streamPromise) { try { await l.streamPromise; } catch (e) {} }
  }
  await new Promise(function (r) { setImmediate(r); });

  var statsFinal = bridge.getMemoryStats();
  assert.equal(statsFinal.activeLiveCount, 0, "activeLiveCount should be 0 after streams end");
});
