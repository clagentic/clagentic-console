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

// A distinct tag loads a private instance of the module (its own state), the
// way the prompt-card tests do for tools.js.
function frontend(name, tag) {
  return import(pathToFileURL(path.join(PUBLIC_MODULES, name)).href + (tag ? "?case=" + encodeURIComponent(tag) : ""));
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

// The page's elements by id. The modules cache the elements they look up, so
// the same element answers every case and a case empties it before use.
var PAGE_ELEMENTS = {};

// Layout reads and focus calls the shell makes while it wires itself up.
function withLayoutStubs(el) {
  el.getBoundingClientRect = function () { return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; };
  el.closest = function () { return null; };
  el.blur = function () {};
  el.select = function () {};
  return el;
}

var PAGE_LAYOUT = withLayoutStubs(new fakeDom.FakeElement("div"));

function pageElement(id) {
  if (!PAGE_ELEMENTS[id]) {
    PAGE_ELEMENTS[id] = withLayoutStubs(new fakeDom.FakeElement("div"));
    PAGE_ELEMENTS[id].parentElement = PAGE_LAYOUT;
    if (id === "resume-modal") PAGE_ELEMENTS[id].appendChild(Object.assign(new fakeDom.FakeElement("div"), { className: "confirm-backdrop" }));
  }
  return PAGE_ELEMENTS[id];
}

function unescapeAttr(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// The shared fake element drops markup assigned through innerHTML. The modules
// under test build their action rows that way, so here each <button> in the
// markup becomes a child with its class, title and disabled state.
function markupAwareElement(tag) {
  var el = new fakeDom.FakeElement(tag);
  var plain = Object.getOwnPropertyDescriptor(fakeDom.FakeElement.prototype, "innerHTML");
  Object.defineProperty(el, "innerHTML", {
    configurable: true,
    get: plain.get,
    set: function (markup) {
      plain.set.call(el, markup);
      var tagPattern = /<button\s+class="([^"]*)"([^>]*)>/g;
      var found;
      while ((found = tagPattern.exec(String(markup)))) {
        var button = new fakeDom.FakeElement("button");
        button.className = found[1];
        button.disabled = /(^|\s)disabled(\s|$)/.test(found[2]);
        var title = /title="([^"]*)"/.exec(found[2]);
        button.title = title ? unescapeAttr(title[1]) : "";
        el.appendChild(button);
      }
    },
  });
  return el;
}

function prepareBrowser() {
  fakeDom.setupGlobals();
  global.document.createElement = markupAwareElement;
  // The module graph of the panels reaches a few browser globals at load.
  global.document.querySelectorAll = function () { return []; };
  global.document.removeEventListener = function () {};
  global.document.getElementById = function (id) {
    return ["session-list", "messages", "resume-modal", "resume-cancel", "resume-picker-loading", "resume-picker-empty", "resume-picker-list"].indexOf(id) !== -1
      ? pageElement(id)
      : null;
  };
  global.marked.setOptions = function () {};
  global.mermaid.render = function () { return Promise.resolve({ svg: "" }); };
  global.ResizeObserver = function () { this.observe = function () {}; this.disconnect = function () {}; };
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
      prepareBrowser();

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

  test("a fake agent declaring the " + testCase.name + " capability set: the sidebar, notification and message modules follow it", async function () {
    await withFakeAgent(testCase, async function (server, caps) {
      prepareBrowser();
      var VR = await frontend("vendor-registry.js");
      var storeMod = await frontend("store.js");
      var messages = await frontend("app-messages.js");
      var rendering = await frontend("app-rendering.js");
      var notifications = await frontend("app-notifications.js");
      var sidebar = await frontend("sidebar-sessions.js", testCase.name);
      storeMod.createStore({ connected: true, cachedAllUsers: [] });
      var store = storeMod.store;

      // The registry arrives as a message, the agent under test first in the
      // order the server sends them.
      var registryMessage = JSON.parse(JSON.stringify(lib("vendor-registry-message").buildVendorRegistryMessage(server.sm)));
      registryMessage.vendors.sort(function (a, b) { return (b.id === FAKE_ID) - (a.id === FAKE_ID); });
      messages.processMessage(registryMessage);
      var byId = {};
      registryMessage.vendors.forEach(function (v) { byId[v.id] = v; });
      assert.equal(VR.defaultVendorId(), FAKE_ID, "the default agent is the registry's first");
      assert.equal(VR.VENDOR_NAMES[FAKE_ID], "Acme Agent");
      store.set({ currentVendor: FAKE_ID });

      // Message module: the user message's Fork and Rewind buttons carry the
      // agent's own gate, disabled with the reason when it cannot do them.
      pageElement("messages")._children = [];
      rendering.addUserMessage("hello");
      var actions = pageElement("messages").querySelector(".msg-actions");
      var fork = actions.querySelector(".msg-action-fork");
      var rewind = actions.querySelector(".msg-action-rewind");
      assert.equal(fork.disabled, !caps.fork, "fork button");
      assert.equal(rewind.disabled, !caps.rewind, "rewind button");
      if (!caps.rewind) assert.ok(rewind.title.indexOf(VR.capabilityGate("rewind").reason) !== -1, "the reason is in the title");

      // Notification module: a not-logged-in notice for the agent names the
      // agent's own sign-in command, and an explicit command is kept.
      assert.deepEqual(notifications.authLoginFor({ type: "auth_required", vendor: FAKE_ID }), { vendor: FAKE_ID, loginCommand: "acme-agent signin" });
      assert.equal(notifications.authLoginFor({ meta: { vendor: FAKE_ID } }).loginCommand, "acme-agent signin");
      assert.deepEqual(notifications.authLoginFor({}), { vendor: FAKE_ID, loginCommand: "acme-agent signin" }, "no agent named: the default agent");
      assert.equal(notifications.authLoginFor({ vendor: FAKE_ID, loginCommand: "other login" }).loginCommand, "other login");
      notifications.initAppNotifications();
      notifications.showAuthRequiredBanner({ vendor: FAKE_ID, title: "Acme Agent is not logged in." });
      var banner = global.document.body.querySelector('[data-auth-banner="true"]');
      assert.ok(banner, "the banner is shown");
      assert.ok(banner.innerHTML.indexOf("Acme Agent is not logged in.") !== -1);

      // Sidebar: the Agent Chat entry follows the capability of the agent in use,
      // on first render and when the agent changes underneath it.
      function agentChat() {
        return pageElement("session-list").querySelectorAll("button.session-top-action").filter(function (b) {
          return b.innerHTML.indexOf("Agent Chat") !== -1;
        })[0];
      }
      pageElement("session-list")._children = [];
      global.document.getElementById = pageElement;
      var shell = await frontend("sidebar.js");
      shell.initSidebar(new Proxy({ projectName: "Acme", $: pageElement }, {
        get: function (target, key) { return key in target ? target[key] : pageElement("ctx." + String(key)); },
      }));
      sidebar.renderSessionList([]);
      Object.keys(byId).forEach(function (id) {
        store.set({ currentVendor: id });
        var button = agentChat();
        assert.ok(button, "Agent Chat is listed for " + id);
        var enabled = byId[id].capabilities.agentInjection === true;
        assert.equal(button.disabled, !enabled, "Agent Chat for " + id);
        if (!enabled) {
          assert.ok(VR.capabilityGate("agentInjection").reason, "the registry gives a reason for " + id);
          assert.equal(button.title, VR.capabilityGate("agentInjection").reason, "reason as title for " + id);
        }
      });
    });
  });
});
