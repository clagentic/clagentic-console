"use strict";
/**
 * A loop never moves a browser tab that did not ask for it.
 *
 * The fake session manager mirrors the real createSession contract: with
 * activate:false nothing switches, with a target ws only that ws switches,
 * with neither every client switches. Each fake client records the
 * session switches it receives.
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");
var execFileSync = require("child_process").execFileSync;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-loop-tabs-"));
}

function gitInit(dir) {
  var env = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
  });
  execFileSync("git", ["init", "-q"], { cwd: dir, env: env });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir, env: env });
}

function makeClient(name) {
  return { name: name, readyState: 1, switched: [] };
}

function makeHarness() {
  var home = tmp();
  var cwd = tmp();
  gitInit(cwd);
  var clients = [makeClient("c1"), makeClient("c2")];
  var sessions = new Map();
  var nextId = 1;
  var noop = function () {};

  function switchTo(id, targetWs) {
    var targets = targetWs ? [targetWs] : clients;
    targets.forEach(function (c) { c.switched.push(id); });
  }

  var ctx = {
    cwd: cwd,
    slug: "test-project",
    sm: {
      sessions: sessions,
      setResolveLoopInfo: noop,
      createSession: function (opts, targetWs) {
        var s = { localId: nextId++, history: [], loop: {}, isProcessing: false };
        sessions.set(s.localId, s);
        if (!(opts && opts.activate === false)) switchTo(s.localId, targetWs);
        return s;
      },
      switchSession: function (id, targetWs) { switchTo(id, targetWs); },
      saveSessionFile: noop,
      appendToSessionFile: noop,
      broadcastSessionList: noop,
      recordHistoryEntry: function (sess, obj) { sess.history.push(obj); },
    },
    sdk: { startQuery: noop },
    send: noop,
    sendTo: noop,
    sendToSession: noop,
    pushModule: null,
    notificationsModule: null,
    getHubSchedules: function () { return []; },
    getAllProjectSessions: function () { return []; },
    getStatus: noop,
    getLinuxUserForSession: function () { return null; },
    onProcessingChanged: noop,
    hydrateImageRefs: noop,
  };

  ["../lib/config", "../lib/utils", "../lib/store", "../lib/scheduler", "../lib/project-loop", "../lib/loop-handoff"]
    .forEach(function (m) { delete require.cache[require.resolve(m)]; });
  var orig = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = home;
  var engine;
  try {
    engine = require("../lib/project-loop").attachLoop(ctx);
  } finally {
    if (orig === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = orig;
  }
  engine.stopTimer();

  var dir = path.join(cwd, ".claude", "loops", "loop_tabs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "PROMPT.md"), "Do the task.");
  fs.writeFileSync(path.join(dir, "JUDGE.md"), "Judge it.");
  fs.writeFileSync(path.join(dir, "LOOP.json"), JSON.stringify({ maxIterations: 3 }));
  engine.loopState.loopId = "loop_tabs";
  engine.loopState.loopFilesId = "loop_tabs";
  engine.loopState.wizardData = { loopMode: "judge" };

  return {
    engine: engine, ctx: ctx, c1: clients[0], c2: clients[1],
    cleanup: function () {
      engine.stopClaudeDirWatch();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

// Completes the running iteration so the judge session is created.
function completeIteration(h) {
  var ls = h.engine.loopState;
  var iter = h.ctx.sm.sessions.get(ls.currentSessionId);
  assert.ok(iter, "iteration session exists");
  iter.history.push({ type: "done", code: 0 });
  iter.onQueryComplete(iter);
  assert.ok(ls.judgeSessionId, "judge session exists");
}

// The loop arms real watchdog timers; clear every one so the test process exits.
function withHarness(fn) {
  var origSetTimeout = global.setTimeout;
  var armed = [];
  global.setTimeout = function (f, d) {
    var t = origSetTimeout(f, d);
    armed.push(t);
    return t;
  };
  var h;
  try {
    h = makeHarness();
    fn(h);
  } finally {
    global.setTimeout = origSetTimeout;
    armed.forEach(function (t) { clearTimeout(t); });
    if (h) h.cleanup();
  }
}

test("a scheduled trigger runs an iteration and a judge and no client switches", function () {
  withHarness(function (h) {
    h.engine.startLoop({ maxIterations: 3, name: "nightly" });
    completeIteration(h);
    assert.ok(h.ctx.sm.sessions.size >= 2, "iteration and judge sessions were created");
    assert.deepEqual(h.c1.switched, []);
    assert.deepEqual(h.c2.switched, []);
  });
});

test("wizard draft crafting switches only the requesting client, once", function () {
  withHarness(function (h) {
    h.engine.handleLoopMessage(h.c1, {
      type: "ralph_wizard_complete",
      data: { name: "n", task: "t", loopMode: "simple", mode: "draft" },
    });
    assert.equal(h.c1.switched.length, 1, "requesting client switched exactly once");
    assert.deepEqual(h.c2.switched, []);
  });
});

test("wizard judge crafting switches only the requesting client, once", function () {
  withHarness(function (h) {
    h.engine.handleLoopMessage(h.c1, {
      type: "ralph_wizard_complete",
      data: { name: "n", task: "t", loopMode: "judge", mode: "own", promptText: "p", source: "ralph" },
    });
    assert.equal(h.c1.switched.length, 1);
    assert.deepEqual(h.c2.switched, []);
  });
});

test("loop_start from client 1 switches client 1 for the iteration and the judge, never client 2", function () {
  withHarness(function (h) {
    h.engine.handleLoopMessage(h.c1, { type: "loop_start", maxIterations: 3 });
    completeIteration(h);
    assert.equal(h.c1.switched.length, 2, "iteration then judge");
    assert.deepEqual(h.c2.switched, []);
  });
});

test("loop_start from client 1 then client 1 disconnects: later sessions switch nobody", function () {
  withHarness(function (h) {
    h.engine.handleLoopMessage(h.c1, { type: "loop_start", maxIterations: 3 });
    assert.equal(h.c1.switched.length, 1, "first iteration followed the starter");
    h.c1.readyState = 3;
    completeIteration(h);
    assert.equal(h.c1.switched.length, 1, "no switch after the starter closed");
    assert.deepEqual(h.c2.switched, []);
  });
});
