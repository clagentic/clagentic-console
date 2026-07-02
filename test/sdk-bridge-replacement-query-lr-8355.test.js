/**
 * Regression test for lr-8355: query finally block clobbers a replacement
 * query's session state.
 *
 * Scenario: a rewind (or any other replacement) nulls session.queryInstance
 * and starts a NEW query while the OLD query's processQueryStream for-await
 * is still unwinding in the background (e.g. draining a slow/blocked async
 * iterator after abort()). Before the fix, the old stream's `finally` block
 * unconditionally reset session.pendingPermissions / pendingAskUser /
 * pendingElicitations / isProcessing — wiping out the NEW query's in-flight
 * state and flipping isProcessing=false while the new query was still live.
 *
 * This test drives that exact race: start query A with a handle whose
 * iterator blocks on the first next() call, "rewind" by nulling
 * session.queryInstance and swapping in query B (also blocked, holding a
 * pending permission), then unblock A's iterator so its finally block runs.
 * Assert B's pendingPermissions entry and isProcessing survive.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

function makeBlockedHandle() {
  var resolveNext;
  return {
    _adapterState: null,
    [Symbol.asyncIterator]: function () {
      return {
        next: function () {
          return new Promise(function (resolve) {
            resolveNext = function () { resolve({ value: undefined, done: true }); };
          });
        },
      };
    },
    pushMessage: function () {},
    close: function () { if (resolveNext) resolveNext(); },
    endInput: function () {},
    abort: function () { if (resolveNext) resolveNext(); },
    _unblock: function () { if (resolveNext) resolveNext(); },
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

var _localIdSeq = 1;
function makeSession() {
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

function makeBridge(handles) {
  var { createSDKBridge } = freshSdkBridge();
  var messages = [];
  var sm = makeSessionManager(messages);
  var idx = 0;
  var adapter = makeAdapter(function () {
    var h = handles[idx++];
    return Promise.resolve(h);
  });
  var bridge = createSDKBridge({
    cwd: "/tmp/test-project",
    slug: "test-project",
    sessionManager: sm,
    send: function (msg) { messages.push(msg); },
    adapter: adapter,
    adapters: { claude: adapter },
    onProcessingChanged: function () {},
    getConfig: null,
  });
  return { bridge, sm, messages };
}

test("lr-8355: old query's finally does not clobber a replacement query's pendingPermissions/isProcessing", async function () {
  var handleA = makeBlockedHandle();
  var handleB = makeBlockedHandle();
  var { bridge, sm } = makeBridge([handleA, handleB]);

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  // Start query A (simulates the pre-rewind, in-flight query).
  await bridge.startQuery(session, "first message", null, null);
  assert.equal(session.queryInstance, handleA, "session should own query A after startQuery");

  // Simulate a permission request arriving on query A before the rewind.
  session.pendingPermissions["perm-a"] = { resolve: function () {}, reject: function () {} };

  // Simulate rewind_execute (project-sessions.js:874-965): it aborts/ends the
  // old query and nulls session.queryInstance, but does NOT wait for query
  // A's processQueryStream for-await loop to actually finish unwinding.
  session.queryInstance = null;
  session.pendingPermissions = {};
  session.isProcessing = false;

  // User immediately sends a new message — starts query B while A's stream
  // (still blocked on its iterator's next()) has not yet run its finally.
  await bridge.startQuery(session, "second message (post-rewind)", null, null);
  assert.equal(session.queryInstance, handleB, "session should now own query B");

  // Query B has an in-flight permission request the operator is about to
  // approve/deny. This is the exact state that a clobbering finally block
  // would wipe out.
  session.pendingPermissions["perm-b"] = { resolve: function () {}, reject: function () {} };
  session.isProcessing = true;

  // Now let query A's stream actually finish unwinding — its finally block
  // runs while session.queryInstance !== handleA (it's handleB).
  handleA._unblock();
  if (session.streamPromiseA) { try { await session.streamPromiseA; } catch (e) {} }
  // Give the finally block's microtasks a tick to run.
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });

  // Query B's permission card must still be there, and isProcessing must
  // still reflect query B being live — NOT reset by query A's stale finally.
  assert.ok(
    session.pendingPermissions["perm-b"],
    "query B's pendingPermissions entry must survive query A's finally block"
  );
  assert.equal(
    session.isProcessing,
    true,
    "isProcessing must reflect the live query B, not be reset by the unwinding query A"
  );

  // Cleanup: unblock B so the test process doesn't hang.
  handleB._unblock();
  if (session.streamPromise) { try { await session.streamPromise; } catch (e) {} }
  await new Promise(function (r) { setImmediate(r); });
});

test("lr-8355: finally block still resets state normally when no newer query has taken over", async function () {
  var handleA = makeBlockedHandle();
  var { bridge, sm } = makeBridge([handleA]);

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "only message", null, null);
  assert.equal(session.queryInstance, handleA);

  session.pendingPermissions["perm-a"] = { resolve: function () {}, reject: function () {} };

  // No rewind, no replacement query — this is the normal single-query path.
  handleA._unblock();
  if (session.streamPromise) { try { await session.streamPromise; } catch (e) {} }
  await new Promise(function (r) { setImmediate(r); });

  assert.deepEqual(
    session.pendingPermissions,
    {},
    "pendingPermissions should still be reset to {} for a normal (non-superseded) completion"
  );
  assert.equal(session.isProcessing, false, "isProcessing should still be reset to false normally");
});
