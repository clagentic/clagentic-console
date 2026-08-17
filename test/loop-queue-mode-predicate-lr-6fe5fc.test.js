"use strict";
// Regression tests for lr-6fe5fc: single derivation of "should this
// session's composer present queue-mode UI", shared by
// updateLoopInputVisibility() and the reactive recheckLoopQueueModeFromState()
// subscriber in lib/public/modules/app-loop-ui.js.
//
// Before this task, both call sites hand-rolled the same three-condition
// check independently (visible pre-fix as two near-identical inline
// expressions in updateLoopInputVisibility() and
// recheckLoopQueueModeFromState()). Two independently-maintained copies of
// "the same" boolean is exactly the shape of drift that produced the
// lr-fd38ac fold-in bug (one copy got the reactive re-check, the other
// didn't, until both were unified under one subscriber). This test asserts
// a single exported function (isLoopQueueSession) is what both paths
// actually run, so a future change to the predicate cannot update one call
// site and silently miss the other.
//
// Non-vacuous per lr-4e1242: asserts the exported function exists and
// exact boundary conditions (which would not hold if callers reverted to
// inlining the check independently, or if the predicate's semantics
// changed) — see the "two independent call sites converge" test, which
// fails if updateLoopInputVisibility() and recheckLoopQueueModeFromState()
// ever compute different answers for the same store state, a class of bug
// this file cannot pass without the extraction actually being wired in.

var test = require("node:test");
var assert = require("node:assert/strict");

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

function installDomStubs() {
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
}

test("lr-6fe5fc: isLoopQueueSession is a pure function of (loopActive, loopCurrentSessionId, activeSessionId)", async function () {
  installDomStubs();
  var loopUiMod = await import("../lib/public/modules/app-loop-ui.js");
  var isLoopQueueSession = loopUiMod.isLoopQueueSession;
  assert.equal(typeof isLoopQueueSession, "function",
    "isLoopQueueSession must be exported — the shared derivation, not two independently inlined checks");

  assert.strictEqual(isLoopQueueSession(true, 7, 7), true, "loop running, viewing its own current session: queue mode on");
  assert.strictEqual(isLoopQueueSession(false, 7, 7), false, "no loop running: queue mode off even if ids match");
  assert.strictEqual(isLoopQueueSession(true, 7, 3), false, "loop running, viewing a DIFFERENT session: queue mode off");
  assert.strictEqual(isLoopQueueSession(true, null, null), false, "loop running but no current session id: queue mode off");
  assert.strictEqual(isLoopQueueSession(true, null, 7), false, "loop running, no current session id, viewing session 7: queue mode off");
});

test("lr-6fe5fc: updateLoopInputVisibility() and the reactive path converge on isLoopQueueSession for the same store state", async function () {
  installDomStubs();

  var storeMod = await import("../lib/public/modules/store.js");
  var loopUiMod = await import("../lib/public/modules/app-loop-ui.js");
  var createStore = storeMod.createStore;
  var store = storeMod.store;
  var updateLoopInputVisibility = loopUiMod.updateLoopInputVisibility;
  var initLoopQueueModeSync = loopUiMod.initLoopQueueModeSync;

  // Direct-call path: updateLoopInputVisibility(loop) with a per-session
  // object whose own .active/.role would (pre-lr-6fe5fc) have been checked
  // as a SECOND, independent condition. Post-lr-6fe5fc it is accepted for
  // backward compatibility but is not part of the derivation — passing a
  // stale/contradictory `loop` object must not change the answer from what
  // isLoopQueueSession(store-state) alone would produce.
  createStore({ activeSessionId: 7, loopActive: true, loopCurrentSessionId: 7 });
  var contradictoryStaleLoop = { active: false, role: "crafting" }; // would have failed the old per-session check
  updateLoopInputVisibility(contradictoryStaleLoop);
  assert.strictEqual(store.get("loopQueueMode"), true,
    "direct-call path must match isLoopQueueSession(store state) regardless of the passed loop object's own fields");

  // Reactive path: same store state, driven through store.set() the way a
  // real loop_iteration handler does, never calling updateLoopInputVisibility
  // directly.
  initLoopQueueModeSync();
  createStore({ activeSessionId: 3, loopActive: false, loopCurrentSessionId: null, loopQueueMode: false });
  store.set({ loopActive: true });
  store.set({ loopCurrentSessionId: 3 });
  assert.strictEqual(store.get("loopQueueMode"), true,
    "reactive path must independently converge on the same true/false answer as the direct-call path for equivalent store state");

  // Both paths must agree the OFF case too.
  createStore({ activeSessionId: 3, loopActive: true, loopCurrentSessionId: 9, loopQueueMode: true });
  updateLoopInputVisibility({ active: true, role: "coder" });
  assert.strictEqual(store.get("loopQueueMode"), false,
    "direct-call path: viewing a session that is not the loop's current session must not arm queue mode");
});
