"use strict";
// The client's side of prompt names that arrive from outside (a kind, a
// decision, a cancel reason, a tone): a name every object inherits
// (constructor, toString, __proto__, ...) is no entry of any of the card's
// tables, so it draws nothing, throws nothing, and reads as the card's
// fallback. And a settled card's outcome label is text, never markup.

var test = require("node:test");
var assert = require("node:assert/strict");
var dom = require("./fake-dom-prompt-cards");
var { setupToolsEnv, cardFor, decisionLabel } = dom;

var INHERITED = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"];

function planRequest(id) {
  return { type: "prompt_request", requestId: id, kind: "plan", toolName: "ExitPlanMode", toolInput: { plan: "p" }, decisionReason: "" };
}

test("a prompt of an inherited kind draws no card and throws nothing", async function (t) {
  var env = await setupToolsEnv(t);
  INHERITED.forEach(function (name) {
    var id = "kind-" + name;
    assert.doesNotThrow(function () {
      env.tools.applyPromptMessage({ type: "prompt_request", requestId: id, kind: name });
    }, name);
    assert.equal(cardFor(env, id), null, name + ": no card");
  });
});

test("an inherited decision or cancel reason reads as the card's fallback label", async function (t) {
  var env = await setupToolsEnv(t);
  INHERITED.forEach(function (name) {
    env.tools.applyPromptMessage(planRequest("plan-" + name));
    env.tools.applyPromptMessage({ type: "prompt_resolved", requestId: "plan-" + name, kind: "plan", decision: name });
    assert.equal(decisionLabel(cardFor(env, "plan-" + name)), "Allowed", "plan decision " + name);

    env.tools.applyPromptMessage(planRequest("cancel-" + name));
    env.tools.applyPromptMessage({ type: "prompt_cancel", requestId: "cancel-" + name, kind: "plan", reason: name });
    var c = cardFor(env, "cancel-" + name);
    assert.equal(decisionLabel(c), "Cancelled", "cancel reason " + name);
    assert.ok(c.classList.contains("resolved-cancelled"), "cancel reason " + name + ": the cancelled tone");
  });
});

test("an outcome with an inherited tone is drawn in the cancelled tone", async function () {
  dom.setupGlobals();
  var card = await import(dom.moduleUrl("prompt-card.js"));
  INHERITED.forEach(function (name) {
    var container = new dom.FakeElement("div");
    container.appendChild(Object.assign(new dom.FakeElement("div"), { className: "permission-actions" }));
    card.showOutcome(container, { text: "Done", tone: name });
    assert.deepEqual(container.className.split(" ").sort(), ["resolved", "resolved-cancelled"], name);
  });
});

test("a settled card's outcome label is text, never markup", async function () {
  dom.setupGlobals();
  var card = await import(dom.moduleUrl("prompt-card.js"));
  var container = new dom.FakeElement("div");
  var actions = Object.assign(new dom.FakeElement("div"), { className: "permission-actions" });
  container.appendChild(actions);
  var text = '<img src=x onerror="alert(1)">Allowed';

  card.showOutcome(container, { text: text, tone: "allowed" });

  assert.equal(actions.innerHTML, "", "no markup is written into the actions row");
  var label = actions.querySelector(".permission-decision-label");
  assert.ok(label, "the label is an element");
  assert.equal(label.textContent, text, "carrying the outcome as text");
});
