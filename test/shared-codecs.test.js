"use strict";
// The modules the server shares with the client: the answer codecs and the
// own-key lookups. Each has one source, the ES module the browser is served;
// the server imports that same module. The behaviour it gives is pinned by
// one table per codec.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { pathToFileURL } = require("url");
var { spawnSync } = require("child_process");
var codecs = require("../lib/prompt-kinds/codecs");

var LIB = path.join(__dirname, "..", "lib");
var PUBLIC_DIR = path.join(LIB, "public");
var MODULES_DIR = path.join(PUBLIC_DIR, "modules");
// accessor on lib/prompt-kinds/codecs.js -> the file the browser imports
var SHARED = { ownKey: "own-key.js", askUser: "ask-user-codec.js", elicitation: "elicitation-codec.js" };
// The codecs that bound typed text.
var ANSWER_CODECS = ["askUser", "elicitation"];

function browserPath(file) { return path.join(MODULES_DIR, "prompt-kinds", file); }

async function shared(accessor) {
  await codecs.load();
  return codecs[accessor]();
}

function jsFilesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(function (entry) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFilesUnder(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

// Every file a browser module imports, resolved as the browser resolves a
// relative specifier.
function browserImports() {
  var out = [];
  jsFilesUnder(MODULES_DIR).forEach(function (importer) {
    var source = fs.readFileSync(importer, "utf8");
    var re = /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g;
    var m;
    while ((m = re.exec(source))) out.push({ importer: importer, file: path.resolve(path.dirname(importer), m[1]) });
  });
  return out;
}

test("the server's shared codecs are the very modules the browser is served, and the server keeps no copy", async function () {
  var imports = browserImports();
  for (var accessor of Object.keys(SHARED)) {
    var file = browserPath(SHARED[accessor]);
    assert.ok(!path.relative(PUBLIC_DIR, file).startsWith(".."), SHARED[accessor] + " is under the static root the browser loads from");
    assert.ok(imports.some(function (i) { return i.file === file; }), "the browser imports " + SHARED[accessor] + " from that path");
    assert.equal(codecs.sourceUrl(accessor), pathToFileURL(file).href, accessor + " is loaded from the browser's file");
    var browserModule = await import(pathToFileURL(file).href);
    assert.equal(await shared(accessor), browserModule, accessor + ": one module instance, so the same exports");
    assert.equal(fs.existsSync(path.join(LIB, "prompt-kinds", SHARED[accessor])), false, "no server copy of " + SHARED[accessor]);
  }
});

test("where Node cannot require() an ES module, the codecs come through import(): unusable until load() settles, then the browser's modules", function () {
  var script = [
    "var codecs = require(" + JSON.stringify(path.join(LIB, "prompt-kinds", "codecs.js")) + ");",
    "var early;",
    "try { codecs.ownValue({ a: 1 }, 'a'); early = 'no error'; } catch (e) { early = e.message; }",
    "codecs.load().then(async function () {",
    "  var browser = await import(codecs.sourceUrl('ownKey'));",
    "  process.stdout.write(JSON.stringify({ early: early, same: codecs.ownKey() === browser, value: codecs.ownValue({ a: 1 }, 'a') }));",
    "});",
  ].join("\n");
  var run = spawnSync(process.execPath, ["--no-experimental-require-module", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  var got = JSON.parse(run.stdout);
  assert.match(got.early, /used before load\(\) finished/, "a codec read before load() throws");
  assert.equal(got.same, true, "import() yields the browser's module");
  assert.equal(got.value, 1);
});

test("both codecs bound typed text by the server's answer limit", async function () {
  var limits = require("../lib/prompt-kinds/answer-limits");
  for (var accessor of ANSWER_CODECS) {
    assert.equal((await shared(accessor)).MAX_ANSWER_CHARS, limits.MAX_ANSWER_CHARS, accessor);
  }
});

// --- own-key: lookups by names from outside --------------------------------

var INHERITED_NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "__defineGetter__"];

test("own-key: a map answers only the names it holds itself, and only for a string", async function () {
  var k = await shared("ownKey");
  var map = { allow: 1, zero: 0 };
  INHERITED_NAMES.forEach(function (name) {
    assert.equal(k.hasOwnKey(map, name), false, name);
    assert.equal(k.ownValue(map, name), undefined, name);
  });
  assert.equal(k.ownValue(map, "allow"), 1);
  assert.equal(k.hasOwnKey(map, "zero"), true, "a falsy value is still held");
  [["allow"], { toString: null }, 0, null, undefined, true].forEach(function (key) {
    assert.equal(k.hasOwnKey(map, key), false, JSON.stringify(key) + " is not a name");
    assert.equal(k.ownValue(map, key), undefined);
  });
  assert.equal(k.ownValue(null, "allow"), undefined, "no map holds nothing");
  assert.equal(k.ownValue(Object.create(null), "allow"), undefined);

  var store = {};
  k.putOwn(store, "__proto__", "entry");
  assert.equal(Object.getPrototypeOf(store), Object.prototype, "writing __proto__ leaves the prototype alone");
  assert.equal(k.ownValue(store, "__proto__"), "entry", "and reads back as an entry");
  assert.deepEqual(Object.keys(store), ["__proto__"]);
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
  var k = await shared("elicitation");
  CONTROL_TABLE.forEach(function (row) {
    assert.deepEqual(k.readControl(field(k, row[0]), row[1]), row[2], JSON.stringify(row[0]) + " reading " + JSON.stringify(row[1]));
  });
});

test("elicitation codec: which values answer a field", async function () {
  var k = await shared("elicitation");
  CONFORM_TABLE.forEach(function (row) {
    assert.equal(k.conforms(field(k, row[0]), row[1]), row[2], JSON.stringify(row[0]) + " with " + String(row[1]));
  });
});

test("elicitation codec: a control starts from a default only when the default fits; booleans are a Yes/No choice", async function () {
  var k = await shared("elicitation");
  assert.equal(k.initialControlText(field(k, { type: "boolean" }, false)), "", "an untouched optional boolean is unset");
  assert.equal(k.initialControlText(field(k, { type: "boolean" }, true)), "", "so is a required one");
  assert.equal(k.initialControlText(field(k, { type: "boolean", default: false })), "false");
  assert.equal(k.initialControlText(field(k, { enum: ["a", "b"] }, true)), "", "no choice is made for the operator");
  assert.equal(k.initialControlText(field(k, { enum: ["a", "b"], default: "b" })), "b");
  assert.equal(k.initialControlText(field(k, { type: "integer", default: 1.5 })), "", "a default of the wrong type is not shown");
  assert.equal(k.initialControlText(field(k, { type: "string", maxLength: 2, default: "long" })), "");
  assert.deepEqual(field(k, { type: "boolean" }).choices, [true, false]);
  assert.equal(k.choiceLabel(field(k, { type: "boolean" }), true), "Yes");
  assert.equal(k.choiceLabel(field(k, { type: "boolean" }), false), "No");
});

var SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, count: { type: "integer" }, on: { type: "boolean" }, region: { enum: ["eu", "us"] } },
  required: ["name", "ghost"],
};

test("elicitation codec: the form's content is what was given, typed; empty is absent; a required field must be given", async function () {
  var k = await shared("elicitation");
  function texts(t) { return function (n) { return t[n]; }; }
  assert.deepEqual(k.contentFromControls(SCHEMA, texts({ name: "a", count: "", on: "", region: "" })),
    { content: { name: "a" }, errors: [] }, "untouched optional fields are absent, never \"\", 0 or false");
  assert.deepEqual(k.contentFromControls(SCHEMA, texts({ name: "a", count: "4", on: "false", region: "us" })),
    { content: { name: "a", count: 4, on: false, region: "us" }, errors: [] });
  assert.deepEqual(k.contentFromControls(SCHEMA, texts({ name: "", count: "1.5" })),
    { content: {}, errors: ["name is required", "count must be a whole number"] });
});

test("elicitation codec: submitted content is held to the schema, and a missing required field is an error", async function () {
  var k = await shared("elicitation");
  assert.deepEqual(k.contentForSchema(SCHEMA, { name: "a", count: 2, on: true, region: "eu", extra: 1 }),
    { content: { name: "a", count: 2, on: true, region: "eu" }, errors: [] });
  assert.deepEqual(k.contentForSchema(SCHEMA, { name: "a", count: "2", on: "true", region: "mars" }),
    { content: { name: "a" }, errors: [] }, "values of the wrong type are dropped, never coerced");
  assert.deepEqual(k.contentForSchema(SCHEMA, { count: 2 }), { content: { count: 2 }, errors: ["name is required"] });
  assert.deepEqual(k.contentForSchema(SCHEMA, { name: "" }), { content: {}, errors: ["name is required"] }, "empty is absent");
  assert.deepEqual(k.contentForSchema(SCHEMA, null), { content: {}, errors: ["name is required"] });
  var protoSchema = { properties: JSON.parse('{"__proto__": {"type": "string"}}') };
  var held = k.contentForSchema(protoSchema, JSON.parse('{"__proto__": "v"}'));
  assert.equal(Object.getOwnPropertyDescriptor(held.content, "__proto__").value, "v", "a field named __proto__ is a key");
  assert.equal(Object.getPrototypeOf(held.content), Object.prototype);
});

// [schema, whether a form is drawn for it]: the MCP elicitation subset.
var SUBSET_TABLE = [
  [null, true],
  [undefined, true],
  [{ type: "object" }, true],
  [{ type: "object", properties: {} }, true],
  [{ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", title: "T", description: "D", additionalProperties: false, properties: { a: { type: "string" } }, required: ["a"] }, true],
  [{ type: "object", properties: { a: { type: "string", title: "A", description: "d", default: "x", minLength: 1, maxLength: 5 } } }, true],
  [{ type: "object", properties: { a: { type: "string", format: "email" }, b: { type: "string", format: "uri" }, c: { type: "string", format: "date" }, d: { type: "string", format: "date-time" } } }, true],
  [{ type: "object", properties: { a: { type: "number", minimum: -1.5, maximum: 2 }, b: { type: "integer", minimum: 0 }, c: { type: "boolean", default: true } } }, true],
  [{ type: "object", properties: { a: { type: "string", enum: ["x", "y"], enumNames: ["Ex", "Why"] } } }, true],
  [{ type: "array" }, false],
  [{ properties: { a: { type: "string" } } }, false],
  [[], false],
  [{ type: "object", properties: { a: { type: "string" } }, minProperties: 1 }, false],
  [{ type: "object", additionalProperties: { type: "string" } }, false],
  [{ type: "object", required: "a" }, false],
  [{ type: "object", properties: [] }, false],
  [{ type: "object", properties: { a: {} } }, false],
  [{ type: "object", properties: { a: "string" } }, false],
  [{ type: "object", properties: { a: { type: "object", properties: {} } } }, false],
  [{ type: "object", properties: { a: { type: "array", items: { type: "string" } } } }, false],
  [{ type: "object", properties: { a: { type: ["string", "null"] } } }, false],
  [{ type: "object", properties: { a: { type: "constructor" } } }, false],
  [{ type: "object", properties: { a: { type: "enum", enum: ["x"] } } }, false],
  [{ type: "object", properties: { a: { type: "string", pattern: "^x" } } }, false],
  [{ type: "object", properties: { a: { type: "string", format: "hostname" } } }, false],
  [{ type: "object", properties: { a: { type: "string", format: "toString" } } }, false],
  [{ type: "object", properties: { a: { type: "string", minLength: -1 } } }, false],
  [{ type: "object", properties: { a: { type: "string", minLength: 3, maxLength: 2 } } }, false],
  [{ type: "object", properties: { a: { type: "string", oneOf: [{ const: "x", title: "X" }] } } }, false],
  [{ type: "object", properties: { a: { type: "integer", enum: [1, 2] } } }, false],
  [{ enum: ["x"] }, false],
  [{ type: "object", properties: { a: { enum: ["x"] } } }, false],
  [{ type: "object", properties: { a: { type: "string", enum: [] } } }, false],
  [{ type: "object", properties: { a: { type: "string", enum: ["x", "y"], enumNames: ["Ex"] } } }, false],
  [{ type: "object", properties: { a: { type: "string", enum: ["x"], maxLength: 3 } } }, false],
  [{ type: "object", properties: { a: { type: "number", minimum: "1" } } }, false],
  [{ type: "object", properties: { a: { type: "number", minimum: 2, maximum: 1 } } }, false],
  [{ type: "object", properties: { a: { type: "integer", exclusiveMinimum: 0 } } }, false],
  [{ type: "object", properties: { a: { type: "boolean", enumNames: ["x"] } } }, false],
];

test("elicitation codec: a form is drawn only for a schema inside the MCP elicitation subset, and the reason names what is outside it", async function () {
  var k = await shared("elicitation");
  SUBSET_TABLE.forEach(function (row) {
    var problem = k.schemaProblem(row[0]);
    if (row[1]) assert.equal(problem, null, JSON.stringify(row[0]));
    else assert.ok(typeof problem === "string" && problem.length > 0, JSON.stringify(row[0]) + " is refused with a reason");
  });
  assert.match(k.schemaProblem({ type: "object", properties: { zone: { type: "string", pattern: "x" } } }), /zone: "pattern" is not supported/);
});

// [property, control text, what it reads as]: every constraint of the subset.
var CONSTRAINT_TABLE = [
  [{ type: "string", minLength: 2 }, "a", { error: "is too short" }],
  [{ type: "string", minLength: 2 }, "ab", { value: "ab" }],
  [{ type: "string", maxLength: 2 }, "\u{1F600}\u{1F600}", { value: "\u{1F600}\u{1F600}" }],
  [{ type: "string", maxLength: 1 }, "\u{1F600}\u{1F600}", { error: "is too long" }],
  [{ type: "string", format: "email" }, "a@b.test", { value: "a@b.test" }],
  [{ type: "string", format: "email" }, "a@", { error: "is not an email address" }],
  [{ type: "string", format: "email" }, "a b@c", { error: "is not an email address" }],
  [{ type: "string", format: "uri" }, "https://example.test/x", { value: "https://example.test/x" }],
  [{ type: "string", format: "uri" }, "urn:isbn:0451450523", { value: "urn:isbn:0451450523" }],
  [{ type: "string", format: "uri" }, "/relative/path", { error: "is not an absolute URI" }],
  [{ type: "string", format: "date" }, "2024-02-29", { value: "2024-02-29" }],
  [{ type: "string", format: "date" }, "2023-02-29", { error: "is not a date (YYYY-MM-DD)" }],
  [{ type: "string", format: "date" }, "2024-1-01", { error: "is not a date (YYYY-MM-DD)" }],
  [{ type: "string", format: "date-time" }, "2024-02-29T23:59:60Z", { value: "2024-02-29T23:59:60Z" }],
  [{ type: "string", format: "date-time" }, "2024-03-01T08:00:00.5+05:30", { value: "2024-03-01T08:00:00.5+05:30" }],
  [{ type: "string", format: "date-time" }, "2024-03-01T24:00:00Z", { error: "is not a date and time (YYYY-MM-DDThh:mm:ssZ)" }],
  [{ type: "string", format: "date-time" }, "2024-03-01 08:00:00Z", { error: "is not a date and time (YYYY-MM-DDThh:mm:ssZ)" }],
  [{ type: "integer", minimum: 1, maximum: 3 }, "0", { error: "must be at least 1" }],
  [{ type: "integer", minimum: 1, maximum: 3 }, "3", { value: 3 }],
  [{ type: "integer", minimum: 1, maximum: 3 }, "4", { error: "must be at most 3" }],
  [{ type: "number", minimum: -0.5 }, "-0.5", { value: -0.5 }],
  [{ type: "number", maximum: 2.5 }, "2.75", { error: "must be at most 2.5" }],
];

test("elicitation codec: every constraint of the subset is enforced on a control's text and on a submitted value", async function () {
  var k = await shared("elicitation");
  CONSTRAINT_TABLE.forEach(function (row) {
    var f = field(k, row[0]);
    var where = JSON.stringify(row[0]) + " reading " + JSON.stringify(row[1]);
    assert.deepEqual(k.readControl(f, row[1]), row[2], where);
    var submitted = row[0].type === "string" ? row[1] : Number(row[1]);
    assert.equal(k.conforms(f, submitted), !row[2].error, where + " (as a submitted value)");
  });
  var schema = { type: "object", properties: { n: { type: "integer", maximum: 3 }, d: { type: "string", format: "date" } }, required: ["d"] };
  assert.deepEqual(k.contentForSchema(schema, { n: 9, d: "2024-13-01" }), { content: {}, errors: ["d is required"] },
    "a value outside its constraints is dropped, and a required one leaves the answer incomplete");
  assert.equal(k.initialControlText(field(k, { type: "string", minLength: 3, default: "ab" })), "", "a default that misses a constraint is not shown");
});

test("elicitation codec: an enum choice reads by its enumNames entry", async function () {
  var k = await shared("elicitation");
  var f = field(k, { type: "string", enum: ["eu", "us"], enumNames: ["Europe", "United States"] });
  assert.equal(k.choiceLabel(f, "eu"), "Europe");
  assert.equal(k.choiceLabel(f, "us"), "United States");
  assert.deepEqual(k.readControl(f, "us"), { value: "us" }, "the value is still the enum value");
  assert.equal(k.choiceLabel(field(k, { type: "string", enum: ["eu"] }), "eu"), "eu");
});

test("elicitation codec: a URL request is a URL request whatever its URL, and only an http(s) URL can be opened", async function () {
  var k = await shared("elicitation");
  assert.equal(k.requestMode({ mode: "url", url: "" }), "url");
  assert.equal(k.requestMode({ mode: "url" }), "url");
  assert.equal(k.requestMode({ mode: "form" }), "form");
  assert.equal(k.requestMode({}), "form");
  [["https://example.test/a", true], ["http://localhost:1/x", true], ["", false], [null, false],
    ["javascript:alert(1)", false], ["ftp://x.test/", false], ["not a url", false]].forEach(function (row) {
    assert.equal(k.isOpenableUrl(row[0]), row[1], String(row[0]));
  });
});

// --- ask-user: answer codec -------------------------------------------------

var MULTI = { question: "Targets?", multiSelect: true, options: [{ label: "a" }, { label: "b, c" }, { label: "a" }, { label: "d" }] };
var SINGLE = { question: "Pick?", options: [{ label: "x" }, { label: "y" }, { label: "x" }] };

test("ask-user codec: options sharing a label are one choice", async function () {
  var k = await shared("askUser");
  assert.deepEqual(k.choiceLabels(MULTI), ["a", "b, c", "d"]);
  assert.deepEqual(k.answerFromCard(MULTI, ["d", "a", "a"], ""), ["a", "d"], "listed once, in choice order");
  assert.deepEqual(k.normalizeAnswer(MULTI, ["d", "a", "a", "zz"]), ["d", "a"], "an answer keeps its order, once each, choices only");
  assert.deepEqual(k.readAnswer(MULTI, ["a"]), { labels: ["a"], other: "" });
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
  var k = await shared("askUser");
  CARD_TABLE.forEach(function (row) {
    assert.deepEqual(k.answerFromCard(row[0], row[1], row[2]), row[3], JSON.stringify(row.slice(1)));
  });
});

test("ask-user codec: answers reach the tool keyed by question text, keeping every answer to questions that share it", async function () {
  var k = await shared("askUser");
  var input = { questions: [{ question: "Same?" }, { question: "Other?" }, { question: "Same?" }, { question: "__proto__" }] };
  var out = k.toolAnswers(input, { 0: "one", 1: ["p", "q"], 2: "three", 3: "proto" });
  assert.deepEqual(Object.keys(out), ["Same?", "Other?", "__proto__"]);
  assert.equal(out["Same?"], "one, three");
  assert.equal(out["Other?"], "p, q");
  assert.equal(Object.getOwnPropertyDescriptor(out, "__proto__").value, "proto");
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test("ask-user codec: a recorded answer reads back as choices or Other text, older joined strings included", async function () {
  var k = await shared("askUser");
  assert.deepEqual(k.readAnswer(MULTI, "a, b, c"), { labels: ["a", "b, c"], other: "" });
  assert.deepEqual(k.readAnswer(MULTI, "b, c"), { labels: ["b, c"], other: "" });
  assert.deepEqual(k.readAnswer(MULTI, "a, "), { labels: [], other: "a, " });
  assert.deepEqual(k.readAnswer(SINGLE, "free text"), { labels: [], other: "free text" });
  assert.deepEqual(k.readAnswer(SINGLE, "y"), { labels: ["y"], other: "" });
});
