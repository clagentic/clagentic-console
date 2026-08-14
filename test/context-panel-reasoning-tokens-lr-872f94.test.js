// Regression / coverage tests for lr-872f94: reasoning_output_tokens (Codex's
// thread/tokenUsage/updated breakdown, now surfaced via the 'result' event's
// usage.reasoning_output_tokens) was previously discarded entirely -- a real
// Codex-specific spend category invisible to users. accumulateContext now
// tracks it on contextData.reasoningOutput; updateContextPanel renders it as
// a "Reasoning" row that stays hidden for vendors/turns that never report it
// (Claude has no equivalent field), so this never displays a fabricated
// zero for a provider that doesn't report reasoning tokens at all.
//
// Uses the same minimal-DOM-stub + dynamic-import pattern as
// test/context-meter-vendor-first-lr-3af675.test.js.

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
    textContent: "",
    innerHTML: "",
    dataset: {},
    removeAttribute: function () {},
    closest: function () { return this._row || null; },
  };
  return el;
}

var contextReasoningEl = makeFakeElement();
var reasoningRow = makeFakeElement();
contextReasoningEl._row = reasoningRow;

var elementsById = {
  "context-reasoning": contextReasoningEl,
};

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
global.mermaid = { initialize: function () {}, render: function () { return Promise.resolve({ svg: '' }); } };

var appPanels = await import('../lib/public/modules/app-panels.js');
var storeMod = await import('../lib/public/modules/store.js');

var accumulateContext = appPanels.accumulateContext;
var getContextData = appPanels.getContextData;
var createStore = storeMod.createStore;

test.beforeEach(function () {
  createStore({ replayingHistory: false });
  appPanels.resetContextData();
});

test('lr-872f94: accumulateContext captures reasoning_output_tokens onto contextData.reasoningOutput', function () {
  createStore({ currentModel: 'gpt-5.5', replayingHistory: false });
  accumulateContext(null, {
    input_tokens: 1000,
    output_tokens: 200,
    reasoning_output_tokens: 150,
  }, { 'gpt-5.5': { contextWindow: 272000 } }, null);

  var cd = getContextData();
  assert.equal(cd.reasoningOutput, 150, 'reasoning_output_tokens must be captured, previously discarded entirely');
});

test('lr-872f94: accumulateContext defaults reasoningOutput to 0 when the vendor does not report it (e.g. Claude)', function () {
  createStore({ currentModel: 'claude-sonnet-4-6', replayingHistory: false });
  accumulateContext(0.02, {
    input_tokens: 1000,
    output_tokens: 200,
  }, { 'claude-sonnet-4-6': { contextWindow: 200000 } }, null);

  var cd = getContextData();
  assert.equal(cd.reasoningOutput, 0, 'a vendor that never reports reasoning tokens must not show a leftover/fabricated value');
});

test('lr-872f94: resetContextData clears reasoningOutput back to 0', function () {
  createStore({ currentModel: 'gpt-5.5', replayingHistory: false });
  accumulateContext(null, { input_tokens: 10, reasoning_output_tokens: 999 }, null, null);
  assert.equal(getContextData().reasoningOutput, 999);

  appPanels.resetContextData();
  assert.equal(getContextData().reasoningOutput, 0, 'resetContextData must not leak a prior session\'s reasoning-token figure');
});
