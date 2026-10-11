"use strict";
// An MCP tool whose input schema cannot be converted is left out and reported,
// never published with an empty parameter list. Covers the in-process listing
// (Codex bridge), the descriptors sent to a worker process, and the worker's
// own rebuild of the schemas.

var test = require("node:test");
var assert = require("node:assert/strict");
var z = require("zod");
var { extractMcpDescriptors } = require("../lib/sdk-bridge");
var mcpToolSchema = require("../lib/mcp-tool-schema");
var workerMcp = require("../lib/yoke/adapters/worker-mcp-servers");

function serverWith(tools) {
  var registered = {};
  Object.keys(tools).forEach(function (name) {
    registered[name] = { description: name + " description", inputSchema: tools[name], handler: function () {} };
  });
  return { instance: { _registeredTools: registered } };
}

// A date cannot be represented in JSON schema, so zod refuses to convert it.
var UNCONVERTIBLE = z.object({ when: z.date() });
var CONVERTIBLE = z.object({ query: z.string() });

function captureConsoleError(fn) {
  var real = console.error;
  var lines = [];
  console.error = function () { lines.push(Array.prototype.join.call(arguments, " ")); };
  try { fn(); } finally { console.error = real; }
  return lines;
}

test("the sanity premise: zod really cannot convert the schema used here", function () {
  assert.throws(function () { z.toJSONSchema(UNCONVERTIBLE); });
  assert.doesNotThrow(function () { z.toJSONSchema(CONVERTIBLE); });
});

test("worker descriptors: an unconvertible tool is left out, named, and never given an empty schema", function () {
  var servers = { files: serverWith({ search: CONVERTIBLE, schedule: UNCONVERTIBLE }) };
  var skipped = [];
  var descriptors;
  var logged = captureConsoleError(function () {
    descriptors = extractMcpDescriptors(servers, function (d) { skipped.push(d); });
  });

  assert.equal(descriptors.length, 1);
  assert.deepEqual(descriptors[0].tools.map(function (t) { return t.name; }), ["search"]);
  descriptors[0].tools.forEach(function (t) {
    assert.ok(Object.keys(t.inputSchema.properties || {}).length > 0, t.name + " keeps its parameters");
  });

  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].type, "diagnostic");
  assert.equal(skipped[0].severity, "warning");
  assert.equal(skipped[0].source, "mcp");
  assert.match(skipped[0].message, /files\/schedule/);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /files\/schedule/);
});

test("worker descriptors: a server whose every tool is unconvertible contributes nothing", function () {
  var descriptors;
  captureConsoleError(function () {
    descriptors = extractMcpDescriptors({ only: serverWith({ schedule: UNCONVERTIBLE }) }, function () {});
  });
  assert.equal(descriptors, null);
});

test("worker descriptors: a tool declared without any schema takes no parameters and is not a failure", function () {
  var skipped = [];
  var descriptors = extractMcpDescriptors({ s: serverWith({ ping: undefined }) }, function (d) { skipped.push(d); });
  assert.deepEqual(descriptors[0].tools[0].inputSchema, { type: "object", properties: {} });
  assert.equal(skipped.length, 0);
});

test("worker descriptors: a missing schema converter is reported per tool, not hidden behind empty schemas", function () {
  var skipped = [];
  var descriptors;
  captureConsoleError(function () {
    descriptors = extractMcpDescriptors({ s: serverWith({ search: CONVERTIBLE }) }, function (d) { skipped.push(d); }, null);
  });
  assert.equal(descriptors, null);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].message, /converter is not available/);
});

test("in-process listing (Codex bridge): the same rule, through the shared lister", function () {
  var skipped = [];
  var tools;
  captureConsoleError(function () {
    tools = mcpToolSchema.listServerTools("files", serverWith({ search: CONVERTIBLE, schedule: UNCONVERTIBLE }), z.toJSONSchema, function (d) { skipped.push(d); });
  });
  assert.deepEqual(tools.map(function (t) { return t.name; }), ["search"]);
  assert.equal(skipped.length, 1);
  assert.deepEqual(mcpToolSchema.listServerTools("none", null, z.toJSONSchema, null), []);
});

test("worker rebuild: a descriptor the worker cannot turn into a schema is skipped and reported over IPC, the rest are registered", function () {
  var registered = [];
  var sdk = {
    tool: function (name, description, shape) { registered.push(name); return { name: name, shape: shape }; },
    createSdkMcpServer: function (def) { return { name: def.name, tools: def.tools }; },
  };
  var reported = [];
  var descriptors = [{
    serverName: "files",
    tools: [
      { name: "search", description: "d", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      // A property that is not a schema object: building its field throws.
      { name: "broken", description: "d", inputSchema: { type: "object", properties: { x: null } } },
    ],
  }];
  var servers;
  captureConsoleError(function () {
    servers = workerMcp.buildMcpServersFromDescriptors(descriptors, sdk, {
      loadZod: function () { return z; },
      createHandler: function () { return function () {}; },
      onSkipped: function (d) { reported.push(d); },
    });
  });
  assert.deepEqual(registered, ["search"]);
  assert.deepEqual(Object.keys(servers), ["files"]);
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /files\/broken/);
});

test("worker rebuild: zod missing in the worker reports every tool instead of silently dropping the server", function () {
  var sdk = { tool: function () { throw new Error("must not register"); }, createSdkMcpServer: function () { throw new Error("no server"); } };
  var reported = [];
  var servers;
  captureConsoleError(function () {
    servers = workerMcp.buildMcpServersFromDescriptors(
      [{ serverName: "s", tools: [{ name: "t", inputSchema: { type: "object", properties: {} } }] }],
      sdk,
      { loadZod: function () { return null; }, createHandler: function () {}, onSkipped: function (d) { reported.push(d); } }
    );
  });
  assert.equal(servers, null);
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /zod could not be loaded/);
});
