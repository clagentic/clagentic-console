"use strict";
// Install state belongs to an OS identity; credential sets are owned whole;
// Bedrock/Vertex/Foundry count as configured only with a complete credential
// source; an install lookup that fails is told apart from "not installed".

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var execFileSync = require("child_process").execFileSync;
var world = require("./prompt-harness-world");

function lib(name) { return require(path.join(world.LIB_ROOT, name)); }

async function withHarness(fn) {
  var server = await world.createServer();
  try {
    await fn(server);
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
}

function userClient(linuxUser) {
  var c = world.client();
  c.ws._clagenticUser = linuxUser ? { id: "u-" + linuxUser, linuxUser: linuxUser } : { id: "u-none" };
  return c;
}

function registryMessages(c) {
  return c.inbox.filter(function (m) { return m.type === "vendor_registry"; });
}

function installedIn(message) {
  return message.vendors.filter(function (v) { return v.installed; }).map(function (v) { return v.id; });
}

// Stands in for the lookup: what is installed depends on whose PATH is read.
function stubLookup(yoke, installedByUser) {
  var calls = [];
  var real = yoke.detectVendorInstallState;
  yoke.detectVendorInstallState = function (linuxUser) {
    calls.push(linuxUser);
    return { installed: installedByUser[linuxUser || ""] || [], failures: {} };
  };
  return { calls: calls, restore: function () { yoke.detectVendorInstallState = real; } };
}

test("recheck_vendors looks up the requesting user's PATH, and tells every client of that same identity, no other", async function () {
  await withHarness(async function (server) {
    var yoke = lib("yoke");
    var stub = stubLookup(yoke, { alice: ["claude", "codex"], bob: ["claude"], "": [] });
    try {
      var handlers = lib("project-sessions").attachSessions(Object.assign({}, server.handlerContext, { osUsers: [{}] }));
      var alice1 = userClient("alice");
      var alice2 = userClient("alice");
      var bob = userClient("bob");
      var daemonUser = userClient(null);
      [alice1, alice2, bob, daemonUser].forEach(function (c) { server.connect(c.ws); c.inbox.length = 0; });

      handlers.handleSessionsMessage(alice1.ws, { type: "recheck_vendors" });

      assert.deepEqual(stub.calls, ["alice"], "the lookup ran as the requester, never as the daemon account");
      assert.deepEqual(installedIn(registryMessages(alice1)[0]), ["claude", "codex"]);
      assert.deepEqual(installedIn(registryMessages(alice2)[0]), ["claude", "codex"], "a second client of the same identity is updated too");
      assert.equal(registryMessages(bob).length, 0, "another identity never receives the requester's state");
      assert.equal(registryMessages(daemonUser).length, 0);

      handlers.handleSessionsMessage(bob.ws, { type: "recheck_vendors" });
      assert.deepEqual(stub.calls, ["alice", "bob"]);
      assert.deepEqual(installedIn(registryMessages(bob)[0]), ["claude"]);
      assert.equal(registryMessages(alice1).length, 1, "bob's recheck does not reach alice");
    } finally {
      stub.restore();
    }
  });
});

test("without OS users, a recheck is the daemon account's and reaches every client of the project", async function () {
  await withHarness(async function (server) {
    var yoke = lib("yoke");
    var stub = stubLookup(yoke, { "": ["claude"] });
    try {
      var a = userClient("alice");
      var b = userClient(null);
      [a, b].forEach(function (c) { server.connect(c.ws); c.inbox.length = 0; });
      server.handlers.handleSessionsMessage(a.ws, { type: "recheck_vendors" });
      assert.deepEqual(stub.calls, [null], "a Linux user name on the connection means nothing when OS users are off");
      assert.equal(registryMessages(a).length, 1);
      assert.equal(registryMessages(b).length, 1);
    } finally {
      stub.restore();
    }
  });
});

test("a connecting client is told its own identity's install state, not another user's", async function () {
  await withHarness(async function (server) {
    var yoke = lib("yoke");
    var stub = stubLookup(yoke, { alice: ["claude", "codex"], "": ["claude"] });
    try {
      server.bridge.recheckVendors("alice");
      var message = lib("vendor-registry-message");
      assert.deepEqual(installedIn(message.buildVendorRegistryMessage(server.sm, "alice")), ["claude", "codex"]);
      assert.deepEqual(installedIn(message.buildVendorRegistryMessage(server.sm, "bob")), [], "an identity never looked up falls back to the daemon list");
      assert.deepEqual(server.sm.installedVendors || [], [], "a user's lookup does not overwrite the daemon account's list");
      server.bridge.recheckVendors(null);
      assert.deepEqual(server.sm.installedVendors, ["claude"]);
    } finally {
      stub.restore();
    }
  });
});

function modelInfoMessages(c) {
  return c.inbox.filter(function (m) { return m.type === "model_info"; });
}

test("model_info never carries install state, so it cannot overwrite an OS user's per-identity state", async function () {
  await withHarness(async function (server) {
    var yoke = lib("yoke");
    var stub = stubLookup(yoke, { alice: ["claude", "codex"], "": ["claude"] });
    try {
      server.bridge.recheckVendors("alice");
      server.bridge.recheckVendors(null);
      var handlers = lib("project-sessions").attachSessions(Object.assign({}, server.handlerContext, { osUsers: [{}] }));
      var alice = userClient("alice");
      server.connect(alice.ws);
      alice.inbox.length = 0;

      handlers.handleSessionsMessage(alice.ws, { type: "set_vendor", vendor: "codex" });
      var infos = modelInfoMessages(alice);
      assert.ok(infos.length > 0, "set_vendor answers with a model_info");

      infos.forEach(function (m) {
        assert.equal(Object.prototype.hasOwnProperty.call(m, "installedVendors"), false, "install state comes only from the registry message");
      });
      var registry = lib("vendor-registry-message");
      assert.deepEqual(installedIn(registry.buildVendorRegistryMessage(server.sm, "alice")), ["claude", "codex"], "alice's state stands apart from the project-wide list");
      assert.deepEqual(server.sm.installedVendors, ["claude"]);
    } finally {
      stub.restore();
    }
  });
});

test("every declared credential group is owned whole, for every registered agent", function () {
  var registry = lib("yoke").registry;
  var groupsSeen = 0;
  registry.list().forEach(function (vendor) {
    vendor.credentialGroups.forEach(function (group) {
      groupsSeen++;
      group.prefixes.forEach(function (prefix) {
        assert.ok(vendor.ownedEnvPrefixes.indexOf(prefix) !== -1, vendor.id + " declares group " + group.id + " but does not own " + prefix);
      });
      group.envNames.forEach(function (name) {
        assert.ok(registry.ownsEnvName(vendor.id, name), vendor.id + " declares group " + group.id + " but does not own " + name);
      });
    });
  });
  assert.ok(groupsSeen >= 4, "claude's three cloud providers and codex's endpoint are declared");

  [
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK",
    "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS",
    "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_RESOURCE",
  ].forEach(function (name) {
    assert.ok(registry.ownsEnvName("claude", name), "claude owns " + name);
  });
});

test("credential ownership is by namespace: names no list mentions are owned and cleaned", function () {
  var registry = lib("yoke").registry;
  var credentials = lib("yoke/provider-credentials");
  var unlisted = {
    AWS_ROLE_ARN: "bedrock", AWS_CA_BUNDLE: "bedrock", AWS_WEB_IDENTITY_TOKEN_FILE: "bedrock",
    GOOGLE_CLOUD_PROJECT: "vertex", GCLOUD_PROJECT: "vertex", CLOUDSDK_CORE_PROJECT: "vertex",
    CLOUD_ML_PROJECT: "vertex", ANTHROPIC_VERTEX_BASE_URL: "vertex",
    ANTHROPIC_FOUNDRY_ORG: "foundry",
  };
  Object.keys(unlisted).forEach(function (name) {
    assert.equal(credentials.groupOf(name), unlisted[name], name + " belongs to " + unlisted[name]);
    assert.equal(registry.ownsEnvName("claude", name), true, "claude owns " + name);
    assert.equal(registry.ownerOfEnvName(name), "claude");
  });
  assert.equal(credentials.groupOf("PATH"), null);
  assert.equal(credentials.groupOf("AWSOME"), null, "a prefix needs its separator");
  assert.equal(registry.ownerOfEnvName("HOME"), null);

  var daemonEnv = Object.assign({ PATH: "/usr/bin", HOME: "/h", OPENAI_API_KEY: "o" }, Object.keys(unlisted).reduce(function (acc, n) {
    acc[n] = "x";
    return acc;
  }, {}));
  var cleaned = registry.withoutOwnedEnv("claude", daemonEnv);
  assert.deepEqual(Object.keys(cleaned).sort(), ["HOME", "OPENAI_API_KEY", "PATH"], "only the claude-owned names are removed");
});

test("the registry refuses a descriptor that declares a credential namespace it does not own", function () {
  var registry = lib("yoke").registry;
  var descriptor = {
    id: "nsless", displayName: "Nsless", priority: 97, binaryNames: ["nsless-agent"],
    probeInstalled: function () { return false; }, checkAuth: function () { return true; },
    installHint: "x", loginCommand: "x", osUsersSupported: false, needsRuntimeEnv: false,
    ownedEnvNames: [],
    credentialGroups: [{ id: "cloud", prefixes: ["NSLESS_"] }],
    nativeInstructionFiles: [], interruptMessage: "x",
    capabilities: {}, createAdapter: function () { return {}; },
  };
  assert.throws(function () { registry.register(descriptor); }, /does not own the NSLESS_ namespace/);
  assert.equal(registry.isKnown("nsless"), false);
});

test("Bedrock web-identity authentication is a complete credential source", function () {
  var auth = lib("yoke/auth-checks");
  var base = { CLAUDE_CODE_USE_BEDROCK: "1" };
  assert.equal(auth.hasThirdPartyProviderAuth(Object.assign({ AWS_ROLE_ARN: "arn:aws:iam::1:role/r" }, base)), null);
  assert.equal(auth.hasThirdPartyProviderAuth(Object.assign({ AWS_WEB_IDENTITY_TOKEN_FILE: "/t" }, base)), null);
  assert.equal(auth.hasThirdPartyProviderAuth(Object.assign({ AWS_ROLE_ARN: "arn:aws:iam::1:role/r", AWS_WEB_IDENTITY_TOKEN_FILE: "/t" }, base)), "bedrock");
});

test("the registry refuses a descriptor that owns only part of a declared credential group", function () {
  var registry = lib("yoke").registry;
  var descriptor = {
    id: "partial", displayName: "Partial", priority: 98, binaryNames: ["partial-agent"],
    probeInstalled: function () { return false; }, checkAuth: function () { return true; },
    installHint: "x", loginCommand: "x", osUsersSupported: false, needsRuntimeEnv: false,
    ownedEnvNames: ["PARTIAL_KEY_ID"],
    credentialGroups: [{ id: "pair", envNames: ["PARTIAL_KEY_ID", "PARTIAL_SECRET"] }],
    nativeInstructionFiles: [], interruptMessage: "x",
    capabilities: {}, createAdapter: function () { return {}; },
  };
  assert.throws(function () { registry.register(descriptor); }, /does not own PARTIAL_SECRET/);
  assert.equal(registry.isKnown("partial"), false);
});

test("Bedrock counts as configured only with a complete credential source", function () {
  var auth = lib("yoke/auth-checks");
  var base = { CLAUDE_CODE_USE_BEDROCK: "1" };
  function withEnv(extra) { return Object.assign({}, base, extra); }

  assert.equal(auth.hasThirdPartyProviderAuth(withEnv({ AWS_ACCESS_KEY_ID: "AKIAEXAMPLE" })), null,
    "an access key id alone is not authenticated");
  assert.equal(auth.hasThirdPartyProviderAuth(withEnv({ AWS_SECRET_ACCESS_KEY: "s" })), null);
  assert.equal(auth.hasThirdPartyProviderAuth(withEnv({ AWS_SESSION_TOKEN: "t" })), null);
  assert.equal(auth.hasThirdPartyProviderAuth(withEnv({ AWS_REGION: "us-east-1" })), null);
  assert.equal(auth.hasThirdPartyProviderAuth(withEnv({ AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "s" })), "bedrock");
  assert.equal(auth.hasThirdPartyProviderAuth(withEnv({ AWS_PROFILE: "work" })), "bedrock");
  assert.equal(auth.hasThirdPartyProviderAuth(withEnv({ AWS_BEARER_TOKEN_BEDROCK: "b" })), "bedrock");
  assert.equal(auth.hasThirdPartyProviderAuth({ AWS_PROFILE: "work" }), null, "the provider switch is required too");
});

test("Vertex and Foundry need their project or resource together with a credential", function () {
  var auth = lib("yoke/auth-checks");
  var vertex = { CLAUDE_CODE_USE_VERTEX: "1" };
  assert.equal(auth.hasThirdPartyProviderAuth(vertex), null);
  assert.equal(auth.hasThirdPartyProviderAuth(Object.assign({ ANTHROPIC_VERTEX_PROJECT_ID: "p" }, vertex)), null);
  assert.equal(auth.hasThirdPartyProviderAuth(Object.assign({ GOOGLE_APPLICATION_CREDENTIALS: "/c.json" }, vertex)), null);
  assert.equal(auth.hasThirdPartyProviderAuth(Object.assign({ ANTHROPIC_VERTEX_PROJECT_ID: "p", GOOGLE_APPLICATION_CREDENTIALS: "/c.json" }, vertex)), "vertex");

  var foundry = { CLAUDE_CODE_USE_FOUNDRY: "1" };
  assert.equal(auth.hasThirdPartyProviderAuth(Object.assign({ ANTHROPIC_FOUNDRY_API_KEY: "k" }, foundry)), null);
  assert.equal(auth.hasThirdPartyProviderAuth(Object.assign({ ANTHROPIC_FOUNDRY_RESOURCE: "r" }, foundry)), null);
  assert.equal(auth.hasThirdPartyProviderAuth(Object.assign({ ANTHROPIC_FOUNDRY_API_KEY: "k", ANTHROPIC_FOUNDRY_RESOURCE: "r" }, foundry)), "foundry");
  assert.equal(auth.hasThirdPartyProviderAuth({ ANTHROPIC_API_KEY: "k" }), "api_key");
});

// Errors are produced by running real commands, not hand-built objects.
function captured(file, args, options) {
  try {
    execFileSync(file, args, Object.assign({ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }, options || {}));
  } catch (e) {
    return e;
  }
  throw new Error("expected " + file + " to fail");
}

test("a lookup failure is classified apart from 'not installed'", function () {
  var probe = lib("yoke/install-probe");
  var classify = probe.classifyLookupFailure;

  var notFound = captured(process.execPath, ["-e", "process.exit(1)"]);
  assert.equal(classify(notFound, false), null, "exit 1 with no output is which saying the name is not on PATH");

  var timedOut = captured(process.execPath, ["-e", "setTimeout(function(){}, 10000)"], { timeout: 100 });
  assert.equal(classify(timedOut, false), "timeout");

  var missingTool = captured("clagentic-console-no-such-lookup-tool", []);
  assert.equal(classify(missingTool, false), "lookup-tool-missing");
  assert.equal(classify(missingTool, true), "su-unavailable");

  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-probe-"));
  try {
    var notExecutable = path.join(dir, "tool");
    fs.writeFileSync(notExecutable, "#!/bin/sh\n");
    fs.chmodSync(notExecutable, 420);
    assert.equal(classify(captured(notExecutable, []), false), "permission-denied");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  var suFailed = captured(process.execPath, ["-e", "console.error('su: user ghost does not exist'); process.exit(1)"]);
  assert.equal(classify(suFailed, true), "su-failed", "exit 1 WITH output is su failing, not the agent missing");
  assert.equal(classify(suFailed, false), "lookup-failed");
});

test("a vendor whose lookup failed is reported as not checkable, not as not installed, and the others are unaffected", function () {
  var registry = lib("yoke").registry;
  var probe = lib("yoke/install-probe");
  registry.register({
    id: "flaky", displayName: "Flaky", priority: 97, binaryNames: ["claude"],
    probeInstalled: function (ctx) { return ctx.lookupBinary("claude"); },
    checkAuth: function () { return true; }, installHint: "Install flaky.", loginCommand: "flaky login",
    osUsersSupported: false, needsRuntimeEnv: false, ownedEnvNames: [], nativeInstructionFiles: [],
    interruptMessage: "x", capabilities: {}, createAdapter: function () { return {}; },
  });
  try {
    // Every lookup times out, as a wedged su would.
    var state = withLookupError(probe, function () {
      var err = new Error("spawnSync which ETIMEDOUT");
      err.code = "ETIMEDOUT";
      return err;
    });
    assert.equal(state.failures.flaky, "timeout");
    assert.equal(state.installed.indexOf("flaky"), -1);
    var message = lib("vendor-registry-message");
    var sm = { installedVendors: [], availableVendors: [], capabilitiesByVendor: {} };
    message.recordInstallState(sm, null, state);
    var entry = message.buildVendorRegistryMessage(sm, null).vendors.filter(function (v) { return v.id === "flaky"; })[0];
    assert.equal(entry.installed, false);
    assert.equal(entry.probeFailure, "timeout");
  } finally {
    registry.unregister("flaky");
  }
});

// Runs detectVendorInstallState with every child-process lookup failing.
function withLookupError(probe, makeError) {
  var childProcess = require("child_process");
  var original = childProcess.execFileSync;
  // install-probe binds execFileSync at load; reload it against the stub.
  childProcess.execFileSync = function () { throw makeError(); };
  var key = require.resolve(path.join(world.LIB_ROOT, "yoke/install-probe"));
  var cached = require.cache[key];
  delete require.cache[key];
  try {
    return require(key).detectVendorInstallState(null);
  } finally {
    childProcess.execFileSync = original;
    require.cache[key] = cached;
  }
}
