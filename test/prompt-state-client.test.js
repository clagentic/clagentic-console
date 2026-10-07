"use strict";
// A prompt card, of any kind, is a pure function of the server's state for its
// requestId, never of message order: paged history replay delivers an outcome
// (newer page) before the request it closes (older page), and a reconnect
// re-presents still-pending prompts after replay. Older recorded shapes of the
// same events map onto the same cards.

var test = require("node:test");
var assert = require("node:assert/strict");
var { setupToolsEnv, cardFor, enabledButtons, liveControls, decisionLabel, moduleUrl } = require("./fake-dom-prompt-cards");

function request(id, extra) {
  return Object.assign({ type: "prompt_request", requestId: id, kind: "permission", toolName: "Write", toolInput: { file_path: "/tmp/x" }, decisionReason: "" }, extra || {});
}

var ASK_INPUT = { questions: [{ question: "Which target?", options: [{ label: "staging" }, { label: "prod" }] }] };

function askRequest(id, extra) {
  return Object.assign({ type: "prompt_request", requestId: id, kind: "ask_user", toolUseId: id, input: ASK_INPUT }, extra || {});
}

function elicitationRequest(id, extra) {
  return Object.assign({
    type: "prompt_request", requestId: id, kind: "elicitation", serverName: "deploy", message: "Token?",
    mode: "form", requestedSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
  }, extra || {});
}

test("prompt-state: terminal states are final and the first terminal wins", async function () {
  var { createPromptStates } = await import(moduleUrl("prompt-state.js"));
  var states = createPromptStates();

  assert.equal(states.apply("a", { state: "pending" }).state, "pending");
  states.apply("a", { state: "resolved", decision: "deny" });
  states.apply("a", { state: "pending" });
  states.apply("a", { state: "cancelled", reason: "stale" });

  assert.equal(states.get("a").state, "resolved");
  assert.equal(states.get("a").decision, "deny");
  states.clear();
  assert.equal(states.get("a"), null);
});

test("prompt-state: older recorded shapes normalize onto the one prompt shape", async function () {
  var { normalizePromptMessage } = await import(moduleUrl("prompt-state.js"));
  var cases = [
    [{ type: "permission_request", requestId: "p", toolName: "Bash", permissionState: { state: "pending" } }, "request", "permission"],
    [{ type: "permission_request", requestId: "p", toolName: "ExitPlanMode" }, "request", "plan"],
    [{ type: "permission_request_pending", requestId: "p", toolName: "Bash" }, "pending", "permission"],
    [{ type: "permission_resolved", requestId: "p", decision: "allow" }, "resolved", null],
    [{ type: "permission_cancel", requestId: "p", reason: "turn_ended" }, "cancel", null],
    [{ type: "elicitation_request", requestId: "e" }, "request", "elicitation"],
    [{ type: "elicitation_resolved", requestId: "e", action: "accept" }, "resolved", null],
    [{ type: "tool_executing", id: "t", name: "AskUserQuestion", input: ASK_INPUT }, "request", "ask_user"],
    [{ type: "ask_user_answered", toolId: "t", answers: { 0: "prod" } }, "resolved", "ask_user"],
    [{ type: "ask_user_answered", toolId: "t" }, "cancel", "ask_user"],
  ];
  cases.forEach(function (c) {
    var n = normalizePromptMessage(c[0]);
    assert.equal(n.phase, c[1], c[0].type);
    assert.equal(n.kind, c[2], c[0].type);
  });
  assert.equal(normalizePromptMessage({ type: "tool_executing", id: "x", name: "Bash", input: {} }), null);
  assert.equal(normalizePromptMessage({ type: "delta", text: "x" }), null);
});

test("a resolution seen before its request draws the request already resolved", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.applyPromptMessage({ type: "prompt_resolved", requestId: "r-split", kind: "permission", decision: "allow" });
  // Loading an older page resets tool state before drawing the request.
  env.tools.resetToolState();
  env.tools.applyPromptMessage(request("r-split"));

  var c = cardFor(env, "r-split");
  assert.ok(c.classList.contains("resolved-allowed"));
  assert.equal(decisionLabel(c), "Allowed");
  assert.equal(enabledButtons(c).length, 0);
});

test("a replayed request carrying the server's state renders that state", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.applyPromptMessage(request("r-allow", { promptState: { state: "resolved", decision: "allow_always" } }));
  env.tools.applyPromptMessage(request("r-gone", { promptState: { state: "cancelled", reason: "stale" } }));
  env.tools.applyPromptMessage(request("r-turn", { promptState: { state: "cancelled", reason: "turn_ended" } }));
  env.tools.applyPromptMessage(request("r-expired", { promptState: { state: "cancelled", reason: "expired" } }));
  env.tools.applyPromptMessage(request("r-shutdown", { promptState: { state: "cancelled", reason: "shutdown" } }));
  var live = env.tools.applyPromptMessage(request("r-live", { promptState: { state: "pending" } }));

  assert.equal(decisionLabel(cardFor(env, "r-allow")), "Allowed for session");
  assert.match(decisionLabel(cardFor(env, "r-gone")), /No longer active/);
  assert.equal(decisionLabel(cardFor(env, "r-turn")), "Cancelled");
  assert.equal(decisionLabel(cardFor(env, "r-expired")), "Expired");
  assert.match(decisionLabel(cardFor(env, "r-shutdown")), /daemon restart/);
  ["r-allow", "r-gone", "r-turn", "r-expired", "r-shutdown"].forEach(function (id) {
    assert.equal(enabledButtons(cardFor(env, id)).length, 0, id);
  });
  assert.equal(live.state, "pending");
  assert.ok(enabledButtons(cardFor(env, "r-live")).length >= 2);
});

test("an older history's permission_request and permissionState render like the current shape", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.applyPromptMessage({ type: "permission_request", requestId: "r-old", toolName: "Write", toolInput: {}, permissionState: { state: "resolved", decision: "deny" } });
  env.tools.applyPromptMessage({ type: "permission_request", requestId: "r-old-live", toolName: "Write", toolInput: {} });
  env.tools.applyPromptMessage({ type: "permission_cancel", requestId: "r-old-live", reason: "turn_ended" });

  assert.equal(decisionLabel(cardFor(env, "r-old")), "Denied");
  assert.equal(decisionLabel(cardFor(env, "r-old-live")), "Cancelled");
});

test("a pending snapshot cannot reopen a prompt the server already settled", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.applyPromptMessage(request("r-done"));
  env.tools.applyPromptMessage({ type: "prompt_cancel", requestId: "r-done", kind: "permission", reason: "turn_ended" });
  env.tools.applyPromptMessage(request("r-done", { type: "prompt_pending" }));

  var c = cardFor(env, "r-done");
  assert.equal(decisionLabel(c), "Cancelled");
  assert.equal(enabledButtons(c).length, 0);
  assert.equal(env.messagesEl.querySelectorAll('[data-request-id="r-done"]').length, 1);
});

test("clearPromptStates forgets outcomes when the transcript is rebuilt", async function (t) {
  var env = await setupToolsEnv(t);

  env.tools.applyPromptMessage({ type: "prompt_resolved", requestId: "r-forget", kind: "permission", decision: "deny" });
  env.tools.clearPromptStates();
  env.tools.applyPromptMessage(request("r-forget"));

  assert.ok(!cardFor(env, "r-forget").classList.contains("resolved"));
});

test("applyPromptMessage ignores unrelated messages", async function (t) {
  var env = await setupToolsEnv(t);
  assert.equal(env.tools.applyPromptMessage({ type: "delta", text: "x" }), null);
});

// --- every kind shares the shell ------------------------------------------

test("an AskUserQuestion card sends a prompt_response and shows its answers only once confirmed", async function (t) {
  var env = await setupToolsEnv(t);
  env.tools.applyPromptMessage({ type: "tool_executing", id: "tu-ask", name: "AskUserQuestion", input: ASK_INPUT });
  env.tools.applyPromptMessage(askRequest("tu-ask"));
  var c = cardFor(env, "tu-ask");
  assert.equal(env.messagesEl.querySelectorAll('[data-request-id="tu-ask"]').length, 1, "the tool call and the prompt draw one card");
  assert.equal(env.ctx.inputEl.disabled, true, "the main input waits for the answer");

  c.querySelectorAll(".ask-user-option")[1].click();
  c.querySelector(".ask-user-submit").click();

  assert.deepEqual(env.sent, [{ type: "prompt_response", requestId: "tu-ask", kind: "ask_user", answers: { 0: "prod" } }]);
  assert.ok(c.classList.contains("sending"));
  assert.ok(!c.querySelector(".ask-user-answer-summary"), "no answer is shown before the server confirms");

  env.tools.applyPromptMessage({ type: "prompt_resolved", requestId: "tu-ask", kind: "ask_user", answers: { 0: "prod" } });

  assert.ok(c.classList.contains("answered"));
  assert.ok(c.querySelector(".ask-user-answer-summary"));
  assert.equal(liveControls(c).length, 0);
  assert.equal(env.ctx.inputEl.disabled, false);
});

test("a skipped or ended question is labelled, and an older ask_user_answered settles it", async function (t) {
  var env = await setupToolsEnv(t);
  env.tools.applyPromptMessage(askRequest("tu-skip"));
  cardFor(env, "tu-skip").querySelector(".ask-user-skip").click();
  assert.deepEqual(env.sent[0], { type: "prompt_response", requestId: "tu-skip", kind: "ask_user", decision: "skip" });
  env.tools.applyPromptMessage({ type: "prompt_resolved", requestId: "tu-skip", kind: "ask_user", skipped: true });
  assert.equal(decisionLabel(cardFor(env, "tu-skip")), "Skipped");

  env.tools.applyPromptMessage({ type: "tool_executing", id: "tu-old", name: "AskUserQuestion", input: ASK_INPUT });
  env.tools.applyPromptMessage({ type: "ask_user_answered", toolId: "tu-old", answers: { 0: "staging" } });
  var old = cardFor(env, "tu-old");
  assert.ok(old.querySelector(".ask-user-answer-summary"));
  assert.equal(liveControls(old).length, 0);

  env.tools.applyPromptMessage({ type: "tool_executing", id: "tu-turn", name: "AskUserQuestion", input: ASK_INPUT });
  env.tools.applyPromptMessage({ type: "ask_user_answered", toolId: "tu-turn" });
  assert.equal(decisionLabel(cardFor(env, "tu-turn")), "Cancelled");
});

test("an elicitation card waits for the server instead of claiming it was submitted", async function (t) {
  var env = await setupToolsEnv(t);
  env.tools.applyPromptMessage(elicitationRequest("el-1"));
  var c = cardFor(env, "el-1");

  c.querySelector('[data-prop-name="token"]').value = "abc";
  c.querySelector(".permission-allow").click();

  assert.equal(env.sent[0].type, "prompt_response");
  assert.equal(env.sent[0].kind, "elicitation");
  assert.equal(env.sent[0].action, "accept");
  assert.ok(c.classList.contains("sending"));
  assert.doesNotMatch(c.textContent, /Submitted/);

  env.tools.applyPromptMessage({ type: "prompt_resolved", requestId: "el-1", kind: "elicitation", action: "accept" });
  assert.equal(decisionLabel(c), "Submitted");
  assert.equal(liveControls(c).length, 0, "the form fields are no longer live either");

  env.tools.applyPromptMessage({ type: "elicitation_request", requestId: "el-old", serverName: "x", message: "?" });
  env.tools.applyPromptMessage({ type: "elicitation_resolved", requestId: "el-old", action: "reject" });
  assert.equal(decisionLabel(cardFor(env, "el-old")), "Denied");
});
