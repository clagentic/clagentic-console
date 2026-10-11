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
var { attachMcp } = require("../lib/project-mcp");

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

// A schema generated from a Python model: shared shapes under $defs, referenced
// from properties, from array items and from inside another definition.
var MODEL_SCHEMA = {
  type: "object",
  $defs: {
    Address: {
      type: "object",
      properties: { city: { type: "string", minLength: 1 }, zip: { $ref: "#/$defs/Zip" } },
      required: ["city"],
      additionalProperties: false,
    },
    Zip: { type: "string", pattern: "^[0-9]{5}$" },
  },
  properties: {
    home: { $ref: "#/$defs/Address" },
    others: { type: "array", items: { $ref: "#/$defs/Address" } },
    legacy: { $ref: "#/definitions/Old" },
  },
  definitions: { Old: { type: "integer", minimum: 0 } },
  required: ["home"],
};

test("local references are inlined and the result validates exactly", function () {
  assert.equal(accepts(MODEL_SCHEMA, { home: { city: "Boston", zip: "02101" } }), true);
  assert.equal(accepts(MODEL_SCHEMA, { home: { city: "Boston" }, others: [{ city: "Salem" }], legacy: 3 }), true);
  assert.equal(accepts(MODEL_SCHEMA, {}), false, "home is required");
  assert.equal(accepts(MODEL_SCHEMA, { home: { city: "" } }), false, "city bound from the definition");
  assert.equal(accepts(MODEL_SCHEMA, { home: { city: "B", zip: "12" } }), false, "pattern from a nested reference");
  assert.equal(accepts(MODEL_SCHEMA, { home: { city: "B", extra: 1 } }), false, "additionalProperties from the definition");
  assert.equal(accepts(MODEL_SCHEMA, { home: { city: "B" }, others: [{ city: 5 }] }), false, "a reference inside array items");
  assert.equal(accepts(MODEL_SCHEMA, { home: { city: "B" }, legacy: -1 }), false, "a definitions reference");
});

test("a description beside a reference is kept and other validation keywords beside it are refused", function () {
  var schema = { type: "object", $defs: { N: { type: "number" } }, properties: { n: { $ref: "#/$defs/N", description: "count" } } };
  assert.equal(accepts(schema, { n: 1 }), true);
  assert.equal(accepts(schema, { n: "1" }), false);
  var bad = { type: "object", $defs: { N: { type: "number" } }, properties: { n: { $ref: "#/$defs/N", minimum: 2 } } };
  assert.throws(function () { buildZodShape(z, bad); }, /keyword 'minimum' next to a \$ref/);
});

test("a recursive reference, a non-local reference and an undefined reference are refused by name", function () {
  var recursive = {
    type: "object",
    $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
    properties: { head: { $ref: "#/$defs/Node" } },
  };
  assert.throws(function () { buildZodShape(z, recursive); }, function (err) {
    assert.equal(err.code, "UNSUPPORTED_SCHEMA");
    assert.match(err.message, /\$ref/);
    assert.match(err.message, /recursive/);
    assert.match(err.message, /head\.next/, "the path names where the cycle closes");
    return true;
  });
  assert.throws(function () { buildZodShape(z, objectSchema({ a: { $ref: "https://example.com/s.json" } })); }, /not a local/);
  assert.throws(function () { buildZodShape(z, objectSchema({ a: { $ref: "#/$defs/Missing" } })); }, /not defined/);
  var shared = { type: "object", $defs: { S: { type: "string" } }, properties: { a: { $ref: "#/$defs/S" }, b: { $ref: "#/$defs/S" } } };
  assert.equal(accepts(shared, { a: "x", b: "y" }), true, "the same definition used twice is not a cycle");
});

test("the worker publishes a tool with local references and skips recursive and oneOf tools with a diagnostic naming the keyword", function () {
  var registered = [];
  var sdk = {
    tool: function (name, description, shape) { registered.push({ name: name, shape: shape }); return { name: name }; },
    createSdkMcpServer: function (def) { return def; },
  };
  var reported = [];
  var originalError = console.error;
  console.error = function () {};
  try {
    workerMcp.buildMcpServersFromDescriptors([{
      serverName: "py",
      tools: [
        { name: "model", description: "d", inputSchema: MODEL_SCHEMA },
        { name: "tree", description: "d", inputSchema: { type: "object", $defs: { T: { type: "object", properties: { kids: { type: "array", items: { $ref: "#/$defs/T" } } } } }, properties: { root: { $ref: "#/$defs/T" } } } },
        { name: "either", description: "d", inputSchema: objectSchema({ v: { oneOf: [{ type: "string" }, { type: "number" }] } }) },
      ],
    }], sdk, {
      loadZod: function () { return z; },
      createHandler: function () { return function () {}; },
      onSkipped: function (d) { reported.push(d); },
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(registered.map(function (r) { return r.name; }), ["model"]);
  assert.equal(z.object(registered[0].shape).safeParse({ home: { city: "B", zip: "1" } }).success, false, "exact validation after the worker rebuild");
  assert.equal(reported.length, 2);
  reported.forEach(function (d) {
    assert.equal(d.type, "diagnostic");
    assert.equal(d.source, "mcp", "the source the diagnostics panel shows");
  });
  assert.match(reported[0].message, /py\/tree/);
  assert.match(reported[0].message, /\$ref/);
  assert.match(reported[1].message, /py\/either/);
  assert.match(reported[1].message, /oneOf/);
});

test("the project bridge sends the diagnostic to the panel for a skipped remote tool and registers the tool with references", function () {
  var sent = [];
  var ext = { readyState: 1 };
  var mcp = attachMcp({
    send: function (msg) { sent.push(msg); },
    sendTo: function () {},
    slug: "p",
    getExtensionWs: function () { return ext; },
    getEnabledMcpServers: function () { return ["srv"]; },
    setEnabledMcpServers: function () {},
  });
  var originalError = console.error;
  console.error = function () {};
  try {
    mcp.handleMcpMessage(ext, { type: "mcp_servers_available", hostConnected: true, servers: [{
      name: "srv",
      tools: [
        { name: "model", description: "d", inputSchema: MODEL_SCHEMA },
        { name: "either", description: "d", inputSchema: objectSchema({ v: { oneOf: [{ type: "string" }] } }) },
      ],
    }] });
  } finally {
    console.error = originalError;
  }
  var diagnostics = sent.filter(function (m) { return m.type === "diagnostic"; });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].source, "mcp");
  assert.match(diagnostics[0].message, /srv\/either/);
  assert.match(diagnostics[0].message, /oneOf/);
  assert.ok(mcp.getMcpServers().srv, "the server with the convertible tool is still published");
});
