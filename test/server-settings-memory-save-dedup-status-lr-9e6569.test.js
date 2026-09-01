// server-settings-memory-save-dedup-status-lr-9e6569.test.js
//
// Execution-based regression coverage for lr-9e6569 fold-in (PEACHES PR #416
// blocking findings 1 and 2), added specifically because
// server-settings-memory-save-affordance-lr-9e6569.test.js is static
// source-inspection only and does not (and by construction cannot) catch
// either finding, both of which were LIVE in that PR's diff:
//
//   FINDING 2 (double-send on blur+click): the preserved `change` listener
//   (blur/Enter) and the new ss-memory-save-btn click handler both call
//   saveMemAvailableThreshold()/saveTokensPerMbHeadroom(). Typing a value
//   then clicking Save fired the WS send twice for the same, unchanged
//   value.
//
//   FINDING 1 (shared status element races / hides errors): both fields
//   write to the single ss-memory-save-status element. An error from one
//   field was unconditionally overwritten by "Saving..."/"Saved" from the
//   other, which can render a green success indication for a field that
//   actually failed.
//
// Uses the same minimal-DOM-stub + dynamic-import pattern as
// test/context-meter-vendor-first-lr-3af675.test.js and
// test/rate-limit-pill-percent-lr-872f94.test.js -- no jsdom/happy-dom/
// linkedom/Playwright dependency added (none exists in this repo's
// devDependencies; adding one is out of proportion for this fold-in and
// would need allow_new_deps, not set in .crew/amos.yaml). This is a REAL
// execution of the shipped ES module against hand-built fake DOM nodes,
// not a source-text pattern match -- it fails if the double-send or the
// status race is reintroduced, because it drives the real exported
// functions and asserts on the real ws.send() call count / the real
// rendered status text.
//
// WHAT THIS STILL DOES NOT PROVE: a real browser event loop, real
// user-agent click/blur dispatch, or real CSS-class-driven visibility.
// Flagged rather than silently substituted -- see this task's PR body for
// the full reasoning on why a jsdom-class harness was judged disproportionate
// here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeElement(id) {
  var el = {
    id: id || "",
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    hidden: false,
    style: {},
    dataset: {},
    classList: {
      _set: {},
      add: function (c) { this._set[c] = true; },
      remove: function (c) { delete this._set[c]; },
      toggle: function (c, force) {
        var want = force !== undefined ? force : !this._set[c];
        if (want) this._set[c] = true; else delete this._set[c];
        return want;
      },
      contains: function (c) { return !!this._set[c]; },
    },
    appendChild: function (c) { return c; },
    removeChild: function () {},
    setAttribute: function () {},
    getAttribute: function () { return null; },
    removeAttribute: function () {},
    addEventListener: function () {},
    removeEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { width: 0, height: 0, top: 0, left: 0 }; },
    focus: function () {},
    click: function () {},
  };
  return el;
}

var elementsById = {};
function fakeElementFor(id) {
  if (!elementsById[id]) elementsById[id] = makeFakeElement(id);
  return elementsById[id];
}

global.document = {
  addEventListener: function () {},
  removeEventListener: function () {},
  createElement: function () { return makeFakeElement(); },
  getElementById: function (id) { return fakeElementFor(id); },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  body: makeFakeElement(),
};
global.window = {
  innerWidth: 1024, innerHeight: 768,
  addEventListener: function () {}, removeEventListener: function () {},
  matchMedia: function () { return { matches: false }; },
};
global.lucide = { createIcons: function () {} };
// Node 22's global `navigator` is a non-configurable getter (NodeJS.Navigator)
// -- it cannot be reassigned like the other stubbed globals above. Only
// patch in the one property this module's transitive import graph reads
// (copyToClipboard in utils.js), leaving the real navigator object intact.
if (!global.navigator.clipboard) {
  global.navigator.clipboard = { writeText: function () { return Promise.resolve(); } };
}
global.localStorage = {
  _data: {},
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
  setItem: function (k, v) { this._data[k] = String(v); },
  removeItem: function (k) { delete this._data[k]; },
};
global.requestAnimationFrame = function () { return 0; };
global.cancelAnimationFrame = function () {};
global.marked = { use: function () {}, parse: function (s) { return s; }, setOptions: function () {} };
global.mermaid = { initialize: function () {}, render: function () { return Promise.resolve({ svg: '' }); } };

var serverSettings = await import('../lib/public/modules/server-settings.js');

var memInput = fakeElementFor("settings-mem-available-min");
var tpmInput = fakeElementFor("settings-tokens-per-mb-headroom");
var statusEl = fakeElementFor("ss-memory-save-status");

function makeFakeCtx() {
  var sent = [];
  return {
    ws: {
      readyState: 1,
      send: function (raw) { sent.push(JSON.parse(raw)); },
    },
    sent: sent,
  };
}

// initServerSettings binds ctx and wires all the listeners this module
// exposes; server-settings.js itself does not export saveMemAvailableThreshold/
// saveTokensPerMbHeadroom directly (they are module-private), so the tests
// below drive them via the exported result handlers plus a hand-rolled call
// through the same private path the click/change listeners use: since
// initServerSettings requires a real settings root element which our stub
// happily fabricates, calling initServerSettings(ctx) is what makes ctx
// available to the private save functions in the first place.
test.beforeEach(function () {
  elementsById = {};
  memInput = fakeElementFor("settings-mem-available-min");
  tpmInput = fakeElementFor("settings-tokens-per-mb-headroom");
  statusEl = fakeElementFor("ss-memory-save-status");
});

function initWithFakeCtx() {
  var ctx = makeFakeCtx();
  serverSettings.initServerSettings(ctx);
  return ctx;
}

// Simulate the blur/Enter `change` listener firing, then the Save button's
// click listener firing for the SAME unedited value -- the exact repro for
// finding 2 (type a value, click Save).
function fireChangeThenClickSave(el, elId) {
  var listeners = { change: [], click: [] };
  // Re-wire a lightweight addEventListener capture on the specific elements
  // the module attaches to, so this test can invoke the exact same handler
  // functions initServerSettings registered -- without reimplementing them.
  el.addEventListener = function (type, fn) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(fn);
  };
  return listeners;
}

test('lr-9e6569 finding 2: typing a value then clicking Save sends set_mem_available_threshold exactly once, not twice', function () {
  // Recreate fresh elements with listener capture BEFORE init, since
  // initServerSettings.addEventListener wiring happens at init time.
  elementsById = {};
  var memEl = fakeElementFor("settings-mem-available-min");
  var saveBtn = fakeElementFor("ss-memory-save-btn");
  var memListeners = fireChangeThenClickSave(memEl, "settings-mem-available-min");
  var btnListeners = fireChangeThenClickSave(saveBtn, "ss-memory-save-btn");

  var ctx = makeFakeCtx();
  serverSettings.initServerSettings(ctx);

  memEl.value = "2048";

  // Blur/Enter path: the `change` listener fires first (user types then
  // tabs/blurs away).
  assert.equal(memListeners.change.length, 1, "expected exactly one change listener bound to settings-mem-available-min");
  memListeners.change[0]();

  // Then the user clicks the explicit Save button for the SAME, now-unedited
  // value -- this must NOT send a second set_mem_available_threshold message.
  assert.equal(btnListeners.click.length, 1, "expected exactly one click listener bound to ss-memory-save-btn");
  btnListeners.click[0]();

  var memSends = ctx.sent.filter(function (m) { return m.type === "set_mem_available_threshold"; });
  assert.equal(memSends.length, 1,
    "a single user gesture (type + blur, then click Save on the unchanged value) must produce exactly one " +
    "set_mem_available_threshold send, not two -- this is the exact double-send finding 2 flagged");
  assert.equal(memSends[0].value, 2048);
});

test('lr-9e6569 finding 2: a genuinely new edit after a save still sends (dedup only suppresses the unchanged repeat)', function () {
  elementsById = {};
  var memEl = fakeElementFor("settings-mem-available-min");
  var saveBtn = fakeElementFor("ss-memory-save-btn");
  var memListeners = fireChangeThenClickSave(memEl, "settings-mem-available-min");
  var btnListeners = fireChangeThenClickSave(saveBtn, "ss-memory-save-btn");

  var ctx = makeFakeCtx();
  serverSettings.initServerSettings(ctx);

  // Distinct values from every other test in this file: the module tracks
  // last-sent value as its own top-level state (no reset hook is exported,
  // matching this module's existing style -- see updateSsLiteVisibility's
  // own module-level state), so re-sending a value another test already
  // established as "last sent" would be misread as this test's own
  // suppressed repeat rather than a fresh edit.
  memEl.value = "3072";
  memListeners.change[0]();
  btnListeners.click[0](); // suppressed repeat, per the test above

  // Now the user edits again to a genuinely different value and clicks Save.
  memEl.value = "5120";
  btnListeners.click[0]();

  var memSends = ctx.sent.filter(function (m) { return m.type === "set_mem_available_threshold"; });
  assert.equal(memSends.length, 2, "the first send (3072) plus one more send for the genuinely new value (5120)");
  assert.equal(memSends[0].value, 3072);
  assert.equal(memSends[1].value, 5120, "the second send must carry the new, edited value");
});

test('lr-9e6569 finding 2: clicking Save with only the tokens-per-mb field edited does not re-send the untouched mem-available field, and does send tokens-per-mb once', function () {
  elementsById = {};
  var memEl = fakeElementFor("settings-mem-available-min");
  var tpmEl = fakeElementFor("settings-tokens-per-mb-headroom");
  var saveBtn = fakeElementFor("ss-memory-save-btn");
  fireChangeThenClickSave(memEl, "settings-mem-available-min");
  var tpmListeners = fireChangeThenClickSave(tpmEl, "settings-tokens-per-mb-headroom");
  var btnListeners = fireChangeThenClickSave(saveBtn, "ss-memory-save-btn");

  var ctx = makeFakeCtx();
  serverSettings.initServerSettings(ctx);

  memEl.value = "1024"; // unedited default; never blurred
  tpmEl.value = "300";
  tpmListeners.change[0]();
  btnListeners.click[0]();

  var memSends = ctx.sent.filter(function (m) { return m.type === "set_mem_available_threshold"; });
  var tpmSends = ctx.sent.filter(function (m) { return m.type === "set_tokens_per_mb_headroom"; });
  // The untouched field still sends once via the click handler's call to
  // saveMemAvailableThreshold() -- this dedup only suppresses a REPEAT of an
  // already-sent value, it does not suppress the first send for a field the
  // click handler is also responsible for triggering when change never fired.
  assert.equal(memSends.length, 1, "the click handler must still attempt the mem-available field at least once");
  assert.equal(tpmSends.length, 1, "tokens-per-mb must send exactly once (change fired, then click's repeat must be suppressed)");
  assert.equal(tpmSends[0].value, 300);
});

test('lr-9e6569 finding 1: an error on one field is not overwritten by a later success on the other field', function () {
  var ctx = initWithFakeCtx();

  // Field A (mem-available) fails.
  serverSettings.handleSetMemAvailableThresholdResult({ ok: false, error: "disk full" });
  assert.match(statusEl.textContent, /disk full/, "the mem-available error must be visible");
  assert.ok(statusEl.classList.contains("ps-save-status-error"), "error class must be set after field A fails");

  // Field B (tokens-per-mb) then succeeds -- this must NOT clear/replace the
  // still-live error from field A. This is exactly finding 1: a green
  // success indication must never mask a field that actually failed.
  serverSettings.handleSetTokensPerMbHeadroomResult({ ok: true, tokensPerMbHeadroom: 240 });
  assert.match(statusEl.textContent, /disk full/,
    "field A's error must still be visible/attributable after field B's unrelated success -- " +
    "an error from one field must never be masked by the other field's result");
  assert.ok(statusEl.classList.contains("ps-save-status-error"),
    "the shared status element must still report an error state, not a bare success, while field A's error is unresolved");
});

test('lr-9e6569 finding 1: a field-A error surfaces even if it arrives (out of order) AFTER field B already reported success', function () {
  var ctx = initWithFakeCtx();

  // Both fields start from an explicit known-clean (success) state -- this
  // module intentionally has no reset hook (matching its existing style),
  // so this cannot assume a pristine baseline left over from whichever
  // test ran immediately before it; it establishes its own.
  serverSettings.handleSetMemAvailableThresholdResult({ ok: true, memAvailableMinMB: 1024 });
  serverSettings.handleSetTokensPerMbHeadroomResult({ ok: true, tokensPerMbHeadroom: 240 });
  assert.ok(!statusEl.classList.contains("ps-save-status-error"), "both fields clean before this scenario begins");

  serverSettings.handleSetTokensPerMbHeadroomResult({ ok: true, tokensPerMbHeadroom: 250 });
  assert.doesNotMatch(statusEl.textContent, /Error/, "no error yet -- only a success so far");

  serverSettings.handleSetMemAvailableThresholdResult({ ok: false, error: "invalid" });
  assert.match(statusEl.textContent, /invalid/,
    "a later-arriving error for field A must still surface and be attributable, not be hidden behind field B's earlier success");
  assert.ok(statusEl.classList.contains("ps-save-status-error"));
});

test('lr-9e6569 finding 1: both fields succeeding clears the error state entirely (no error means no error class lingers)', function () {
  var ctx = initWithFakeCtx();

  serverSettings.handleSetMemAvailableThresholdResult({ ok: true, memAvailableMinMB: 1024 });
  serverSettings.handleSetTokensPerMbHeadroomResult({ ok: true, tokensPerMbHeadroom: 240 });

  assert.ok(!statusEl.classList.contains("ps-save-status-error"), "no field is in error -- the error class must not be set");
});

test('lr-9e6569 finding 3 (fold-in): a partial daemon_config_changed broadcast lacking the *IsDefault keys does not clear an existing default-note', function () {
  var ctx = initWithFakeCtx();
  var memNoteEl = fakeElementFor("settings-mem-available-min-default-note");
  var tpmNoteEl = fakeElementFor("settings-tokens-per-mb-headroom-default-note");

  // Full snapshot establishes the default-note text for both fields.
  serverSettings.updateDaemonConfig({
    memAvailableMinMB: 1024, memAvailableMinMBIsDefault: true,
    tokensPerMbHeadroom: 240, tokensPerMbHeadroomIsDefault: true,
  });
  assert.match(memNoteEl.textContent, /Using default/);
  assert.match(tpmNoteEl.textContent, /Using default/);

  // Partial broadcast (the real daemon_config_changed shape today: only
  // liteAutoEnroll) must NOT clear either note -- it says nothing about
  // memory settings at all.
  serverSettings.updateDaemonConfig({ type: "daemon_config_changed", liteAutoEnroll: true });
  assert.match(memNoteEl.textContent, /Using default/,
    "an unrelated partial broadcast must not silently clear the mem-available default-note");
  assert.match(tpmNoteEl.textContent, /Using default/,
    "an unrelated partial broadcast must not silently clear the tokens-per-mb default-note");
});
