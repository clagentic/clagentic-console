"use strict";
// Client-side coverage for permission cards: a click only moves the card to a
// pending state, the final label comes from the server's permission_resolved,
// a dead socket never produces an "Allowed" card, and a reconnect replay of a
// still-pending request yields a clickable card.
//
// Drives the real tools.js exports against the shared hand-built DOM (no jsdom
// dependency in this repo).

var test = require("node:test");
var assert = require("node:assert/strict");
var { setupToolsEnv, cardFor, decisionLabel } = require("./fake-dom-permission-cards");

var setup = setupToolsEnv;
var card = cardFor;
var label = decisionLabel;
// The formal (bubble) and conversational (channel) layouts use different classes.
function allowSessionBtn(c) { return c.querySelector(".permission-allow-session, .perm-always"); }

test("a click while the socket is down leaves the card undecided and clickable", async function (t) {
  var env = await setup(t);
  env.ctx.connected = false;
  env.tools.renderPermissionRequest("r1", "Write", { file_path: "/tmp/x" }, "");
  var c = card(env, "r1");

  allowSessionBtn(c).click();

  assert.equal(env.sent.length, 0);
  assert.ok(!c.classList.contains("resolved"));
  assert.ok(!c.classList.contains("resolved-allowed"));
  assert.equal(label(c), "");
  assert.equal(allowSessionBtn(c).disabled, false);
  assert.match(c.textContent, /Not connected/);
});

test("a click while connected shows a pending state, not a decision, until the server confirms", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r2", "Write", { file_path: "/tmp/x" }, "");
  var c = card(env, "r2");

  allowSessionBtn(c).click();

  assert.deepEqual(env.sent, [{ type: "permission_response", requestId: "r2", decision: "allow_always" }]);
  assert.ok(c.classList.contains("sending"));
  assert.ok(!c.classList.contains("resolved"));
  assert.doesNotMatch(c.textContent, /Allowed/);
  assert.match(c.textContent, /Sending/);
  assert.equal(allowSessionBtn(c).disabled, true);

  env.tools.markPermissionResolved("r2", "allow_always");

  assert.ok(c.classList.contains("resolved-allowed"));
  assert.equal(label(c), "Allowed for session");
  assert.ok(!c.classList.contains("sending"));
  assert.doesNotMatch(c.textContent, /Sending/);
});

test("a decision the server never confirms is offered again after the ack timeout", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r3", "Write", { file_path: "/tmp/x" }, "");
  var c = card(env, "r3");
  allowSessionBtn(c).click();
  assert.ok(c.classList.contains("sending"));

  t.mock.timers.tick(10000);

  assert.ok(!c.classList.contains("sending"));
  assert.ok(!c.classList.contains("resolved"));
  assert.equal(allowSessionBtn(c).disabled, false);
  assert.match(c.textContent, /No confirmation/);
});

test("a socket drop restores every card awaiting confirmation", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r4", "Write", { file_path: "/tmp/x" }, "");
  var c = card(env, "r4");
  allowSessionBtn(c).click();

  env.tools.restoreUnconfirmedPermissions("Connection lost");

  assert.ok(!c.classList.contains("sending"));
  assert.equal(allowSessionBtn(c).disabled, false);
  assert.match(c.textContent, /Connection lost/);
});

test("reconnect replay of a still-pending request turns an unconfirmed card back into a clickable one", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r5", "Write", { file_path: "/tmp/x" }, "");
  var first = card(env, "r5");
  allowSessionBtn(first).click();
  assert.ok(first.classList.contains("sending"));

  env.tools.renderPermissionRequest("r5", "Write", { file_path: "/tmp/x" }, "", undefined, undefined, true);

  var replayed = card(env, "r5");
  assert.ok(replayed, "a card must exist for the pending request");
  assert.ok(!replayed.classList.contains("sending"));
  assert.ok(!replayed.classList.contains("resolved"));
  assert.equal(allowSessionBtn(replayed).disabled, false);
  assert.equal(env.messagesEl.querySelectorAll('[data-request-id="r5"]').length, 1);
});

test("history replay of a request without the server-pending flag does not duplicate or reset a card", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r6", "Write", { file_path: "/tmp/x" }, "");
  var first = card(env, "r6");
  allowSessionBtn(first).click();

  env.tools.renderPermissionRequest("r6", "Write", { file_path: "/tmp/x" }, "");

  assert.equal(card(env, "r6"), first);
  assert.ok(first.classList.contains("sending"));
});

test("a stale reply renders as no longer active instead of leaving an actionable card", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r7", "Write", { file_path: "/tmp/x" }, "");
  var c = card(env, "r7");
  allowSessionBtn(c).click();

  env.tools.markPermissionCancelled("r7", "stale");

  assert.ok(c.classList.contains("resolved"));
  assert.ok(!c.classList.contains("resolved-allowed"));
  assert.match(label(c), /No longer active/);
});

test("plan approval also stays pending until confirmed and is restorable", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r8", "ExitPlanMode", {}, "");
  var c = card(env, "r8");
  var approve = c.querySelector(".permission-allow");

  approve.click();

  assert.equal(env.sent[0].decision, "allow_accept_edits");
  assert.ok(c.classList.contains("sending"));
  assert.doesNotMatch(c.textContent, /Approved/);

  env.tools.restoreUnconfirmedPermissions("Connection lost");

  assert.equal(c.querySelector(".permission-allow").disabled, false);
  assert.equal(c.querySelector(".plan-feedback-send").disabled, true, "feedback send stays disabled while the input is empty");
});
