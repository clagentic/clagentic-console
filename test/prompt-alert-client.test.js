"use strict";
// The urgent "Input needed" alert follows whether any prompt, of any kind, is
// still awaiting the operator; it is never decided by the message that
// arrived last. With two prompts open, settling one leaves the alert on for
// the other; a turn ending leaves it on for a sub-agent prompt that outlives
// the turn.
//
// The derivation is exercised on its own first; then the app's message router
// (app-messages.js and its module graph) runs under the DOM stub, with the
// timers mocked, and the alert is read off the page title it flips.

var test = require("node:test");
var assert = require("node:assert/strict");
var { setupToolsEnv, moduleUrl } = require("./fake-dom-prompt-cards");

function permission(id) {
  return { type: "prompt_request", requestId: id, kind: "permission", toolName: "Bash", toolInput: { command: "make" }, decisionReason: "" };
}

function ask(id) {
  return { type: "prompt_request", requestId: id, kind: "ask_user", toolUseId: id, input: { questions: [{ question: "Q?", options: [{ label: "a" }] }] } };
}

test("the pending-prompt derivation stays on while any prompt of any kind is unanswered", async function (t) {
  var env = await setupToolsEnv(t);
  assert.equal(env.tools.hasPendingPrompts(), false);

  env.tools.applyPromptMessage(permission("p-1"));
  env.tools.applyPromptMessage(ask("a-1"));
  assert.equal(env.tools.hasPendingPrompts(), true);

  env.tools.applyPromptMessage({ type: "prompt_resolved", requestId: "p-1", kind: "permission", decision: "allow" });
  assert.equal(env.tools.hasPendingPrompts(), true, "settling one of two prompts leaves the other awaiting the operator");

  env.tools.resetToolState();
  assert.equal(env.tools.hasPendingPrompts(), true, "a turn's tool reset does not end a prompt that outlives the turn");

  env.tools.applyPromptMessage({ type: "prompt_cancel", requestId: "a-1", kind: "ask_user", reason: "stale" });
  assert.equal(env.tools.hasPendingPrompts(), false);

  env.tools.applyPromptMessage(permission("p-2"));
  env.tools.clearPromptStates();
  assert.equal(env.tools.hasPendingPrompts(), false, "a rebuilt transcript starts from the server's word again");
});

// Whether the urgent alert is running, read the way a user sees it: while it
// runs the page title flips to "Input needed" every 500 ms. Two ticks cover
// both halves of the flip.
var ALERT_TITLE = "⚠ Input needed";
function alertIsOn(t) {
  var seen = [];
  t.mock.timers.tick(500);
  seen.push(global.document.title);
  t.mock.timers.tick(500);
  seen.push(global.document.title);
  return seen.indexOf(ALERT_TITLE) !== -1;
}

// Runs app-messages.js and its whole module graph under the DOM stub and feeds
// it the server's messages through processMessage, the browser's one entry
// point, so the wiring between message handlers and the alert is the shipped
// wiring and not a reading of its source.
async function setupAppMessages(t) {
  var env = await setupToolsEnv(t, ["setTimeout", "setInterval"]);
  global.document.title = "Console";
  var messages = await import(moduleUrl("app-messages.js"));
  return { env: env, processMessage: messages.processMessage };
}

test("the alert follows every open prompt through the app's message router", async function (t) {
  var app = await setupAppMessages(t);
  assert.equal(alertIsOn(t), false, "no prompt, no alert");

  app.processMessage(permission("p-1"));
  assert.equal(alertIsOn(t), true, "a permission prompt raises the alert");
  app.processMessage(ask("a-1"));

  app.processMessage({ type: "prompt_resolved", requestId: "p-1", kind: "permission", decision: "allow" });
  assert.equal(alertIsOn(t), true, "settling one of two prompts leaves the alert on for the other");

  app.processMessage({ type: "done" });
  assert.equal(alertIsOn(t), true, "a finished turn does not hide a prompt that outlives it");

  app.processMessage({ type: "prompt_cancel", requestId: "a-1", kind: "ask_user", reason: "stale" });
  assert.equal(alertIsOn(t), false, "the last prompt settling clears the alert");
  assert.equal(global.document.title, "Console", "the page title is restored");

  app.processMessage({ type: "done" });
  assert.equal(alertIsOn(t), false, "a turn ending with no prompt open leaves no alert");
});
