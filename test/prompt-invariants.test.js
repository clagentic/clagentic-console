"use strict";
// Model-based invariant harness for the operator-prompt lifecycle, over every
// prompt kind: tool permissions, plan approval, AskUserQuestion and MCP
// elicitation.
//
// Generates interleavings of everything that touches a prompt - top-level and
// sub-agent prompts, Task spawn/notification/result, the parent turn's
// result, query end, WS answers from several clients (the current
// prompt_response and the older per-kind aliases), HTTP answers, aborts,
// disconnect/reconnect, history paging, user messages between request and
// answer, and daemon restart - against the real server modules (see
// prompt-harness-world.js) and the real client card code, and after every
// step checks:
//
//   I1  the server re-presents exactly the prompts it can still answer
//   I2  a prompt the server no longer holds never shows live controls on any
//       client, and no notification still offers it
//   I3  a pending prompt is answerable on every connected client
//   I4  an answer settles a pending prompt exactly once, with the operator's
//       answer; an answer to anything else is answered as stale
//   I5  Deny (or skip, or reject), and every ending that is not an answer,
//       stops the call
//   I6  only the prompt's own scope ends it: a top-level prompt may end with
//       its turn, a tracked sub-agent's prompt not with its parent's turn,
//       every prompt with its query (the vendor cancels the callbacks of a
//       closed query), and every prompt with the daemon
//   I7  Allow for Session auto-approves the same grant key afterwards, across
//       turns and restart, and nothing else
//   I8  every prompt that ends records exactly one terminal event
//   I9  an ask carrying the SDK's hints is held to them: Allow for session on
//       a suppressAlwaysAllowRule ask is refused on every path (the card and
//       its aliases, the banner) and writes no grant, and no standing approval
//       answers an ask marked suppressAlwaysAllowRule, defaultToNo or
//       matchedAskRule
//   I10 every settle carries a source: an answer its responder, a cancel one
//       of user, timeout, session_end, daemon_restart, worker or caller:<name>
//
// Set CLAGENTIC_CONSOLE_PROMPT_HARNESS_LIB to another checkout's lib/ to run the
// wire-level checks against it; the client render layer always exercises
// this checkout's tools.js, so it is skipped for a foreign lib. The named
// scenarios below are the shapes behind past regressions; `npm run
// test:prompt-history` runs them against the commits before and after each
// fix.

var nodeTest = require("node:test");
var test = nodeTest.test;
var assert = require("node:assert/strict");
var harness = require("./prompt-invariants-harness");
var world = harness.world;
var dom = harness.dom;
var RENDER = harness.RENDER;
var PROMPTS = harness.PROMPTS;
var BY_KIND = harness.BY_KIND;
var ANSWERS = harness.ANSWERS;
var Harness = harness.Harness;
var allows = harness.allows;
var freshDom = harness.freshDom;
var scenario = harness.scenario;

// --- named interleavings: the shapes behind past regressions -------------


// The guard that keeps a run honest: a step the lib cannot be sent is counted,
// and a run against this checkout fails on it instead of passing on a message
// that was never delivered.
test("a run against this checkout fails when a step it chose could not be sent", async function (t) {
  if (world.overridesLib) { t.skip("only meaningful against this checkout"); return; }
  if (RENDER) t.mock.timers.enable({ apis: ["setTimeout"] });
  await freshDom();
  var h = new Harness("unexpressible-guard");
  await h.init(1);
  try {
    var r = null;
    // A skip is expressible only as prompt_response, whatever the parity.
    await h.step(async function () { r = await h.request(BY_KIND.ask_user, null); });
    h.predatesPromptResponse = true;
    h.clients[0].view = null;
    await h.step(function () { return h.respond(h.clients[0], r, "skip"); });
    assert.equal(h.unexpressible, 1, "the lost step was counted");
    assert.deepEqual(h.violations, [], "and is no invariant violation by itself");
    assert.throws(function () { h.assertClean(); }, /every answer the run chose could be sent/);
  } finally {
    h.close();
  }
});

test("a prompt that settles without a source fails the run (I10)", async function (t) {
  if (world.overridesLib) { t.skip("only meaningful against this checkout"); return; }
  if (RENDER) t.mock.timers.enable({ apis: ["setTimeout"] });
  await freshDom();
  var h = new Harness("source-guard");
  await h.init(1);
  try {
    var r = null;
    await h.step(async function () { r = await h.request(PROMPTS[0], null); });
    h.auditor.inbox.push({ type: "prompt_cancel", requestId: r.id, kind: "permission", reason: "aborted" });
    h.drain(h.auditor);
    assert.match(h.violations.join("\n"), /was cancelled with no source \(I10\)/);
  } finally {
    h.close();
  }
});

test("a sub-agent's request survives its parent's turn result", async function (t) {
  await scenario(t, "subagent-vs-parent-result", 1, async function (h) {
    var task = null;
    await h.step(async function () { task = await h.spawnTask(); });
    await h.step(function () { return h.request(PROMPTS[0], task); });
    await h.step(function () { return h.turnResult(); });
    var r = h.pending()[0];
    if (!r) { h.fail("the sub-agent's request ended with the parent's turn (I6)"); return; }
    await h.step(function () { return h.respond(h.clients[0], r, "allow"); });
  });
});

test("a Task's completion before the operator answers keeps its request answerable", async function (t) {
  await scenario(t, "task-notification-before-answer", 2, async function (h) {
    var task = null;
    await h.step(async function () { task = await h.spawnTask(); });
    await h.step(function () { return h.request(PROMPTS[0], task); });
    await h.step(function () { return h.taskNotification(task); });
    await h.step(function () { return h.turnResult(); });
    var r = h.pending()[0];
    if (!r) { h.fail("the request ended before the operator answered (I6)"); return; }
    await h.step(function () { return h.respond(h.clients[1], r, "deny"); });
  });
});

test("Allow for Session survives a daemon restart", async function (t) {
  await scenario(t, "grant-across-restart", 1, async function (h) {
    var r = null;
    await h.step(async function () { r = await h.request(PROMPTS[1], null); });
    await h.step(function () { return h.respond(h.clients[0], r, "allow_always"); });
    await h.step(function () { return h.turnResult(); });
    await h.step(function () { return h.restart(); });
    await h.step(function () { return h.request(PROMPTS[1], null); });
  });
});

test("Allow for Session on one skill does not approve another", async function (t) {
  await scenario(t, "skill-grant-scope", 1, async function (h) {
    var r = null;
    await h.step(async function () { r = await h.request(PROMPTS[2], null); });
    await h.step(function () { return h.respond(h.clients[0], r, "allow_always"); });
    await h.step(function () { return h.request(PROMPTS[3], null); });
    await h.step(function () { return h.request(PROMPTS[2], null); });
  });
});

test("a second client's late response is answered and every banner retires", async function (t) {
  await scenario(t, "late-second-response", 2, async function (h) {
    var r = null;
    await h.step(async function () { r = await h.request(PROMPTS[0], null); });
    await h.step(function () { return h.respond(h.clients[0], r, "allow"); });
    await h.step(function () { return h.respond(h.clients[1], r, "deny"); });
  });
});

test("a request open across a daemon restart is not offered afterwards", async function (t) {
  await scenario(t, "pending-across-restart", 2, async function (h) {
    await h.step(function () { return h.request(PROMPTS[0], null); });
    await h.step(function () { return h.restart(); });
  });
});

test("a top-level prompt of every kind ended by its turn tells every client", async function (t) {
  await scenario(t, "turn-end-tells-clients", 2, async function (h) {
    for (var kind in BY_KIND) {
      await h.step(function () { return h.request(BY_KIND[kind], null); });
    }
    await h.step(function () { return h.turnResult(); });
  });
});

// Filler, then request, a user message, and the resolution: the first replay
// page starts at that user message, so it carries the resolution while the
// request only arrives on the older page.
test("paged replay never revives a resolved prompt, of any kind", async function (t) {
  var kinds = Object.keys(BY_KIND);
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    await scenario(t, "paged-replay " + kind, 2, async function (h) {
      var r = null;
      await h.step(function () { return h.userMessage(120); });
      await h.step(async function () { r = await h.request(BY_KIND[kind], null); });
      await h.step(function () { return h.userMessage(0); });
      await h.step(function () { return h.respond(h.clients[0], r, Object.keys(ANSWERS[kind])[0]); });
      await h.step(function () { return h.disconnect(h.clients[1]); });
      await h.step(function () { return h.reconnect(h.clients[1]); });
      if (h.clients[1].known[r.id] !== "settled") h.fail("the first page did not carry the resolution; the scenario lost its shape");
      if (RENDER && dom.cardFor(h.clients[1].view, r.id)) h.fail("the first page already carried the request; the scenario lost its shape");
      await h.step(function () { return h.pageOlder(h.clients[1]); });
      if (RENDER && !dom.cardFor(h.clients[1].view, r.id)) h.fail("paging never reached the request; the scenario lost its shape");
    });
    t.mock.timers.reset();
  }
});

test("an HTTP Allow for Session is refused and grants nothing; HTTP never answers a question", async function (t) {
  await scenario(t, "http-allow-always", 1, async function (h) {
    var r = null;
    var ask = null;
    await h.step(async function () { r = await h.request(PROMPTS[1], null); });
    await h.step(function () { return h.httpRespond(r, "allow_always"); });
    await h.step(function () { return h.httpRespond(r, "allow"); });
    await h.step(function () { return h.request(PROMPTS[1], null); });
    await h.step(async function () { ask = await h.request(BY_KIND.ask_user, null); });
    await h.step(function () { return h.httpRespond(ask, "allow"); });
  });
});

// A backgrounded sub-agent outlives its parent's turn while the query stays
// open: the operator must still be able to answer its prompt, and that answer
// settles it exactly once.
test("a backgrounded sub-agent's prompt survives its parent's turn result and is answered exactly once", async function (t) {
  var kinds = ["permission", "plan", "ask_user"];
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    await scenario(t, "subagent-across-turn-result " + kind, 2, async function (h) {
      var task = null;
      var r = null;
      await h.step(async function () { task = await h.spawnTask(); });
      await h.step(async function () { r = await h.request(BY_KIND[kind], task); });
      await h.step(function () { return h.turnResult(); });
      if (r.settled) { h.fail(r.id + " (" + kind + ") ended with its parent's turn (I6)"); return; }
      var answer = Object.keys(ANSWERS[kind])[0];
      await h.step(function () { return h.respond(h.clients[0], r, answer); });
      await h.step(function () { return h.respond(h.clients[1], r, answer); });
      if (!allows(r.outcome)) h.fail(r.id + " was answered " + answer + " but resolved as " + JSON.stringify(r.outcome));
    });
    t.mock.timers.reset();
  }
});

// The real Claude SDK cancels every callback still waiting when its query
// closes, a backgrounded sub-agent's included (and kills the process hosting
// that sub-agent), so no operator answer can reach it: the prompt ends denied
// and recorded, no card offers controls, and a later click is answered stale.
test("a query close cancels every pending prompt, a sub-agent's included; a later click is stale", async function (t) {
  var kinds = ["permission", "plan", "ask_user"];
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    await scenario(t, "query-close-cancels-everything " + kind, 2, async function (h) {
      var task = null;
      var sub = null;
      var top = null;
      await h.step(async function () { task = await h.spawnTask(); });
      await h.step(async function () { sub = await h.request(BY_KIND[kind], task); });
      await h.step(async function () { top = await h.request(BY_KIND[kind], null); });
      await h.step(function () { return h.turnResult(); });
      await h.step(function () { return h.queryEnd(); });
      [sub, top].forEach(function (r) {
        if (!r.settled) { h.fail(r.id + " (" + kind + ") outlived its closed query (I5)"); return; }
        if (allows(r.outcome)) h.fail(r.id + " (" + kind + ") ended with its query without stopping the call (I5)");
        h.clients.forEach(function (c) {
          var card = RENDER ? dom.cardFor(c.view, r.id) : null;
          if (card && dom.liveControls(card).length > 0) h.fail(c.name + " still offers controls on " + r.id + " after its query closed (I2)");
        });
      });
      var answer = Object.keys(ANSWERS[kind])[0];
      await h.step(function () { return h.respond(h.clients[0], sub, answer); });
      await h.step(function () { return h.respond(h.clients[1], top, answer); });
    });
    t.mock.timers.reset();
  }
});

test("a daemon restart ends every open prompt, of every kind and owner, denied and recorded", async function (t) {
  await scenario(t, "restart-ends-everything", 2, async function (h) {
    var task = null;
    await h.step(async function () { task = await h.spawnTask(); });
    for (var kind in BY_KIND) {
      await h.step(function () { return h.request(BY_KIND[kind], null); });
    }
    await h.step(function () { return h.request(BY_KIND.permission, task); });
    await h.step(function () { return h.request(BY_KIND.ask_user, task); });
    await h.step(function () { return h.restart(); });
  });
});

test("a stale answer of every kind, from either message shape, gets a reply", async function (t) {
  await scenario(t, "stale-answer-every-kind", 2, async function (h) {
    for (var kind in BY_KIND) {
      var r = null;
      await h.step(async function () { r = await h.request(BY_KIND[kind], null); });
      var answer = Object.keys(ANSWERS[kind])[0];
      await h.step(function () { return h.respond(h.clients[0], r, answer); });
      await h.step(function () { return h.respond(h.clients[1], r, answer); });
      h.toolSeq++;
      await h.step(function () { return h.respond(h.clients[1], r, answer); });
    }
  });
});
