"use strict";
// The effective environment narrows what an agent's session can do: Bedrock has
// no web search; a gateway behind a non-first-party base URL turns MCP tool
// search and Remote Control off. Each narrowing carries the reason shown beside
// the disabled control.

var test = require("node:test");
var assert = require("node:assert/strict");

var providerCapabilities = require("../lib/yoke/provider-capabilities");
var sessionCapabilities = require("../lib/session-capabilities");
var vendorRegistryMessage = require("../lib/vendor-registry-message");

function record(env, vendor) {
  var sm = {};
  var caps = sessionCapabilities.recordCapabilities(sm, vendor || "claude", null, env);
  return { sm: sm, caps: caps };
}

test("with no provider and no base URL, nothing is narrowed", function () {
  var r = record({});
  assert.equal(r.caps.webSearch, true);
  assert.equal(r.caps.mcpToolSearch, true);
  assert.equal(r.caps.remoteControl, true);
  assert.deepEqual(r.sm.capabilityReasonsByVendor.claude, {});
});

test("a first-party base URL narrows nothing", function () {
  var r = record({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
  assert.equal(r.caps.mcpToolSearch, true);
  assert.equal(r.caps.remoteControl, true);
});

test("Bedrock turns web search off and keeps the rest", function () {
  var r = record({ CLAUDE_CODE_USE_BEDROCK: "1" });
  assert.equal(r.caps.webSearch, false);
  assert.equal(r.caps.mcpToolSearch, true);
  assert.equal(r.caps.remoteControl, true);
  assert.match(r.sm.capabilityReasonsByVendor.claude.webSearch, /Amazon Bedrock/);
});

test("Vertex and Foundry narrow nothing by themselves", function () {
  assert.equal(record({ CLAUDE_CODE_USE_VERTEX: "1" }).caps.webSearch, true);
  assert.equal(record({ CLAUDE_CODE_USE_FOUNDRY: "1" }).caps.webSearch, true);
});

test("a non-first-party base URL turns MCP tool search and Remote Control off", function () {
  var r = record({ ANTHROPIC_BASE_URL: "https://gateway.example.invalid/v1" });
  assert.equal(r.caps.mcpToolSearch, false);
  assert.equal(r.caps.remoteControl, false);
  assert.equal(r.caps.webSearch, true);
  assert.match(r.sm.capabilityReasonsByVendor.claude.mcpToolSearch, /ANTHROPIC_BASE_URL/);
  assert.match(r.sm.capabilityReasonsByVendor.claude.remoteControl, /ANTHROPIC_BASE_URL/);
});

test("a base URL that does not parse is not first-party", function () {
  assert.equal(providerCapabilities.isFirstPartyBaseUrl("not a url"), false);
  assert.equal(record({ ANTHROPIC_BASE_URL: "not a url" }).caps.remoteControl, false);
});

test("an agent that never declared a capability is not changed by the narrowing", function () {
  var r = record({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BASE_URL: "https://gateway.example.invalid" }, "codex");
  assert.equal(r.caps.webSearch, false);
  assert.deepEqual(r.sm.capabilityReasonsByVendor.codex, {});
});

test("the registry message carries the narrowed capability and its reason to the client", function () {
  var r = record({ CLAUDE_CODE_USE_BEDROCK: "1" });
  var msg = vendorRegistryMessage.buildVendorRegistryMessage(r.sm, null);
  var claude = msg.vendors.filter(function (v) { return v.id === "claude"; })[0];
  assert.equal(claude.capabilities.webSearch, false);
  assert.match(claude.capabilityReasons.webSearch, /Amazon Bedrock/);
  var codex = msg.vendors.filter(function (v) { return v.id === "codex"; })[0];
  assert.equal(codex.capabilities.webSearch, false);
});
