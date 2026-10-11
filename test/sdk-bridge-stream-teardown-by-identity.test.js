"use strict";
// A stream that unwinds after its query was replaced (a rewind, or a runtime
// whose close() failed and was detached) must leave the replacement alone: its
// message queue, its worker, its live-session slot. The real bridge's
// startQuery and processQueryStream, with stand-in query handles whose
// iterators block until the test lets them finish.

var test = require("node:test");
var assert = require("node:assert/strict");

function makeBlockedHandle(extra) {
  var resolveNext;
  return Object.assign({
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
    unblock: function () { if (resolveNext) resolveNext(); },
  }, extra || {});
}

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

var seq = 1;
function makeSession() {
  return {
    localId: seq++,
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
    lastActivityAt: Date.now(),
    _isCountedLive: false,
    _adapterWorkerState: null,
    _workerExitPromise: null,
  };
}

// gates[i], when given, is a promise the i-th createQuery waits for.
function makeBridge(handles, gates) {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  var mod = require("../lib/sdk-bridge");
  var sm = makeSessionManager();
  var index = 0;
  var adapter = {
    vendor: "claude",
    createQuery: function () {
      var i = index++;
      var wait = gates && gates[i] ? gates[i] : Promise.resolve();
      return wait.then(function () { return handles[i]; });
    },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
    generateTitle: null,
    renameSession: null,
    forkSession: null,
  };
  var bridge = mod.createSDKBridge({
    cwd: "/tmp/test-project",
    slug: "test-project",
    sessionManager: sm,
    send: function () {},
    adapter: adapter,
    adapters: { claude: adapter },
    onProcessingChanged: function () {},
    getConfig: null,
  });
  return { bridge: bridge, sm: sm, liveCount: mod.getActiveLiveCount };
}

function settle() {
  return new Promise(function (resolve) { setImmediate(function () { setImmediate(resolve); }); });
}

// Starts query A, detaches it the way a rewind or a failed close does (the
// session no longer points at it, its stream is still reading), then starts B.
async function replaceWhileUnwinding() {
  var killed = [];
  var workerB = { process: { pid: 4242 }, kill: function () { killed.push("B"); } };
  var handleA = makeBlockedHandle();
  var handleB = makeBlockedHandle({ _adapterState: { worker: workerB, exitPromise: null } });
  var ctx = makeBridge([handleA, handleB]);
  var session = makeSession();
  ctx.sm.sessions.set(session.localId, session);

  await ctx.bridge.startQuery(session, "first", null, null);
  var streamA = session.streamPromise;
  assert.equal(session.queryInstance, handleA);
  assert.equal(ctx.liveCount(), 1);

  session.queryInstance = null;

  await ctx.bridge.startQuery(session, "second", null, null);
  assert.equal(session.queryInstance, handleB);
  assert.equal(ctx.liveCount(), 2, "both queries hold a slot until the old stream unwinds");

  return { ctx: ctx, session: session, handleA: handleA, handleB: handleB, streamA: streamA, workerB: workerB, killed: killed };
}

test("an old stream unwinding after a replacement started leaves the replacement's queue, worker and state alone", async function () {
  var r = await replaceWhileUnwinding();
  var queueB = { end: function () {} };
  r.session.messageQueue = queueB;
  r.session.isProcessing = true;
  r.session.taskStopRequested = true;

  r.handleA.unblock();
  await r.streamA;
  await settle();

  assert.equal(r.session.messageQueue, queueB, "the new query's message queue is intact");
  assert.equal(r.session._adapterWorkerState && r.session._adapterWorkerState.worker, r.workerB, "the new query's worker state is intact");
  assert.equal(r.session.worker, r.workerB);
  assert.deepEqual(r.killed, [], "the new query's worker was not killed");
  assert.equal(r.session.queryInstance, r.handleB);
  assert.equal(r.session.isProcessing, true);
  assert.equal(r.session.taskStopRequested, true);

  r.handleB.unblock();
  await r.session.streamPromise;
});

test("an old stream unwinding after a replacement started releases only its own live slot", async function () {
  var r = await replaceWhileUnwinding();

  r.handleA.unblock();
  await r.streamA;
  await settle();

  assert.equal(r.ctx.liveCount(), 1, "the old query's slot is given back");
  assert.equal(r.session._isCountedLive, true, "the new query still holds its own");

  r.handleB.unblock();
  await r.session.streamPromise;
  await settle();
  assert.equal(r.ctx.liveCount(), 0, "and gives it back when it ends");
  assert.equal(r.session._isCountedLive, false);
});

test("a stream that unwinds while the replacement is still starting does not treat the empty session as its own", async function () {
  var handleA = makeBlockedHandle();
  var handleB = makeBlockedHandle();
  var releaseCreate;
  var gate = new Promise(function (resolve) { releaseCreate = resolve; });
  var ctx = makeBridge([handleA, handleB], [null, gate]);
  var session = makeSession();
  ctx.sm.sessions.set(session.localId, session);

  await ctx.bridge.startQuery(session, "first", null, null);
  var streamA = session.streamPromise;
  session.queryInstance = null;

  // B is inside createQuery: the session has no runtime yet, and its pending
  // work is B's.
  var starting = ctx.bridge.startQuery(session, "second", null, null);
  session.isProcessing = true;
  session.pendingPermissions["perm-b"] = { resolve: function () {}, reject: function () {} };

  handleA.unblock();
  await streamA;
  await settle();

  assert.equal(session.isProcessing, true, "B's turn is not marked finished by A");
  assert.ok(session.pendingPermissions["perm-b"], "B's prompt survives A's unwinding");

  releaseCreate();
  await starting;
  assert.equal(session.queryInstance, handleB);
  assert.equal(ctx.liveCount(), 1);

  handleB.unblock();
  await session.streamPromise;
  await settle();
  assert.equal(ctx.liveCount(), 0);
});
