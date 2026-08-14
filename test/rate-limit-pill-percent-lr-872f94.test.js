// Regression / coverage tests for lr-872f94: the rate-limit warning/
// rejection pill (header) rendered a status label and a reset countdown but
// never the vendor-reported usedPercent, even though the data was already
// present on the event (info.utilization, forwarded verbatim from
// account/rateLimits/updated's RateLimitWindow.usedPercent for Codex, and
// from the Anthropic SDK's rate_limit_info.utilization for Claude — both
// funnel into the same yokeType: "rate_limit" -> handleRateLimitEvent path,
// see lib/sdk-message-processor.js and lib/yoke/adapters/{codex,claude}.js).
//
// Uses the same minimal-DOM-stub + dynamic-import pattern as
// test/context-meter-vendor-first-lr-3af675.test.js (app-rate-limit.js has
// one load-bearing top-level document.addEventListener in its
// app-rendering.js import graph, which the stub's no-op satisfies).

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeElement() {
  var el = {
    style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    children: [],
    appendChild: function (c) { this.children.push(c); return c; },
    removeChild: function () {},
    remove: function () {},
    setAttribute: function () {},
    getAttribute: function () { return null; },
    addEventListener: function () {},
    removeEventListener: function () {},
    querySelector: function (sel) {
      // Minimal support for the ".header-pill-text" lookup startRateLimitCountdown does.
      if (sel === ".header-pill-text") return makeFakeElement();
      return null;
    },
    querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { width: 0, height: 0, top: 0, left: 0 }; },
    textContent: "",
    innerHTML: "",
    dataset: {},
    removeAttribute: function () {},
    insertBefore: function (c) { this.children.push(c); return c; },
  };
  return el;
}

var statusAreaEl = makeFakeElement();

global.document = {
  addEventListener: function () {},
  removeEventListener: function () {},
  createElement: function () { return makeFakeElement(); },
  getElementById: function () { return makeFakeElement(); },
  querySelector: function (sel) {
    if (sel === ".title-bar-content .status") return statusAreaEl;
    return null;
  },
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

var appRateLimit = await import('../lib/public/modules/app-rate-limit.js');
var storeMod = await import('../lib/public/modules/store.js');
var rateLimitStateMod = await import('../lib/public/modules/rate-limit-state.js');

var handleRateLimitEvent = appRateLimit.handleRateLimitEvent;
var createStore = storeMod.createStore;

test.beforeEach(function () {
  createStore({ activeSessionId: 's1', currentVendor: 'codex', replayingHistory: false });
  rateLimitStateMod._resetAllForTest();
  // resetRateLimitState() clears the module-scoped rateLimitIndicatorEl
  // reference (not just the DOM stub's children array) so each test starts
  // from "no pill exists yet" -- without this, updateRateLimitIndicator()
  // sees a stale non-null rateLimitIndicatorEl from a prior test and only
  // mutates its innerHTML without re-inserting it into statusAreaEl.
  appRateLimit.resetRateLimitState();
  statusAreaEl.children = [];
});

test('lr-872f94: an allowed_warning rate_limit event with utilization renders a usedPercent span in the pill', function () {
  handleRateLimitEvent({
    status: 'allowed_warning',
    resetsAt: Date.now() + 60000,
    rateLimitType: 'five_hour',
    utilization: 0.83,
    isUsingOverage: false,
    localId: 's1',
  });

  var wrap = statusAreaEl.children[0];
  assert.ok(wrap, 'the rate-limit indicator wrapper must be inserted into the status area');
  assert.match(wrap.innerHTML, /header-pill-pct/, 'a usedPercent element must be present in the pill markup');
  assert.match(wrap.innerHTML, />83%</, 'utilization 0.83 must render as "83%" (rounded)');
});

test('lr-872f94: a rejected rate_limit event with utilization also renders the pill percent (applies regardless of warning vs rejected)', function () {
  handleRateLimitEvent({
    status: 'rejected',
    resetsAt: Date.now() + 60000,
    rateLimitType: 'seven_day',
    utilization: 1.0,
    isUsingOverage: false,
    localId: 's1',
  });

  var wrap = statusAreaEl.children[0];
  assert.ok(wrap);
  assert.match(wrap.innerHTML, />100%</);
});

test('lr-872f94: no utilization on the event -> no percent span rendered (never fabricate a number)', function () {
  handleRateLimitEvent({
    status: 'allowed_warning',
    resetsAt: Date.now() + 60000,
    rateLimitType: 'five_hour',
    isUsingOverage: false,
    localId: 's1',
    // utilization intentionally omitted
  });

  var wrap = statusAreaEl.children[0];
  assert.ok(wrap);
  assert.doesNotMatch(wrap.innerHTML, /header-pill-pct/, 'must not render a percent element when the vendor did not report utilization');
});

test('lr-872f94: the pill link points at the current vendor\'s usage page, not a hardcoded claude.ai URL', function () {
  createStore({ activeSessionId: 's1', currentVendor: 'codex', replayingHistory: false });
  handleRateLimitEvent({
    status: 'allowed_warning',
    resetsAt: Date.now() + 60000,
    rateLimitType: 'five_hour',
    utilization: 0.5,
    isUsingOverage: false,
    localId: 's1',
  });

  var wrap = statusAreaEl.children[0];
  assert.match(wrap.innerHTML, /chatgpt\.com\/admin\/usage/, 'a Codex-vendor pill must link to the ChatGPT usage page, not claude.ai (pre-existing hardcode fixed alongside the percent render)');
});
