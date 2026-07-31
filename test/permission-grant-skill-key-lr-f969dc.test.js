"use strict";
// Regression tests for lr-f969dc: "Allow for session" on a Skill permission
// prompt did not scope to the specific skill that was approved.
//
// Root cause: session.allowedTools was keyed on the BARE tool name only
// (lib/project-sessions.js write site, lib/sdk-bridge.js:800 read site).
// Every distinct skill invocation (claude-api, lore-commit, ...) arrives as
// the SAME toolName "Skill" with a different `input.skill` discriminator, so
// keying on "Skill" alone meant approving ONE skill silently authorized
// EVERY skill for the rest of the session — a security regression, not the
// "doesn't stick" fix the grant was meant to provide. (MCP tools do not have
// this problem: their toolName already folds server + tool identity in,
// e.g. "mcp__browser__navigate" vs "mcp__browser__screenshot" are already
// distinct keys.)
//
// Fix: lib/utils.js's new permissionGrantKey(toolName, input) helper builds
// a composite "Skill:<skill>" key for the Skill tool (falling back to the
// bare tool name for every other tool, and for Skill calls missing a valid
// `input.skill` string). Both the write site (project-sessions.js's
// "allow_always" handler) and the read site (sdk-bridge.js's
// handleCanUseTool auto-approve check) now route through this single
// helper, so they can never diverge.
//
// This suite drives real production code (lib/sdk-bridge.js, lib/utils.js,
// lib/sessions.js) — no inline reimplementations of the keying/persist/
// restore/auto-approve logic.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createSDKBridge } = require("../lib/sdk-bridge");
var utils = require("../lib/utils");

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-f969dc-"));
}

function makeSessionManager(tmpHome) {
  // Bust require cache so a fresh instance picks up the temp CLAGENTIC_HOME.
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessionsModule;
  try {
    sessionsModule = require("../lib/sessions");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  return sessionsModule.createSessionManager({
    cwd: tmpHome,
    send: function () {},
    sendTo: function () {},
    sendEach: function () {},
  });
}

// Minimal adapter — handleCanUseTool never reaches the adapter for the
// auto-approve early-return path exercised here.
function makeAdapter() {
  return {
    vendor: "claude",
    createQuery: function () { throw new Error("not used in this test"); },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
  };
}

function makeBridge(sm) {
  var adapter = makeAdapter();
  return createSDKBridge({
    cwd: "/tmp/test-lr-f969dc",
    slug: "test-lr-f969dc",
    sessionManager: sm,
    send: function () {},
    adapter: adapter,
    adapters: { claude: adapter },
    onProcessingChanged: function () {},
  });
}

function makeOpts() {
  return { toolUseID: "tool-use-1", signal: null };
}

// --- permissionGrantKey unit coverage ---

test("lr-f969dc: permissionGrantKey builds a composite key for Skill + a valid discriminator", function () {
  assert.equal(utils.permissionGrantKey("Skill", { skill: "claude-api" }), "Skill:claude-api");
  assert.equal(utils.permissionGrantKey("Skill", { skill: "lore-commit" }), "Skill:lore-commit");
});

test("lr-f969dc: permissionGrantKey falls back to the bare tool name for non-Skill tools", function () {
  assert.equal(utils.permissionGrantKey("Bash", { command: "ls" }), "Bash");
  assert.equal(utils.permissionGrantKey("Edit", { file_path: "/tmp/x" }), "Edit");
  // MCP tools already fold server+tool identity into the name — no
  // discriminator needed, bare name is correct.
  assert.equal(utils.permissionGrantKey("mcp__browser__navigate", { url: "https://a" }), "mcp__browser__navigate");
});

test("lr-f969dc: permissionGrantKey fails closed to the bare 'Skill' key when the discriminator is missing/malformed", function () {
  assert.equal(utils.permissionGrantKey("Skill", {}), "Skill");
  assert.equal(utils.permissionGrantKey("Skill", null), "Skill");
  assert.equal(utils.permissionGrantKey("Skill", { skill: 123 }), "Skill");
  assert.equal(utils.permissionGrantKey("Skill", { skill: "" }), "Skill");
});

// --- End-to-end: grant one skill, a DIFFERENT skill still prompts ---

test("lr-f969dc: granting one skill auto-approves ONLY that skill — a different skill still prompts", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var session = sm.createSessionRaw({});
    session.cliSessionId = "sess-lr-f969dc-scoped";

    // Simulate the "allow_always" grant path (project-sessions.js) for the
    // claude-api skill specifically.
    session.allowedTools = {};
    session.allowedTools[utils.permissionGrantKey("Skill", { skill: "claude-api" })] = true;
    sm.saveSessionFile(session);

    var bridge = makeBridge(sm);
    session.pendingPermissions = {};

    return bridge.handleCanUseTool(session, "Skill", { skill: "claude-api" }, makeOpts()).then(function (result) {
      assert.equal(result.behavior, "allow", "the granted skill must auto-approve");
      assert.equal(Object.keys(session.pendingPermissions).length, 0,
        "no new permission_request for the granted skill");

      // A DIFFERENT skill (same toolName "Skill") must still prompt.
      bridge.handleCanUseTool(session, "Skill", { skill: "lore-commit" }, makeOpts());
      return new Promise(function (resolve) { setImmediate(resolve); }).then(function () {
        assert.equal(Object.keys(session.pendingPermissions).length, 1,
          "a DIFFERENT skill must still create a pending permission_request, not silently auto-approve");
        sm.flushSessionBuffer(session);
      });
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// --- Grant survives resume/restart, still scoped correctly ---

test("lr-f969dc: a Skill grant survives loadSessions() rehydration and stays scoped to that skill", function () {
  var tmpHome = makeTempHome();
  try {
    var sm1 = makeSessionManager(tmpHome);
    var session = sm1.createSessionRaw({});
    session.cliSessionId = "sess-lr-f969dc-rehydrate";
    session.allowedTools = {};
    session.allowedTools[utils.permissionGrantKey("Skill", { skill: "claude-api" })] = true;
    sm1.saveSessionFile(session);

    // Simulate the live session object going away (daemon restart) and being
    // rebuilt from durable state via loadSessions().
    var sm2 = makeSessionManager(tmpHome);
    var rebuilt = null;
    sm2.sessions.forEach(function (s) {
      if (s.cliSessionId === "sess-lr-f969dc-rehydrate") rebuilt = s;
    });
    assert.ok(rebuilt, "rebuilt session should be found after rehydration");
    assert.deepEqual(rebuilt.allowedTools, { "Skill:claude-api": true },
      "the composite Skill grant key must round-trip through persist/rehydrate intact");

    var bridge = makeBridge(sm2);
    rebuilt.pendingPermissions = {};

    return bridge.handleCanUseTool(rebuilt, "Skill", { skill: "claude-api" }, makeOpts()).then(function (result) {
      assert.equal(result.behavior, "allow", "the granted skill must auto-approve after rehydration");

      // A different skill must still prompt even after rehydration.
      bridge.handleCanUseTool(rebuilt, "Skill", { skill: "lore-commit" }, makeOpts());
      return new Promise(function (resolve) { resolve(); }).then(function () {
        return new Promise(function (resolve) { setImmediate(resolve); });
      }).then(function () {
        assert.equal(Object.keys(rebuilt.pendingPermissions).length, 1,
          "a different skill must still prompt after rehydration, not inherit the grant");
        sm2.flushSessionBuffer(rebuilt);
      });
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// --- resumeSession (leave-and-return) path stays scoped ---

test("lr-f969dc: resumeSession() hydrates a composite Skill grant and it stays scoped to that skill", function () {
  var tmpHome = makeTempHome();
  try {
    var sm = makeSessionManager(tmpHome);
    var resumed = sm.resumeSession("sess-lr-f969dc-resume", {
      history: [],
      title: "Resumed",
      allowedTools: { "Skill:claude-api": true },
    }, null);

    assert.deepEqual(resumed.allowedTools, { "Skill:claude-api": true },
      "resumeSession must hydrate the composite Skill grant key from opts");

    var bridge = makeBridge(sm);
    resumed.pendingPermissions = {};

    return bridge.handleCanUseTool(resumed, "Skill", { skill: "claude-api" }, makeOpts()).then(function (result) {
      assert.equal(result.behavior, "allow", "the granted skill must auto-approve after resume");

      bridge.handleCanUseTool(resumed, "Skill", { skill: "lore-commit" }, makeOpts());
      return new Promise(function (resolve) { setImmediate(resolve); }).then(function () {
        assert.equal(Object.keys(resumed.pendingPermissions).length, 1,
          "a different skill must still prompt after resume");
        sm.flushSessionBuffer(resumed);
      });
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// --- sanitizeAllowedTools compatibility (BOBBIE's lr-8b2e nit) ---

test("lr-f969dc: composite Skill keys survive sanitizeAllowedTools() — strict-boolean check only cares about the value shape", function () {
  var sanitized = utils.sanitizeAllowedTools({
    "Skill:claude-api": true,
    "Skill:lore-commit": true,
    "Skill": "yes", // malformed — non-boolean value must still be dropped
    "Bash": true,
  });
  assert.deepEqual(sanitized, {
    "Skill:claude-api": true,
    "Skill:lore-commit": true,
    "Bash": true,
  }, "composite keys are plain strings — the sanitizer's key-shape contract is unaffected by the ':' separator");
});

// --- Write-site behavior: project-sessions.js's "allow_always" handler ---
// (Exercised directly against the same keying helper the handler calls,
// since driving the full WS message-handler stack is out of scope for this
// unit-level suite — the lr-8b2e suite establishes that pattern.)

test("lr-f969dc: the write-site key for a Skill grant matches permissionGrantKey(toolName, toolInput)", function () {
  var pending = { toolName: "Skill", toolInput: { skill: "claude-api" } };
  var key = utils.permissionGrantKey(pending.toolName, pending.toolInput);
  assert.equal(key, "Skill:claude-api");

  // A different pending Skill request (same toolName, different input)
  // yields a different key, not the same one.
  var otherPending = { toolName: "Skill", toolInput: { skill: "lore-commit" } };
  var otherKey = utils.permissionGrantKey(otherPending.toolName, otherPending.toolInput);
  assert.notEqual(key, otherKey, "distinct skills must never collide onto the same grant key");
});
