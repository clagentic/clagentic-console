"use strict";
// An agent behaves by what it declares, never by its name. A fake agent whose
// id is neither of the shipped ones declares first the Claude capability set,
// then the Codex set, and every place that used to branch on a shipped agent's
// name is shown to follow the declaration instead: the browser's picker and
// gated controls, the login command, and the server's agent-injection guard,
// binding, permission modes, activity tokens, human attestation and runtime
// lifecycle. A surviving comparison against "claude" or "codex" fails here by
// behaving like the wrong set, whatever the spelling of the comparison.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");
var world = require("./prompt-harness-world");
var fakeDom = require("./fake-dom-prompt-cards");

var FAKE_ID = "acme";
var PUBLIC_MODULES = path.join(__dirname, "..", "lib", "public", "modules");

function lib(name) { return require(path.join(world.LIB_ROOT, name)); }

function frontend(name) {
  return import(pathToFileURL(path.join(PUBLIC_MODULES, name)).href);
}

// Each case is a capability set and the adapter traits that go with it.
var CASES = [
  {
    name: "Claude",
    capabilities: function () { return lib("yoke/adapters/claude-capabilities").claudeCapabilities(); },
    traits: { perProjectRuntime: false, activityTokens: false, attestsHumanSessions: false },
  },
  {
    name: "Codex",
    capabilities: function () { return lib("yoke/adapters/codex-capabilities").codexCapabilities(); },
    traits: { perProjectRuntime: true, activityTokens: true, attestsHumanSessions: true },
  },
];

function descriptorFor(testCase) {
  return Object.assign({
    id: FAKE_ID,
    displayName: "Acme Agent",
    icon: "/acme-avatar.png",
    priority: 99,
    binaryNames: ["acme-agent"],
    probeInstalled: function () { return true; },
    checkAuth: function () { return true; },
    installHint: "Install acme-agent.",
    loginCommand: "acme-agent signin",
    osUsersSupported: false,
    needsRuntimeEnv: false,
    ownedEnvNames: [],
    nativeInstructionFiles: [],
    interruptMessage: "Stopped the acme agent.",
    capabilities: testCase.capabilities(),
    createAdapter: function () {
      return {
        vendor: FAKE_ID,
        init: function () { return Promise.resolve({ models: [], skills: [] }); },
        supportedModels: function () { return Promise.resolve([]); },
        createToolServer: function () { return {}; },
        createQuery: function () { return Promise.resolve({}); },
      };
    },
  }, testCase.traits);
}

async function withFakeAgent(testCase, fn) {
  var server = await world.createServer();
  var registry = lib("yoke").registry;
  registry.register(descriptorFor(testCase));
  try {
    lib("session-capabilities").seedCapabilities(server.sm);
    await fn(server, registry.declaredCapabilities(FAKE_ID));
  } finally {
    registry.unregister(FAKE_ID);
    server.shutdown();
    world.removeHome(server.home);
  }
}

function historyOf(session, type) {
  return session.history.filter(function (m) { return m.type === type; });
}

CASES.forEach(function (testCase) {
  test("a fake agent declaring the " + testCase.name + " capability set: the server decides as that set does", async function () {
    await withFakeAgent(testCase, async function (server, caps) {
      // Agent identity reaches the query exactly when injection is declared.
      var served = world.serveVendor(server, FAKE_ID, undefined);
      var agentSession = server.sm.createSessionRaw({});
      agentSession.vendor = FAKE_ID;
      agentSession.agentName = "Helper";
      await served.bridge.startQuery(agentSession, "hi", null, null);
      assert.equal(served.created.length, 1);
      assert.equal(served.created[0].adapterOptions.CLAUDE.agent, caps.agentInjection ? "Helper" : undefined, "agent option");

      // Binding a session to the agent keeps or clears the identity the same way.
      var c = world.client();
      server.connect(c.ws);
      server.session.cliSessionId = null;
      server.session.agentName = "Helper";
      server.handlers.handleSessionsMessage(c.ws, { type: "set_vendor", vendor: FAKE_ID });
      assert.equal(server.session.vendor, FAKE_ID);
      assert.equal(server.session.agentName, caps.agentInjection ? "Helper" : null, "agent identity on bind");

      // Auto and Don't ask are accepted exactly when the agent lists them.
      c.inbox.length = 0;
      server.handlers.handleSessionsMessage(c.ws, { type: "set_permission_mode", mode: "auto" });
      await world.flush();
      var refused = c.inbox.filter(function (m) { return m.type === "error"; }).length;
      assert.equal(refused === 0, caps.permissionModes.indexOf("auto") !== -1, "permission mode auto");

      // The login command and name in a not-logged-in reply are the descriptor's.
      var loginSession = server.sm.createSessionRaw({});
      loginSession.vendor = FAKE_ID;
      loginSession.responsePreview = "Not logged in · Please run /login";
      server.bridge.processSDKMessage(loginSession, { yokeType: "result", cost: 0, duration: 1, usage: null, sessionId: "s-login" });
      var auth = historyOf(loginSession, "auth_required")[0];
      assert.equal(auth.text, "Acme Agent is not logged in.");
      assert.equal(auth.loginCommand, "acme-agent signin");
    });
  });

  test("a fake agent with the " + testCase.name + " traits: activity tokens, human attestation and runtime lifecycle follow the traits", async function () {
    await withFakeAgent(testCase, async function (server) {
      var activity = lib("session-activity");
      var session = server.sm.createSessionRaw({});
      session.vendor = FAKE_ID;
      server.bridge.processSDKMessage(session, { yokeType: "tool_start", blockId: "blk_1", toolId: "tool-1", toolName: "Bash" });
      assert.equal(activity.isSessionActive(session), testCase.traits.activityTokens, "tool activity token");
      server.bridge.processSDKMessage(session, { yokeType: "result", cost: 0, duration: 1, usage: null, sessionId: "s-1" });
      assert.equal(activity.isSessionActive(session), false, "released at the turn's result");

      var attested = [];
      var attestation = lib("lore-attestation");
      var realAttest = attestation.attestHumanSession;
      attestation.attestHumanSession = function (id) { attested.push(id); };
      try {
        var human = server.sm.createSessionRaw({});
        human.vendor = FAKE_ID;
        human.humanOriginated = true;
        server.bridge.processSDKMessage(human, { yokeType: "text_start", blockId: "blk_2", sessionId: "thread-9" });
        assert.deepEqual(attested, testCase.traits.attestsHumanSessions ? ["thread-9"] : [], "human attestation");
      } finally {
        attestation.attestHumanSession = realAttest;
      }

      // A runtime that belongs to one project is created per project; a shared
      // one is created once and handed to every project.
      var yoke = lib("yoke");
      yoke.invalidateAuthCache();
      var first =yoke.createAdapters({ cwd: server.home, slug: "one" }).adapters[FAKE_ID];
      var second = yoke.createAdapters({ cwd: server.home, slug: "two" }).adapters[FAKE_ID];
      assert.ok(first && second);
      assert.equal(first === second, !testCase.traits.perProjectRuntime, "adapter sharing");
    });
  });

  test("a fake agent declaring the " + testCase.name + " capability set: the browser's picker and gated controls follow it", async function () {
    await withFakeAgent(testCase, async function (server, caps) {
      fakeDom.setupGlobals();
      // The module graph of the panels reaches a few browser globals at load.
      global.document.querySelectorAll = function () { return []; };
      global.document.removeEventListener = function () {};
      global.marked.setOptions = function () {};
      global.mermaid.render = function () { return Promise.resolve({ svg: "" }); };

      var VR = await frontend("vendor-registry.js");
      var storeMod = await frontend("store.js");
      var modes = await frontend("mode-options.js");
      var panels = await frontend("app-panels.js");
      var rewind = await frontend("rewind.js");

      storeMod.createStore({});
      var registryMessage = lib("vendor-registry-message").buildVendorRegistryMessage(server.sm);
      VR.applyVendorRegistry(JSON.parse(JSON.stringify(registryMessage)));
      storeMod.store.set({ currentVendor: FAKE_ID, currentModels: [] });

      var rows = VR.pickerRows(storeMod.store.get("vendorRegistry"), FAKE_ID);
      var row = rows.filter(function (r) { return r.id === FAKE_ID; })[0];
      assert.ok(row, "the fake agent is a row in the picker");
      assert.equal(row.displayName, "Acme Agent");
      assert.equal(row.active, true);
      assert.equal(VR.loginCommandFor(FAKE_ID), "acme-agent signin");

      function expectedEnabled(key) {
        return Array.isArray(caps[key]) ? caps[key].length > 0 : caps[key] === true;
      }
      ["permissionModes", "effort", "thinking", "executionPolicy", "fork", "rewind", "rollback", "agentInjection", "betas"].forEach(function (key) {
        assert.equal(VR.capabilityGate(key).enabled, expectedEnabled(key), "gate " + key);
      });
      var offered = modes.modeOptions(VR.currentCapabilities(), false).map(function (o) { return o.value; });
      assert.equal(offered.indexOf("dontAsk") !== -1, caps.permissionModes.indexOf("dontAsk") !== -1, "mode picker: Don't ask");
      assert.equal(offered.indexOf("auto") !== -1, caps.permissionModes.indexOf("auto") !== -1, "mode picker: Auto");
      assert.equal(panels.getModelSupportsThinking(), caps.thinking, "thinking fallback");

      var rewindHost = new fakeDom.FakeElement("div");
      rewind.addRewindButton(rewindHost);
      var button = rewindHost.querySelector(".msg-user-rewind-btn");
      assert.ok(button, "a rewind button is drawn");
      assert.equal(button.disabled, !caps.rewind, "rewind button");
    });
  });
});
