"use strict";
// Codex is disabled while the daemon isolates users at the OS level: it does not
// yet run per OS user, and an app-server started in that mode would run as the
// daemon's user. The agent stays in the registry, shown disabled with a reason,
// and nothing of it is ever created or started. One test per place an adapter or
// an app-server could otherwise come from: the install state, the registry
// message, adapter creation (all three ways), lazy creation, and a session bound
// to Codex starting a query. A Codex stand-in is installed and usable, so the
// only thing that can keep it out is the mode.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

// The Codex adapter takes its app-server class when it is loaded: swap in a
// recorder before anything loads it. Constructing one at all is a failure.
var codexAppServerModule = require("../lib/yoke/codex-app-server");
var constructed = [];
codexAppServerModule.CodexAppServer = function FakeAppServer() {
  constructed.push(this);
  throw new Error("an app-server was constructed");
};

var yoke = require("../lib/yoke");
var codexBinary = require("../lib/yoke/codex-binary");
var codexModule = require("../lib/yoke/adapters/codex");
var installProbe = require("../lib/yoke/install-probe");
var { buildVendorRegistryMessage, recordInstallState } = require("../lib/vendor-registry-message");
var { createSDKBridge } = require("../lib/sdk-bridge");

var REASON = "Codex is not yet isolated per OS user";
var ENV_NAME = "CLAGENTIC_CONSOLE_CODEX_PATH";

var dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-os-users-"));
var standIn = path.join(dir, "codex");
fs.writeFileSync(standIn, "#!/bin/sh\necho 'codex-cli 0.162.1'\n");
fs.chmodSync(standIn, 0o755);
var savedOverride = process.env[ENV_NAME];

test.before(function () {
  process.env[ENV_NAME] = standIn;
  yoke.invalidateAuthCache();
});

test.after(function () {
  if (savedOverride === undefined) delete process.env[ENV_NAME]; else process.env[ENV_NAME] = savedOverride;
  yoke.invalidateAuthCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

function codexEntry(message) {
  return message.vendors.filter(function (v) { return v.id === "codex"; })[0];
}

test("Codex declares it does not support OS user isolation, and Claude does", function () {
  assert.equal(yoke.registry.get("codex").osUsersSupported, false);
  assert.equal(yoke.registry.get("claude").osUsersSupported, true);
  assert.equal(yoke.registry.disabledByOsUsers("codex", true), true);
  assert.equal(yoke.registry.disabledByOsUsers("codex", false), false);
  assert.equal(yoke.registry.disabledByOsUsers("claude", true), false);
  assert.equal(yoke.registry.osUsersReasonFor("codex"), REASON);
});

test("the install state under OS user isolation reports Codex not installed, with the reason, and does not look for it", function () {
  var looked = 0;
  var realResolve = codexBinary.resolveCached;
  codexBinary.resolveCached = function () { looked++; return realResolve.apply(this, arguments); };
  try {
    var state = installProbe.detectVendorInstallState("clay-alice", { osUsers: true });
    assert.equal(state.installed.indexOf("codex"), -1);
    assert.equal(state.details.codex.reason, REASON);
    assert.equal(looked, 0, "the Codex probe was not run");

    var daemonAccount = installProbe.detectVendorInstallState(null, { osUsers: true });
    assert.equal(daemonAccount.installed.indexOf("codex"), -1, "the daemon's own account is no exception");

    var off = installProbe.detectVendorInstallState(null, { osUsers: false });
    assert.notEqual(off.installed.indexOf("codex"), -1, "without the mode the same Codex is installed");
    assert.equal(off.details.codex.version, "0.162.1");
  } finally {
    codexBinary.resolveCached = realResolve;
  }
});

test("the registry message keeps Codex visible, disabled, with the reason", function () {
  var sm = { availableVendors: [] };
  recordInstallState(sm, null, installProbe.detectVendorInstallState(null, { osUsers: true }));
  var entry = codexEntry(buildVendorRegistryMessage(sm, null));
  assert.ok(entry, "Codex is still listed");
  assert.equal(entry.installed, false);
  assert.equal(entry.installDetail.reason, REASON);
  assert.equal(entry.osUsersSupported, false);
});

test("the rewind controls carry their own reason in the registry message", function () {
  var entry = codexEntry(buildVendorRegistryMessage({ availableVendors: [], installedVendors: ["codex"] }, null));
  assert.equal(entry.capabilities.rewind, false);
  assert.equal(entry.capabilities.rollback, false);
  assert.equal(entry.capabilityReasons.rewind, "Rewind is not available for Codex sessions yet");
  assert.equal(entry.capabilityReasons.rollback, "Rewind is not available for Codex sessions yet");
  var claude = buildVendorRegistryMessage({ availableVendors: [], installedVendors: ["claude"] }, null).vendors.filter(function (v) { return v.id === "claude"; })[0];
  assert.deepEqual(claude.capabilityReasons, {}, "an agent with no override keeps the ledger's general reasons");
});

test("creating the adapters in OS user isolation makes none for Codex; without it one is made", function () {
  yoke.invalidateAuthCache();
  var on = yoke.createAdapters({ cwd: dir, slug: "p", osUsers: true });
  assert.equal(on.adapters.codex, undefined);
  assert.equal(on.auth.codex, false);
  yoke.invalidateAuthCache();
  var off = yoke.createAdapters({ cwd: dir, slug: "p", osUsers: false });
  assert.equal(typeof off.adapters.codex, "object", "the same Codex is usable without the mode");
  assert.equal(constructed.length, 0, "and creating an adapter starts no app-server");
});

test("an adapter for Codex is refused in OS user isolation by the factory and by the adapter itself", function () {
  assert.throws(function () { yoke.createAdapter({ vendor: "codex", cwd: dir, slug: "p", osUsers: true }); },
    { code: "YOKE_OS_USERS_UNSUPPORTED", message: new RegExp(REASON) });
  assert.throws(function () { codexModule.createCodexAdapter({ cwd: dir, slug: "p", osUsers: true }); },
    { code: "CODEX_OS_USERS_UNSUPPORTED", message: new RegExp(REASON) });
  assert.equal(constructed.length, 0);
});

test("lazy creation in OS user isolation returns no adapter for Codex and starts nothing", async function () {
  var adapters = {};
  var lazy = await yoke.lazyCreateAdapter(adapters, "codex", { cwd: dir, slug: "p", osUsers: true, runtimeEnv: null });
  assert.equal(lazy, null);
  assert.equal(adapters.codex, undefined);
  assert.equal(constructed.length, 0);
});

test("a session bound to Codex is stopped with the reason in OS user isolation; no adapter, no app-server", async function () {
  var recorded = [];
  var sm = {
    modelsByVendor: {},
    sendAndRecord: function (session, obj) { recorded.push(obj); },
  };
  var adapters = {};
  var bridge = createSDKBridge({
    cwd: dir, slug: "p", osUsers: true, sessionManager: sm, send: function () {},
    adapter: { vendor: "claude" }, adapters: adapters,
  });
  await bridge.startQuery({ localId: 1, vendor: "codex", history: [] }, "hello", null, "clay-alice");
  assert.deepEqual(recorded.map(function (m) { return m.type; }), ["error", "done"]);
  assert.equal(recorded[0].text, REASON);
  assert.equal(recorded[1].code, 1);
  assert.equal(adapters.codex, undefined, "no adapter was created for it");
  assert.equal(constructed.length, 0);
});
