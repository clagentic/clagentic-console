"use strict";
// The browser renders the agent picker and gates its controls from the
// registry message the server sends, so an agent registered on the server
// appears with its declared capabilities and no front-end change.

var test = require("node:test");
var assert = require("node:assert/strict");
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
    assert.equal(VR.loginCommandFor("claude"), "claude auth login");
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

// Which vendor a session's page shows is decided from the server's messages and
// is never a default: the header names the session's vendor or, knowing none,
// nobody's.
function sessionVendorModules() {
  return Promise.all([
    import(pathToFileURL(path.join(PUBLIC, "modules", "session-vendor-state.js")).href),
    import(pathToFileURL(path.join(PUBLIC, "modules", "assistant-identity.js")).href),
  ]);
}

[
  { name: "a Codex session with history binds and locks Codex", msg: { vendor: "codex", hasHistory: true }, current: { currentVendor: "claude", vendorSelectionLocked: false }, want: { currentVendor: "codex", vendorSelectionLocked: true } },
  { name: "a locked page switching to a Codex session with history takes Codex", msg: { vendor: "codex", hasHistory: true }, current: { currentVendor: "claude", vendorSelectionLocked: true }, want: { currentVendor: "codex", vendorSelectionLocked: true } },
  { name: "a locked page switching to a new session keeps its vendor", msg: { vendor: "codex", hasHistory: false }, current: { currentVendor: "claude", vendorSelectionLocked: true }, want: { currentVendor: "claude", vendorSelectionLocked: true } },
  { name: "a session with history and no recorded vendor takes the default, unlocked", msg: { vendor: null, hasHistory: true }, current: { currentVendor: "codex", vendorSelectionLocked: true }, want: { currentVendor: "claude", vendorSelectionLocked: false } },
  { name: "a new session with no vendor imposes nothing", msg: { vendor: null, hasHistory: false }, current: { currentVendor: "codex", vendorSelectionLocked: false }, want: null },
  { name: "an explicitly absent vendor with history takes the default", msg: { vendor: null, vendorSource: "absent", hasHistory: true }, current: { currentVendor: null, vendorSelectionLocked: false }, want: { currentVendor: "claude", vendorSelectionLocked: false } },
  { name: "an unreadable vendor shows none, locked, not the default", msg: { vendor: null, vendorSource: "error", hasHistory: true }, current: { currentVendor: "claude", vendorSelectionLocked: false }, want: { currentVendor: null, vendorSelectionLocked: true } },
  { name: "a default-bound vendor is applied as sent", msg: { vendor: "claude", vendorSource: "default-bound", hasHistory: true }, current: { currentVendor: null, vendorSelectionLocked: false }, want: { currentVendor: "claude", vendorSelectionLocked: true } },
  { name: "a new session keeps the vendor picked before its first message", msg: { vendor: null, vendorSource: "absent", hasHistory: false }, current: { currentVendor: "codex", vendorSelectionLocked: true, sameSession: true }, want: { currentVendor: "codex", vendorSelectionLocked: true } },
  { name: "a different new session takes the vendor the server resolved, not the held pick", msg: { vendor: "codex", vendorSource: "default-bound", hasHistory: false }, current: { currentVendor: "claude", vendorSelectionLocked: true, sameSession: false }, want: { currentVendor: "codex", vendorSelectionLocked: true } },
  { name: "an unreadable vendor without history is neutral and locked", msg: { vendor: null, vendorSource: "error", hasHistory: false }, current: { currentVendor: "claude", vendorSelectionLocked: false }, want: { currentVendor: null, vendorSelectionLocked: true } },
  { name: "a pick made on another session is not carried to a new one", msg: { vendor: null, vendorSource: "absent", hasHistory: false }, current: { currentVendor: "codex", vendorSelectionLocked: true, sameSession: false }, want: null },
].forEach(function (row) {
  test("session_switched vendor state: " + row.name, async function () {
    var [state] = await sessionVendorModules();
    assert.deepEqual(state.vendorStateForSwitch(row.msg, row.current, "claude"), row.want);
  });
});

[
  { name: "a vendor the session or its meta records", source: "meta", want: "present" },
  { name: "the project default standing in", source: "default", want: "default-bound" },
  { name: "a meta that could not be read", source: "error", want: "error" },
  { name: "no vendor at all", source: null, want: "absent" },
].forEach(function (row) {
  test("session_switched vendorSource: " + row.name, function () {
    assert.equal(require("../lib/session-vendor").vendorSourceLabel(row.source), row.want);
  });
});

[
  { name: "the active session's vendor changed", state: { currentVendor: "codex", activeSessionId: 1, sessionVendors: {} }, prev: { currentVendor: "claude", activeSessionId: 1, sessionVendors: {} }, want: true },
  { name: "the active session changed to one the list records another vendor for", state: { currentVendor: null, activeSessionId: 2, sessionVendors: { 1: "claude", 2: "codex" } }, prev: { currentVendor: null, activeSessionId: 1, sessionVendors: { 1: "claude", 2: "codex" } }, want: true },
  { name: "a new session_list map with the same active vendor", state: { currentVendor: null, activeSessionId: 1, sessionVendors: { 1: "codex" } }, prev: { currentVendor: null, activeSessionId: 1, sessionVendors: { 1: "codex" } }, want: false },
  { name: "loop-queue mode keeps the queue placeholder", state: { loopQueueMode: true, currentVendor: "codex", activeSessionId: 1, sessionVendors: {} }, prev: { currentVendor: "claude", activeSessionId: 1, sessionVendors: {} }, want: false },
].forEach(function (row) {
  test("placeholder recompute: " + row.name, async function () {
    var [state] = await sessionVendorModules();
    assert.equal(state.placeholderNeedsRecompute(row.state, row.prev), row.want);
  });
});

test("the placeholder subscription asks the shared recompute rule", function () {
  var source = require("fs").readFileSync(path.join(PUBLIC, "modules", "app-rendering.js"), "utf8");
  var sub = source.slice(source.indexOf("store.subscribe(['currentVendor', 'activeSessionId', 'sessionVendors']"));
  assert.match(sub.slice(0, 700), /placeholderNeedsRecompute\(state, prev\)/);
});

test("session_switched applies the settled vendor again after resetClientState() wipes it", function () {
  var source = require("fs").readFileSync(path.join(PUBLIC, "modules", "app-messages.js"), "utf8");
  var switched = source.slice(source.indexOf("session_switched: function"));
  var reset = switched.indexOf("resetClientState();");
  var reapply = switched.indexOf("if (_boundVendor) store.set(_boundVendor);", reset);
  assert.ok(reset > 0 && reapply > reset, "the vendor is re-applied after the reset");
});

[
  { name: "a Codex session's turn, also after a tool error, is headed Codex", args: ["codex", null, null], name_: "Codex", avatar: "/codex-avatar.png" },
  { name: "no vendor on the page: the session list's vendor is used", args: [null, null, "codex"], name_: "Codex", avatar: "/codex-avatar.png" },
  { name: "the page's own vendor outranks the list's", args: ["claude", null, "codex"], name_: "Claude Code", avatar: "/claude-code-avatar.png" },
  { name: "no vendor known anywhere: a neutral assistant, no vendor avatar", args: [null, null, null], name_: "Assistant", avatar: null },
  { name: "a vendor the registry does not know: a neutral assistant", args: ["ghost", null, null], name_: "Assistant", avatar: null },
  { name: "a named agent keeps its own name", args: [null, "Holden", "codex"], name_: "Holden", avatar: null },
].forEach(function (row) {
  test("assistant header: " + row.name, async function () {
    var [, identity] = await sessionVendorModules();
    var got = identity.assistantIdentity.apply(null, row.args);
    assert.equal(got.name, row.name_);
    assert.equal(got.avatarUrl, row.avatar);
  });
});

[
  { name: "the page's vendor", state: { currentVendor: "codex", activeSessionId: 1, sessionVendors: { 1: "claude" } }, want: "Message Codex..." },
  { name: "no page vendor: the session list's vendor", state: { currentVendor: null, activeSessionId: 1, sessionVendors: { 1: "codex" } }, want: "Message Codex..." },
  { name: "no vendor known anywhere: neutral wording, never Claude", state: { currentVendor: null, activeSessionId: 1, sessionVendors: {} }, want: "Message the assistant..." },
  { name: "a vendor the registry does not know: neutral wording", state: { currentVendor: "ghost", activeSessionId: 1, sessionVendors: {} }, want: "Message the assistant..." },
  { name: "loop-queue mode keeps the queue wording over any vendor", state: { loopQueueMode: true, currentVendor: "codex", activeSessionId: 1, sessionVendors: { 1: "codex" } }, want: "Message queues for the next loop iteration…" },
].forEach(function (row) {
  test("composer placeholder: " + row.name, async function () {
    var [, identity] = await sessionVendorModules();
    assert.equal(identity.composerPlaceholder(function (k) { return row.state[k]; }), row.want);
  });
});

[
  { name: "another session's model_info", msg: { vendor: "claude", sessionId: 2 }, state: { currentVendor: null, activeSessionId: 1 }, foreign: true },
  { name: "another vendor's model_info on a bound page", msg: { vendor: "claude" }, state: { currentVendor: "codex", activeSessionId: 1 }, foreign: true },
  { name: "this session's own model_info", msg: { vendor: "codex", sessionId: 1 }, state: { currentVendor: "codex", activeSessionId: 1 }, foreign: false },
  { name: "a model_info that names no session, for a page with no vendor yet", msg: { vendor: "claude" }, state: { currentVendor: null, activeSessionId: 1 }, foreign: false },
].forEach(function (row) {
  test("model_info scoping: " + row.name, async function () {
    var [state] = await sessionVendorModules();
    assert.equal(state.isForeignModelInfo(row.msg, row.state), row.foreign);
  });
});

test("the session list's vendors are mapped by session id", async function () {
  var [state] = await sessionVendorModules();
  var map = state.sessionVendorMap([{ id: 3, vendor: "codex" }, { id: 4, vendor: null }, { id: 5, vendor: "claude" }]);
  assert.equal(state.listedVendor(map, 3), "codex");
  assert.equal(state.listedVendor(map, 4), null);
  assert.equal(state.listedVendor(map, 99), null);
  assert.equal(state.listedVendor(map, null), null);
});
