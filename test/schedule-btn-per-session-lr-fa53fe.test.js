// The composer's schedule button used to be disabled by one page-wide flag
// that only the on-screen session's events could change. Its disabled state
// is now derived from the on-screen session's own pending entry.
//
// The derivation (hasPendingScheduledMsg) lives in the DOM-free
// rate-limit-state.js and is exercised directly; the wiring in the
// DOM-bound modules is asserted from source text, matching
// rate-limit-per-session-lr-0827ba.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasPendingScheduledMsg,
  setScheduledMsg,
  clearScheduledMsg,
  _resetAllForTest,
} from "../lib/public/modules/rate-limit-state.js";

var here = path.dirname(fileURLToPath(import.meta.url));
function readMod(rel) {
  return fs.readFileSync(path.join(here, "..", rel), "utf8");
}

// Mirrors what the client does: events write the event session's entry
// (null localId means the session on screen); the button is derived from
// the entry of the session on screen.
function makeClient(initialActive) {
  var active = initialActive;
  return {
    switchTo: function (id) { active = id; },
    queued: function (localId) { setScheduledMsg(localId != null ? localId : active, "msg", Date.now() + 60000); },
    cleared: function (localId) { clearScheduledMsg(localId != null ? localId : active); },
    buttonDisabled: function () { return hasPendingScheduledMsg(active); },
  };
}

test.beforeEach(() => {
  _resetAllForTest();
});

test("arm in A, switch to B: B is enabled; back to A: A is disabled while pending", () => {
  var c = makeClient("A");
  c.queued("A");
  assert.equal(c.buttonDisabled(), true);
  c.switchTo("B");
  assert.equal(c.buttonDisabled(), false);
  c.switchTo("A");
  assert.equal(c.buttonDisabled(), true);
});

test("A fires while B is on screen: both are enabled afterwards", () => {
  var c = makeClient("A");
  c.queued("A");
  c.switchTo("B");
  c.cleared("A");
  assert.equal(c.buttonDisabled(), false);
  c.switchTo("A");
  assert.equal(c.buttonDisabled(), false);
});

test("A is cancelled while B is on screen: both are enabled afterwards", () => {
  var c = makeClient("A");
  c.queued("A");
  c.switchTo("B");
  c.cleared("A");
  assert.equal(c.buttonDisabled(), false);
  c.switchTo("A");
  assert.equal(c.buttonDisabled(), false);
});

test("B's own pending message does not enable or disable A", () => {
  var c = makeClient("A");
  c.queued("A");
  c.queued("B");
  c.cleared("B");
  assert.equal(c.buttonDisabled(), true);
});

test("an event with no localId acts on the on-screen session", () => {
  var c = makeClient("A");
  c.queued(null);
  assert.equal(c.buttonDisabled(), true);
  c.cleared(null);
  assert.equal(c.buttonDisabled(), false);
});

test("replayed queued then sent leaves the session enabled", () => {
  var c = makeClient("A");
  c.queued("A");
  c.cleared("A");
  assert.equal(c.buttonDisabled(), false);
});

test("wiring: bubble add/clear and session switch-in recompute the button; handlers no longer gate on focus", () => {
  var rl = readMod("lib/public/modules/app-rate-limit.js");
  var add = rl.indexOf("export function addScheduledMessageBubble");
  var addEnd = rl.indexOf("removeScheduledMessageBubble();", add);
  assert.match(rl.slice(add, addEnd), /setScheduledMsg\([^)]*\);\s*refreshScheduleBtnDisabled\(\);/);
  var clr = rl.indexOf("export function clearScheduledMessage");
  assert.match(rl.slice(clr, clr + 400), /clearScheduledMsg\([^)]*\);\s*refreshScheduleBtnDisabled\(\);/);
  var rst = rl.indexOf("export function restoreRateLimitStateForSession");
  assert.match(rl.slice(rst, rst + 200), /refreshScheduleBtnDisabled\(\)/);

  var am = readMod("lib/public/modules/app-messages.js");
  var q = am.indexOf("scheduled_message_queued:");
  var end = am.indexOf("auto_continue_scheduled:", q);
  assert.doesNotMatch(am.slice(q, end), /setScheduleBtnDisabled/);
});
