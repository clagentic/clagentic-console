"use strict";
// The browser renders the agent picker and gates its controls from the
// registry message the server sends, so an agent registered on the server
// appears with its declared capabilities and no front-end change.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { pathToFileURL } = require("url");
var yoke = require("../lib/yoke");
var { buildVendorRegistryMessage } = require("../lib/vendor-registry-message");
var fakeDom = require("./fake-dom-prompt-cards");

var PUBLIC = path.join(__dirname, "..", "lib", "public");

function modules() {
  return Promise.all([
    import(pathToFileURL(path.join(PUBLIC, "modules", "vendor-registry.js")).href),
    import(pathToFileURL(path.join(PUBLIC, "modules", "store.js")).href),
    import(pathToFileURL(path.join(PUBLIC, "modules", "mode-options.js")).href),
  ]);
}

function fakeDescriptor() {
  return {
    id: "fake",
    displayName: "Fake Agent",
    icon: "/fake-avatar.png",
    priority: 99,
    binaryNames: ["fake-agent"],
    probeInstalled: function () { return false; },
    checkAuth: function () { return true; },
    installHint: "Install fake-agent from its release page.",
    loginCommand: "fake-agent signin",
    osUsersSupported: false,
    needsRuntimeEnv: false,
    ownedEnvNames: [],
    nativeInstructionFiles: [],
    interruptMessage: "Stopped.",
    capabilities: { effort: true, rewind: true, steering: true, permissionModes: ["default", "auto"], toolPolicy: ["ask"] },
    createAdapter: function () { throw new Error("not built here"); },
  };
}

async function withRegistryApplied(installed, fn) {
  var [VR, storeMod] = await modules();
  yoke.registry.register(fakeDescriptor());
  try {
    storeMod.createStore({});
    var msg = buildVendorRegistryMessage({ installedVendors: installed, availableVendors: installed.slice(), capabilitiesByVendor: {} });
    VR.applyVendorRegistry(JSON.parse(JSON.stringify(msg)));
    await fn(VR, storeMod.store, msg);
  } finally {
    yoke.registry.unregister("fake");
  }
}

test("a fake agent registered on the server appears in the picker, disabled with its install hint until it is installed", async function () {
  await withRegistryApplied(["claude"], async function (VR, store) {
    var rows = VR.pickerRows(store.get("vendorRegistry"), "claude");
    assert.deepEqual(rows.map(function (r) { return r.id; }), ["claude", "codex", "fake"]);
    var fake = rows[2];
    assert.equal(fake.displayName, "Fake Agent");
    assert.equal(fake.icon, "/fake-avatar.png");
    assert.equal(fake.installed, false);
    assert.match(fake.title, /not installed/);
    assert.match(fake.title, /Install fake-agent from its release page\./);
    assert.equal(rows[0].active, true);
    assert.equal(rows[0].installed, true);
    assert.deepEqual(store.get("installedVendors"), ["claude"], "only installed agents can be bound");
    assert.equal(VR.VENDOR_NAMES.fake, "Fake Agent", "names and avatars come from the registry too");
    assert.equal(VR.VENDOR_AVATARS.fake, "/fake-avatar.png");
  });
});

test("after a re-check the same agent is enabled", async function () {
  await withRegistryApplied(["claude", "fake"], async function (VR, store) {
    var fake = VR.pickerRows(store.get("vendorRegistry"), "claude")[2];
    assert.equal(fake.installed, true);
    assert.equal(fake.title, "Fake Agent");
    assert.deepEqual(store.get("installedVendors"), ["claude", "fake"]);
  });
});

test("the fake agent's declared capabilities drive the control flags, with a reason where one is off", async function () {
  await withRegistryApplied(["claude", "fake"], async function (VR, store) {
    store.set({ currentVendor: "fake" });
    assert.deepEqual(VR.capabilityGate("effort"), { enabled: true, reason: "" });
    assert.deepEqual(VR.capabilityGate("permissionModes"), { enabled: true, reason: "" });
    var fork = VR.capabilityGate("fork");
    assert.equal(fork.enabled, false);
    assert.match(fork.reason, /cannot fork a conversation/);
    assert.match(VR.gatedButtonAttrs("fork", "Fork"), /disabled aria-disabled="true"/);
    assert.match(VR.gatedButtonAttrs("fork", "Fork"), /title="Fork \(unavailable\): This agent cannot fork/);
    assert.equal(VR.gatedButtonAttrs("rewind", "Rewind"), 'title="Rewind"');

    store.set({ currentVendor: "codex" });
    assert.equal(VR.capabilityGate("rewind").enabled, false, "Codex declares no file rewind");
    assert.equal(VR.capabilityGate("agentInjection").enabled, false);
    assert.equal(VR.capabilityGate("permissionModes").enabled, false);
    assert.equal(VR.capabilityGate("effort").enabled, true);
    store.set({ currentVendor: "claude" });
    assert.equal(VR.capabilityGate("agentInjection").enabled, true);
  });
});

test("a Claude session in a Codex-default project is gated on Claude's capabilities, not on the project's default", async function () {
  var [VR, storeMod, modeMod] = await modules();
  storeMod.createStore({});
  var msg = buildVendorRegistryMessage({ installedVendors: ["claude", "codex"], availableVendors: ["codex"], capabilitiesByVendor: {} });
  VR.applyVendorRegistry(msg);
  // What the session last reported is the default agent's (Codex): none of the Claude modes.
  storeMod.store.set({ currentVendor: "claude", vendorCapabilities: yoke.registry.declaredCapabilities("codex") });
  var options = modeMod.modeOptions(VR.currentCapabilities(), false).map(function (o) { return o.value; });
  assert.deepEqual(options, ["default", "plan", "acceptEdits", "dontAsk", "auto"]);
  assert.equal(VR.capabilityGate("permissionModes").enabled, true);
});

test("the login command comes from the registry, and an unknown agent has none", async function () {
  await withRegistryApplied(["claude", "fake"], async function (VR) {
    assert.equal(VR.loginCommandFor("claude"), "claude login");
    assert.equal(VR.loginCommandFor("codex"), "codex login --device-auth");
    assert.equal(VR.loginCommandFor("fake"), "fake-agent signin");
    assert.equal(VR.loginCommandFor("ghost"), "");
    assert.equal(VR.defaultVendorId(), "claude");
  });
});

test("before any registry arrives a control reads as unavailable with a generic reason, never as available by default", async function () {
  var [VR, storeMod] = await modules();
  storeMod.createStore({});
  var gate = VR.capabilityGate("rewind");
  assert.equal(gate.enabled, false);
  assert.ok(gate.reason.length > 0);
});

test("the page no longer hardcodes agent buttons; the picker mounts into an empty container", function () {
  var html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  assert.equal(html.indexOf("vendor-btn-"), -1, "no hardcoded vendor buttons in index.html");
  assert.match(html, /<div id="vendor-toggle-wrap"><\/div>/);
});

// The picker as the browser draws it: a registry message in, DOM out.
async function renderPickerFrom(registryState, current) {
  fakeDom.setupGlobals();
  var [VR, storeMod] = await modules();
  var picker = await import(pathToFileURL(path.join(PUBLIC, "modules", "vendor-picker.js")).href);
  storeMod.createStore({});
  yoke.registry.register(fakeDescriptor());
  try {
    var msg = JSON.parse(JSON.stringify(buildVendorRegistryMessage(registryState)));
    VR.applyVendorRegistry(msg);
    var container = new fakeDom.FakeElement("div");
    var selected = [];
    var rechecks = [];
    picker.renderVendorPicker(container, VR.pickerRows(storeMod.store.get("vendorRegistry"), current), {
      onSelect: function (id) { selected.push(id); },
      onRecheck: function () { rechecks.push(true); },
    });
    return { container: container, selected: selected, rechecks: rechecks };
  } finally {
    yoke.registry.unregister("fake");
  }
}

function pickerButton(container, id) {
  return container.querySelector('[data-vendor="' + id + '"]');
}

test("picker DOM: a registered fake agent is a disabled button with its install hint, and Re-check asks the server again", async function () {
  var view = await renderPickerFrom({ installedVendors: ["claude"], availableVendors: ["claude"], capabilitiesByVendor: {} }, "claude");
  var buttons = view.container.querySelectorAll(".vendor-toggle-btn");
  assert.deepEqual(buttons.map(function (b) { return b.dataset.vendor; }), ["claude", "codex", "fake"]);

  var claude = pickerButton(view.container, "claude");
  assert.ok(claude.classList.contains("active"));
  assert.ok(!claude.classList.contains("disabled"));
  assert.equal(claude.getAttribute("aria-disabled"), null);

  var fake = pickerButton(view.container, "fake");
  assert.ok(fake.classList.contains("disabled"));
  assert.equal(fake.getAttribute("aria-disabled"), "true");
  assert.match(fake.title, /Fake Agent is not installed\. Install fake-agent from its release page\./);
  assert.equal(fake.querySelector(".vendor-toggle-label").textContent, "Fake Agent");
  assert.equal(fake.querySelector("img").src, "/fake-avatar.png");
  assert.equal(fake.querySelector(".vendor-toggle-note"), null, "not installed is not a failed check");

  fake.click();
  claude.click();
  assert.deepEqual(view.selected, ["fake", "claude"], "the click reaches the caller; refusing an agent that is not installed is the caller's rule");

  var recheck = view.container.querySelector(".vendor-recheck-btn");
  assert.ok(recheck, "a Re-check action is offered while an agent is missing");
  assert.equal(recheck.textContent, "Re-check");
  recheck.click();
  assert.equal(view.rechecks.length, 1);
});

test("picker DOM: when every agent is installed there is no Re-check action", async function () {
  var view = await renderPickerFrom({ installedVendors: ["claude", "codex", "fake"], availableVendors: ["claude"], capabilitiesByVendor: {} }, "codex");
  assert.equal(view.container.querySelector(".vendor-recheck-btn"), null);
  assert.ok(pickerButton(view.container, "codex").classList.contains("active"));
  assert.equal(view.container.querySelectorAll(".disabled").length, 0);
});

test("picker DOM: an agent whose install lookup failed says it could not be checked, not that it is missing", async function () {
  var view = await renderPickerFrom({ installedVendors: ["claude"], probeFailures: {}, availableVendors: ["claude"], capabilitiesByVendor: {} }, "claude");
  assert.equal(pickerButton(view.container, "fake").querySelector(".vendor-toggle-note"), null);

  fakeDom.setupGlobals();
  var [VR] = await modules();
  var rows = VR.pickerRows([
    { id: "claude", displayName: "Claude Code", installed: false, probeFailure: "timeout", installHint: "Install it." },
    { id: "codex", displayName: "Codex", installed: false, probeFailure: null, installHint: "Install Codex." },
  ], "claude");
  assert.equal(rows[0].checkFailed, true);
  assert.match(rows[0].title, /Could not check: timeout/);
  assert.doesNotMatch(rows[0].title, /not installed/);
  assert.equal(rows[1].checkFailed, false);
  assert.match(rows[1].title, /Codex is not installed\. Install Codex\./);

  var picker = await import(pathToFileURL(path.join(PUBLIC, "modules", "vendor-picker.js")).href);
  var container = new fakeDom.FakeElement("div");
  picker.renderVendorPicker(container, rows, { onSelect: function () {}, onRecheck: function () {} });
  assert.equal(pickerButton(container, "claude").querySelector(".vendor-toggle-note").textContent, "Could not check");
  assert.equal(pickerButton(container, "codex").querySelector(".vendor-toggle-note"), null);
});

test("no front-end control compares the current vendor to a literal agent name for the gated controls", function () {
  ["app-panels.js", "sidebar-sessions.js", "sidebar-mobile.js", "app-notifications.js", "app-messages.js", "rewind.js"].forEach(function (file) {
    var source = fs.readFileSync(path.join(PUBLIC, "modules", file), "utf8");
    source.split("\n").forEach(function (line, i) {
      if (/isCodex|isClaude|isCodexMode/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
        assert.fail(file + ":" + (i + 1) + " still derives a control from an agent name: " + line.trim());
      }
    });
  });
});
