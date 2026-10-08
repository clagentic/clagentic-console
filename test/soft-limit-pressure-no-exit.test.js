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

test("new-work gate: a throwing predicate fails open", function () {
  setNewWorkGate(function () { throw new Error("boom"); });
  assert.strictEqual(getNewWorkRefusal(), null);
  setNewWorkGate(null);
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
