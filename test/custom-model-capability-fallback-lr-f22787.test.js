// Regression tests for lr-f22787 FINDING 3 — capability lookups for a model
// ID that is NOT present in the enumerated `currentModels` array. This can
// happen whenever `store.currentModel` is set from a source outside the
// vendor's live enumeration snapshot — e.g. a session restored from disk
// after the vendor's model list changed, a model set via
// ANTHROPIC_CUSTOM_MODEL_OPTION on the CLI side, or any other path where
// the persisted/selected model and the freshest `currentModels` array can
// briefly disagree.
//
// getModelSupportsEffort/getModelSupportsThinking/getModelEffortLevels
// (lib/public/modules/app-panels.js) each linear-scan `currentModels` for an
// entry whose `value` matches `currentModel`. Before this task, no test
// exercised the "no match at all" branch (as opposed to "matched, vendor
// didn't report a capability flag"). These tests pin that unmatched-model
// case explicitly: every one of these functions must fail OPEN (assume the
// control is available / use a sane vendor-generic default) rather than fail
// CLOSED (silently hide effort/thinking controls) for a model ID the current
// enumeration snapshot doesn't contain — confirmed by reading the source,
// not assumed.
//
// resolveContextWindow (also app-panels.js, delegating to the shared core in
// lib/public/modules/model-context-windows.js) is covered too: an unmatched
// model ID must fall back to the live SDK-reported window, then to the
// documented 200000 last resort — never a wrong/tiny hardcoded number.
//
// app-panels.js itself has no top-level `document.`/DOM access outside
// function bodies (only `var x = null` module state) — but its import graph
// transitively reaches lib/public/modules/tool-palette.js, which DOES call
// document.addEventListener(...) at module-eval time (line 346-349). A
// minimal global `document`/`window` stub (just enough surface for every
// module in that import chain to load without throwing) is installed before
// the dynamic import — no jsdom dependency added.

import { test } from 'node:test';
import assert from 'node:assert/strict';

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
  };
  return el;
}

global.document = {
  addEventListener: function () {},
  removeEventListener: function () {},
  createElement: function () { return makeFakeElement(); },
  getElementById: function () { return makeFakeElement(); },
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
// app-panels.js imports VENDOR_NAMES from app-rendering.js, which imports
// renderMarkdown from markdown.js — that module calls the CDN-vendored
// globals `marked.use(...)` and `mermaid.initialize(...)` at eval time (a
// fixed, small set of eval-time calls, not an open-ended chain — confirmed
// by reading markdown.js in full). Only those two calls are exercised at
// import time; no test here calls anything that actually renders
// markdown/diagrams.
global.marked = { use: function () {}, parse: function (s) { return s; }, setOptions: function () {} };
global.mermaid = { initialize: function () {}, render: function () { return Promise.resolve({ svg: '' }); } };

var appPanels = await import('../lib/public/modules/app-panels.js');
var storeMod = await import('../lib/public/modules/store.js');

var getModelSupportsEffort = appPanels.getModelSupportsEffort;
var getModelSupportsThinking = appPanels.getModelSupportsThinking;
var getModelEffortLevels = appPanels.getModelEffortLevels;
var resolveContextWindow = appPanels.resolveContextWindow;
var createStore = storeMod.createStore;

var UNMATCHED_MODEL = 'claude-opus-4-99-totally-unenumerated';

test.beforeEach(function () {
  // Reset the module-level store before each test so cases don't bleed into
  // each other (store.js holds a single shared _state object).
  createStore({});
});

test('lr-f22787: getModelSupportsEffort assumes true for a custom model ID absent from currentModels', function () {
  createStore({
    currentModel: UNMATCHED_MODEL,
    currentModels: [
      { value: 'sonnet', displayName: 'Sonnet', supportsEffort: false },
      { value: 'haiku', displayName: 'Haiku', supportsEffort: false },
    ],
  });

  assert.equal(getModelSupportsEffort(), true,
    'an unmatched model must not silently inherit false from an unrelated enumerated entry, nor default to hidden');
});

test('lr-f22787: getModelSupportsThinking falls back to the vendor-level default for a custom model ID (claude vendor)', function () {
  createStore({
    currentModel: UNMATCHED_MODEL,
    currentVendor: 'claude',
    currentModels: [
      { value: 'haiku', displayName: 'Haiku', supportsThinking: false },
    ],
  });

  assert.equal(getModelSupportsThinking(), true,
    'claude vendor default is "supports thinking" — an unmatched custom ID must not fall back to false');
});

test('lr-f22787: getModelSupportsThinking falls back to the vendor-level default for a custom model ID (codex vendor)', function () {
  createStore({
    currentModel: 'gpt-5.9-unenumerated',
    currentVendor: 'codex',
    currentModels: [
      { value: 'gpt-5.5', displayName: 'GPT-5.5' },
    ],
  });

  assert.equal(getModelSupportsThinking(), false,
    'codex vendor default is "no thinking UI" — matches real Codex behavior, not a hidden-by-accident false');
});

test('lr-f22787: getModelEffortLevels falls back to the vendor-generic level set for a custom model ID', function () {
  createStore({
    currentModel: UNMATCHED_MODEL,
    currentVendor: 'claude',
    currentModels: [
      { value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'medium'] },
    ],
  });

  var levels = getModelEffortLevels();
  assert.ok(Array.isArray(levels) && levels.length > 0,
    'must never return an empty/undefined level set for an unmatched model');
  // Claude vendor-generic default (EFFORT_LEVELS_BY_VENDOR.claude in app-panels.js)
  assert.deepEqual(levels, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('lr-f22787: resolveContextWindow falls back to the live SDK-reported window for an unrecognized custom model ID', function () {
  createStore({ currentBetas: [] });

  // "unrecognized" here means it doesn't even substring-match any
  // KNOWN_CONTEXT_WINDOWS key (unlike e.g. "claude-opus-4-6", which matches
  // the "opus-4-6" key by substring and is intentionally NOT a case this
  // test covers — that path already works via the shared map).
  var result = resolveContextWindow('totally-unknown-custom-id', 512000);
  assert.equal(result, 512000, 'a live SDK-reported context window must win over the last-resort default');
});

test('lr-f22787: resolveContextWindow falls back to 200000 when a custom model ID matches nothing and the SDK reported no window', function () {
  createStore({ currentBetas: [] });

  var result = resolveContextWindow('totally-unknown-custom-id', 0);
  assert.equal(result, 200000, 'last-resort default must never be silently 0 or undefined for an unrecognized model');
});
