"use strict";
// A tool recreated from its JSON schema must accept exactly what the JSON
// schema accepts. zod's converter describes the parameters to the model; ajv
// decides validity. A schema neither can read makes the tool be left out and
// reported; it is never registered looser than it was declared.

var test = require("node:test");
var assert = require("node:assert/strict");
var z = require("zod");
var { prepareTool } = require("../lib/mcp-tool-input");
var workerMcp = require("../lib/yoke/adapters/worker-mcp-servers");
var mcpToolSchema = require("../lib/mcp-tool-schema");
var { attachMcp } = require("../lib/project-mcp");

// What the SDK does with a call: parse the arguments with the registered zod
// shape, then run the handler. Accepted means the handler ran without an error result.
async function accepts(inputSchema, value) {
  var prepared = prepareTool(z, inputSchema, function () { return { content: [{ type: "text", text: "ran" }] }; });
  var parsed = prepared.inputSchema.safeParse(value);
  if (!parsed.success) return false;
  var result = await prepared.handler(parsed.data, {});
  return !result.isError;
}

function objectSchema(properties, required) {
  return { type: "object", properties: properties, required: required || [] };
}

// The gate cases: each is a shape z.fromJSONSchema alone widens or mishandles.
// They are the reason ajv decides validity.

test("gate: required with empty properties rejects a missing key, at the root and nested", async function () {
  var rooted = prepareTool(z, { type: "object", required: ["q"] }, function () { return { content: [] }; });
  assert.equal((await rooted.handler({ q: "x" }, {})).isError, undefined);
  assert.equal((await rooted.handler({}, {})).isError, true, "root required, no properties");
  var nested = objectSchema({ opts: { type: "object", required: ["k"] } }, ["opts"]);
  assert.equal(await accepts(nested, { opts: { k: 1 } }), true);
  assert.equal(await accepts(nested, { opts: {} }), false, "nested required, no properties");
});

test("why ajv decides: zod's own converter alone accepts what these schemas reject", function () {
  var widened = [
    [{ type: "object", required: ["k"] }, {}],
    [{ type: "string", enum: ["fast", 1] }, 1],
    [{ type: "array", uniqueItems: true }, [1, 1]],
  ];
  widened.forEach(function (pair) {
    assert.equal(z.fromJSONSchema(pair[0]).safeParse(pair[1]).success, true, JSON.stringify(pair[0]));
  });
});

test("gate: a string enum rejects integer 1, also when the enum lists a mixed member", async function () {
  var plain = objectSchema({ mode: { type: "string", enum: ["fast", "slow"] } }, ["mode"]);
  assert.equal(await accepts(plain, { mode: "fast" }), true);
  assert.equal(await accepts(plain, { mode: 1 }), false);
  var mixed = objectSchema({ mode: { type: "string", enum: ["fast", 1] } }, ["mode"]);
  assert.equal(await accepts(mixed, { mode: "fast" }), true);
  assert.equal(await accepts(mixed, { mode: 1 }), false, "the type excludes the integer member");
});

test("gate: an array of numbers rejects strings", async function () {
  var schema = objectSchema({ ids: { type: "array", items: { type: "number" } } }, ["ids"]);
  assert.equal(await accepts(schema, { ids: [1, 2.5] }), true);
  assert.equal(await accepts(schema, { ids: ["a"] }), false);
  assert.equal(await accepts(schema, { ids: [1, "2"] }), false);
  assert.equal(await accepts(schema, { ids: "1" }), false);
});

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
  },
  required: ["home"],
};

test("gate: $defs with nested local $ref validates exactly", async function () {
  assert.equal(await accepts(MODEL_SCHEMA, { home: { city: "Boston", zip: "02101" } }), true);
  assert.equal(await accepts(MODEL_SCHEMA, { home: { city: "Boston" }, others: [{ city: "Salem" }] }), true);
  assert.equal(await accepts(MODEL_SCHEMA, {}), false, "home is required");
  assert.equal(await accepts(MODEL_SCHEMA, { home: { city: "" } }), false, "bound from the definition");
  assert.equal(await accepts(MODEL_SCHEMA, { home: { city: "B", zip: "12" } }), false, "pattern from the nested reference");
  assert.equal(await accepts(MODEL_SCHEMA, { home: { city: "B", extra: 1 } }), false, "additionalProperties from the definition");
  assert.equal(await accepts(MODEL_SCHEMA, { home: { city: "B" }, others: [{ city: 5 }] }), false, "a reference inside array items");
});

test("gate: a recursive $ref is validated exactly at every depth", async function () {
  var tree = {
    type: "object",
    $defs: { Node: { type: "object", properties: { name: { type: "string" }, kids: { type: "array", items: { $ref: "#/$defs/Node" } } }, required: ["name"] } },
    properties: { root: { $ref: "#/$defs/Node" } },
    required: ["root"],
  };
  assert.equal(await accepts(tree, { root: { name: "a", kids: [{ name: "b", kids: [{ name: "c" }] }] } }), true);
  assert.equal(await accepts(tree, { root: { name: "a", kids: [{ name: "b", kids: [{ name: 3 }] }] } }), false, "three levels down");
  assert.equal(await accepts(tree, { root: { name: "a", kids: [{}] } }), false, "a missing name in a child");
});

test("gate: oneOf accepts exactly one matching member", async function () {
  var schema = objectSchema({ v: { oneOf: [{ type: "number" }, { type: "integer" }] } }, ["v"]);
  assert.equal(await accepts(schema, { v: 1.5 }), true, "only the number member matches");
  assert.equal(await accepts(schema, { v: 1 }), false, "both members match");
  assert.equal(await accepts(schema, { v: "x" }), false, "no member matches");
});

test("gate: uniqueItems rejects duplicates", async function () {
  var schema = objectSchema({ tags: { type: "array", items: { type: "string" }, uniqueItems: true } }, ["tags"]);
  assert.equal(await accepts(schema, { tags: ["a", "b"] }), true);
  assert.equal(await accepts(schema, { tags: ["a", "a"] }), false);
});

test("nested objects, unions and nullable types keep their own rules", async function () {
  var schema = objectSchema({
    filter: {
      type: "object",
      properties: { name: { type: "string" }, limit: { type: "integer", minimum: 1 } },
      required: ["name"],
      additionalProperties: false,
    },
    id: { anyOf: [{ type: "string" }, { type: "number" }] },
    note: { type: ["string", "null"] },
  }, ["filter", "id", "note"]);
  assert.equal(await accepts(schema, { filter: { name: "a", limit: 2 }, id: "x", note: null }), true);
  assert.equal(await accepts(schema, { filter: { limit: 2 }, id: 1, note: "n" }), false, "name is required");
  assert.equal(await accepts(schema, { filter: { name: "a", limit: 0 }, id: 1, note: "n" }), false, "below the minimum");
  assert.equal(await accepts(schema, { filter: { name: "a", extra: true }, id: 1, note: "n" }), false, "additionalProperties false");
  assert.equal(await accepts(schema, { filter: { name: "a" }, id: true, note: "n" }), false, "neither member of the union");
  assert.equal(await accepts(schema, { filter: { name: "a" }, id: 1, note: 5 }), false);
});

test("format is an annotation: a value zod would reject as a url or email is still accepted", async function () {
  var schema = objectSchema({ url: { type: "string", format: "uri", description: "where", default: "x" }, format: { type: "string" } }, ["url"]);
  assert.equal(await accepts(schema, { url: "relative/path", format: "json" }), true);
  assert.equal(await accepts(schema, { url: 5 }), false);
});

test("a call that fails validation gets an error result and never reaches the tool", async function () {
  var calls = 0;
  var prepared = prepareTool(z, { type: "object", required: ["q"] }, function () { calls++; return { content: [] }; });
  var result = await prepared.handler({}, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Invalid arguments: .*required property 'q'/);
  assert.equal(calls, 0);
  await prepared.handler({ q: 1 }, {});
  assert.equal(calls, 1);
});

test("a tool declared with no input schema takes no parameters and is not wrapped", function () {
  var handler = function () {};
  var prepared = prepareTool(z, undefined, handler);
  assert.deepEqual(prepared.inputSchema, {});
  assert.equal(prepared.handler, handler);
});

test("a schema neither library can read throws instead of registering a looser tool", function () {
  [
    objectSchema({ field: { type: "mystery" } }),
    objectSchema({ field: { type: "string", pattern: "(" } }),
    objectSchema({ field: { $ref: "#/$defs/Missing" } }),
    objectSchema({ field: { not: { type: "string" } } }),
    "not an object",
    [],
  ].forEach(function (schema) {
    assert.throws(function () { prepareTool(z, schema, function () {}); });
  });
  assert.throws(function () { prepareTool({}, objectSchema({ a: { type: "string" } }), function () {}); }, /no fromJSONSchema/);
});

test("worker rebuild: a tool whose schema cannot be read is skipped with a diagnostic, the others are registered and validate", async function () {
  var registered = [];
  var sdk = {
    tool: function (name, description, inputSchema, handler) { registered.push({ name: name, inputSchema: inputSchema, handler: handler }); return { name: name }; },
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
        { name: "model", description: "d", inputSchema: MODEL_SCHEMA },
        { name: "broken", description: "d", inputSchema: objectSchema({ v: { type: "mystery" } }) },
      ],
    }], sdk, {
      loadZod: function () { return z; },
      createHandler: function () { return function () { return { content: [{ type: "text", text: "ran" }] }; }; },
      onSkipped: function (d) { reported.push(d); },
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(registered.map(function (r) { return r.name; }), ["list", "model"]);
  assert.deepEqual(Object.keys(servers), ["files"]);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].type, "diagnostic");
  assert.equal(reported[0].source, "mcp", "the source the diagnostics panel shows");
  assert.match(reported[0].message, /files\/broken/);
  var list = registered[0];
  assert.equal(list.inputSchema.safeParse({ ids: ["a"] }).success, false, "the described shape rejects strings in an array of numbers");
  assert.equal((await list.handler({ ids: [1] }, {})).isError, undefined);
  assert.equal((await registered[1].handler({ home: { city: "B", zip: "1" } }, {})).isError, true, "exact validation after the worker rebuild");
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

test("the registered recursive and referenced shapes still convert to JSON schema for the model", function () {
  var tree = {
    type: "object",
    $defs: { Node: { type: "object", properties: { kids: { type: "array", items: { $ref: "#/$defs/Node" } } } } },
    properties: { root: { $ref: "#/$defs/Node" } },
  };
  [tree, MODEL_SCHEMA].forEach(function (schema) {
    var prepared = prepareTool(z, schema, function () {});
    var converted = mcpToolSchema.convertToolInputSchema(z.toJSONSchema, { inputSchema: prepared.inputSchema });
    assert.equal(converted.ok, true, converted.error);
    assert.ok(converted.schema.properties, "the model sees the parameters");
  });
});

test("the project bridge sends the diagnostic to the panel for a skipped remote tool and registers a validating tool", async function () {
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
        { name: "broken", description: "d", inputSchema: objectSchema({ v: { type: "mystery" } }) },
      ],
    }] });
  } finally {
    console.error = originalError;
  }
  var diagnostics = sent.filter(function (m) { return m.type === "diagnostic"; });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].source, "mcp");
  assert.match(diagnostics[0].message, /srv\/broken/);
  var published = mcp.getMcpServers().srv;
  assert.ok(published, "the server with the readable tool is still published");
  var registered = published.instance._registeredTools;
  assert.deepEqual(Object.keys(registered), ["model"]);
});

// R18: the arguments ajv validates are the ones the model sent. The SDK parses
// a call with the schema it registered; these tests take that registered schema
// from the real SDK server and run the call the way the SDK does.

var REQUIRES_UNDECLARED = {
  type: "object",
  properties: { a: { type: "string" } },
  required: ["q"],
};

var CLOSED = {
  type: "object",
  properties: { a: { type: "string" } },
  required: ["a"],
  additionalProperties: false,
};

var OPEN = {
  type: "object",
  properties: { a: { type: "string" } },
  required: ["a"],
};

async function callRegistered(entry, args) {
  var parsed = entry.inputSchema.safeParse(args);
  if (!parsed.success) return { parseFailed: true };
  return entry.handler(parsed.data, {});
}

function workerTools() {
  var sdk = require("@anthropic-ai/claude-agent-sdk");
  var seen = [];
  var servers = workerMcp.buildMcpServersFromDescriptors([{
    serverName: "s",
    tools: [
      { name: "requires", description: "d", inputSchema: REQUIRES_UNDECLARED },
      { name: "closed", description: "d", inputSchema: CLOSED },
      { name: "open", description: "d", inputSchema: OPEN },
    ],
  }], sdk, {
    loadZod: function () { return z; },
    createHandler: function () { return function (args) { seen.push(args); return { content: [{ type: "text", text: "ran" }] }; }; },
  });
  return { tools: servers.s.instance._registeredTools, seen: seen };
}

test("R18 worker path: a required key absent from properties is accepted, an extra key is preserved or rejected as the schema says", async function () {
  var built = workerTools();
  var ok = await callRegistered(built.tools.requires, { q: "x", a: "y" });
  assert.equal(ok.isError, undefined, "q is required by the schema and was sent");
  assert.deepEqual(built.seen[0], { q: "x", a: "y" }, "the undeclared key reaches the tool");
  var missing = await callRegistered(built.tools.requires, { a: "y" });
  assert.equal(missing.isError, true, "q is still required");

  var open = await callRegistered(built.tools.open, { a: "y", extra: 1 });
  assert.equal(open.isError, undefined);
  assert.deepEqual(built.seen[1], { a: "y", extra: 1 }, "additionalProperties allowed: preserved");
  var closed = await callRegistered(built.tools.closed, { a: "y", extra: 1 });
  assert.equal(closed.isError, true, "additionalProperties false: rejected by ajv, not silently stripped");
  assert.match(closed.content[0].text, /additional properties/);
  assert.equal((await callRegistered(built.tools.closed, { a: "y" })).isError, undefined);
});

test("R18 project bridge: same cases through project-mcp.js", async function () {
  var sent = [];
  var ext = { readyState: 1 };
  var mcp = attachMcp({
    send: function () {},
    sendTo: function (ws, msg) { sent.push(msg); },
    slug: "p",
    getExtensionWs: function () { return ext; },
    getEnabledMcpServers: function () { return ["srv"]; },
    setEnabledMcpServers: function () {},
  });
  mcp.handleMcpMessage(ext, { type: "mcp_servers_available", hostConnected: true, servers: [{
    name: "srv",
    tools: [
      { name: "requires", description: "d", inputSchema: REQUIRES_UNDECLARED },
      { name: "closed", description: "d", inputSchema: CLOSED },
      { name: "open", description: "d", inputSchema: OPEN },
    ],
  }] });
  var tools = mcp.getMcpServers().srv.instance._registeredTools;

  // The extension echoes the call back as the result, so the test sees the
  // arguments the bridge forwarded.
  async function forwarded(name, args) {
    sent.length = 0;
    var pending = callRegistered(tools[name], args);
    await new Promise(function (resolve) { setImmediate(resolve); });
    var call = sent.find(function (m) { return m.type === "mcp_tool_call"; });
    if (!call) return { result: await pending, arguments: undefined };
    mcp.handleMcpMessage(ext, { type: "mcp_tool_result", callId: call.callId, result: { content: [{ type: "text", text: "ok" }] } });
    return { result: await pending, arguments: call.params.arguments };
  }

  var ok = await forwarded("requires", { q: "x", a: "y" });
  assert.equal(ok.result.isError, undefined);
  assert.deepEqual(ok.arguments, { q: "x", a: "y" });
  assert.equal((await forwarded("requires", { a: "y" })).result.isError, true);

  var open = await forwarded("open", { a: "y", extra: 1 });
  assert.deepEqual(open.arguments, { a: "y", extra: 1 });
  var closed = await forwarded("closed", { a: "y", extra: 1 });
  assert.equal(closed.result.isError, true);
  assert.equal(closed.arguments, undefined, "a rejected call never reaches the extension");
});
