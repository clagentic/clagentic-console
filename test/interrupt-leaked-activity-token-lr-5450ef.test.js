/**
 * Regression tests for lr-5450ef: an interrupted turn leaks an activity
 * token, pinning session.isProcessing=true forever — every later user
 * message then buffers into an undrainable session.pendingMessages queue
 * and is silently lost (no UI error).
 *
 * Chain (see task description for full diagnosis):
 *   1. A Task tool acquires an activity token at block_stop
 *      (sdk-message-processor.js) that is only ever released by a later
 *      tool_result/task_notification for the same tool id.
 *   2. The user interrupts the turn (taskStopRequested / AbortError). The
 *      stream that would have delivered that tool_result never gets the
 *      chance to — the token is now permanently leaked.
 *   3. processQueryStream's finally block re-derives
 *      session.isProcessing = sessionActivity.isSessionActive(session),
 *      which is still true because of the leaked token.
 *   4. dispatchToSdk (project-user-message.js) sees isProcessing===true and
 *      routes every later message through sdk.pushMessage instead of
 *      startQuery. queryInstance is null, so pushMessage buffers instead of
 *      delivering — silently, from the user's point of view.
 *   5. Nothing self-heals: bumpGeneration (the PRIMARY leak-resistance
 *      layer) only ran from inside startQuery, which a pinned isProcessing
 *      prevents from ever being reached again.
 *
 * Fix under test (lib/sdk-bridge.js):
 *   - bumpGeneration() is now also called on both terminal paths of
 *     processQueryStream (the taskStopRequested branch and the
 *     AbortError/catch branch), so a token leaked by an interrupted turn is
 *     dropped immediately and isProcessing correctly resolves to false.
 *   - the idle reaper now also runs sweepStaleTokens (BACKSTOP layer) for a
 *     session stuck with isProcessing=true and no live queryInstance, so
 *     even a pinning mechanism this fix didn't anticipate is eventually
 *     recoverable instead of self-sealing forever.
 *   - pushMessage's buffer is now bounded and emits a UI-visible diagnostic
 *     on every buffer, so silence-to-UI can never recur even for a
 *     candidate cause outside this specific token-leak mechanism.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var sessionActivity = require("../lib/session-activity");

function makeBlockedHandle() {
  var resolveNext;
  var rejectNext;
  return {
    _adapterState: null,
    [Symbol.asyncIterator]: function () {
      return {
        next: function () {
          return new Promise(function (resolve, reject) {
            resolveNext = function () { resolve({ value: undefined, done: true }); };
            rejectNext = function (err) { reject(err); };
          });
        },
      };
    },
    pushMessage: function () {},
    close: function () { if (resolveNext) resolveNext(); },
    endInput: function () {},
    abort: function () { if (resolveNext) resolveNext(); },
    _unblock: function () { if (resolveNext) resolveNext(); },
    _rejectAbort: function () {
      var err = new Error("aborted");
      err.name = "AbortError";
      if (rejectNext) rejectNext(err);
    },
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
    destroying: false,
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

/**
 * Simulate a Task tool's activity token being acquired mid-turn, the same
 * way sdk-message-processor.js's block_stop handler does for a Task tool
 * (source: "task", token = the tool_use block id) — without pulling in the
 * whole message-processor pipeline, since only the registry state matters
 * for this test.
 */
function acquireLeakedTaskToken(session, toolId) {
  sessionActivity.acquireToken(session, toolId, { source: "task", label: "background work" });
}

test("lr-5450ef: an interrupted turn (taskStopRequested) drops a leaked Task activity token instead of pinning isProcessing forever", async function () {
  var handleA = makeBlockedHandle();
  var { bridge, sm } = makeBridge([handleA]);

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "do something with a subagent", null, null);
  assert.equal(session.queryInstance, handleA);

  // A backgrounded Task tool acquired an activity token that nothing will
  // ever release now — the interrupt below ends the stream before any
  // tool_result/task_notification for it can arrive.
  acquireLeakedTaskToken(session, "toolu_task_leaked");
  assert.equal(sessionActivity.isSessionActive(session), true, "token acquired: registry reports active");

  // User interrupts the turn (project-sessions.js stop_task handler calls
  // sdk.stopTask, which sets taskStopRequested and aborts).
  session.taskStopRequested = true;
  handleA._unblock(); // for-await loop ends normally (done:true), taking the taskStopRequested branch

  if (session.streamPromise) { try { await session.streamPromise; } catch (e) {} }
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });

  assert.equal(
    sessionActivity.isSessionActive(session),
    false,
    "the leaked token must be dropped by the interrupt path's generation bump"
  );
  assert.equal(
    session.isProcessing,
    false,
    "isProcessing must resolve to false — not stay pinned true by the leaked token"
  );
});

test("lr-5450ef: an aborted turn (AbortError catch path) also drops a leaked Task activity token", async function () {
  var handleA = makeBlockedHandle();
  var { bridge, sm } = makeBridge([handleA]);

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "do something with a subagent", null, null);
  assert.equal(session.queryInstance, handleA);

  acquireLeakedTaskToken(session, "toolu_task_leaked_2");
  assert.equal(sessionActivity.isSessionActive(session), true);

  // Simulate an AbortController-driven abort: the for-await loop rejects
  // with AbortError instead of completing normally.
  if (session.abortController) session.abortController.abort();
  handleA._rejectAbort();

  if (session.streamPromise) { try { await session.streamPromise; } catch (e) {} }
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });

  assert.equal(
    sessionActivity.isSessionActive(session),
    false,
    "the leaked token must be dropped by the AbortError catch path's generation bump"
  );
  assert.equal(session.isProcessing, false);
});

test("lr-5450ef: end-to-end — after the interrupt-leak fix, a message sent while isProcessing would have been true instead reaches startQuery, not the buffer", async function () {
  var handleA = makeBlockedHandle();
  var handleB = makeBlockedHandle();
  var { bridge, sm } = makeBridge([handleA, handleB]);

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  await bridge.startQuery(session, "first message", null, null);
  acquireLeakedTaskToken(session, "toolu_task_leaked_3");

  session.taskStopRequested = true;
  handleA._unblock();
  if (session.streamPromise) { try { await session.streamPromise; } catch (e) {} }
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });

  // This mirrors dispatchToSdk's branch selection in project-user-message.js:
  // it checks session.isProcessing to decide startQuery vs pushMessage.
  assert.equal(session.isProcessing, false, "precondition: isProcessing correctly recovered");

  // A genuinely idle session (queryInstance null, isProcessing false) takes
  // the startQuery branch on the next message — confirms the session is no
  // longer wedged into the pushMessage/pendingMessages dead end.
  await bridge.startQuery(session, "second message (post-interrupt)", null, null);
  assert.equal(session.queryInstance, handleB, "startQuery must be reachable again after the interrupt");
  assert.equal(session.pendingMessages, undefined, "no message should ever have been forced into the buffer");

  handleB._unblock();
  if (session.streamPromise) { try { await session.streamPromise; } catch (e) {} }
  await new Promise(function (r) { setImmediate(r); });
});

test("lr-5450ef: idle reaper sweepStaleTokens BACKSTOP recovers a session pinned by a leaked token with no live queryInstance", function (t) {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
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

    // Simulate the self-sealing trap directly: isProcessing pinned true by a
    // leaked token, queryInstance already null (the stream ended), nothing
    // left to call startQuery/bumpGeneration ever again.
    var session = makeSession();
    session.queryInstance = null;
    session.isProcessing = true;
    sessionActivity.acquireToken(session, "toolu_leaked_forever", { source: "task" });
    sm.sessions.set(session.localId, session);

    assert.equal(sessionActivity.isSessionActive(session), true);

    bridge.startIdleReaper();
    // Advance past the 5-minute BACKSTOP staleness window in 60s ticks.
    t.mock.timers.tick(60 * 1000 * 6);

    assert.equal(
      sessionActivity.isSessionActive(session),
      false,
      "sweepStaleTokens backstop must eventually drop a token that survived even the generation-bump fix"
    );
    assert.equal(
      session.isProcessing,
      false,
      "the reaper must recover isProcessing once the backstop sweep clears the registry"
    );
    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

test("lr-5450ef: idle reaper does NOT touch a session that is genuinely, currently active (token younger than the backstop window)", function (t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
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

    var session = makeSession();
    session.queryInstance = null;
    session.isProcessing = true;
    sessionActivity.acquireToken(session, "toolu_fresh", { source: "task" });
    sm.sessions.set(session.localId, session);

    bridge.startIdleReaper();
    t.mock.timers.tick(60 * 1000 * 1); // well under the 5-minute backstop window

    assert.equal(sessionActivity.isSessionActive(session), true, "a fresh token must not be swept early");
    assert.equal(session.isProcessing, true, "isProcessing must not be disturbed while genuinely active");
    bridge.stopIdleReaper();
  } finally {
    t.mock.timers.reset();
  }
});

test("lr-5450ef: pushMessage bounds the pendingMessages buffer and emits a UI-visible diagnostic instead of buffering silently", async function () {
  var handleA = makeBlockedHandle();
  var { bridge, sm, messages } = makeBridge([handleA]);

  var session = makeSession();
  sm.sessions.set(session.localId, session);

  // queryInstance is null (between turns) — pushMessage must buffer, not
  // throw, and it must now emit a diagnostic every time it does.
  bridge.pushMessage(session, "buffered while wedged", null);

  assert.equal(session.pendingMessages.length, 1);
  var diag = messages.filter(function (m) { return m.type === "diagnostic"; });
  assert.equal(diag.length, 1, "buffering a message must emit exactly one diagnostic");
  assert.equal(diag[0].severity, "warning");
  assert.equal(diag[0].source, "message-buffer");
  assert.ok(diag[0].message.indexOf("Clagentic: Console") === 0, "diagnostic text must use the correct product name, never bare 'clagentic'");

  // Fill the buffer past its bound and confirm it does not grow unbounded.
  for (var i = 0; i < 30; i++) {
    bridge.pushMessage(session, "msg " + i, null);
  }
  assert.ok(session.pendingMessages.length <= 20, "pendingMessages must be bounded, not grow without limit");
});

test("lr-5450ef: project-user-message.js surfaces an error instead of silently dropping a message when getSessionForWs returns null", function () {
  var { attachUserMessage } = require("../lib/project-user-message");

  var sentToWs = [];
  var fakeWs = { readyState: 1 };

  var ctx = {
    cwd: "/tmp",
    slug: "test-slug",
    osUsers: null,
    sm: { sessions: new Map(), broadcastSessionList: function () {} },
    sdk: {},
    nm: {},
    tm: { list: function () { return []; } },
    send: function () {},
    sendTo: function (ws, obj) { sentToWs.push(obj); },
    sendToSession: function () {},
    sendToSessionOthers: function () {},
    clients: [],
    opts: {},
    usersModule: {},
    // The defect under test: no session bound to this websocket.
    getSessionForWs: function () { return null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return null; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function () {},
    saveImageFile: function () {},
    imagesDir: "/tmp",
    onProcessingChanged: function () {},
    onSessionDone: function () {},
    _loop: { handleLoopMessage: function () { return false; } },
    browserState: { _browserTabList: {}, _extensionWs: null, pendingExtensionRequests: {} },
    sendExtensionCommandAny: function () {},
    requestTabContext: function () {},
    startFileWatch: function () {},
    stopFileWatch: function () {},
    scheduleMessage: function () {},
    cancelScheduledMessage: function () {},
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    digestDmTurn: function () {},
    adapter: { vendor: "claude" },
  };

  var handlers = attachUserMessage(ctx);
  var handled = handlers.handleUserMessage(fakeWs, { type: "message", text: "hello?" });

  assert.equal(handled, true, "the message type must still be reported as handled (no downstream fallthrough)");
  assert.equal(sentToWs.length, 1, "exactly one error must be surfaced to the sender");
  assert.equal(sentToWs[0].type, "error");
  assert.ok(sentToWs[0].text && sentToWs[0].text.length > 0, "the error must carry a non-empty message, not a bare drop");
});
