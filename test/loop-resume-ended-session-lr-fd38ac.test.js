"use strict";
// Regression tests for lr-fd38ac: a finished loop session could not be
// resumed. A stale per-session `loop.active` marker re-armed client-side
// loop "queue mode" for a session whose loop had already ended, so a normal
// send was misrouted into `loop_message` — which the server correctly
// rejects ("No loop is currently running"). Two independent bugs, both
// covered here so neither alone can pass the file:
//
//   1. Server (lib/project-loop.js finishLoop()): only the LAST coder
//      session's `loop.active` was cleared, and the clear was never
//      persisted via sm.saveSessionFile() — so every judge session and
//      every prior iteration's coder session stayed active:true forever,
//      and even the one session that WAS cleared reverted to active:true
//      across a daemon restart (sessions.js rehydrates session.loop
//      straight off the persisted meta line).
//   2. Client (lib/public/modules/app-loop-ui.js updateLoopInputVisibility):
//      queue mode was armed from the per-session marker alone, never
//      cross-checked against whether a loop is actually running globally.
//
// Fixing only #1 without #2 still leaves a resumability gap on any client
// that missed the loop_finished broadcast (e.g. a reconnect). Fixing only
// #2 without #1 leaves every non-last, non-persisted session's on-disk
// marker permanently wrong (an audit/inspection correctness bug, and the
// only thing standing between a future client-side regression and this
// exact class of bug re-appearing). Both parts are exercised below.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-loop-resume-"));
}

/**
 * Build the minimal ctx that attachLoop needs. Mirrors the harness used by
 * test/project-loop-message-lr-e31b.test.js and
 * test/project-loop-stop-race-lr-e823.test.js, with one addition: a real
 * saveSessionFile spy so tests can assert the fix's "persist the clear"
 * requirement, not just the in-memory mutation.
 */
function makeCtx(cwd) {
  var noop = function () {};
  var sent = [];
  var sessions = new Map();
  var savedSessionIds = [];
  var nextLocalId = 1;

  var ctx = {
    cwd: cwd,
    slug: "test-project",
    sm: {
      sessions: sessions,
      setResolveLoopInfo: noop,
      createSession: function () {
        var s = { localId: nextLocalId++, history: [], loop: {}, isProcessing: false };
        sessions.set(s.localId, s);
        return s;
      },
      saveSessionFile: function (session) {
        savedSessionIds.push(session.localId);
      },
      appendToSessionFile: noop,
      broadcastSessionList: noop,
      recordHistoryEntry: function (sess, obj) { sess.history.push(obj); },
    },
    sdk: { startQuery: noop },
    send: function (msg) { sent.push(msg); },
    sendTo: function (ws, msg) { sent.push(msg); },
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
  ctx._sent = sent;
  ctx._savedSessionIds = savedSessionIds;
  return ctx;
}

function makeEngine(cwd) {
  var tmpHome = makeTempHome();

  ["../lib/config", "../lib/utils", "../lib/store", "../lib/scheduler", "../lib/project-loop", "../lib/loop-handoff"]
    .forEach(function (m) {
      try { delete require.cache[require.resolve(m)]; } catch (_) {}
    });

  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var engine, ctx;
  try {
    var { attachLoop } = require("../lib/project-loop");
    ctx = makeCtx(cwd || tmpHome);
    engine = attachLoop(ctx);
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }

  engine.stopTimer();

  function cleanup() {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }

  return { engine: engine, ctx: ctx, cleanup: cleanup };
}

/**
 * Drive finishLoop() the same way test/project-loop-stop-race-lr-e823.test.js
 * and test/project-loop-message-lr-e31b.test.js do: finishLoop is not
 * directly exported, but stopLoop()'s 5s fallback timer calls it, and that
 * timer can be captured and invoked synchronously.
 */
function triggerFinishLoop(engine) {
  var capturedCallback = null;
  var origSetTimeout = global.setTimeout;
  global.setTimeout = function (fn, delay) {
    if (delay === 5000) { capturedCallback = fn; return 0; }
    return origSetTimeout(fn, delay);
  };
  try {
    engine.stopLoop();
  } finally {
    global.setTimeout = origSetTimeout;
  }
  assert.ok(capturedCallback, "stopLoop() should schedule a fallback timer");
  capturedCallback(); // invokes finishLoop("stopped") — seq/stopping unchanged
}

// ---------------------------------------------------------------------------
// Part 1 (server): finishLoop() must clear loop.active on every session that
// belongs to the loop — coder AND judge, every iteration — and persist each
// clear via sm.saveSessionFile(), not just the last coder session in memory.
// ---------------------------------------------------------------------------

test("lr-fd38ac: finishLoop() clears loop.active on judge sessions and prior-iteration coder sessions, not just the last coder", function () {
  var cwd = makeTempHome();
  var { engine, ctx, cleanup } = makeEngine(cwd);
  try {
    var ls = engine.loopState;
    var loopId = "loop_test_fd38ac";
    ls.loopId = loopId;

    // Simulate a completed judge-mode run: iteration 1's coder + judge both
    // finished (judge session created after coder, both left active:true by
    // the pre-fix code — only the CURRENT session at finish time was ever
    // touched). Iteration 2's coder is the "last" / current session.
    var coder1 = ctx.sm.createSession();
    coder1.loop = { active: true, iteration: 1, role: "coder", loopId: loopId };
    var judge1 = ctx.sm.createSession();
    judge1.loop = { active: true, iteration: 1, role: "judge", loopId: loopId };
    var coder2 = ctx.sm.createSession();
    coder2.loop = { active: true, iteration: 2, role: "coder", loopId: loopId };

    // A session from an unrelated loop must be left untouched.
    var otherLoopSession = ctx.sm.createSession();
    otherLoopSession.loop = { active: true, iteration: 1, role: "coder", loopId: "loop_other" };

    ls.active = true;
    ls.stopping = false;
    ls.iteration = 2;
    ls.maxIterations = 5;
    ls.currentSessionId = coder2.localId; // "last coder session" — the only one the pre-fix code touched
    ls.judgeSessionId = judge1.localId;

    triggerFinishLoop(engine);

    assert.strictEqual(coder1.loop.active, false,
      "prior-iteration coder session must be unlocked, not just the last coder session");
    assert.strictEqual(judge1.loop.active, false,
      "judge session must be unlocked — pre-fix code never touched judge sessions at all");
    assert.strictEqual(coder2.loop.active, false,
      "last coder session must still be unlocked (pre-fix behavior, must not regress)");
    assert.strictEqual(otherLoopSession.loop.active, true,
      "a session belonging to a DIFFERENT loop must not be touched");

    // The clear must be persisted, not merely mutated in memory — a
    // daemon restart rehydrates session.loop straight from the on-disk
    // meta line (sessions.js), so an unsaved clear reverts on restart.
    assert.ok(ctx._savedSessionIds.indexOf(coder1.localId) !== -1,
      "prior-iteration coder session's cleared marker must be persisted via saveSessionFile");
    assert.ok(ctx._savedSessionIds.indexOf(judge1.localId) !== -1,
      "judge session's cleared marker must be persisted via saveSessionFile");
    assert.ok(ctx._savedSessionIds.indexOf(coder2.localId) !== -1,
      "last coder session's cleared marker must be persisted via saveSessionFile");
    assert.ok(ctx._savedSessionIds.indexOf(otherLoopSession.localId) === -1,
      "an unrelated loop's session must never be saved by this finish");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// Part 2 (client): updateLoopInputVisibility() must not re-arm queue mode
// from a stale per-session marker alone — it must also require a loop to
// actually be running globally (store.loopActive) AND that the loop's
// current session is the one being viewed. This is what makes reading a
// STALE on-disk session.loop safe even before finishLoop's persistence fix
// takes effect on already-existing data (no migration required), and what
// covers a client that reconnects after missing a loop_finished broadcast.
// ---------------------------------------------------------------------------

function makeFakeElement() {
  var el = {
    style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    appendChild: function (c) { return c; },
    removeChild: function () {},
    setAttribute: function () {},
    getAttribute: function () { return null; },
    addEventListener: function () {},
    removeEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { width: 0, height: 0, top: 0, left: 0 }; },
    textContent: "",
    innerHTML: "",
    dataset: {},
    removeAttribute: function () {},
    closest: function () { return null; },
  };
  return el;
}

test("lr-fd38ac (client gate): switching into a finished loop session after a daemon restart must not re-arm queue mode", async function () {
  var inputAreaEl = makeFakeElement();
  var inputEl = makeFakeElement();
  inputEl.placeholder = "Message Claude Code...";
  var elementsById = { "input-area": inputAreaEl, "input": inputEl };

  global.document = {
    addEventListener: function () {},
    removeEventListener: function () {},
    createElement: function () { return makeFakeElement(); },
    getElementById: function (id) { return elementsById[id] || makeFakeElement(); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    body: makeFakeElement(),
  };
  global.window = { innerWidth: 1024, innerHeight: 768, addEventListener: function () {}, removeEventListener: function () {} };
  global.lucide = { createIcons: function () {} };
  global.requestAnimationFrame = function (fn) { return 0; };
  global.cancelAnimationFrame = function () {};
  global.localStorage = {
    _data: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
    setItem: function (k, v) { this._data[k] = String(v); },
    removeItem: function (k) { delete this._data[k]; },
  };
  global.marked = { use: function () {}, parse: function (s) { return s; }, setOptions: function () {} };
  global.mermaid = { initialize: function () {}, render: function () { return Promise.resolve({ svg: "" }); } };
  global.DOMPurify = { sanitize: function (s) { return s; } };
  global.fetch = function () { return Promise.resolve({ json: function () { return Promise.resolve({}); } }); };

  var storeMod = await import("../lib/public/modules/store.js");
  var loopUiMod = await import("../lib/public/modules/app-loop-ui.js");
  var createStore = storeMod.createStore;
  var store = storeMod.store;
  var updateLoopInputVisibility = loopUiMod.updateLoopInputVisibility;

  // Scenario: daemon restart. No loop is running anywhere in the project
  // (loopActive: false, as loop_available/loop_finished would report on
  // reconnect), but the session being switched into still carries the
  // stale on-disk marker from before the daemon restart — exactly the
  // rehydration bug in sessions.js (m.loop restored verbatim, never
  // re-validated) prior to the finishLoop persistence fix, and exactly
  // what remains possible on old data even after that fix ships.
  createStore({ activeSessionId: null, loopActive: false, loopCurrentSessionId: null });

  var staleSessionLoop = { active: true, role: "coder", loopId: "loop_old" };
  createStore(Object.assign({}, store.snap(), { activeSessionId: 42 }));
  updateLoopInputVisibility(staleSessionLoop);

  assert.strictEqual(store.get("loopQueueMode"), false,
    "a finished loop session's stale active:true marker must not re-arm queue mode when no loop is globally running");

  // Contrast case: an ACTUAL running loop, viewing its own current session
  // — queue mode must still arm correctly (the fix must not break the
  // legitimate case, only the stale one).
  createStore({ activeSessionId: 7, loopActive: true, loopCurrentSessionId: 7 });
  var liveSessionLoop = { active: true, role: "coder", loopId: "loop_live" };
  updateLoopInputVisibility(liveSessionLoop);
  assert.strictEqual(store.get("loopQueueMode"), true,
    "a genuinely running loop's own current session must still arm queue mode");

  // Contrast case: loop is running, but the VIEWED session is a different,
  // already-finished session from the same or another loop (its own
  // active:true is stale relative to the currently running iteration).
  createStore({ activeSessionId: 3, loopActive: true, loopCurrentSessionId: 7 });
  var otherStaleLoop = { active: true, role: "coder", loopId: "loop_live" };
  updateLoopInputVisibility(otherStaleLoop);
  assert.strictEqual(store.get("loopQueueMode"), false,
    "a session that is not the loop's current session must not arm queue mode even while a loop is running elsewhere");
});

// ---------------------------------------------------------------------------
// Part 2 follow-up (PEACHES-blocking on the initial Part 2 fix): a
// re-evaluation bug in the new global-state dependency. loop_started and
// loop_iteration (app-messages.js) write loopActive/loopCurrentSessionId
// directly via store.set() — they do not call updateLoopInputVisibility()
// themselves. Before this follow-up, nothing re-ran the gate when those
// fields changed, so a client already viewing the session that becomes the
// loop's own current session (e.g. it started the loop from that session)
// was stuck with a stale loopQueueMode: false even once every gate
// condition became true — silently dropping a message instead of queuing
// it, the inverse of the original lr-fd38ac bug.
//
// This test drives the exact state transition loop_iteration performs
// (plain store.set() calls on loopIteration/loopMaxIterations/
// loopCurrentSessionId, and loopActive from loop_started) — never calling
// updateLoopInputVisibility() directly — and asserts loopQueueMode follows
// automatically via app-loop-ui.js's reactive store.subscribe().
test("lr-fd38ac follow-up: loopQueueMode re-arms via reactive subscription when loop_started/loop_iteration set loopActive/loopCurrentSessionId, without a direct updateLoopInputVisibility() call", async function () {
  var inputAreaEl = makeFakeElement();
  var inputEl = makeFakeElement();
  inputEl.placeholder = "Message Claude Code...";
  var elementsById = { "input-area": inputAreaEl, "input": inputEl };

  global.document = {
    addEventListener: function () {},
    removeEventListener: function () {},
    createElement: function () { return makeFakeElement(); },
    getElementById: function (id) { return elementsById[id] || makeFakeElement(); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    body: makeFakeElement(),
  };
  global.window = { innerWidth: 1024, innerHeight: 768, addEventListener: function () {}, removeEventListener: function () {} };
  global.lucide = { createIcons: function () {} };
  global.requestAnimationFrame = function () { return 0; };
  global.cancelAnimationFrame = function () {};
  global.localStorage = {
    _data: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
    setItem: function (k, v) { this._data[k] = String(v); },
    removeItem: function (k) { delete this._data[k]; },
  };
  global.marked = { use: function () {}, parse: function (s) { return s; }, setOptions: function () {} };
  global.mermaid = { initialize: function () {}, render: function () { return Promise.resolve({ svg: "" }); } };
  global.DOMPurify = { sanitize: function (s) { return s; } };
  global.fetch = function () { return Promise.resolve({ json: function () { return Promise.resolve({}); } }); };

  var storeMod = await import("../lib/public/modules/store.js");
  var loopUiMod = await import("../lib/public/modules/app-loop-ui.js");
  var createStore = storeMod.createStore;
  var store = storeMod.store;

  // Install the reactive subscription under test — initLoopUi() calls this
  // as part of real app boot; installing it directly here avoids pulling
  // in initLoopUi()'s unrelated DOM-rendering subscriber (loop banner/
  // button), which this test has no reason to exercise. Must run before
  // any store.set() calls below for the subscription to see them.
  loopUiMod.initLoopQueueModeSync();

  // Scenario: the human is already viewing session 7 (e.g. they started
  // the loop from this exact session — session_switched already ran for
  // it earlier with loopActive still false, so the gate evaluated false
  // and armed nothing) when the loop actually starts and its first
  // iteration lands on this same session id.
  createStore({ activeSessionId: 7, loopActive: false, loopCurrentSessionId: null, loopQueueMode: false });

  // loop_started: sets loopActive true. Does not touch loopCurrentSessionId
  // or activeSessionId, so the gate must NOT arm yet (no loop session is
  // confirmed as "this one" until loop_iteration below).
  store.set({ loopActive: true, ralphPhase: "executing", loopIteration: 0, loopMaxIterations: 20, loopBannerName: "Test Loop" });
  assert.strictEqual(store.get("loopQueueMode"), false,
    "loop_started alone (loopCurrentSessionId still null) must not arm queue mode");

  // loop_iteration: sets loopCurrentSessionId to the loop's new session —
  // here, the same session (7) already being viewed. This is a plain
  // store.set(), exactly mirroring app-messages.js's loop_iteration
  // handler; updateLoopInputVisibility() is never called directly by this
  // test. All four gate conditions are now true.
  store.set({ loopIteration: 1, loopMaxIterations: 20, loopCurrentSessionId: 7 });

  assert.strictEqual(store.get("loopQueueMode"), true,
    "loopQueueMode must re-arm reactively once loopActive/loopCurrentSessionId/activeSessionId all line up, " +
    "even though nothing called updateLoopInputVisibility() directly for this transition");

  // Inverse: an ENDED loop session must still not re-arm queue mode
  // through this same reactive path. loop_finished sets loopActive:false
  // and loopCurrentSessionId:null in the same store.set() (see
  // app-messages.js) — assert the reactive subscriber tracks that too.
  store.set({ loopActive: false, ralphPhase: "done", loopBannerName: null, loopCurrentSessionId: null });
  assert.strictEqual(store.get("loopQueueMode"), false,
    "an ended loop must not leave queue mode re-armed via the reactive path");

  // Further inverse: loopCurrentSessionId pointing at a DIFFERENT loop
  // session than the one being viewed must not arm queue mode, even while
  // a loop is genuinely running (mirrors the direct-call contrast case
  // above, exercised here through the reactive path instead).
  createStore({ activeSessionId: 3, loopActive: false, loopCurrentSessionId: null, loopQueueMode: false });
  store.set({ loopActive: true });
  store.set({ loopCurrentSessionId: 7 });
  assert.strictEqual(store.get("loopQueueMode"), false,
    "a running loop whose current session is not the one being viewed must not arm queue mode reactively");
});

test("lr-fd38ac (client gate): judge session with a stale active marker after daemon restart is also resumable", async function () {
  var inputAreaEl = makeFakeElement();
  var inputEl = makeFakeElement();
  inputEl.placeholder = "Message Claude Code...";
  var elementsById = { "input-area": inputAreaEl, "input": inputEl };

  global.document = {
    addEventListener: function () {},
    removeEventListener: function () {},
    createElement: function () { return makeFakeElement(); },
    getElementById: function (id) { return elementsById[id] || makeFakeElement(); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    body: makeFakeElement(),
  };
  global.window = { innerWidth: 1024, innerHeight: 768, addEventListener: function () {}, removeEventListener: function () {} };
  global.lucide = { createIcons: function () {} };
  global.requestAnimationFrame = function () { return 0; };
  global.cancelAnimationFrame = function () {};
  global.localStorage = {
    _data: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
    setItem: function (k, v) { this._data[k] = String(v); },
    removeItem: function (k) { delete this._data[k]; },
  };
  global.marked = { use: function () {}, parse: function (s) { return s; }, setOptions: function () {} };
  global.mermaid = { initialize: function () {}, render: function () { return Promise.resolve({ svg: "" }); } };
  global.DOMPurify = { sanitize: function (s) { return s; } };
  global.fetch = function () { return Promise.resolve({ json: function () { return Promise.resolve({}); } }); };

  var storeMod = await import("../lib/public/modules/store.js");
  var loopUiMod = await import("../lib/public/modules/app-loop-ui.js");
  var createStore = storeMod.createStore;
  var store = storeMod.store;
  var updateLoopInputVisibility = loopUiMod.updateLoopInputVisibility;

  // A judge session (role: "judge") left over with a stale active:true
  // marker (finishLoop pre-fix never even attempted to clear judge
  // sessions — this is the second half of the diagnosis's "orphaned
  // forever" class, distinct from the coder-only persistence gap).
  createStore({ activeSessionId: 99, loopActive: false, loopCurrentSessionId: null });
  var staleJudgeLoop = { active: true, role: "judge", loopId: "loop_old" };
  updateLoopInputVisibility(staleJudgeLoop);

  assert.strictEqual(store.get("loopQueueMode"), false,
    "a finished judge session's stale active:true marker must not re-arm queue mode");
});
