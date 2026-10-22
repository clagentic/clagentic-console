// The composer's schedule button used to be disabled by one page-wide flag that
// only the on-screen session's events could change. Whether a session is at its
// cap is derived from the on-screen session's own list of scheduled inputs and
// the cap the server sent, and the list for a session that is not on screen is
// kept and never disturbs the one that is. The button is never disabled, also at
// the cap: it must open the panel to cancel or send now. At the cap only the
// arming control is off (test/scheduled-input-surfaces.test.js drives the panel).
//
// These tests drive the production entry points the websocket handler and the
// session-switch hook call (applyScheduledInputList,
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
var btnClasses = new Set();
scheduleBtn.classList = {
  add: function (c) { btnClasses.add(c); },
  remove: function (c) { btnClasses.delete(c); },
  toggle: function (c, on) { if (on) btnClasses.add(c); else btnClasses.delete(c); },
  contains: function (c) { return btnClasses.has(c); },
  has: function (c) { return btnClasses.has(c); },
};

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
var LIMIT = 5;

// The session-switch hook sets the active session, then calls
// restoreRateLimitStateForSession (see the wiring check below).
function switchTo(id) {
  store.set({ activeSessionId: id });
  appRateLimit.restoreRateLimitStateForSession(id);
}

function inputsOf(n) {
  var list = [];
  for (var i = 0; i < n; i++) {
    list.push({ id: 'si_' + i, kind: 'once', text: 'msg ' + i, nextAt: Date.now() + 60000 + i, createdBy: 'test', firedCount: 0 });
  }
  return list;
}

// The server's list for a session, as the scheduled_input_list handler gets it.
function listed(localId, n) {
  var msg = { type: 'scheduled_input_list', limit: LIMIT, inputs: inputsOf(n) };
  if (localId !== undefined) msg.localId = localId;
  appRateLimit.applyScheduledInputList(msg);
}

// Whether the on-screen session is shown at its cap. The button itself is never
// disabled: it always opens the panel, where a queued input is cancelled or sent
// now; at the cap only the panel's Schedule control is off.
function atCap() {
  assert.notEqual(scheduleBtn.disabled, true, 'the schedule button is never disabled');
  assert.notEqual(scheduleBtn.style.pointerEvents, 'none', 'the schedule button always takes clicks');
  return scheduleBtn.classList.has('schedule-at-cap');
}

test.beforeEach(function () {
  storeMod.createStore({ activeSessionId: 'A', currentVendor: 'claude', replayingHistory: false });
  stateMod._resetAllForTest();
  appRateLimit.resetRateLimitState();
  scheduleBtn.disabled = false;
  scheduleBtn.style = {};
  btnClasses.clear();
});

test.afterEach(function () {
  appRateLimit.resetRateLimitState();
});

test('fill A to the cap, switch to B: B is enabled; back to A: A is disabled while at the cap', function () {
  listed('A', LIMIT);
  assert.equal(atCap(), true);
  switchTo('B');
  assert.equal(atCap(), false);
  switchTo('A');
  assert.equal(atCap(), true);
});

test('a session below the cap keeps its button enabled', function () {
  listed('A', 1);
  assert.equal(atCap(), false);
  listed('A', LIMIT - 1);
  assert.equal(atCap(), false);
});

test("A's inputs fire while B is on screen: both are enabled afterwards", function () {
  listed('A', LIMIT);
  switchTo('B');
  listed('A', 0);
  assert.equal(atCap(), false);
  switchTo('A');
  assert.equal(atCap(), false);
});

test('a background list for B does not disable the button while A is on screen', function () {
  listed('B', LIMIT);
  assert.equal(atCap(), false);
  switchTo('B');
  assert.equal(atCap(), true);
});

test("B's list changes do not enable or disable A", function () {
  listed('A', LIMIT);
  listed('B', LIMIT);
  listed('B', 0);
  assert.equal(atCap(), true);
});

test('a list with no localId acts on the on-screen session', function () {
  listed(undefined, LIMIT);
  assert.equal(atCap(), true);
  listed(undefined, 0);
  assert.equal(atCap(), false);
});

test('a full list followed by an empty one leaves the session enabled', function () {
  listed('A', LIMIT);
  listed('A', 0);
  assert.equal(atCap(), false);
});

test("the cap is the server's: a list that carries another limit moves the threshold", function () {
  appRateLimit.applyScheduledInputList({ type: 'scheduled_input_list', localId: 'A', limit: 2, inputs: inputsOf(2) });
  assert.equal(atCap(), true);
  appRateLimit.applyScheduledInputList({ type: 'scheduled_input_list', localId: 'A', limit: 3, inputs: inputsOf(2) });
  assert.equal(atCap(), false);
});

test("a server limit of 0 is honoured: nothing can be armed; an absent limit keeps the default", function () {
  appRateLimit.applyScheduledInputList({ type: 'scheduled_input_list', localId: 'A', limit: 0, inputs: [] });
  assert.equal(atCap(), true);
  appRateLimit.applyScheduledInputList({ type: 'scheduled_input_list', localId: 'B', inputs: inputsOf(LIMIT - 1) });
  switchTo('B');
  assert.equal(atCap(), false);
});

test('the list is kept per session and drawn only for the one on screen', function () {
  listed('A', 2);
  listed('B', 3);
  assert.equal(stateMod.getScheduledInputs('A').length, 2);
  assert.equal(stateMod.getScheduledInputs('B').length, 3);
  assert.notEqual(appRateLimit.getScheduledMsgEl(), null, 'A is on screen and has inputs: its bubbles are drawn');
  assert.equal(appRateLimit.getScheduledMsgEl().children.length, 2, 'one bubble per armed input of A, none of B');
  switchTo('B');
  assert.equal(appRateLimit.getScheduledMsgEl().children.length, 3);
  listed('B', 0);
  assert.equal(appRateLimit.getScheduledMsgEl(), null);
});

// Supplement: the wiring that cannot be reached without a full app boot.
test('wiring: the list handler no longer gates the button on focus; the switch hook reaches restoreRateLimitStateForSession', function () {
  var here = path.dirname(fileURLToPath(import.meta.url));
  var am = fs.readFileSync(path.join(here, '..', 'lib/public/modules/app-messages.js'), 'utf8');
  var q = am.indexOf('scheduled_input_list:');
  var end = am.indexOf('scheduled_message_sent:', q);
  assert.ok(q !== -1 && end !== -1);
  assert.doesNotMatch(am.slice(q, end), /setScheduleBtnDisabled/);
  assert.match(am, /restoreRateLimitStateForSession\(/);
});
