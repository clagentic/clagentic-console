"use strict";
// A tool's input schema rebuilt from JSON schema must accept exactly what the
// JSON schema accepts. A shape the converter cannot reproduce makes the tool be
// left out and reported; it is never rebuilt looser than it was declared.

var test = require("node:test");
var assert = require("node:assert/strict");
var z = require("zod");
var { buildZodShape, UnsupportedSchemaError } = require("../lib/mcp-json-schema-to-zod");
var workerMcp = require("../lib/yoke/adapters/worker-mcp-servers");
var mcpToolSchema = require("../lib/mcp-tool-schema");

function accepts(inputSchema, value) {
  return z.object(buildZodShape(z, inputSchema)).safeParse(value).success;
}

function objectSchema(properties, required) {
  return { type: "object", properties: properties, required: required || [] };
}

test("an array of numbers rejects strings, and an array item keeps its own validation", function () {
  var schema = objectSchema({ ids: { type: "array", items: { type: "number" } } }, ["ids"]);
  assert.equal(accepts(schema, { ids: [1, 2, 3] }), true);
  assert.equal(accepts(schema, { ids: ["a"] }), false, "a string is not a number");
  assert.equal(accepts(schema, { ids: [1, "2"] }), false);
  assert.equal(accepts(schema, { ids: "1" }), false, "not an array at all");
});

test("a nested object rebuilds its own properties, required list and extra-property rule", function () {
  var schema = objectSchema({
    filter: {
      type: "object",
      properties: { name: { type: "string" }, limit: { type: "integer", minimum: 1 } },
      required: ["name"],
      additionalProperties: false,
    },
  }, ["filter"]);
  assert.equal(accepts(schema, { filter: { name: "a", limit: 2 } }), true);
  assert.equal(accepts(schema, { filter: { name: "a" } }), true, "limit is optional");
  assert.equal(accepts(schema, { filter: { limit: 2 } }), false, "name is required");
  assert.equal(accepts(schema, { filter: { name: 3 } }), false);
  assert.equal(accepts(schema, { filter: { name: "a", limit: 0 } }), false, "below the minimum");
  assert.equal(accepts(schema, { filter: { name: "a", limit: 1.5 } }), false, "an integer");
  assert.equal(accepts(schema, { filter: { name: "a", extra: true } }), false, "additionalProperties false");
});

test("a union (anyOf), a nullable type and an enum accept only their members", function () {
  var schema = objectSchema({
    id: { anyOf: [{ type: "string" }, { type: "number" }] },
    note: { type: ["string", "null"] },
    mode: { enum: ["fast", "slow"] },
  }, ["id", "note", "mode"]);
  assert.equal(accepts(schema, { id: "a", note: null, mode: "fast" }), true);
  assert.equal(accepts(schema, { id: 7, note: "x", mode: "slow" }), true);
  assert.equal(accepts(schema, { id: true, note: "x", mode: "slow" }), false, "neither member of the union");
  assert.equal(accepts(schema, { id: 1, note: 5, mode: "slow" }), false);
  assert.equal(accepts(schema, { id: 1, note: null, mode: "medium" }), false, "not in the enum");
});

test("an object with no declared properties accepts any object and nothing else", function () {
  var schema = objectSchema({ payload: { type: "object" } }, ["payload"]);
  assert.equal(accepts(schema, { payload: { a: 1, b: [2] } }), true);
  assert.equal(accepts(schema, { payload: "text" }), false);
  assert.equal(accepts(schema, { payload: [1] }), false);
});

test("string bounds and a pattern are kept", function () {
  var schema = objectSchema({ code: { type: "string", minLength: 2, maxLength: 3, pattern: "^[A-Z]+$" } }, ["code"]);
  assert.equal(accepts(schema, { code: "AB" }), true);
  assert.equal(accepts(schema, { code: "A" }), false);
  assert.equal(accepts(schema, { code: "ABCD" }), false);
  assert.equal(accepts(schema, { code: "ab" }), false);
});

test("annotations such as format and default do not stop a tool from being rebuilt", function () {
  var schema = objectSchema({ url: { type: "string", format: "uri", description: "where", default: "x" } }, ["url"]);
  assert.equal(accepts(schema, { url: "https://example.com" }), true);
  assert.equal(accepts(schema, { url: 5 }), false);
});

test("a shape that cannot be reproduced exactly is refused by name, never loosened", function () {
  [
    [{ $ref: "#/$defs/thing" }, /\$ref/],
    [{ oneOf: [{ type: "string" }, { type: "number" }] }, /oneOf/],
    [{ type: "array", items: { type: "string" }, uniqueItems: true }, /uniqueItems/],
    [{ type: "array", prefixItems: [{ type: "string" }] }, /prefixItems/],
    [{ type: "string", contentEncoding: "base64" }, /contentEncoding/],
    [{ type: "string", pattern: "(" }, /pattern/],
    [{ type: "mystery" }, /type 'mystery'/],
    [{ type: "array", items: { type: "object", properties: { deep: { not: { type: "string" } } } } }, /not/],
  ].forEach(function (pair) {
    assert.throws(function () {
      buildZodShape(z, objectSchema({ field: pair[0] }));
    }, function (err) {
      assert.equal(err.code, "UNSUPPORTED_SCHEMA");
      assert.match(err.message, pair[1]);
      assert.match(err.message, /field/, "the path names the property");
      return true;
    });
  });
  assert.equal(typeof UnsupportedSchemaError, "function");
});

test("worker rebuild: a tool whose schema cannot be reproduced is skipped with a diagnostic, the others are registered", function () {
  var registered = [];
  var sdk = {
    tool: function (name, description, shape) { registered.push({ name: name, shape: shape }); return { name: name }; },
    createSdkMcpServer: function (def) { return def; },
  };
  var reported = [];
  var originalError = console.error;
  console.error = function () {};
  var servers;
  try {
    servers = workerMcp.buildMcpServersFromDescriptors([{
      serverName: "files",
      tools: [
        { name: "list", description: "d", inputSchema: objectSchema({ ids: { type: "array", items: { type: "number" } } }, ["ids"]) },
        { name: "pick", description: "d", inputSchema: objectSchema({ choice: { oneOf: [{ type: "string" }, { type: "number" }] } }) },
      ],
    }], sdk, {
      loadZod: function () { return z; },
      createHandler: function () { return function () {}; },
      onSkipped: function (d) { reported.push(d); },
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(registered.map(function (r) { return r.name; }), ["list"]);
  assert.deepEqual(Object.keys(servers), ["files"]);
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /files\/pick/);
  assert.match(reported[0].message, /oneOf/);
  assert.equal(z.object(registered[0].shape).safeParse({ ids: ["a"] }).success, false, "the registered tool rejects strings in an array of numbers");
});

test("a zod that cannot be loaded is reported with the cause, for the worker and for the converter", function () {
  var originalError = console.error;
  console.error = function () {};
  var reported = [];
  try {
    workerMcp.buildMcpServersFromDescriptors(
      [{ serverName: "s", tools: [{ name: "t", inputSchema: objectSchema({}) }] }],
      { tool: function () { throw new Error("must not register"); }, createSdkMcpServer: function () { throw new Error("no server"); } },
      { loadZod: function () { throw new Error("Cannot find module 'zod' (corrupt install)"); }, createHandler: function () {}, onSkipped: function (d) { reported.push(d); } }
    );
    assert.equal(reported.length, 1);
    assert.match(reported[0].message, /zod could not be loaded in the worker: Cannot find module 'zod' \(corrupt install\)/);

    var converter = mcpToolSchema.loadToJSONSchema(function () { throw new Error("SyntaxError in zod/index.js"); });
    var converted = mcpToolSchema.convertToolInputSchema(converter, { inputSchema: z.object({ q: z.string() }) });
    assert.equal(converted.ok, false);
    assert.match(converted.error, /SyntaxError in zod\/index\.js/, "the load failure is the reported cause");

    var incompatible = mcpToolSchema.loadToJSONSchema(function () { return {}; });
    assert.match(mcpToolSchema.convertToolInputSchema(incompatible, { inputSchema: z.object({}) }).error, /no toJSONSchema/);

    var working = mcpToolSchema.loadToJSONSchema(function () { return z; });
    assert.equal(mcpToolSchema.convertToolInputSchema(working, { inputSchema: z.object({ q: z.string() }) }).ok, true);
  } finally {
    console.error = originalError;
  }
});
