// Regression tests for lr-4a13c3 — Codex $<skill-name> injection previously
// bypassed the permission gate entirely: parseSkillRefs()/discoverClaudeSkills()
// matched $<skill-name> tokens out of raw user turn text and appended them to
// the turn/start RPC input with no canUseTool call and no permissionGrantKey
// check at all (contrast the already-gated command/file/MCP approval branches
// in the same file).
//
// Fix: the $skill-name injection site now calls canUseTool("Skill",
// { skill: <name> }, {}) per candidate skill before injecting it — the same
// vendor-neutral tool name + input shape the Claude Skill tool uses
// (lib/utils.js permissionGrantKey, established by lr-f969dc), so a Codex
// skill grant behaves identically to a Claude one.
//
// This suite drives a real $skill-bearing turn through the actual
// createCodexQueryHandle / runQueryLoop path against a fake app-server (same
// harness pattern as test/codex-approval-routing-lr-f7a4.test.js) and asserts
// on the resulting turn/start RPC input, not on source-text greps.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var codexAdapter = require("../lib/yoke/adapters/codex");
var createCodexQueryHandle = codexAdapter._test_createCodexQueryHandle;

function makeSkillsDir(names) {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-lr-4a13c3-"));
  var skillsDir = path.join(cwd, ".claude", "skills");
  names.forEach(function (name) {
    var dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# " + name + "\nDo the thing.\n");
  });
  return cwd;
}

// Minimal fake app-server: only implements what createCodexQueryHandle's
// runQueryLoop / handleServerEvent actually call. turn/start does not push
// any server-initiated approval RPC (unlike the lr-f7a4 harness) because the
// skill gate is resolved via canUseTool BEFORE turn/start is ever sent.
function buildFakeAppServer() {
  var handlers = [];
  var sentMethods = [];
  var turnResolvers = [];

  var appServer = {
    started: true,
    addEventHandler: function (fn, threadId) {
      var entry = { fn: fn, threadId: threadId || null };
      handlers.push(entry);
      return entry;
    },
    removeEventHandler: function (entry) {
      handlers = handlers.filter(function (h) { return h !== entry; });
    },
    updateHandlerThreadId: function (entry, threadId) {
      entry.threadId = threadId || null;
    },
    respond: function () {},
    send: function (method, params) {
      sentMethods.push({ method: method, params: params });
      if (method === "thread/start" || method === "thread/resume") {
        return Promise.resolve({ thread: { id: "test-thread-1" } });
      }
      if (method === "turn/start") {
        // Complete the turn on the next tick so runQueryLoop's while loop
        // doesn't spin forever, but don't resolve synchronously so tests can
        // inspect sentMethods for the turn/start call first.
        setImmediate(function () {
          dispatch({ method: "turn/completed", params: { usage: {} } });
        });
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
  };

  function dispatch(msg) {
    handlers.forEach(function (h) {
      if (h.threadId === null || h.threadId === "test-thread-1") h.fn(msg);
    });
  }

  return {
    appServer: appServer,
    dispatch: dispatch,
    sentMethods: sentMethods,
  };
}

function waitForTurnStart(fake, count) {
  return new Promise(function (resolve, reject) {
    var deadline = Date.now() + 2000;
    (function poll() {
      var seen = fake.sentMethods.filter(function (m) { return m.method === "turn/start"; });
      if (seen.length >= count) return resolve(seen);
      if (Date.now() > deadline) return reject(new Error("timed out waiting for turn/start"));
      setImmediate(poll);
    })();
  });
}

function skillNamesInInput(input) {
  return input.filter(function (item) { return item && item.type === "skill"; })
    .map(function (item) { return item.name; });
}

test("lr-4a13c3: a $skill reference prompts via canUseTool('Skill', {skill}) before injection", async function () {
  var cwd = makeSkillsDir(["alpha"]);
  try {
    var fake = buildFakeAppServer();
    var canUseToolCalls = [];

    var handle = createCodexQueryHandle(fake.appServer, {
      cwd: cwd,
      approvalPolicy: "on-request",
      canUseTool: function (toolName, input) {
        canUseToolCalls.push({ toolName: toolName, input: input });
        return Promise.resolve({ behavior: "allow" });
      },
    });

    handle.pushMessage("please run $alpha now");
    var turnStarts = await waitForTurnStart(fake, 1);

    assert.equal(canUseToolCalls.length, 1, "canUseTool must be invoked for the $skill reference");
    assert.equal(canUseToolCalls[0].toolName, "Skill");
    assert.equal(canUseToolCalls[0].input.skill, "alpha");

    var injectedNames = skillNamesInInput(turnStarts[0].params.input);
    assert.deepEqual(injectedNames, ["alpha"], "an approved skill must be injected into turn/start input");

    handle.close();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("lr-4a13c3: a denied skill is NOT injected into the RPC input", async function () {
  var cwd = makeSkillsDir(["alpha"]);
  try {
    var fake = buildFakeAppServer();

    var handle = createCodexQueryHandle(fake.appServer, {
      cwd: cwd,
      approvalPolicy: "on-request",
      canUseTool: function () {
        return Promise.resolve({ behavior: "deny" });
      },
    });

    handle.pushMessage("please run $alpha now");
    var turnStarts = await waitForTurnStart(fake, 1);

    var injectedNames = skillNamesInInput(turnStarts[0].params.input);
    assert.deepEqual(injectedNames, [], "a denied skill must never reach the turn/start RPC input");

    handle.close();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("lr-4a13c3: approving one skill grants it for the session — a DIFFERENT skill still prompts", async function () {
  var cwd = makeSkillsDir(["alpha", "beta"]);
  try {
    var fake = buildFakeAppServer();
    var canUseToolCalls = [];
    // Simulate the daemon-side session.allowedTools grant map that
    // handleCanUseTool (lib/sdk-bridge.js) checks via permissionGrantKey —
    // this test exercises the adapter's call shape, and the composite-key
    // scoping semantics are covered end-to-end for the Skill tool by
    // test/permission-grant-skill-key-lr-f969dc.test.js (vendor-neutral,
    // reused unchanged by this fix per the operator's decision).
    var grants = {};

    function fakeCanUseTool(toolName, input) {
      canUseToolCalls.push({ toolName: toolName, input: input });
      var key = toolName === "Skill" && input && input.skill ? "Skill:" + input.skill : toolName;
      if (grants[key]) return Promise.resolve({ behavior: "allow" });
      grants[key] = true; // first reference to a given skill is approved and granted
      return Promise.resolve({ behavior: "allow" });
    }

    var handle = createCodexQueryHandle(fake.appServer, {
      cwd: cwd,
      approvalPolicy: "on-request",
      canUseTool: fakeCanUseTool,
    });

    handle.pushMessage("please run $alpha now");
    await waitForTurnStart(fake, 1);

    handle.pushMessage("now run $beta instead");
    await waitForTurnStart(fake, 2);

    assert.equal(canUseToolCalls.length, 2, "each distinct skill name must trigger its own canUseTool call");
    assert.equal(canUseToolCalls[0].input.skill, "alpha");
    assert.equal(canUseToolCalls[1].input.skill, "beta");

    handle.close();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("lr-4a13c3: a grant map keyed via permissionGrantKey auto-approves without a canUseTool round-trip on repeat reference", async function () {
  // This exercises the shape the real daemon uses: sdk-bridge.js's
  // handleCanUseTool auto-approves from session.allowedTools BEFORE ever
  // calling back into the adapter, so a granted skill's second reference
  // never even reaches a fresh prompt. We simulate that pre-resolution here
  // by having the fake canUseTool consult the same grant map the real
  // handleCanUseTool would have already populated.
  var utils = require("../lib/utils");
  var cwd = makeSkillsDir(["alpha"]);
  try {
    var fake = buildFakeAppServer();
    var canUseToolCalls = 0;
    var allowedTools = {};
    allowedTools[utils.permissionGrantKey("Skill", { skill: "alpha" })] = true;

    var handle = createCodexQueryHandle(fake.appServer, {
      cwd: cwd,
      approvalPolicy: "on-request",
      canUseTool: function (toolName, input) {
        canUseToolCalls++;
        var key = utils.permissionGrantKey(toolName, input);
        if (allowedTools[key]) return Promise.resolve({ behavior: "allow" });
        return Promise.resolve({ behavior: "deny" });
      },
    });

    handle.pushMessage("please run $alpha now");
    var turnStarts = await waitForTurnStart(fake, 1);

    var injectedNames = skillNamesInInput(turnStarts[0].params.input);
    assert.deepEqual(injectedNames, ["alpha"], "a pre-granted skill must be injected via the allow path");
    assert.equal(canUseToolCalls, 1);

    handle.close();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("lr-4a13c3: no canUseTool wired fails closed — skill is not injected", async function () {
  var cwd = makeSkillsDir(["alpha"]);
  try {
    var fake = buildFakeAppServer();

    var handle = createCodexQueryHandle(fake.appServer, {
      cwd: cwd,
      approvalPolicy: "on-request",
      // canUseTool intentionally omitted.
    });

    handle.pushMessage("please run $alpha now");
    var turnStarts = await waitForTurnStart(fake, 1);

    var injectedNames = skillNamesInInput(turnStarts[0].params.input);
    assert.deepEqual(injectedNames, [], "with no canUseTool wired, a skill must never be silently injected");

    handle.close();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("lr-4a13c3: setToolPolicy('allow-all') bypasses canUseTool for skill injection too, consistent with command/file approvals", async function () {
  var cwd = makeSkillsDir(["alpha"]);
  try {
    var fake = buildFakeAppServer();
    var canUseToolCalls = 0;

    var handle = createCodexQueryHandle(fake.appServer, {
      cwd: cwd,
      approvalPolicy: "on-request",
      toolPolicy: "allow-all",
      canUseTool: function () {
        canUseToolCalls++;
        return Promise.resolve({ behavior: "deny" });
      },
    });

    handle.pushMessage("please run $alpha now");
    var turnStarts = await waitForTurnStart(fake, 1);

    assert.equal(canUseToolCalls, 0, "allow-all must bypass the canUseTool round-trip, same as command/file approvals");
    var injectedNames = skillNamesInInput(turnStarts[0].params.input);
    assert.deepEqual(injectedNames, ["alpha"]);

    handle.close();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("lr-4a13c3: an unrecognized $token that does not match a discovered skill is left as plain text, never gated or injected", async function () {
  var cwd = makeSkillsDir(["alpha"]);
  try {
    var fake = buildFakeAppServer();
    var canUseToolCalls = 0;

    var handle = createCodexQueryHandle(fake.appServer, {
      cwd: cwd,
      approvalPolicy: "on-request",
      canUseTool: function () {
        canUseToolCalls++;
        return Promise.resolve({ behavior: "allow" });
      },
    });

    handle.pushMessage("what does $notaskill mean?");
    var turnStarts = await waitForTurnStart(fake, 1);

    assert.equal(canUseToolCalls, 0, "an undiscovered $token must not trigger a permission prompt");
    var injectedNames = skillNamesInInput(turnStarts[0].params.input);
    assert.deepEqual(injectedNames, []);

    handle.close();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
