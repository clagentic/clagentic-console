"use strict";
// The answer codecs the server and the client share (one body, two module
// wrappers): the two copies of each body are byte-identical, and the
// behaviour both copies give is pinned by one table per codec, run against
// each copy.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { pathToFileURL } = require("url");

var LIB = path.join(__dirname, "..", "lib");
var CODECS = ["ask-user-codec.js", "elicitation-codec.js"];
var OPEN = "// <shared-codec>";
var CLOSE = "// </shared-codec>";

function serverPath(name) { return path.join(LIB, "prompt-kinds", name); }
function clientPath(name) { return path.join(LIB, "public", "modules", "prompt-kinds", name); }

function sharedBody(file) {
  var text = fs.readFileSync(file, "utf8");
  var start = text.indexOf(OPEN);
  var end = text.indexOf(CLOSE);
  assert.ok(start !== -1 && end > start, file + " marks its shared body");
  assert.equal(text.indexOf(OPEN, start + 1), -1, file + " has one shared body");
  return text.slice(start, end + CLOSE.length);
}

async function bothCopies(name) {
  return [
    { where: "server", codec: require(serverPath(name)) },
    { where: "client", codec: await import(pathToFileURL(clientPath(name)).href) },
  ];
}

CODECS.forEach(function (name) {
  test(name + ": the server and client copies share one body, byte for byte", function () {
    assert.equal(sharedBody(serverPath(name)), sharedBody(clientPath(name)));
  });
});

test("both codecs bound typed text by the server's answer limit", async function () {
  var limits = require("../lib/prompt-kinds/answer-limits");
  for (var i = 0; i < CODECS.length; i++) {
    (await bothCopies(CODECS[i])).forEach(function (c) {
      assert.equal(c.codec.MAX_ANSWER_CHARS, limits.MAX_ANSWER_CHARS, CODECS[i] + " (" + c.where + ")");
    });
  }
});

// --- elicitation: JSON Schema field codec ----------------------------------

function field(codec, prop, required) {
  var schema = { type: "object", properties: { f: prop }, required: required ? ["f"] : [] };
  return codec.schemaFields(schema)[0];
}

// [property, control text, what it reads as]
var CONTROL_TABLE = [
  [{ type: "string" }, "", { absent: true }],
  [{ type: "string" }, "abc", { value: "abc" }],
  [{ type: "string" }, " ", { value: " " }],
  [{ type: "string", maxLength: 3 }, "abcd", { error: "is too long" }],
  [{}, "untyped", { value: "untyped" }],
  [{ type: "integer" }, "", { absent: true }],
  [{ type: "integer" }, "  ", { absent: true }],
  [{ type: "integer" }, "42", { value: 42 }],
  [{ type: "integer" }, "-3", { value: -3 }],
  [{ type: "integer" }, "1.5", { error: "must be a whole number" }],
  [{ type: "integer" }, "abc", { error: "must be a number" }],
  [{ type: "number" }, "0", { value: 0 }],
  [{ type: "number" }, "2.25", { value: 2.25 }],
  [{ type: "number" }, "Infinity", { error: "must be a number" }],
  [{ type: "boolean" }, "", { absent: true }],
  [{ type: "boolean" }, "true", { value: true }],
  [{ type: "boolean" }, "false", { value: false }],
  [{ type: "boolean" }, "yes", { error: "is not one of the choices" }],
  [{ type: "string", enum: ["eu", "us"] }, "", { absent: true }],
  [{ type: "string", enum: ["eu", "us"] }, "us", { value: "us" }],
  [{ type: "string", enum: ["eu", "us"] }, "mars", { error: "is not one of the choices" }],
  [{ type: "integer", enum: [1, 2] }, "2", { value: 2 }],
];

// [property, value, whether it is an answer to the property]
var CONFORM_TABLE = [
  [{ type: "string" }, "x", true],
  [{ type: "string" }, "", false],
  [{ type: "string" }, null, false],
  [{ type: "string" }, undefined, false],
  [{ type: "string" }, 5, false],
  [{ type: "string", maxLength: 2 }, "abc", false],
  [{ type: "integer" }, 3, true],
  [{ type: "integer" }, 3.5, false],
  [{ type: "integer" }, "3", false],
  [{ type: "number" }, 3.5, true],
  [{ type: "number" }, NaN, false],
  [{ type: "number" }, Infinity, false],
  [{ type: "boolean" }, false, true],
  [{ type: "boolean" }, "false", false],
  [{ type: "boolean" }, 0, false],
  [{ enum: ["a", "b"] }, "a", true],
  [{ enum: ["a", "b"] }, "c", false],
  [{ enum: [1, 2] }, "1", false],
];

test("elicitation codec: a control's text reads as a value of its field's type, absent, or an error", async function () {
  (await bothCopies("elicitation-codec.js")).forEach(function (c) {
    CONTROL_TABLE.forEach(function (row) {
      assert.deepEqual(c.codec.readControl(field(c.codec, row[0]), row[1]), row[2],
        c.where + ": " + JSON.stringify(row[0]) + " reading " + JSON.stringify(row[1]));
    });
  });
});

test("elicitation codec: which values answer a field", async function () {
  (await bothCopies("elicitation-codec.js")).forEach(function (c) {
    CONFORM_TABLE.forEach(function (row) {
      assert.equal(c.codec.conforms(field(c.codec, row[0]), row[1]), row[2],
        c.where + ": " + JSON.stringify(row[0]) + " with " + String(row[1]));
    });
  });
});

test("elicitation codec: a control starts from a default only when the default fits; booleans are a Yes/No choice", async function () {
  (await bothCopies("elicitation-codec.js")).forEach(function (c) {
    var k = c.codec;
    assert.equal(k.initialControlText(field(k, { type: "boolean" }, false)), "", c.where + ": an untouched optional boolean is unset");
    assert.equal(k.initialControlText(field(k, { type: "boolean" }, true)), "", c.where + ": so is a required one");
    assert.equal(k.initialControlText(field(k, { type: "boolean", default: false })), "false", c.where);
    assert.equal(k.initialControlText(field(k, { enum: ["a", "b"] }, true)), "", c.where + ": no choice is made for the operator");
    assert.equal(k.initialControlText(field(k, { enum: ["a", "b"], default: "b" })), "b", c.where);
    assert.equal(k.initialControlText(field(k, { type: "integer", default: 1.5 })), "", c.where + ": a default of the wrong type is not shown");
    assert.equal(k.initialControlText(field(k, { type: "string", maxLength: 2, default: "long" })), "", c.where);
    assert.deepEqual(field(k, { type: "boolean" }).choices, [true, false], c.where);
    assert.equal(k.choiceLabel(field(k, { type: "boolean" }), true), "Yes", c.where);
    assert.equal(k.choiceLabel(field(k, { type: "boolean" }), false), "No", c.where);
  });
});

var SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, count: { type: "integer" }, on: { type: "boolean" }, region: { enum: ["eu", "us"] } },
  required: ["name", "ghost"],
};

test("elicitation codec: the form's content is what was given, typed; empty is absent; a required field must be given", async function () {
  (await bothCopies("elicitation-codec.js")).forEach(function (c) {
    function texts(t) { return function (n) { return t[n]; }; }
    assert.deepEqual(c.codec.contentFromControls(SCHEMA, texts({ name: "a", count: "", on: "", region: "" })),
      { content: { name: "a" }, errors: [] }, c.where + ": untouched optional fields are absent, never \"\", 0 or false");
    assert.deepEqual(c.codec.contentFromControls(SCHEMA, texts({ name: "a", count: "4", on: "false", region: "us" })),
      { content: { name: "a", count: 4, on: false, region: "us" }, errors: [] }, c.where);
    assert.deepEqual(c.codec.contentFromControls(SCHEMA, texts({ name: "", count: "1.5" })),
      { content: {}, errors: ["name is required", "count must be a whole number"] }, c.where);
  });
});

test("elicitation codec: submitted content is held to the schema, and a missing required field is an error", async function () {
  (await bothCopies("elicitation-codec.js")).forEach(function (c) {
    assert.deepEqual(c.codec.contentForSchema(SCHEMA, { name: "a", count: 2, on: true, region: "eu", extra: 1 }),
      { content: { name: "a", count: 2, on: true, region: "eu" }, errors: [] }, c.where);
    assert.deepEqual(c.codec.contentForSchema(SCHEMA, { name: "a", count: "2", on: "true", region: "mars" }),
      { content: { name: "a" }, errors: [] }, c.where + ": values of the wrong type are dropped, never coerced");
    assert.deepEqual(c.codec.contentForSchema(SCHEMA, { count: 2 }), { content: { count: 2 }, errors: ["name is required"] }, c.where);
    assert.deepEqual(c.codec.contentForSchema(SCHEMA, { name: "" }), { content: {}, errors: ["name is required"] }, c.where + ": empty is absent");
    assert.deepEqual(c.codec.contentForSchema(SCHEMA, null), { content: {}, errors: ["name is required"] }, c.where);
    var protoSchema = { properties: JSON.parse('{"__proto__": {"type": "string"}}') };
    var held = c.codec.contentForSchema(protoSchema, JSON.parse('{"__proto__": "v"}'));
    assert.equal(Object.getOwnPropertyDescriptor(held.content, "__proto__").value, "v", c.where + ": a field named __proto__ is a key");
    assert.equal(Object.getPrototypeOf(held.content), Object.prototype, c.where);
  });
});

test("elicitation codec: a URL request is a URL request whatever its URL, and only an http(s) URL can be opened", async function () {
  (await bothCopies("elicitation-codec.js")).forEach(function (c) {
    assert.equal(c.codec.requestMode({ mode: "url", url: "" }), "url", c.where);
    assert.equal(c.codec.requestMode({ mode: "url" }), "url", c.where);
    assert.equal(c.codec.requestMode({ mode: "form" }), "form", c.where);
    assert.equal(c.codec.requestMode({}), "form", c.where);
    [["https://example.test/a", true], ["http://localhost:1/x", true], ["", false], [null, false],
      ["javascript:alert(1)", false], ["ftp://x.test/", false], ["not a url", false]].forEach(function (row) {
      assert.equal(c.codec.isOpenableUrl(row[0]), row[1], c.where + ": " + row[0]);
    });
  });
});

// --- ask-user: answer codec -------------------------------------------------

var MULTI = { question: "Targets?", multiSelect: true, options: [{ label: "a" }, { label: "b, c" }, { label: "a" }, { label: "d" }] };
var SINGLE = { question: "Pick?", options: [{ label: "x" }, { label: "y" }, { label: "x" }] };

test("ask-user codec: options sharing a label are one choice", async function () {
  (await bothCopies("ask-user-codec.js")).forEach(function (c) {
    assert.deepEqual(c.codec.choiceLabels(MULTI), ["a", "b, c", "d"], c.where);
    assert.deepEqual(c.codec.answerFromCard(MULTI, ["d", "a", "a"], ""), ["a", "d"], c.where + ": listed once, in choice order");
    assert.deepEqual(c.codec.normalizeAnswer(MULTI, ["d", "a", "a", "zz"]), ["d", "a"], c.where + ": an answer keeps its order, once each, choices only");
    assert.deepEqual(c.codec.readAnswer(MULTI, ["a"]), { labels: ["a"], other: "" }, c.where);
  });
});

// [question, card state (chosen, other), the answer]
var CARD_TABLE = [
  [MULTI, [], "", null],
  [MULTI, [], "   ", null],
  [MULTI, [], " typed ", "typed"],
  [MULTI, ["b, c"], "", ["b, c"]],
  [SINGLE, ["y"], "", "y"],
  [SINGLE, ["x"], "", "x"],
  [SINGLE, [], "other", "other"],
];

test("ask-user codec: the answer a card's state stands for", async function () {
  (await bothCopies("ask-user-codec.js")).forEach(function (c) {
    CARD_TABLE.forEach(function (row) {
      assert.deepEqual(c.codec.answerFromCard(row[0], row[1], row[2]), row[3], c.where + ": " + JSON.stringify(row.slice(1)));
    });
  });
});

test("ask-user codec: answers reach the tool keyed by question text, keeping every answer to questions that share it", async function () {
  (await bothCopies("ask-user-codec.js")).forEach(function (c) {
    var input = { questions: [{ question: "Same?" }, { question: "Other?" }, { question: "Same?" }, { question: "__proto__" }] };
    var out = c.codec.toolAnswers(input, { 0: "one", 1: ["p", "q"], 2: "three", 3: "proto" });
    assert.deepEqual(Object.keys(out), ["Same?", "Other?", "__proto__"], c.where);
    assert.equal(out["Same?"], "one, three", c.where);
    assert.equal(out["Other?"], "p, q", c.where);
    assert.equal(Object.getOwnPropertyDescriptor(out, "__proto__").value, "proto", c.where);
    assert.equal(Object.getPrototypeOf(out), Object.prototype, c.where);
  });
});

test("ask-user codec: a recorded answer reads back as choices or Other text, older joined strings included", async function () {
  (await bothCopies("ask-user-codec.js")).forEach(function (c) {
    assert.deepEqual(c.codec.readAnswer(MULTI, "a, b, c"), { labels: ["a", "b, c"], other: "" }, c.where);
    assert.deepEqual(c.codec.readAnswer(MULTI, "b, c"), { labels: ["b, c"], other: "" }, c.where);
    assert.deepEqual(c.codec.readAnswer(MULTI, "a, "), { labels: [], other: "a, " }, c.where);
    assert.deepEqual(c.codec.readAnswer(SINGLE, "free text"), { labels: [], other: "free text" }, c.where);
    assert.deepEqual(c.codec.readAnswer(SINGLE, "y"), { labels: ["y"], other: "" }, c.where);
  });
});
