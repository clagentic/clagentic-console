"use strict";
/**
 * Crossing the MemoryHigh soft limit refuses new sessions and new query
 * processes, leaves existing sessions running, never exits the daemon, and
 * resumes accepting once memory falls back under the limit.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { createDrain } = require("../lib/drain");
var { startMemoryHighWatcher } = require("../lib/memory-limits");
var { setNewWorkGate, getNewWorkRefusal, REFUSAL_MESSAGE } = require("../lib/new-work-gate");
var { attachSessions } = require("../lib/project-sessions");

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

test("new-work gate: open by default, closed while the predicate says so", function () {
  setNewWorkGate(null);
  assert.strictEqual(getNewWorkRefusal(), null);
  var refusing = false;
  setNewWorkGate(function () { return refusing; });
  assert.strictEqual(getNewWorkRefusal(), null);
  refusing = true;
  assert.strictEqual(getNewWorkRefusal(), REFUSAL_MESSAGE);
  setNewWorkGate(null);
});

test("new-work gate: refusal text follows the brand rule", function () {
  assert.match(REFUSAL_MESSAGE, /Clagentic: Console/);
  assert.doesNotMatch(REFUSAL_MESSAGE.replace(/Clagentic: Console/g, ""), /clagentic/i);
});

test("new-work gate: a throwing predicate fails closed and logs the error", function () {
  setNewWorkGate(function () { throw new Error("boom"); });
  var logged = [];
  var origError = console.error;
  console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
  try {
    assert.strictEqual(getNewWorkRefusal(), REFUSAL_MESSAGE);
  } finally {
    console.error = origError;
    setNewWorkGate(null);
  }
  assert.strictEqual(logged.length, 1);
  assert.match(logged[0], /new-work-gate/);
  assert.match(logged[0], /boom/);
});

test("watcher: unreadable cgroup usage never falls back to daemon RSS", async function () {
  var written = [];
  var origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (s) { written.push(String(s)); return true; };
  var crossings = 0;
  // Threshold of 1 byte: the daemon's own RSS is far above it, so an RSS
  // fallback would register a crossing immediately.
  var watcher = startMemoryHighWatcher({ memoryHigh: "1" }, {
    pollIntervalMs: 10,
    readHighCounter: function () { return null; },
    readCurrentBytes: function () { return null; },
    onCrossing: function () { crossings++; },
  });
  try {
    await sleep(80);
  } finally {
    watcher.stop();
    process.stderr.write = origWrite;
  }
  assert.strictEqual(crossings, 0, "RSS must not be measured as cgroup usage");
  var warnings = written.filter(function (l) { return /detection unavailable/.test(l); });
  assert.strictEqual(warnings.length, 1, "unavailability is logged exactly once");
});

test("watcher: recovery does not fire on a low daemon RSS when cgroup usage is unreadable", async function () {
  var current = 1200;
  var unreadable = false;
  var counter = 1;
  var recoveries = 0;
  var origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function () { return true; };
  var watcher = startMemoryHighWatcher({ memoryHigh: "1000000000000" }, {
    pollIntervalMs: 10,
    readHighCounter: function () { return counter; },
    readCurrentBytes: function () { return unreadable ? null : current; },
    onRecovery: function () { recoveries++; },
  });
  try {
    await sleep(30);
    counter++; // kernel reports a crossing
    unreadable = true;
    // The next two polls keep seeing the counter advance, so the quiet-poll
    // path cannot complete; daemon RSS (far below 1e12) must not recover it.
    var bump = setInterval(function () { counter++; }, 5);
    await sleep(80);
    clearInterval(bump);
    assert.strictEqual(recoveries, 0, "RSS reading must not trigger recovery");
    await sleep(80);
    assert.strictEqual(recoveries, 1, "recovery still arrives via quiet polls");
  } finally {
    watcher.stop();
    process.stderr.write = origWrite;
  }
});

test("startQuery: a new query is refused under pressure and an in-flight session is untouched", async function () {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  var { createSDKBridge } = require("../lib/sdk-bridge");
  var messages = [];
  var created = 0;
  var sm = {
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
    sendAndRecord: function (s, obj) { messages.push(obj); },
    sendToSession: function (s, obj) { messages.push(obj); },
  };
  var adapter = {
    vendor: "claude",
    createQuery: async function () {
      created++;
      return {
        _adapterState: null,
        [Symbol.asyncIterator]: function () {
          return { next: function () { return Promise.resolve({ value: undefined, done: true }); } };
        },
        pushMessage: function () {},
        close: function () {},
        endInput: function () {},
        abort: function () {},
      };
    },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
    generateTitle: null,
    renameSession: null,
    forkSession: null,
  };
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
  var makeSession = function (id) {
    return {
      localId: id, queryInstance: null, messageQueue: null, abortController: null,
      isProcessing: true, cliSessionId: null, history: [], blocks: {},
      sentToolResults: {}, pendingPermissions: {}, pendingAskUser: {},
      pendingElicitations: {}, activeTaskToolIds: {}, singleTurn: false,
      lastActivityAt: Date.now(), _isCountedLive: false,
      _adapterWorkerState: null, _workerExitPromise: null,
    };
  };

  var drain = createDrain({
    gracefulShutdown: function () {},
    getActiveCount: function () { return 1; },
    log: function () {},
  });
  setNewWorkGate(drain.isRefusingNewWork);
  var origWarn = console.warn;
  console.warn = function () {};
  try {
    drain.onMemoryHighCrossing({});
    var refused = makeSession(9001);
    sm.sessions.set(refused.localId, refused);
    await bridge.startQuery(refused, "hello", null, null);
    assert.strictEqual(created, 0, "no query process created under pressure");
    assert.strictEqual(refused._isCountedLive, false, "refusal must not claim a slot");
    assert.strictEqual(refused.isProcessing, false);
    var errs = messages.filter(function (m) { return m.type === "error"; });
    assert.strictEqual(errs.length, 1);
    assert.strictEqual(errs[0].text, REFUSAL_MESSAGE);

    drain.onMemoryHighRecovery({});
    var accepted = makeSession(9002);
    sm.sessions.set(accepted.localId, accepted);
    await bridge.startQuery(accepted, "hello", null, null);
    if (accepted.streamPromise) await accepted.streamPromise;
    assert.strictEqual(created, 1, "query accepted after recovery");
  } finally {
    console.warn = origWarn;
    setNewWorkGate(null);
  }
});

test("watcher + drain + gate: crossing refuses, existing work and daemon survive, recovery resumes", async function () {
  var current = 500;
  var shutdowns = 0;
  var changes = [];
  var drain = createDrain({
    gracefulShutdown: function () { shutdowns++; },
    getActiveCount: function () { return 6; },
    drainTimeoutMs: 40,
    log: function () {},
    onPressureChange: function (state) { changes.push(state); },
  });
  setNewWorkGate(drain.isRefusingNewWork);

  var origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function () { return true; };
  var watcher = startMemoryHighWatcher({ memoryHigh: "1000" }, {
    pollIntervalMs: 15,
    readHighCounter: function () { return null; },
    readCurrentBytes: function () { return current; },
    onCrossing: function (d) { drain.onMemoryHighCrossing(d); },
    onRecovery: function (d) { drain.onMemoryHighRecovery(d); },
  });

  try {
    await sleep(60);
    assert.strictEqual(getNewWorkRefusal(), null, "below the limit: accepting");

    current = 1200;
    await sleep(120);
    assert.strictEqual(getNewWorkRefusal(), REFUSAL_MESSAGE, "over the limit: refusing");
    // Well past drainTimeoutMs with 6 active sessions: the old behavior exited.
    assert.strictEqual(shutdowns, 0, "daemon must not exit on a soft-limit crossing");

    current = 500;
    await sleep(120);
    assert.strictEqual(getNewWorkRefusal(), null, "back under the limit: accepting again");
    assert.deepStrictEqual(changes, [true, false]);
    assert.strictEqual(shutdowns, 0);
  } finally {
    watcher.stop();
    process.stderr.write = origWrite;
    setNewWorkGate(null);
  }
});

test("watcher: stays pressured inside the hysteresis band", async function () {
  var current = 1200;
  var recoveries = 0;
  var origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function () { return true; };
  var watcher = startMemoryHighWatcher({ memoryHigh: "1000" }, {
    pollIntervalMs: 15,
    readHighCounter: function () { return null; },
    readCurrentBytes: function () { return current; },
    onRecovery: function () { recoveries++; },
  });
  try {
    await sleep(60);
    current = 980; // under 1000 but not by the 5% margin
    await sleep(80);
    assert.strictEqual(recoveries, 0);
    current = 900;
    await sleep(80);
    assert.strictEqual(recoveries, 1);
  } finally {
    watcher.stop();
    process.stderr.write = origWrite;
  }
});

function makeSessionsCtx() {
  var noop = function () {};
  var sent = [];
  var created = [];
  var ctx = {
    cwd: "/tmp/test-soft-limit",
    slug: "test-soft-limit",
    osUsers: false,
    currentVersion: "0.0.0",
    sm: {
      sessions: new Map(),
      _savedDefaultModel: null,
      _savedDefaultMode: "default",
      createSession: function () {
        var s = { localId: created.length + 1, model: null, permissionMode: null };
        created.push(s);
        return s;
      },
    },
    sdk: {},
    tm: { list: function () { return []; } },
    clients: new Set(),
    send: noop,
    sendTo: function (ws, msg) { sent.push(msg); },
    sendToAdmins: noop,
    sendToSession: noop,
    sendToSessionOthers: noop,
    opts: {},
    usersModule: { getEffectivePermissions: function () { return {}; } },
    userPresence: { setPresence: noop },
    pushModule: null,
    getSessionForWs: function () { return null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: noop,
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (o) { return o; },
    onProcessingChanged: noop,
    broadcastPresence: noop,
    adapter: null,
    getProjectList: function () { return []; },
    getProjectCount: function () { return 0; },
    getScheduleCount: function () { return 0; },
    moveScheduleToProject: noop,
    moveAllSchedulesToProject: noop,
    getHubSchedules: function () { return []; },
    fetchVersion: noop,
    isNewer: function () { return false; },
    onCreateWorktree: null,
    IGNORED_DIRS: new Set(),
    scheduleMessage: noop,
    cancelScheduledMessage: noop,
    getProjectOwnerId: function () { return null; },
    setProjectOwnerId: noop,
    getUpdateChannel: function () { return "stable"; },
    setUpdateChannel: noop,
    getLatestVersion: function () { return "0.0.0"; },
    setLatestVersion: noop,
  };
  return { ctx: ctx, sent: sent, created: created };
}

test("new_session: refused with a toast under pressure, accepted after recovery", function () {
  var h = makeSessionsCtx();
  var handlers = attachSessions(h.ctx);
  var ws = { readyState: 1, send: function () {} };
  var drain = createDrain({
    gracefulShutdown: function () {},
    getActiveCount: function () { return 1; },
    log: function () {},
  });
  setNewWorkGate(drain.isRefusingNewWork);
  try {
    drain.onMemoryHighCrossing({});
    handlers.handleSessionsMessage(ws, { type: "new_session" });
    assert.strictEqual(h.created.length, 0, "no session created under pressure");
    assert.strictEqual(h.sent.length, 1);
    assert.strictEqual(h.sent[0].type, "toast");
    assert.strictEqual(h.sent[0].message, REFUSAL_MESSAGE);

    drain.onMemoryHighRecovery({});
    handlers.handleSessionsMessage(ws, { type: "new_session" });
    assert.strictEqual(h.created.length, 1, "session created after recovery");
  } finally {
    setNewWorkGate(null);
  }
});
