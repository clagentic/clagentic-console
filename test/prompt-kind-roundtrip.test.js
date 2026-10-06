"use strict";
// Round-trip property for every operator-prompt kind: what the operator
// chooses on a card survives the whole trip unchanged.
//
//   answer     the operator works the real card (lib/public/modules/
//              prompt-kinds/) and the client sends what it built;
//   settle     the real registry and kind adapter (lib/prompt-registry.js,
//              lib/prompt-kinds/) parse it, hand the vendor its answer and
//              record the outcome;
//   serialize  the recorded history goes through JSON, as it does on disk;
//   replay     a fresh client renders that history, in order with the
//              server's replay stamps and with the outcome arriving before
//              its request (paged history);
//   render     the live card and both replayed cards read back exactly what
//              the operator chose, and the vendor got exactly that answer.
//
// Each kind supplies a generator of operator actions and a reader for its
// card. A kind with no entry here fails the coverage test, so a new kind
// cannot ship without proving its own round trip.

var test = require("node:test");
var assert = require("node:assert/strict");
var dom = require("./fake-dom-prompt-cards");
var { createPromptRegistry } = require("../lib/prompt-registry");
var promptKinds = require("../lib/prompt-kinds");

var RUNS_PER_KIND = 60;

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function picker(rnd) {
  return {
    one: function (arr) { return arr[Math.floor(rnd() * arr.length)]; },
    chance: function (p) { return rnd() < p; },
    int: function (lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); },
    subset: function (arr) { return arr.filter(function () { return rnd() < 0.5; }); },
  };
}

function click(card, selector) {
  var el = card.querySelector(selector);
  assert.ok(el, "the card has " + selector);
  el.click();
}

// --- per-kind generators and readers --------------------------------------

var LABEL_POOL = ["staging", "prod", "staging, eu", "qa", "eu", "a, b", "b", "Other", "x"];

var SPECS = {
  permission: {
    request: function (p) {
      return {
        req: { toolName: p.one(["Bash", "Write"]), toolInput: { command: "make " + p.int(0, 9) }, decisionReason: "", vendor: "claude" },
      };
    },
    answer: function (card, p) {
      var choice = p.one([
        { selector: ".permission-allow, .perm-allow", label: "Allowed", allows: true },
        { selector: ".permission-allow-session, .perm-always", label: "Allowed for session", allows: true },
        { selector: ".permission-deny, .perm-deny", label: "Denied", allows: false },
      ]);
      click(card, choice.selector);
      return choice;
    },
    read: function (card) { return { label: dom.decisionLabel(card) }; },
    expectedRead: function (choice) { return { label: choice.label }; },
    checkVendor: function (outcome, choice, req) {
      assert.equal(outcome.behavior, choice.allows ? "allow" : "deny");
      if (choice.allows) assert.deepEqual(outcome.updatedInput, req.toolInput);
    },
  },

  plan: {
    request: function () {
      return { req: { toolName: "ExitPlanMode", toolInput: { plan: "ship it" }, decisionReason: "", vendor: "claude" } };
    },
    answer: function (card, p) {
      var choice = p.one([
        { selector: ".plan-btn-clear", label: "Approved (clear + auto-accept)", allows: false },
        { selector: ".permission-allow", label: "Approved (auto-accept)", allows: true },
        { selector: ".permission-allow-session", label: "Allowed", allows: true },
        { selector: ".permission-deny", label: "Denied", allows: false },
        { feedback: "use make test " + p.int(0, 9), label: "Feedback sent", allows: false },
      ]);
      if (choice.feedback) {
        dom.typeInto(card.querySelector(".plan-feedback-input"), choice.feedback);
        click(card, ".plan-feedback-send");
      } else {
        click(card, choice.selector);
      }
      return choice;
    },
    read: function (card) { return { label: dom.decisionLabel(card) }; },
    expectedRead: function (choice) { return { label: choice.label }; },
    checkVendor: function (outcome, choice) {
      assert.equal(outcome.behavior, choice.allows ? "allow" : "deny");
      if (choice.feedback) assert.equal(outcome.message, choice.feedback);
    },
  },

  ask_user: {
    request: function (p) {
      var questions = [];
      var count = p.int(1, 3);
      for (var i = 0; i < count; i++) {
        var labels = [];
        var want = p.int(2, 4);
        while (labels.length < want) {
          var l = p.one(LABEL_POOL);
          if (labels.indexOf(l) === -1) labels.push(l);
        }
        questions.push({
          question: "Question " + i + "?",
          multiSelect: p.chance(0.5),
          options: labels.map(function (label) { return { label: label }; }),
        });
      }
      return { req: { input: { questions: questions } } };
    },
    // Per question: leave it, choose, type "Other", type then clear, or
    // switch between the two; returns what the card should then say.
    answer: function (card, p, req) {
      var questions = req.input.questions;
      var qEls = card.querySelectorAll(".ask-user-question");
      var expected = [];
      questions.forEach(function (q, qi) {
        var qEl = qEls[qi];
        var optionEls = qEl.querySelectorAll(".ask-user-option");
        var other = qEl.querySelector(".ask-user-other input");
        var labels = q.options.map(function (o) { return o.label; });
        function choose() {
          var picked = q.multiSelect ? p.subset(labels) : [p.one(labels)];
          if (!picked.length) picked = [labels[0]];
          picked.forEach(function (label) { optionEls[labels.indexOf(label)].click(); });
          return labels.filter(function (label) { return picked.indexOf(label) !== -1; });
        }
        var text = "typed answer " + qi + " " + p.int(0, 999);
        var action = p.one(["leave", "choose", "other", "other-cleared", "other-then-choose", "choose-then-other"]);
        if (action === "leave") {
          expected.push({ labels: [], other: "" });
        } else if (action === "choose") {
          expected.push({ labels: choose(), other: "" });
        } else if (action === "other") {
          dom.typeInto(other, text);
          expected.push({ labels: [], other: text });
        } else if (action === "other-cleared") {
          dom.typeInto(other, text);
          dom.typeInto(other, "");
          expected.push({ labels: [], other: "" });
        } else if (action === "other-then-choose") {
          dom.typeInto(other, text);
          expected.push({ labels: choose(), other: "" });
        } else {
          choose();
          dom.typeInto(other, text);
          expected.push({ labels: [], other: text });
        }
      });
      var answered = expected.some(function (e) { return e.labels.length || e.other; });
      if (!answered || p.chance(0.1)) {
        click(card, ".ask-user-skip");
        return { skipped: true, label: "Skipped" };
      }
      click(card, ".ask-user-submit");
      return { skipped: false, questions: expected };
    },
    read: function (card) {
      var label = dom.decisionLabel(card);
      if (label) return { label: label };
      return {
        questions: card.querySelectorAll(".ask-user-question").map(function (qEl) {
          return {
            labels: qEl.querySelectorAll(".ask-user-option")
              .filter(function (o) { return o.classList.contains("selected"); })
              .map(function (o) { return o.querySelector(".option-label").textContent; }),
            other: qEl.querySelector(".ask-user-other input").value,
          };
        }),
      };
    },
    expectedRead: function (choice) {
      return choice.skipped ? { label: choice.label } : { questions: choice.questions };
    },
    checkVendor: function (outcome, choice, req) {
      if (choice.skipped) {
        assert.equal(outcome.behavior, "deny");
        return;
      }
      var want = {};
      req.input.questions.forEach(function (q, qi) {
        var e = choice.questions[qi];
        if (e.labels.length) want[q.question] = e.labels.join(", ");
        else if (e.other) want[q.question] = e.other;
      });
      assert.equal(outcome.behavior, "allow");
      assert.deepEqual(outcome.updatedInput.answers, want);
    },
  },

  elicitation: {
    request: function (p) {
      var properties = {};
      var required = [];
      var count = p.int(1, 4);
      for (var i = 0; i < count; i++) {
        var name = "f" + i;
        properties[name] = p.one([
          { type: "string" },
          { type: "integer" },
          { type: "number" },
          { type: "boolean" },
          { type: "string", enum: ["eu", "us", "apac"] },
        ]);
        if (p.chance(0.4)) required.push(name);
      }
      return { req: { serverName: "srv", message: "?", mode: "form", requestedSchema: { type: "object", properties: properties, required: required } } };
    },
    // Fills a random part of the form (always the required part), sometimes
    // with an integer field given a decimal first, which must be refused
    // before anything is sent.
    answer: function (card, p, req, sent) {
      if (p.chance(0.15)) {
        click(card, ".permission-deny");
        return { reject: true, label: "Denied" };
      }
      var props = req.requestedSchema.properties;
      var required = req.requestedSchema.required;
      var content = {};
      var badInteger = null;
      Object.keys(props).forEach(function (name) {
        var prop = props[name];
        var input = card.querySelector('[data-prop-name="' + name + '"]');
        var fill = required.indexOf(name) !== -1 || p.chance(0.5);
        if (prop.type === "boolean") {
          input.checked = p.chance(0.5);
          content[name] = input.checked;
        } else if (prop.enum) {
          if (fill) { input.value = p.one(prop.enum); content[name] = input.value; } else { input.value = ""; }
        } else if (!fill) {
          input.value = "";
        } else if (prop.type === "integer") {
          var n = p.int(-50, 50);
          if (!badInteger && p.chance(0.3)) badInteger = { input: input, value: String(n) };
          input.value = badInteger && badInteger.input === input ? n + ".5" : String(n);
          content[name] = n;
        } else if (prop.type === "number") {
          var x = p.int(-500, 500) / 4;
          input.value = String(x);
          content[name] = x;
        } else {
          input.value = "value " + p.int(0, 999);
          content[name] = input.value;
        }
      });
      if (badInteger) {
        var before = sent.length;
        click(card, ".permission-allow");
        assert.equal(sent.length, before, "a decimal in an integer field is refused before anything is sent");
        assert.ok(card.querySelector(".elicitation-error"), "and the operator is told why");
        badInteger.input.value = badInteger.value;
      }
      click(card, ".permission-allow");
      return { reject: false, label: "Submitted", content: content };
    },
    read: function (card) { return { label: dom.decisionLabel(card) }; },
    expectedRead: function (choice) { return { label: choice.label }; },
    checkVendor: function (outcome, choice) {
      if (choice.reject) {
        assert.deepEqual(outcome, { action: "reject" });
        return;
      }
      assert.deepEqual(outcome, { action: "accept", content: choice.content },
        "the server gets exactly the fields the operator gave, in their schema types");
    },
  },
};

// --- the trip --------------------------------------------------------------

function makeServer() {
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

function isPromptEvent(msg) {
  return msg.type === "prompt_request" || msg.type === "prompt_resolved" || msg.type === "prompt_cancel";
}

async function roundTrip(kind, seed) {
  var spec = SPECS[kind];
  var p = picker(mulberry32(seed));
  var where = kind + " seed " + seed;
  var server = makeServer();
  var opened = spec.request(p);
  var prompt = server.registry.open(server.session, kind, opened.req, { toolUseId: "tu-" + seed });

  // answer, on the live card the request event draws
  var live = await dom.createClient("roundtrip-live");
  var requestEvent = JSON.parse(JSON.stringify(server.history[0]));
  live.tools.applyPromptMessage(requestEvent);
  var card = dom.cardFor(live, prompt.requestId);
  assert.ok(card, where + ": the request draws a card");
  var choice = spec.answer(card, p, opened.req, live.sent);
  assert.equal(live.sent.length, 1, where + ": one answer is sent");
  var sent = JSON.parse(JSON.stringify(live.sent[0]));
  assert.equal(sent.kind, kind);

  // settle
  var outcome = server.registry.respond(sent.requestId, sent, { kinds: [sent.kind] });
  assert.equal(outcome.status, "resolved", where);
  spec.checkVendor(await prompt.answer, choice, opened.req);

  // serialize
  var stored = JSON.parse(JSON.stringify(server.history));
  var resolution = stored.filter(function (m) { return m.type === "prompt_resolved"; });
  assert.equal(resolution.length, 1, where + ": one outcome is recorded");

  // render: the live card, once the server confirms
  live.tools.applyPromptMessage(resolution[0]);
  var want = spec.expectedRead(choice);
  assert.deepEqual(spec.read(card), want, where + ": the live card shows the answer given");

  // replay in order, with the server's stamps
  var replay = await dom.createClient("roundtrip-replay");
  var annotate = server.registry.replayAnnotator(server.session, stored, 0);
  stored.filter(isPromptEvent).forEach(function (m) { replay.tools.applyPromptMessage(annotate(m)); });
  assert.deepEqual(spec.read(dom.cardFor(replay, prompt.requestId)), want, where + ": a replayed card shows the same answer");

  // replay with the outcome on a newer page than its request
  var paged = await dom.createClient("roundtrip-paged");
  paged.tools.applyPromptMessage(resolution[0]);
  paged.tools.resetToolState();
  paged.tools.applyPromptMessage(requestEvent);
  assert.deepEqual(spec.read(dom.cardFor(paged, prompt.requestId)), want, where + ": a card paged in after its outcome shows the same answer");
}

test("every operator-facing prompt kind has a round-trip spec, on the server and in the client", async function () {
  dom.setupGlobals();
  var { PROMPT_KINDS } = await import(dom.moduleUrl("prompt-kinds/index.js"));
  var serverKinds = Object.keys(promptKinds.KINDS).filter(function (k) { return promptKinds.KINDS[k].journal; });
  assert.deepEqual(serverKinds.sort(), Object.keys(SPECS).sort(), "a kind the operator answers needs a round-trip spec here");
  assert.deepEqual(Object.keys(PROMPT_KINDS).sort(), Object.keys(SPECS).sort(), "every client card kind needs a round-trip spec here");
});

Object.keys(SPECS).forEach(function (kind) {
  test("round trip, " + kind + ": the operator's answer survives answer, settle, serialize, replay and render", async function (t) {
    await dom.setupToolsEnv(t);
    for (var seed = 1; seed <= RUNS_PER_KIND; seed++) {
      await roundTrip(kind, seed);
    }
  });
});
