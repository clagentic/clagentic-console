"use strict";
// An elicitation whose requested schema is outside the MCP elicitation
// subset (lib/prompt-kinds/elicitation-codec.js, docs/guides/architecture.md
// "Supported elicitation schemas") is refused whole: the card draws no form
// and offers only Deny, and the server never accepts it, so no answer that
// was checked against only part of the schema reaches the MCP server.

var test = require("node:test");
var assert = require("node:assert/strict");
var { createPromptRegistry } = require("../lib/prompt-registry");
var { setupToolsEnv, cardFor, decisionLabel, liveControls } = require("./fake-dom-prompt-cards");

var UNSUPPORTED = {
  type: "object",
  properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
  required: ["name"],
};

function makeRegistry() {
  var history = [];
  var session = { localId: 1, queryInstance: null };
  var registry = createPromptRegistry({
    index: {},
    getSession: function () { return session; },
    sendAndRecord: function (s, msg) { history.push(msg); },
    saveSessionFile: function () {},
  });
  return { registry: registry, session: session, history: history };
}

test("the server refuses an acceptance of a form outside the subset, says why, and still takes a decline", async function () {
  var h = makeRegistry();
  var opened = h.registry.open(h.session, "elicitation", { serverName: "srv", message: "?", requestedSchema: UNSUPPORTED });

  var outcome = h.registry.respond(opened.requestId, { action: "accept", content: { name: "a", tags: ["x"] } });
  assert.equal(outcome.status, "invalid");
  assert.match(outcome.reason, /outside the supported MCP elicitation schema/);
  assert.match(outcome.reason, /tags/, "the reason names the field outside the subset");
  assert.match(outcome.reason, /can only be declined/);
  assert.equal(outcome.pending.type, "prompt_pending", "the prompt is offered again");
  assert.equal(h.history.filter(function (m) { return m.type === "prompt_resolved"; }).length, 0, "nothing settled");

  assert.equal(h.registry.respond(opened.requestId, { action: "reject" }).status, "resolved");
  assert.deepEqual(await opened.answer, { action: "reject" });
});

test("the card draws no form for a schema outside the subset, says why, and offers only Deny", async function (t) {
  var env = await setupToolsEnv(t);
  env.tools.applyPromptMessage({
    type: "prompt_request", requestId: "el-out", kind: "elicitation", serverName: "deploy", message: "Details?",
    mode: "form", requestedSchema: UNSUPPORTED,
  });
  var c = cardFor(env, "el-out");

  assert.equal(c.querySelectorAll("[data-prop-name]").length, 0, "no field is drawn");
  var note = c.querySelector(".elicitation-unsupported");
  assert.ok(note, "the card says why");
  assert.match(note.textContent, /tags/);
  assert.match(note.textContent, /can only be declined/);
  assert.deepEqual(liveControls(c).map(function (el) { return el.className; }), ["permission-btn permission-deny"], "Deny is the only live control");

  c.querySelector(".permission-allow").click();
  assert.deepEqual(env.sent, [], "Submit sends nothing");
  c.querySelector(".permission-deny").click();
  assert.deepEqual(env.sent, [{ type: "prompt_response", requestId: "el-out", kind: "elicitation", action: "reject" }]);

  env.tools.applyPromptMessage({ type: "prompt_resolved", requestId: "el-out", kind: "elicitation", action: "reject" });
  assert.equal(decisionLabel(c), "Denied");
});

test("the card enforces the subset's constraints before anything is sent, and labels enum choices by enumNames", async function (t) {
  var env = await setupToolsEnv(t);
  env.tools.applyPromptMessage({
    type: "prompt_request", requestId: "el-in", kind: "elicitation", serverName: "deploy", message: "Details?", mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        count: { type: "integer", minimum: 1, maximum: 5 },
        size: { type: "string", enum: ["s", "l"], enumNames: ["Small", "Large"] },
      },
      required: ["email"],
    },
  });
  var c = cardFor(env, "el-in");
  var size = c.querySelector('[data-prop-name="size"]');
  assert.deepEqual(size._children.map(function (o) { return o.textContent; }), ["", "Small", "Large"]);

  c.querySelector('[data-prop-name="email"]').value = "not-an-address";
  c.querySelector('[data-prop-name="count"]').value = "9";
  c.querySelector(".permission-allow").click();
  assert.deepEqual(env.sent, [], "nothing is sent while a constraint is missed");
  assert.match(c.querySelector(".elicitation-error").textContent, /email is not an email address; count must be at most 5/);

  c.querySelector('[data-prop-name="email"]').value = "ops@example.test";
  c.querySelector('[data-prop-name="count"]').value = "5";
  size.value = "l";
  c.querySelector(".permission-allow").click();
  assert.deepEqual(env.sent, [{
    type: "prompt_response", requestId: "el-in", kind: "elicitation", action: "accept",
    content: { email: "ops@example.test", count: 5, size: "l" },
  }]);
});
