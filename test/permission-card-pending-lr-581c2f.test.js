"use strict";
// Client-side coverage for permission cards: a click only moves the card to a
// pending state, the final label comes from the server's prompt_resolved, a
// dead socket never produces an "Allowed" card, and a reconnect replay of a
// still-pending request yields a clickable card.
//
// Drives the real tools.js exports against the shared hand-built DOM (no jsdom
// dependency in this repo).

var test = require("node:test");
var assert = require("node:assert/strict");
var { setupToolsEnv, cardFor, decisionLabel } = require("./fake-dom-prompt-cards");

var setup = setupToolsEnv;
var card = cardFor;
var label = decisionLabel;
// The formal (bubble) and conversational (channel) layouts use different classes.
function allowSessionBtn(c) { return c.querySelector(".permission-allow-session, .perm-always"); }

function request(id, extra) {
  return Object.assign({ type: "prompt_request", requestId: id, kind: "permission", toolName: "Write", toolInput: { file_path: "/tmp/x" }, decisionReason: "" }, extra || {});
}

test("a click while the socket is down leaves the card undecided and clickable", async function (t) {
  var env = await setup(t);
  env.ctx.connected = false;
  env.tools.applyPromptMessage(request("r1"));
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
  env.tools.applyPromptMessage(request("r2"));
  var c = card(env, "r2");

  allowSessionBtn(c).click();

  assert.deepEqual(env.sent, [{ type: "prompt_response", requestId: "r2", kind: "permission", decision: "allow_always" }]);
  assert.ok(c.classList.contains("sending"));
  assert.ok(!c.classList.contains("resolved"));
  assert.doesNotMatch(c.textContent, /Allowed/);
  assert.match(c.textContent, /Sending/);
  assert.equal(allowSessionBtn(c).disabled, true);

  env.tools.applyPromptMessage({ type: "prompt_resolved", requestId: "r2", kind: "permission", decision: "allow_always" });

  assert.ok(c.classList.contains("resolved-allowed"));
  assert.equal(label(c), "Allowed for session");
  assert.ok(!c.classList.contains("sending"));
  assert.doesNotMatch(c.textContent, /Sending/);
});

test("a decision the server never confirms is offered again after the ack timeout", async function (t) {
  var env = await setup(t);
  env.tools.applyPromptMessage(request("r3"));
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
  env.tools.applyPromptMessage(request("r4"));
  var c = card(env, "r4");
  allowSessionBtn(c).click();

  env.tools.restoreUnconfirmedPrompts("Connection lost");

  assert.ok(!c.classList.contains("sending"));
  assert.equal(allowSessionBtn(c).disabled, false);
  assert.match(c.textContent, /Connection lost/);
});

test("reconnect replay of a still-pending request turns an unconfirmed card back into a clickable one", async function (t) {
  var env = await setup(t);
  env.tools.applyPromptMessage(request("r5"));
  var first = card(env, "r5");
  allowSessionBtn(first).click();
  assert.ok(first.classList.contains("sending"));

  env.tools.applyPromptMessage(request("r5", { type: "prompt_pending" }));

  var replayed = card(env, "r5");
  assert.ok(replayed, "a card must exist for the pending request");
  assert.ok(!replayed.classList.contains("sending"));
  assert.ok(!replayed.classList.contains("resolved"));
  assert.equal(allowSessionBtn(replayed).disabled, false);
  assert.equal(env.messagesEl.querySelectorAll('[data-request-id="r5"]').length, 1);
});

test("history replay of a request without the server-pending flag does not duplicate or reset a card", async function (t) {
  var env = await setup(t);
  env.tools.applyPromptMessage(request("r6"));
  var first = card(env, "r6");
  allowSessionBtn(first).click();

  env.tools.applyPromptMessage(request("r6"));

  assert.equal(card(env, "r6"), first);
  assert.ok(first.classList.contains("sending"));
});

test("a stale reply renders as no longer active instead of leaving an actionable card", async function (t) {
  var env = await setup(t);
  env.tools.applyPromptMessage(request("r7"));
  var c = card(env, "r7");
  allowSessionBtn(c).click();

  env.tools.applyPromptMessage({ type: "prompt_cancel", requestId: "r7", kind: "permission", reason: "stale" });

  assert.ok(c.classList.contains("resolved"));
  assert.ok(!c.classList.contains("resolved-allowed"));
  assert.match(label(c), /No longer active/);
});

test("plan approval also stays pending until confirmed and is restorable", async function (t) {
  var env = await setup(t);
  env.tools.applyPromptMessage(request("r8", { kind: "plan", toolName: "ExitPlanMode", toolInput: {} }));
  var c = card(env, "r8");
  var approve = c.querySelector(".permission-allow");

  approve.click();

  assert.equal(env.sent[0].decision, "allow_accept_edits");
  assert.ok(c.classList.contains("sending"));
  assert.doesNotMatch(c.textContent, /Approved/);

  env.tools.restoreUnconfirmedPrompts("Connection lost");

  assert.equal(c.querySelector(".permission-allow").disabled, false);
  assert.equal(c.querySelector(".plan-feedback-send").disabled, true, "feedback send stays disabled while the input is empty");
});
