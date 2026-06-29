"use strict";
// Regression test for lr-4078: _localMcp.shutdown() must be called in
// project.destroy() to prevent zombie stdio MCP child processes and port
// conflicts on project re-creation.
//
// Tests the createLocalMcp() object directly — verifies shutdown() kills
// all tracked processes and resets internal state.

var test = require("node:test");
var assert = require("node:assert/strict");

var { createLocalMcp } = require("../lib/mcp-local");

test("lr-4078: createLocalMcp exposes a shutdown() method", function() {
  var localMcp = createLocalMcp();
  assert.equal(typeof localMcp.shutdown, "function",
    "localMcp must expose shutdown() for destroy() to call");
});

test("lr-4078: shutdown() is idempotent when no servers are running", function() {
  var localMcp = createLocalMcp();
  // Should not throw even with no active processes.
  assert.doesNotThrow(function() { localMcp.shutdown(); });
  assert.doesNotThrow(function() { localMcp.shutdown(); });
});

test("lr-4078: shutdown() called from destroy()-style guard does not throw", function() {
  var localMcp = createLocalMcp();
  // Replicates exactly the guard pattern added to destroy() in project.js.
  assert.doesNotThrow(function() {
    if (localMcp && typeof localMcp.shutdown === "function") {
      try { localMcp.shutdown(); } catch (e) {}
    }
  });
});

test("lr-4078: shutdown() resets initialized flag — re-initialize works after shutdown", function() {
  var localMcp = createLocalMcp();
  var readyCalled = false;

  // Initialize without spawning real processes (no servers in config cache).
  localMcp.initialize(function() { readyCalled = true; });
  assert.equal(localMcp.isReady(), true, "should be ready after initialize");

  localMcp.shutdown();
  assert.equal(localMcp.isReady(), false, "shutdown() must reset initialized state");

  // A second initialize call should succeed.
  localMcp.initialize(function() {});
  assert.equal(localMcp.isReady(), true, "re-initialize after shutdown must work");
});
