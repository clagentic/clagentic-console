"use strict";
// The YOKE vendor registry and the capability ledger: adapters are created,
// detected, logged into and gated from one registered descriptor each, so an
// agent registered here appears everywhere with no other code change.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var yoke = require("../lib/yoke");
var iface = require("../lib/yoke/interface");
var registry = yoke.registry;

function fakeAdapter(vendor) {
  return {
    vendor: vendor,
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
    createToolServer: function () { return {}; },
    createQuery: function () { return Promise.resolve({}); },
  };
}

function fakeDescriptor(overrides) {
  return Object.assign({
    id: "fake",
    displayName: "Fake Agent",
    icon: "/fake-avatar.png",
    priority: 99,
    binaryNames: ["fake-agent"],
    probeInstalled: function () { return true; },
    checkAuth: function () { return true; },
    installHint: "Install fake-agent from its release page.",
    loginCommand: "fake-agent signin",
    osUsersSupported: false,
    needsRuntimeEnv: false,
    ownedEnvNames: ["FAKE_AGENT_KEY"],
    nativeInstructionFiles: ["FAKE.md"],
    interruptMessage: "Stopped the fake agent.",
    capabilities: { effort: true, steering: true, agentInjection: true, permissionModes: ["default", "auto"], toolPolicy: ["ask"] },
    createAdapter: function () { return fakeAdapter("fake"); },
  }, overrides || {});
}

// Registers a fake vendor for the duration of one test.
async function withFake(fn, overrides) {
  registry.register(fakeDescriptor(overrides));
  try {
    await fn();
  } finally {
    registry.unregister((overrides && overrides.id) || "fake");
    yoke.invalidateAuthCache();
  }
}

test("both shipped agents register one complete descriptor each, in preference order", function () {
  assert.deepEqual(registry.ids(), ["claude", "codex"]);
  var claude = registry.get("claude");
  var codex = registry.get("codex");
  assert.equal(claude.displayName, "Claude Code");
  assert.equal(codex.displayName, "Codex");
  assert.equal(claude.loginCommand, "claude login");
  assert.equal(codex.loginCommand, "codex login --device-auth");
  assert.equal(codex.needsRuntimeEnv, true, "every Codex entry point requires runtimeEnv");
  assert.equal(claude.needsRuntimeEnv, false);
  assert.equal(claude.osUsersSupported, true);
  assert.equal(codex.osUsersSupported, false);
  assert.deepEqual(codex.ownedEnvNames, ["OPENAI_API_KEY", "OPENAI_BASE_URL"]);
  assert.ok(claude.ownedEnvNames.indexOf("ANTHROPIC_API_KEY") !== -1);
  assert.ok(claude.installHint.length > 0 && codex.installHint.length > 0);
  assert.deepEqual(claude.nativeInstructionFiles, ["CLAUDE.md"]);
  assert.deepEqual(codex.nativeInstructionFiles, ["AGENTS.md"]);
});

test("an unknown vendor is a named error, from createAdapter and from the registry", function () {
  assert.throws(function () { yoke.createAdapter({ vendor: "ghost", cwd: "/tmp" }); }, function (err) {
    assert.equal(err.code, "YOKE_UNKNOWN_VENDOR");
    assert.equal(err.vendor, "ghost");
    assert.match(err.message, /Unknown adapter vendor: ghost/);
    return true;
  });
  assert.throws(function () { registry.get("__proto__"); }, { code: "YOKE_UNKNOWN_VENDOR" });
  assert.equal(yoke.isKnownVendor("ghost"), false);
  assert.equal(yoke.isKnownVendor("__proto__"), false);
  assert.equal(yoke.isKnownVendor(undefined), false);
  assert.equal(yoke.isKnownVendor("codex"), true);
});

test("the binary allowlist is the registered names, and anything else is refused by name", function () {
  assert.deepEqual(registry.binaryNames(), ["claude", "codex"]);
  assert.doesNotThrow(function () { registry.assertAllowedBinary("codex"); });
  assert.throws(function () { registry.assertAllowedBinary("rm"); }, function (err) {
    assert.equal(err.code, "YOKE_DISALLOWED_BINARY");
    assert.match(err.message, /Disallowed binary name: rm/);
    return true;
  });
  var probe = require("../lib/yoke/install-probe");
  assert.throws(function () { probe.findBinaryPath("rm; echo owned", "someone"); }, { code: "YOKE_DISALLOWED_BINARY" });
});

test("a fake vendor registered in a test is built, detected, listed and given a default with no other code change", async function () {
  await withFake(async function () {
    assert.deepEqual(registry.ids(), ["claude", "codex", "fake"]);
    assert.ok(registry.binaryNames().indexOf("fake-agent") !== -1, "its executable joins the allowlist");

    var adapter = yoke.createAdapter({ vendor: "fake", cwd: "/tmp" });
    assert.equal(adapter.vendor, "fake");

    assert.ok(yoke.detectInstalledVendors(null).indexOf("fake") !== -1, "detection runs its probe");
    yoke.invalidateAuthCache();
    assert.equal(yoke.checkInstalled().fake, true);

    // Auth is asked of each registered vendor's own check (the built-in ones
    // are stubbed so no real CLI is run).
    var claude = registry.get("claude");
    var codex = registry.get("codex");
    var realClaudeCheck = claude.checkAuth;
    var realCodexCheck = codex.checkAuth;
    claude.checkAuth = function () { return false; };
    codex.checkAuth = function () { return true; };
    try {
      assert.deepEqual(yoke.checkAuth(), { claude: false, codex: true, fake: true });
    } finally {
      claude.checkAuth = realClaudeCheck;
      codex.checkAuth = realCodexCheck;
      yoke.invalidateAuthCache();
    }

    var created = yoke.createAdapters({ cwd: "/tmp", slug: "t" });
    assert.equal(created.adapters.fake.vendor, "fake");
    assert.equal(created.auth.fake, true);

    assert.equal(registry.defaultVendorId(["fake"]), "fake", "the only available agent is the default");
    assert.equal(registry.defaultVendorId(["fake", "codex"]), "codex", "preference order, not insertion order");
    assert.equal(registry.defaultVendorId([]), "claude");
  });
  assert.deepEqual(registry.ids(), ["claude", "codex"], "unregistering removes it again");
});

test("a vendor whose probe is false is registered but not detected as installed", async function () {
  await withFake(async function () {
    yoke.invalidateAuthCache();
    assert.equal(yoke.checkInstalled().fake, false);
    assert.equal(yoke.createAdapters({ cwd: "/tmp" }).adapters.fake, undefined);
    assert.equal(yoke.detectInstalledVendors(null).indexOf("fake"), -1);
  }, { probeInstalled: function () { return false; } });
});

test("a probe that looks up an executable no vendor registered fails by name instead of running it", async function () {
  await withFake(async function () {
    assert.throws(function () { yoke.detectInstalledVendors(null); }, { code: "YOKE_DISALLOWED_BINARY" });
  }, { probeInstalled: function (ctx) { return ctx.lookupBinary("unregistered-tool"); } });
});

test("a descriptor is checked when it registers: missing data, unknown capabilities and duplicates are refused", function () {
  assert.throws(function () { registry.register(fakeDescriptor({ loginCommand: "" })); }, /loginCommand/);
  assert.throws(function () { registry.register(fakeDescriptor({ needsRuntimeEnv: "yes" })); }, /needsRuntimeEnv/);
  assert.throws(function () { registry.register(fakeDescriptor({ createAdapter: null })); }, /createAdapter/);
  assert.throws(function () { registry.register(fakeDescriptor({ capabilities: { teleport: true } })); }, /unknown capability: teleport/);
  assert.throws(function () { registry.register(fakeDescriptor({ capabilities: { effort: "yes" } })); }, /must be a boolean/);
  assert.throws(function () { registry.register(fakeDescriptor({ capabilities: { permissionModes: "auto" } })); }, /array of strings/);
  assert.throws(function () { registry.register(fakeDescriptor({ id: "claude" })); }, /already registered/);
  assert.deepEqual(registry.ids(), ["claude", "codex"], "none of the refused descriptors was kept");
});

test("every registered agent declares every ledger key, independent of the project default", function () {
  registry.ids().forEach(function (id) {
    var declared = registry.declaredCapabilities(id);
    assert.deepEqual(Object.keys(declared).sort(), iface.CAPABILITY_KEYS.slice().sort(), id + " declares the whole ledger");
  });
  // The non-default agent's declaration is available without that agent ever being the default.
  assert.deepEqual(registry.declaredCapabilities("claude").permissionModes, ["default", "plan", "acceptEdits", "dontAsk", "auto"]);
  assert.deepEqual(registry.declaredCapabilities("codex").permissionModes, []);
  assert.equal(registry.declaredCapabilities("claude").agentInjection, true);
  assert.equal(registry.declaredCapabilities("codex").agentInjection, false);
});

test("adapter traits are descriptor booleans outside the ledger: never resolved, and a declaration that smuggles one in is refused", function () {
  iface.TRAIT_KEYS.forEach(function (key) {
    assert.equal(iface.isCapabilityKey(key), false, key + " is not a capability");
    assert.equal(Object.prototype.hasOwnProperty.call(registry.declaredCapabilities("codex"), key), false);
    assert.equal(Object.prototype.hasOwnProperty.call(yoke.resolveCapabilities(registry.get("codex"), null, null), key), false);
  });
  assert.deepEqual(iface.TRAIT_KEYS.slice().sort(), ["activityTokens", "perProjectRuntime"]);
  assert.equal(registry.traitOf("codex", "perProjectRuntime"), true);
  assert.equal(registry.traitOf("codex", "activityTokens"), true);
  assert.equal(registry.traitOf("claude", "perProjectRuntime"), false);
  assert.equal(registry.traitOf("claude", "activityTokens"), false);
  assert.equal(registry.traitOf("ghost", "activityTokens"), false, "an unregistered name has no traits");
  assert.throws(function () { registry.traitOf("codex", "effort"); }, /Unknown adapter trait: effort/);
  assert.throws(function () { registry.register(fakeDescriptor({ capabilities: { activityTokens: true } })); }, /adapter trait set on the descriptor/);
  assert.throws(function () { registry.register(fakeDescriptor({ perProjectRuntime: "yes" })); }, /perProjectRuntime/);
  assert.equal(registry.declaredCapabilitiesOrNone, undefined, "a declaration is reachable for a session only through resolve");
});

test("a registered fake agent's traits are read from its descriptor, and default to off", async function () {
  await withFake(async function () {
    assert.equal(registry.traitOf("fake", "activityTokens"), true);
    assert.equal(registry.traitOf("fake", "perProjectRuntime"), false);
  }, { activityTokens: true });
});

test("the ledger's keys are defined once, each with a kind and a one-line reason", function () {
  iface.CAPABILITY_KEYS.forEach(function (key) {
    var def = iface.CAPABILITIES[key];
    assert.ok(def.kind === "flag" || def.kind === "list", key);
    assert.ok(typeof def.reason === "string" && def.reason.length > 0 && def.reason.indexOf("\n") === -1, key);
  });
  ["effort", "permissionModes", "fork", "rewind", "rollback", "sessionList", "sessionRename", "sessionArchive", "mcpPanel", "backgroundTasks", "contextCompacting", "steering"].forEach(function (key) {
    assert.ok(iface.isCapabilityKey(key), key + " is a ledger key");
  });
  assert.equal(iface.isCapabilityKey("constructor"), false);
});

test("resolve: the yoke's declaration is the starting point", function () {
  var resolved = yoke.resolveCapabilities(registry.get("claude"), null, null);
  assert.deepEqual(resolved, registry.declaredCapabilities("claude"));
  resolved.permissionModes.push("mutated");
  assert.equal(registry.declaredCapabilities("claude").permissionModes.length, 5, "the declaration is never shared");
});

test("resolve: a connection's overrides are laid over the declaration, widening or narrowing it", function () {
  var yokeDecl = { capabilities: { effort: true, steering: false, permissionModes: ["default", "plan"] } };
  var connection = { capabilityOverrides: { effort: false, steering: true, permissionModes: ["default"] } };
  var resolved = yoke.resolveCapabilities(yokeDecl, connection, null);
  assert.equal(resolved.effort, false, "a model that ignores effort turns it off");
  assert.equal(resolved.steering, true);
  assert.deepEqual(resolved.permissionModes, ["default"]);
  assert.equal(resolved.fork, false, "an untouched, undeclared key stays off");
});

test("resolve: what the live session advertises can only narrow, never widen", function () {
  var yokeDecl = { capabilities: { effort: true, steering: false, rewind: true, permissionModes: ["default", "plan", "auto"], toolPolicy: ["ask", "allow-all"] } };
  var connection = { capabilityOverrides: { rewind: false } };
  var advertised = {
    effort: false,                       // narrows a flag
    steering: true,                      // would widen: must be ignored
    rewind: true,                        // would re-enable what the connection turned off: ignored
    permissionModes: ["default", "yolo"],// intersects; "yolo" is not declared so it never appears
    toolPolicy: ["ask", "allow-all"],    // same as declared
    notALedgerKey: true,                 // a live session may say more than the ledger names
  };
  var resolved = yoke.resolveCapabilities(yokeDecl, connection, advertised);
  assert.equal(resolved.effort, false);
  assert.equal(resolved.steering, false);
  assert.equal(resolved.rewind, false);
  assert.deepEqual(resolved.permissionModes, ["default"]);
  assert.deepEqual(resolved.toolPolicy, ["ask", "allow-all"]);
  assert.equal(Object.prototype.hasOwnProperty.call(resolved, "notALedgerKey"), false);

  var unreported = yoke.resolveCapabilities(yokeDecl, null, { steering: true });
  assert.equal(unreported.effort, true, "a key the session does not report is left as declared");
  assert.deepEqual(unreported.permissionModes, ["default", "plan", "auto"]);
});

test("resolve: a fake connection override and a fake session narrowing through a registered fake vendor", async function () {
  await withFake(async function () {
    var resolved = yoke.resolveCapabilities(
      registry.get("fake"),
      { capabilityOverrides: { agentInjection: false } },
      { steering: false, permissionModes: ["default"] }
    );
    assert.equal(resolved.effort, true, "from the declaration");
    assert.equal(resolved.agentInjection, false, "from the connection");
    assert.equal(resolved.steering, false, "narrowed by the session");
    assert.deepEqual(resolved.permissionModes, ["default"], "narrowed by the session");
  });
});

test("resolve: an override that names a capability outside the ledger fails loudly; a malformed advertisement does too", function () {
  var decl = { capabilities: { effort: true } };
  assert.throws(function () { yoke.resolveCapabilities(decl, { capabilityOverrides: { teleport: true } }, null); }, /unknown capability: teleport/);
  assert.throws(function () { yoke.resolveCapabilities(decl, { capabilityOverrides: { effort: "yes" } }, null); }, /must be a boolean/);
  assert.throws(function () { yoke.resolveCapabilities(decl, null, { effort: "no" }); }, /must be a boolean/);
  assert.throws(function () { yoke.resolveCapabilities(null, null, null); }, /needs a yoke declaration/);
});

test("the vendor-keyed instruction table is gone: a fake vendor's native files come from its descriptor", async function () {
  var instructions = require("../lib/yoke/instructions");
  var dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "yoke-instr-"));
  try {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "claude rules");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "agents rules");
    assert.equal(instructions.scanAndMerge(dir, "claude").indexOf("claude rules"), -1, "Claude reads CLAUDE.md itself");
    assert.ok(instructions.scanAndMerge(dir, "claude").indexOf("agents rules") !== -1);
    assert.equal(instructions.scanAndMerge(dir, "codex").indexOf("agents rules"), -1);
    await withFake(async function () {
      fs.writeFileSync(path.join(dir, "FAKE.md"), "unused");
      var merged = instructions.scanAndMerge(dir, "fake");
      assert.ok(merged.indexOf("claude rules") !== -1 && merged.indexOf("agents rules") !== -1, "it reads neither natively");
    });
    assert.ok(instructions.scanAndMerge(dir, "ghost").indexOf("claude rules") !== -1, "an unregistered vendor reads nothing natively");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the interface lists what the console really consumes: endInput is required, the rest is declared optional", function () {
  assert.equal(iface.INTERFACE_VERSION, "0.5.0");
  assert.ok(iface.QUERY_HANDLE_METHODS.indexOf("endInput") !== -1);
  assert.deepEqual(iface.QUERY_HANDLE_OPTIONAL_METHODS.slice().sort(), ["rewindFiles", "setPermissionMode"]);
  ["rollbackThread", "shutdown", "forkSession", "generateTitle"].forEach(function (m) {
    assert.ok(iface.ADAPTER_OPTIONAL_METHODS.indexOf(m) !== -1, m);
  });
  var handle = { pushMessage() {}, setModel() {}, setEffort() {}, setToolPolicy() {}, stopTask() {}, getContextUsage() {}, abort() {}, close() {} };
  handle[Symbol.asyncIterator] = function () { return {}; };
  assert.throws(function () { iface.validateQueryHandle(handle); }, /missing required method: endInput/);
  handle.endInput = function () {};
  assert.doesNotThrow(function () { iface.validateQueryHandle(handle); });
});

test("the vendor registry as the browser receives it lists every agent with its declared capabilities", async function () {
  var { buildVendorRegistryMessage } = require("../lib/vendor-registry-message");
  await withFake(async function () {
    var msg = buildVendorRegistryMessage({ installedVendors: ["claude", "fake"], availableVendors: ["claude"], capabilitiesByVendor: {} });
    assert.equal(msg.type, "vendor_registry");
    assert.deepEqual(msg.vendors.map(function (v) { return v.id; }), ["claude", "codex", "fake"]);
    var fake = msg.vendors[2];
    assert.equal(fake.displayName, "Fake Agent");
    assert.equal(fake.icon, "/fake-avatar.png");
    assert.equal(fake.installHint, "Install fake-agent from its release page.");
    assert.equal(fake.loginCommand, "fake-agent signin");
    assert.equal(fake.installed, true);
    assert.equal(fake.available, false);
    assert.equal(fake.capabilities.effort, true);
    assert.equal(fake.capabilities.rewind, false);
    assert.deepEqual(fake.capabilities.permissionModes, ["default", "auto"]);
    assert.equal(msg.vendors[1].installed, false, "codex was not in the installed list");
    assert.equal(msg.reasons.rewind, iface.CAPABILITIES.rewind.reason);
    JSON.stringify(msg);
  });
});

test("a vendor's live capabilities, once a session has narrowed them, replace its declaration in the browser message", function () {
  var { buildVendorRegistryMessage } = require("../lib/vendor-registry-message");
  var narrowed = yoke.resolveCapabilities(registry.get("claude"), null, { effort: false });
  var msg = buildVendorRegistryMessage({ installedVendors: [], availableVendors: [], capabilitiesByVendor: { claude: narrowed } });
  assert.equal(msg.vendors[0].capabilities.effort, false);
  assert.equal(msg.vendors[1].capabilities.effort, true, "codex still shows its declaration");
});
