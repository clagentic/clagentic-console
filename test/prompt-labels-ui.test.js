"use strict";
// The client side of labelled prompts and scoped grants, on the real card,
// banner and grants-list modules over the hand-built DOM: the card and the
// banner say whose prompt it is and what Allow for session would grant, before
// the click, and the grants list offers a Revoke for each grant.

var test = require("node:test");
var assert = require("node:assert/strict");
var dom = require("./fake-dom-prompt-cards");

var LABEL = { project: "Project Alpha", session: "DO NOT ANSWER probe", agent: "scan the repository" };
var SCOPE = "Allow Bash commands starting with find in this session";

function request(id, extra) {
  return Object.assign({
    type: "prompt_request", requestId: id, kind: "permission", toolName: "Bash",
    toolInput: { command: "find /var/tmp" }, decisionReason: "", label: LABEL, grantScope: SCOPE,
  }, extra || {});
}

["bubble", "channel"].forEach(function (layout) {
  test("the " + layout + " card names the project, the session and the agent, and states the scope before the click", async function (t) {
    var env = await dom.setupToolsEnv(t);
    global.localStorage.setItem("clagentic-wide-view", layout);
    env.tools.applyPromptMessage(request("l1"));
    var card = dom.cardFor(env, "l1");
    var label = card.querySelector(".prompt-label");
    assert.ok(label, "the card carries a label");
    assert.equal(label.textContent, "Project: Project Alpha | Session: DO NOT ANSWER probe | Agent: scan the repository");
    var scope = card.querySelector(".permission-scope");
    assert.ok(scope, "the card states what Allow for session grants");
    assert.equal(scope.textContent, SCOPE);
    assert.ok(card.querySelector(".permission-allow-session, .perm-always"), "and offers the button it describes");
  });

  test("the " + layout + " card omits the scope sentence and Allow for session when there is nothing narrow to grant", async function (t) {
    var env = await dom.setupToolsEnv(t);
    global.localStorage.setItem("clagentic-wide-view", layout);
    env.tools.applyPromptMessage(request("l2", { grantScope: null, toolName: "Write", toolInput: { content: "x" } }));
    var card = dom.cardFor(env, "l2");
    assert.equal(card.querySelector(".permission-scope"), null);
    assert.equal(card.querySelector(".permission-allow-session, .perm-always"), null);
    assert.ok(card.querySelector(".permission-allow, .perm-allow"), "Allow once stays");
    assert.ok(card.querySelector(".prompt-label"), "the label stays");
  });

  test("the " + layout + " card for an older recorded request with no label or scope is drawn as before", async function (t) {
    var env = await dom.setupToolsEnv(t);
    global.localStorage.setItem("clagentic-wide-view", layout);
    env.tools.applyPromptMessage({ type: "prompt_request", requestId: "l3", kind: "permission", toolName: "Bash", toolInput: { command: "ls" }, decisionReason: "" });
    var card = dom.cardFor(env, "l3");
    assert.equal(card.querySelector(".prompt-label"), null);
    assert.equal(card.querySelector(".permission-scope"), null);
    assert.ok(card.querySelector(".permission-allow-session, .perm-always"), "the button is still offered");
  });
});

test("every kind of card carries the label", async function (t) {
  var env = await dom.setupToolsEnv(t);
  env.tools.applyPromptMessage({ type: "prompt_request", requestId: "k-plan", kind: "plan", toolName: "ExitPlanMode", toolInput: { plan: "p" }, label: LABEL });
  env.tools.applyPromptMessage({ type: "prompt_request", requestId: "k-el", kind: "elicitation", serverName: "srv", message: "?", label: LABEL });
  env.tools.applyPromptMessage({ type: "prompt_request", requestId: "k-ask", kind: "ask_user", input: { questions: [{ question: "Which?", options: [{ label: "a" }] }] }, toolUseId: "k-ask", label: LABEL });
  ["k-plan", "k-el", "k-ask"].forEach(function (id) {
    var card = dom.cardFor(env, id);
    assert.ok(card, id + " is drawn");
    assert.equal(card.querySelector(".prompt-label").textContent, "Project: Project Alpha | Session: DO NOT ANSWER probe | Agent: scan the repository", id);
  });
});

test("the label drops the parts that are absent and reads nothing that is not a string", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var label = await import(dom.moduleUrl("prompt-label.js"));
  assert.equal(label.promptLabelText({ project: "P", session: "S", agent: "" }), "Project: P | Session: S");
  assert.equal(label.promptLabelText({ project: 1, session: {}, agent: null }), "");
  assert.equal(label.promptLabelText(null), "");
  assert.equal(label.promptLabelHtml(null), "");
  assert.equal(label.promptLabelHtml({ project: "<b>x</b>", session: "S" }), '<div class="notif-banner-label">Project: &lt;b&gt;x&lt;/b&gt; | Session: S</div>', "escaped for the banner's innerHTML");
});

test("a banner states the scope for an ask that offers Allow for session, and only then", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var banner = await import(dom.moduleUrl("prompt-banner.js"));
  assert.equal(banner.bannerScope("permission", { grantScope: SCOPE }), SCOPE);
  assert.equal(banner.bannerScope("permission", { grantScope: SCOPE, suppressAlwaysAllowRule: true }), "", "no button, no promise");
  assert.equal(banner.bannerScope("permission", { grantScope: null }), "");
  assert.equal(banner.bannerScope("permission", {}), "");
  assert.equal(banner.bannerScope("plan", { grantScope: SCOPE }), "");
  var decisions = banner.bannerActions("permission", { grantScope: null }).map(function (a) { return a.decision; });
  assert.deepEqual(decisions, ["allow", "deny"], "a call with nothing narrow to grant offers no session choice");
});

test("the grants list draws one row per grant with a Revoke, marks whole-tool grants, and sends the revoke", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var mod = await import(dom.moduleUrl("session-grants.js"));
  var list = new dom.FakeElement("div");
  var sent = [];
  var grants = [
    { key: "Bash:find", tool: "Bash", wholeTool: false, text: "Bash commands starting with find" },
    { key: "Write", tool: "Write", wholeTool: true, text: "Every Write call, whatever it does (whole-tool grant)" },
  ];
  mod.renderGrantList(list, grants, 7, function (m) { sent.push(m); return true; });
  var rows = list.querySelectorAll(".session-grants-row");
  assert.equal(rows.length, 2);
  assert.ok(rows[1].classList.contains("session-grants-whole"), "a whole-tool grant is marked");
  assert.match(rows[1].textContent, /whole-tool/);
  rows[0].querySelector(".session-grants-revoke").click();
  assert.deepEqual(sent, [{ type: "revoke_session_grant", sessionId: 7, key: "Bash:find" }]);
  assert.equal(rows[0].querySelector(".session-grants-revoke").disabled, true, "disabled while the request is in flight");
  assert.equal(list.querySelectorAll(".session-grants-row").length, 2, "the row stays until the server confirms");

  mod.renderGrantList(list, [], 7, function () { return true; });
  assert.equal(list.querySelectorAll(".session-grants-row").length, 0);
  assert.match(list.textContent, /no Allow for session grants/);
});

test("a revoke whose send fails re-enables the button and says so, so it can be retried", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var mod = await import(dom.moduleUrl("session-grants.js"));
  var list = new dom.FakeElement("div");
  var attempts = 0;
  var grants = [{ key: "Bash:find", tool: "Bash", wholeTool: false, text: "Bash commands starting with find" }];
  mod.renderGrantList(list, grants, 7, function () { attempts++; return attempts > 1; });
  var button = list.querySelector(".session-grants-revoke");
  button.click();
  assert.equal(button.disabled, false, "a false sendMsg leaves the button usable");
  assert.match(list.querySelector(".session-grants-error").textContent, /Could not revoke/);
  assert.equal(list.querySelectorAll(".session-grants-row").length, 1, "the grant is still listed");
  button.click();
  assert.equal(attempts, 2);
  assert.equal(button.disabled, true, "the retry is in flight");
  assert.equal(list.querySelector(".session-grants-error").textContent, "", "the old failure is cleared");
});

test("a server refusal re-enables every Revoke and shows why; the server's list removes the row", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var mod = await import(dom.moduleUrl("session-grants.js"));
  var list = new dom.FakeElement("div");
  var grants = [
    { key: "Bash:find", tool: "Bash", wholeTool: false, text: "Bash commands starting with find" },
    { key: "Write", tool: "Write", wholeTool: true, text: "Every Write call (whole-tool grant)" },
  ];
  mod.renderGrantList(list, grants, 7, function () { return true; });
  list.querySelectorAll(".session-grants-revoke").forEach(function (b) { b.click(); });
  mod.showGrantError(list, "Could not revoke: that session is not available to you");
  list.querySelectorAll(".session-grants-revoke").forEach(function (b) { assert.equal(b.disabled, false); });
  assert.match(list.querySelector(".session-grants-error").textContent, /not available to you/);
  assert.equal(list.querySelectorAll(".session-grants-row").length, 2);

  mod.renderGrantList(list, [grants[1]], 7, function () { return true; });
  assert.equal(list.querySelectorAll(".session-grants-row").length, 1, "confirmed: the revoked row is gone");
  assert.equal(list.querySelector(".session-grants-error").textContent, "");
});
