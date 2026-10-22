// The composer's schedule button used to be disabled by one page-wide flag
// that only the on-screen session's events could change. Its disabled state
// is now derived from the on-screen session's own pending entry.
//
// These tests drive the production entry points the websocket handlers and the
// session-switch hook call (addScheduledMessageBubble, clearScheduledMessage,
// restoreRateLimitStateForSession) against a stubbed #schedule-btn, using the
// same minimal-DOM-stub + dynamic-import pattern as
// test/rate-limit-pill-percent-lr-872f94.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function makeFakeElement() {
  return {
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
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { width: 0, height: 0, top: 0, left: 0 }; },
    textContent: '',
    innerHTML: '',
    dataset: {},
    removeAttribute: function () {},
    insertBefore: function (c) { this.children.push(c); return c; },
  };
}

var scheduleBtn = makeFakeElement();
scheduleBtn.disabled = false;

global.document = {
  addEventListener: function () {},
  removeEventListener: function () {},
  createElement: function () { return makeFakeElement(); },
  getElementById: function (id) { return id === 'schedule-btn' ? scheduleBtn : makeFakeElement(); },
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

var appRateLimit = await import('../lib/public/modules/app-rate-limit.js');
var storeMod = await import('../lib/public/modules/store.js');
var stateMod = await import('../lib/public/modules/rate-limit-state.js');

var store = storeMod.store;

// The session-switch hook sets the active session, then calls
// restoreRateLimitStateForSession (see the wiring check below).
function switchTo(id) {
  store.set({ activeSessionId: id });
  appRateLimit.restoreRateLimitStateForSession(id);
}

function queued(localId) {
  appRateLimit.addScheduledMessageBubble('msg', Date.now() + 60000, localId);
}

function cleared(localId) {
  appRateLimit.clearScheduledMessage(localId);
}

function buttonDisabled() {
  return scheduleBtn.disabled === true;
}

test.beforeEach(function () {
  storeMod.createStore({ activeSessionId: 'A', currentVendor: 'claude', replayingHistory: false });
  stateMod._resetAllForTest();
  appRateLimit.resetRateLimitState();
  scheduleBtn.disabled = false;
  scheduleBtn.style = {};
});

test('arm in A, switch to B: B is enabled; back to A: A is disabled while pending', function () {
  queued('A');
  assert.equal(buttonDisabled(), true);
  switchTo('B');
  assert.equal(buttonDisabled(), false);
  switchTo('A');
  assert.equal(buttonDisabled(), true);
});

test('A fires while B is on screen: both are enabled afterwards', function () {
  queued('A');
  switchTo('B');
  cleared('A');
  assert.equal(buttonDisabled(), false);
  switchTo('A');
  assert.equal(buttonDisabled(), false);
});

test('A is cancelled while B is on screen: both are enabled afterwards', function () {
  queued('A');
  switchTo('B');
  cleared('A');
  assert.equal(buttonDisabled(), false);
  switchTo('A');
  assert.equal(buttonDisabled(), false);
});

test('a background queue for B does not disable the button while A is on screen', function () {
  queued('B');
  assert.equal(buttonDisabled(), false);
  switchTo('B');
  assert.equal(buttonDisabled(), true);
});

test("B's own pending message does not enable or disable A", function () {
  queued('A');
  queued('B');
  cleared('B');
  assert.equal(buttonDisabled(), true);
});

test('an event with no localId acts on the on-screen session', function () {
  queued(null);
  assert.equal(buttonDisabled(), true);
  cleared(null);
  assert.equal(buttonDisabled(), false);
});

test('replayed queued then sent leaves the session enabled', function () {
  queued('A');
  cleared('A');
  assert.equal(buttonDisabled(), false);
});

// Supplement: the wiring that cannot be reached without a full app boot.
test('wiring: the queued handler no longer gates the button on focus; the switch hook reaches restoreRateLimitStateForSession', function () {
  var here = path.dirname(fileURLToPath(import.meta.url));
  var am = fs.readFileSync(path.join(here, '..', 'lib/public/modules/app-messages.js'), 'utf8');
  var q = am.indexOf('scheduled_message_queued:');
  var end = am.indexOf('auto_continue_scheduled:', q);
  assert.doesNotMatch(am.slice(q, end), /setScheduleBtnDisabled/);
  assert.match(am, /restoreRateLimitStateForSession\(/);
});
