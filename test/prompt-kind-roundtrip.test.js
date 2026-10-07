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
// Each kind supplies a generator of requests and operator actions and a
// reader for its card. A kind with no entry here fails the coverage test,
// so a new kind cannot ship without proving its own round trip. The
// generators vary the request as well as the answer: question sets with
// shared labels and shared question text, requested schemas of every field
// type and constraint of the MCP elicitation subset, required or optional,
// with and without defaults, schemas outside the subset (which can only be
// declined), and URL requests with usable and unusable URLs.

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

var OPENABLE_URLS = ["https://example.test/auth", "http://localhost:3000/callback"];
var URL_POOL = OPENABLE_URLS.concat(["", null, undefined, "javascript:alert(1)", "ftp://files.test/x", "not a url"]);

// Requested-schema properties of every field type and every constraint of
// the MCP elicitation subset, each sometimes with a default that fits it and
// sometimes with one that does not.
var FIELD_SHAPES = [
  { prop: { type: "string" }, defaults: ["preset", 5] },
  { prop: { type: "string", maxLength: 8 }, defaults: ["short", "far too long a default"] },
  { prop: { type: "string", minLength: 2, title: "Code", description: "two or more" }, defaults: ["ok", "x"] },
  { prop: { type: "string", format: "email" }, defaults: ["ops@example.test", "not an address"] },
  { prop: { type: "string", format: "uri" }, defaults: ["https://example.test/x", "relative/x"] },
  { prop: { type: "string", format: "date" }, defaults: ["2026-02-28", "2026-02-30"] },
  { prop: { type: "string", format: "date-time" }, defaults: ["2026-10-06T12:30:00Z", "2026-10-06 12:30"] },
  { prop: { type: "integer" }, defaults: [7, 1.5, "7"] },
  { prop: { type: "integer", minimum: 0, maximum: 10 }, defaults: [3, 11] },
  { prop: { type: "number" }, defaults: [2.25, "2.25"] },
  { prop: { type: "number", minimum: -2.5, maximum: 2.5 }, defaults: [0.5, 3] },
  { prop: { type: "boolean" }, defaults: [true, false, "yes"] },
  { prop: { type: "string", enum: ["eu", "us", "apac"] }, defaults: ["us", "mars"] },
  { prop: { type: "string", enum: ["s", "m", "l"], enumNames: ["Small", "Medium", "Large"] }, defaults: ["m", "xl"] },
];

// Properties outside the subset: a schema with any of them is refused whole.
var UNSUPPORTED_SHAPES = [
  {},
  { type: "integer", enum: [1, 2, 3] },
  { type: "string", pattern: "^[a-z]+$" },
  { type: "string", format: "hostname" },
  { type: "array", items: { type: "string", enum: ["a", "b"] } },
  { type: "object", properties: { inner: { type: "string" } } },
  { type: "string", oneOf: [{ const: "a", title: "A" }] },
];

function randomSchema(p) {
  var properties = {};
  var required = [];
  var count = p.int(1, 5);
  for (var i = 0; i < count; i++) {
    var name = "f" + i;
    var shape = p.one(FIELD_SHAPES);
    var prop = Object.assign({}, shape.prop);
    if (p.chance(0.4)) prop.default = p.one(shape.defaults);
    properties[name] = prop;
    if (p.chance(0.4)) required.push(name);
  }
  if (p.chance(0.1)) required.push("not-a-field");
  var schema = { type: "object", properties: properties };
  if (required.length || p.chance(0.5)) schema.required = required;
  return schema;
}

// A schema that is in the subset but for one property somewhere in it.
function unsupportedSchema(p) {
  var schema = randomSchema(p);
  var names = Object.keys(schema.properties);
  schema.properties[p.one(names)] = Object.assign({}, p.one(UNSUPPORTED_SHAPES));
  return schema;
}

// The test's own reading of the subset, independent of the codec under
// test: whether every property of schema is one this test generates as
// supported.
function inSubset(schema) {
  return Object.keys(schema.properties).every(function (name) {
    return FIELD_SHAPES.some(function (shape) {
      var prop = Object.assign({}, schema.properties[name]);
      delete prop.default;
      return JSON.stringify(prop) === JSON.stringify(shape.prop);
    });
  });
}

var FORMAT_CHECKS = {
  email: function (v) { return /^[^\s@]+@[^\s@]+$/.test(v); },
  uri: function (v) { return /^[a-z][a-z0-9+.-]*:\S+$/i.test(v); },
  date: function (v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var d = new Date(v + "T00:00:00Z");
    return !isNaN(d) && d.toISOString().slice(0, 10) === v;
  },
  "date-time": function (v) { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !isNaN(Date.parse(v)); },
};

// The test's own reading of the schema, independent of the codec under
// test: whether v is an answer to prop.
function fits(prop, v) {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(prop.enum)) return prop.enum.indexOf(v) !== -1;
  if (prop.type === "boolean") return typeof v === "boolean";
  if (prop.type === "integer" || prop.type === "number") {
    var ok = prop.type === "integer" ? Number.isInteger(v) : typeof v === "number" && Number.isFinite(v);
    return ok && !(v < prop.minimum) && !(v > prop.maximum);
  }
  if (typeof v !== "string") return false;
  if (prop.maxLength !== undefined && v.length > prop.maxLength) return false;
  if (prop.minLength !== undefined && v.length < prop.minLength) return false;
  return !prop.format || FORMAT_CHECKS[prop.format](v);
}

function validValue(p, prop) {
  if (Array.isArray(prop.enum)) return p.one(prop.enum);
  if (prop.type === "boolean") return p.chance(0.5);
  if (prop.type === "integer") return p.int(prop.minimum !== undefined ? prop.minimum : -50, prop.maximum !== undefined ? prop.maximum : 50);
  if (prop.type === "number") {
    return p.int(prop.minimum !== undefined ? prop.minimum * 4 : -500, prop.maximum !== undefined ? prop.maximum * 4 : 500) / 4;
  }
  switch (prop.format) {
    case "email": return "u" + p.int(0, 999) + "@example.test";
    case "uri": return "https://example.test/" + p.int(0, 999);
    case "date": return "2026-0" + p.int(1, 9) + "-" + (10 + p.int(0, 18));
    case "date-time": return "2026-10-0" + p.int(1, 9) + "T1" + p.int(0, 9) + ":" + (10 + p.int(0, 49)) + ":00Z";
  }
  return "v" + p.int(0, 999);
}

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
    // Options may repeat a label (one choice, which ever of them is
    // clicked) and questions may repeat their text (one slot in the tool's
    // answers, which must keep both answers).
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
        if (p.chance(0.3)) labels.splice(p.int(0, labels.length), 0, p.one(labels));
        questions.push({
          question: i > 0 && p.chance(0.25) ? questions[0].question : "Question " + i + "?",
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
        var optionLabels = q.options.map(function (o) { return o.label; });
        var labels = optionLabels.filter(function (l, i) { return optionLabels.indexOf(l) === i; });
        // Clicks one of the options carrying each picked label.
        function choose() {
          var picked = q.multiSelect ? p.subset(labels) : [p.one(labels)];
          if (!picked.length) picked = [labels[0]];
          picked.forEach(function (label) {
            var carriers = optionEls.filter(function (el, i) { return optionLabels[i] === label; });
            p.one(carriers).click();
          });
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
    // Which options show as selected (every one carrying a chosen label, no
    // other) and the "Other" text, per question.
    read: function (card) {
      var label = dom.decisionLabel(card);
      if (label) return { label: label };
      return {
        questions: card.querySelectorAll(".ask-user-question").map(function (qEl) {
          return {
            selected: qEl.querySelectorAll(".ask-user-option").map(function (o) { return o.classList.contains("selected"); }),
            other: qEl.querySelector(".ask-user-other input").value,
          };
        }),
      };
    },
    expectedRead: function (choice, req) {
      if (choice.skipped) return { label: choice.label };
      return {
        questions: req.input.questions.map(function (q, qi) {
          var e = choice.questions[qi];
          return {
            selected: q.options.map(function (o) { return e.labels.indexOf(o.label) !== -1; }),
            other: e.other,
          };
        }),
      };
    },
    checkVendor: function (outcome, choice, req) {
      if (choice.skipped) {
        assert.equal(outcome.behavior, "deny");
        return;
      }
      var want = {};
      req.input.questions.forEach(function (q, qi) {
        var e = choice.questions[qi];
        var given = e.labels.length ? e.labels.join(", ") : e.other;
        if (!given) return;
        want[q.question] = Object.prototype.hasOwnProperty.call(want, q.question) ? want[q.question] + ", " + given : given;
      });
      assert.equal(outcome.behavior, "allow");
      assert.deepEqual(outcome.updatedInput.answers, want, "every answer reaches the tool, questions sharing their text included");
    },
  },

  elicitation: {
    request: function (p) {
      if (p.chance(0.2)) {
        return {
          req: {
            serverName: "srv", message: "?", mode: "url", url: p.one(URL_POOL),
            requestedSchema: p.chance(0.5) ? randomSchema(p) : null,
          },
        };
      }
      var schema = p.chance(0.15) ? unsupportedSchema(p) : randomSchema(p);
      return { req: { serverName: "srv", message: "?", mode: p.one(["form", undefined]), requestedSchema: schema } };
    },
    // A URL request is approved only when its URL is a web page. A form is
    // worked field by field - filled, cleared, or left as drawn - with
    // Submit tried first while a required field is empty, or while an
    // integer field holds a decimal, both of which must be refused before
    // anything is sent.
    answer: function (card, p, req, sent) {
      var before = sent.length;
      if (req.mode === "url") {
        assert.equal(card.querySelectorAll("[data-prop-name]").length, 0, "a URL request draws no form");
        var openable = OPENABLE_URLS.indexOf(req.url) !== -1;
        if (openable && p.chance(0.7)) {
          global.window.open = function () {};
          click(card, ".permission-allow");
          return { reject: false, label: "Submitted", content: {} };
        }
        if (!openable) {
          card.querySelector(".permission-allow").click();
          assert.equal(sent.length, before, "a URL that is not a web page cannot be approved");
        }
        click(card, ".permission-deny");
        return { reject: true, label: "Denied" };
      }
      // A schema outside the subset draws no form, says why, and can only
      // be declined.
      if (!inSubset(req.requestedSchema)) {
        assert.equal(card.querySelectorAll("[data-prop-name]").length, 0, "a form outside the subset is not drawn");
        assert.ok(card.querySelector(".elicitation-unsupported"), "the card says why it cannot be answered");
        card.querySelector(".permission-allow").click();
        assert.equal(sent.length, before, "a form outside the subset cannot be submitted");
        click(card, ".permission-deny");
        return { reject: true, label: "Denied" };
      }
      if (p.chance(0.15)) {
        click(card, ".permission-deny");
        return { reject: true, label: "Denied" };
      }
      var schema = req.requestedSchema;
      var required = Array.isArray(schema.required) ? schema.required : [];
      var content = {};
      var unanswered = [];
      var badInteger = null;
      Object.keys(schema.properties).forEach(function (name) {
        var prop = schema.properties[name];
        var input = card.querySelector('[data-prop-name="' + name + '"]');
        var action = p.one(["fill", "clear", "untouched"]);
        if (action === "fill") {
          var value = validValue(p, prop);
          if (prop.type === "integer" && !prop.enum && !badInteger && p.chance(0.3)) {
            badInteger = { input: input, text: String(value) };
            input.value = value + ".5";
          } else {
            input.value = String(value);
          }
          content[name] = value;
        } else if (action === "clear") {
          input.value = "";
        } else if (fits(prop, prop.default)) {
          content[name] = prop.default;
        }
        if (required.indexOf(name) !== -1 && !Object.prototype.hasOwnProperty.call(content, name)) {
          unanswered.push({ name: name, prop: prop, input: input });
        }
      });
      if (badInteger || unanswered.length) {
        click(card, ".permission-allow");
        assert.equal(sent.length, before, "an empty required field or a decimal in an integer field is refused before anything is sent");
        assert.ok(card.querySelector(".elicitation-error"), "and the operator is told why");
        if (badInteger) badInteger.input.value = badInteger.text;
        unanswered.forEach(function (u) {
          var value = validValue(p, u.prop);
          u.input.value = String(value);
          content[u.name] = value;
        });
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

  var live = await dom.createClient("roundtrip-live");
  var requestEvent = JSON.parse(JSON.stringify(server.history[0]));
  live.tools.applyPromptMessage(requestEvent);
  var card = dom.cardFor(live, prompt.requestId);
  assert.ok(card, where + ": the request draws a card");
  var choice = spec.answer(card, p, opened.req, live.sent);
  assert.equal(live.sent.length, 1, where + ": one answer is sent");
  var sent = JSON.parse(JSON.stringify(live.sent[0]));
  assert.equal(sent.kind, kind);

  var outcome = server.registry.respond(sent.requestId, sent, { kinds: [sent.kind] });
  assert.equal(outcome.status, "resolved", where);
  spec.checkVendor(await prompt.answer, choice, opened.req);

  var stored = JSON.parse(JSON.stringify(server.history));
  var resolution = stored.filter(function (m) { return m.type === "prompt_resolved"; });
  assert.equal(resolution.length, 1, where + ": one outcome is recorded");

  live.tools.applyPromptMessage(resolution[0]);
  var want = spec.expectedRead(choice, opened.req);
  assert.deepEqual(spec.read(card), want, where + ": the live card shows the answer given");

  var replay = await dom.createClient("roundtrip-replay");
  var annotate = server.registry.replayAnnotator(server.session, stored, 0);
  stored.filter(isPromptEvent).forEach(function (m) { replay.tools.applyPromptMessage(annotate(m)); });
  assert.deepEqual(spec.read(dom.cardFor(replay, prompt.requestId)), want, where + ": a replayed card shows the same answer");

  // Paged history can deliver an outcome before the request it closes.
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

// An answer that did not come from the card (an older page, a hand-built
// frame) is held to the same schema: a value of the wrong type or outside
// its constraints never reaches the MCP server, and an acceptance missing a
// required field, of a schema outside the supported subset, or approving a
// URL that is not a web page, settles nothing.
test("elicitation answers that bypass the card are held to the requested schema", async function () {
  for (var seed = 1; seed <= RUNS_PER_KIND * 2; seed++) {
    var p = picker(mulberry32(1000 + seed));
    var where = "elicitation seed " + seed;
    var server = makeServer();
    var req = SPECS.elicitation.request(p).req;
    var submitted = {};
    var expected = {};
    var incomplete = false;
    if (req.mode === "url") {
      incomplete = OPENABLE_URLS.indexOf(req.url) === -1;
      submitted.injected = true;
    } else {
      var required = Array.isArray(req.requestedSchema.required) ? req.requestedSchema.required : [];
      Object.keys(req.requestedSchema.properties).forEach(function (name) {
        var prop = req.requestedSchema.properties[name];
        var given = p.one(["valid", "wrong", "empty", "null", "missing"]);
        if (given === "valid") submitted[name] = validValue(p, prop);
        else if (given === "wrong") submitted[name] = prop.type === "boolean" ? "true" : (prop.type === "string" || !prop.type) && !prop.enum ? 42 : "1";
        else if (given === "empty") submitted[name] = "";
        else if (given === "null") submitted[name] = null;
        if (fits(prop, submitted[name])) expected[name] = submitted[name];
        else if (required.indexOf(name) !== -1) incomplete = true;
      });
      if (p.chance(0.3)) submitted.extra = "x";
      // A form outside the subset is never accepted, whatever it carries.
      if (!inSubset(req.requestedSchema)) incomplete = true;
    }
    var prompt = server.registry.open(server.session, "elicitation", req);
    var outcome = server.registry.respond(prompt.requestId, { action: "accept", content: submitted });
    if (incomplete) {
      assert.equal(outcome.status, "invalid", where + ": an incomplete acceptance is refused");
      assert.equal(outcome.pending.type, "prompt_pending", where + ": and the prompt is offered again");
      assert.equal(server.history.filter(function (m) { return m.type === "prompt_resolved"; }).length, 0, where + ": nothing settled");
      assert.equal(server.registry.respond(prompt.requestId, { action: "reject" }).status, "resolved", where + ": it is still answerable");
      assert.deepEqual(await prompt.answer, { action: "reject" }, where);
    } else {
      assert.equal(outcome.status, "resolved", where);
      assert.deepEqual(await prompt.answer, { action: "accept", content: expected }, where + ": only the values that fit the schema reach the server");
    }
  }
});

Object.keys(SPECS).forEach(function (kind) {
  test("round trip, " + kind + ": the operator's answer survives answer, settle, serialize, replay and render", async function (t) {
    await dom.setupToolsEnv(t);
    for (var seed = 1; seed <= RUNS_PER_KIND; seed++) {
      await roundTrip(kind, seed);
    }
  });
});
