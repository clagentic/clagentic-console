"use strict";
// The identity surface at a session start: the in-process path through the SDK
// bridge and the Claude adapter, the worker path (the adapter's message to the
// worker and a real worker process), and the plain-user guarantee that with no
// provider configured the launch options, the child environment and everything
// the session shows are exactly what they were without the surface. The Claude
// Agent SDK is a stand-in that records what it was handed.

var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("crypto");
var fs = require("fs");
var net = require("net");
var os = require("os");
var path = require("path");
var nodeModule = require("node:module");
var { spawn } = require("child_process");
var { pathToFileURL } = require("url");

nodeModule.register(pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "resolve-hook.mjs")).href);

var claudeModule = require("../lib/yoke/adapters/claude");
var turnInitiator = require("../lib/turn-initiator");
var config = require("../lib/config");
var delivery = require("../lib/identity/delivery");
var verifier = require("./fixtures/identity-contract/verifier");
var { installFakeIssuer } = require("./fixtures/identity-contract/fake-issuer");
var { INITIATORS } = turnInitiator;

var APP_ID = "clagentic-console/" + require("../package.json").version;
var IDENTITY_ENV = "CLAGENTIC_IDENTITY_DIR";

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), "identity-wiring-")); }
function lastFakeQuery() {
  var all = globalThis.__fakeAgentSdkQueries || [];
  return all[all.length - 1];
}
async function until(predicate, label) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.fail("timed out waiting for " + label);
}

// The environment a plain Claude process gets: the daemon's own, plus the two
// variables the console always adds. Written out, not computed by the code under test.
function plainEnv() {
  var env = {};
  Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
  env.CLAUDE_AGENT_SDK_CLIENT_APP = APP_ID;
  env.CLAUDE_CODE_HOST_SCHEDULED_RUN = "1";
  return env;
}

// What decides the CLI's argv: the SDK's options, without the live objects.
function launchOptions(query) {
  return JSON.parse(JSON.stringify(query.options, function (key, value) {
    if (typeof value === "function") return "[function]";
    return value;
  }));
}

// A project's SDK bridge over the real Claude adapter and the stand-in SDK.
function makeBridge(daemonConfig, vendorAdapter) {
  var realAdapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var adapter = vendorAdapter || {
    vendor: "claude",
    createQuery: realAdapter.createQuery,
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
  };
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  var { createSDKBridge } = require("../lib/sdk-bridge");
  var sent = [];
  var saves = [];
  var sm = {
    sessions: new Map(), currentModel: null, currentPermissionMode: null, currentEffort: null, currentBetas: [],
    modelsByVendor: {}, availableVendors: [], installedVendors: [], defaultVendor: adapter.vendor,
    saveSessionFile: function (s) { saves.push(JSON.stringify(s.identity || null)); },
    broadcastSessionList: function () {}, getActiveSession: function () { return null; },
    setSlashCommandsForVendor: function () {},
    sendAndRecord: function (s, obj) { sent.push(obj); },
    sendToSession: function (s, obj) { sent.push(obj); },
  };
  var bridge = createSDKBridge({
    cwd: os.tmpdir(), slug: "identity-wiring", sessionManager: sm,
    send: function (msg) { sent.push(msg); },
    adapter: adapter, adapters: { [adapter.vendor]: adapter },
    onProcessingChanged: function () {},
    getConfig: daemonConfig === "none" ? null : function () { return daemonConfig; },
  });
  return { bridge: bridge, sm: sm, sent: sent, saves: saves };
}

function makeSession(extra) {
  return Object.assign({
    localId: 9001, queryInstance: null, messageQueue: null, abortController: null, isProcessing: false,
    cliSessionId: null, history: [], blocks: {}, sentToolResults: {}, pendingPermissions: {}, pendingAskUser: {},
    pendingElicitations: {}, activeTaskToolIds: {}, singleTurn: false, lastActivityAt: Date.now(),
    _isCountedLive: false, _adapterWorkerState: null, _workerExitPromise: null,
  }, extra);
}

async function runSession(daemonConfig, sessionExtra, initiator, vendorAdapter) {
  var h = makeBridge(daemonConfig, vendorAdapter);
  var session = makeSession(sessionExtra);
  h.sm.sessions.set(session.localId, session);
  await h.bridge.startQuery(session, "hello", undefined, null, initiator === undefined ? INITIATORS.HUMAN : initiator);
  await sleep(40);
  h.session = session;
  h.query = lastFakeQuery();
  h.end = async function () {
    if (session.queryInstance) session.queryInstance.close();
    await sleep(60);
  };
  return h;
}

function writeKey(dir) {
  var keyPath = path.join(dir, "key.pem");
  fs.writeFileSync(keyPath, crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return keyPath;
}

function jwksSelfConfig(dir) {
  return { identity: { provider: "jwks-self", signing_key: writeKey(dir), jwks_path: path.join(dir, "jwks.json"), spawn_root: path.join(dir, "spawn"), roles: ["builder"] } };
}

function gatekeeperConfig(dir, issuer, socketName) {
  return { identity: { provider: "gatekeeper", gatekeeper: { socket: "/run/test/" + socketName, binary: issuer.binary }, spawn_root: path.join(dir, "spawn") } };
}

var CONSOLE_IDENTITY_DIR = path.join(config.CONFIG_DIR, "identity");

// --- Plain user: with no provider configured, nothing differs ---

test("with no provider configured, the launch options, the child environment and everything shown are identical, whichever way none is spelled", async function () {
  var before = process.env[IDENTITY_ENV];
  delete process.env[IDENTITY_ENV];
  try {
    var spellings = ["none", {}, { identity: { provider: "none" } }, { identity: null }];
    var runs = [];
    for (var i = 0; i < spellings.length; i++) {
      var h = await runSession(spellings[i], {}, INITIATORS.HUMAN);
      // The session start saves nothing by itself; saving the finished record is
      // what makes the saved-record check below able to fail.
      h.sm.saveSessionFile(h.session);
      runs.push({
        options: launchOptions(h.query),
        env: h.query.env,
        sent: JSON.stringify(h.sent),
        session: Object.keys(h.session).sort(),
        identityMember: "identity" in h.query.options,
        saves: h.saves,
      });
      await h.end();
    }
    runs.forEach(function (run, index) {
      assert.deepEqual(run.env, plainEnv(), "the child environment is the daemon's plus the console's two, spelling " + index);
      assert.equal(IDENTITY_ENV in run.env, false);
      assert.equal(run.identityMember, false, "the SDK is handed no identity member");
      assert.equal(run.session.indexOf("identity"), -1, "the session record carries no identity field");
      assert.equal(run.session.indexOf("_identityLease"), -1);
      assert.equal(/identity/i.test(run.sent), false, "no prompt, title, card or notice mentions identity");
      assert.deepEqual(run.options, runs[0].options, "the launch options do not depend on how none is spelled");
      assert.equal(run.sent, runs[0].sent);
      assert.deepEqual(run.session, runs[0].session);
      assert.ok(run.saves.length > 0, "a record was saved, so the check below is not vacuous");
      assert.equal(run.saves.some(function (s) { return s.indexOf('{"provider"') !== -1; }), false, "no saved session record carries an identity record");
    });
    assert.equal(fs.existsSync(CONSOLE_IDENTITY_DIR), false, "no identity directory, key or key set was created");
  } finally {
    if (before !== undefined) process.env[IDENTITY_ENV] = before;
  }
});

test("with no provider configured, an inherited identity variable passes through untouched", async function () {
  var before = process.env[IDENTITY_ENV];
  process.env[IDENTITY_ENV] = "/inherited/value";
  try {
    var h = await runSession("none", {}, INITIATORS.HUMAN);
    assert.equal(h.query.env[IDENTITY_ENV], "/inherited/value");
    await h.end();
  } finally {
    if (before === undefined) delete process.env[IDENTITY_ENV];
    else process.env[IDENTITY_ENV] = before;
  }
});

// --- Class 1 and class 2 through the bridge ---

test("class 1: a typed session gets no assertion, no identity variable and no notice, and the record says declared with the reason", async function () {
  var dir = scratch();
  var issuer = installFakeIssuer();
  var before = process.env[IDENTITY_ENV];
  delete process.env[IDENTITY_ENV];
  try {
    var h = await runSession(gatekeeperConfig(dir, issuer, "issuer.sock"), { agentName: "builder-agent" }, INITIATORS.HUMAN);
    assert.deepEqual(h.query.env, plainEnv(), "the child environment is the plain one");
    assert.equal(IDENTITY_ENV in h.query.env, false);
    assert.deepEqual(issuer.invocations(), [], "the issuer's client was never run");
    assert.deepEqual(h.session.identity, { provider: "declared", grade: null, origin: "human", unavailable: "origin_human_not_issued" });
    assert.equal(h.sent.some(function (m) { return m.source === "identity"; }), false, "no notice for an expected absence");
    await h.end();
  } finally {
    if (before !== undefined) process.env[IDENTITY_ENV] = before;
    issuer.cleanup();
  }
});

test("class 1: a session with a persona and a non-typed origin gets the issuer's directory in its environment and the record says gatekeeper", async function () {
  var dir = scratch();
  var issuer = installFakeIssuer();
  var before = process.env[IDENTITY_ENV];
  delete process.env[IDENTITY_ENV];
  try {
    var h = await runSession(gatekeeperConfig(dir, issuer, "issuer.sock"), { agentName: "builder-agent" }, INITIATORS.LOOP);
    var issued = issuer.issued();
    assert.equal(issued.length, 1);
    var expected = plainEnv();
    expected[IDENTITY_ENV] = issued[0];
    assert.deepEqual(h.query.env, expected, "only the identity variable is added to the plain environment");

    var claims = delivery.decodeClaims(fs.readFileSync(path.join(issued[0], "identity.jwt"), "utf8"));
    assert.equal(claims.act.sub, "agent:builder-agent");
    assert.equal(claims.origin, "loop");
    assert.equal(claims.rt.id, "claude-code");
    assert.deepEqual(h.session.identity, { provider: "gatekeeper", grade: "workload", origin: "loop" });
    assert.deepEqual(JSON.parse(h.saves[h.saves.length - 1]), h.session.identity, "the record was saved");
    assert.equal(h.sent.some(function (m) { return m.source === "identity"; }), false, "no notice when an identity was issued");

    await h.end();
    assert.deepEqual(issuer.issued(), [], "the directory is removed when the session ends");
  } finally {
    if (before !== undefined) process.env[IDENTITY_ENV] = before;
    issuer.cleanup();
  }
});

test("class 1: a scheduled or loop session starts with that origin, never human", async function () {
  var dir = scratch();
  var issuer = installFakeIssuer();
  try {
    var initiators = [INITIATORS.SCHEDULED, INITIATORS.SCHEDULED_NOW, INITIATORS.LOOP, INITIATORS.TRIGGER];
    var origins = [];
    for (var i = 0; i < initiators.length; i++) {
      var h = await runSession(gatekeeperConfig(dir, issuer, "issuer.sock"), {}, initiators[i]);
      origins.push(h.session.identity.origin);
      await h.end();
    }
    assert.deepEqual(origins, ["scheduled", "scheduled", "loop", "trigger"]);
    assert.equal(issuer.invocations().some(function (a) { return a.indexOf("human") !== -1; }), false);
  } finally {
    issuer.cleanup();
  }
});

test("class 1: an issuer that cannot be reached still lets the session start, with no identity variable and one notice", async function () {
  var dir = scratch();
  var issuer = installFakeIssuer();
  var before = process.env[IDENTITY_ENV];
  process.env[IDENTITY_ENV] = "/inherited/value";
  try {
    var h = makeBridge(gatekeeperConfig(dir, issuer, "unreachable.sock"));
    var session = makeSession({ agentName: "builder-agent" });
    h.sm.sessions.set(session.localId, session);
    await h.bridge.startQuery(session, "hello", undefined, null, INITIATORS.LOOP);
    await sleep(40);

    var query = lastFakeQuery();
    assert.equal(query.messages.length, 1, "the turn was delivered: the session started");
    assert.equal(IDENTITY_ENV in query.env, false, "no directory, and not the inherited one either");
    assert.deepEqual(session.identity, { provider: "declared", grade: null, origin: "loop", unavailable: "issuer_unavailable" });
    var notices = h.sent.filter(function (m) { return m.source === "identity"; });
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, "diagnostic");
    assert.equal(notices[0].severity, "warning");
    assert.match(notices[0].message, /^Clagentic: Console could not obtain an identity for this session/);

    // The same failure at the next start is not announced again.
    session.queryInstance.close();
    await sleep(60);
    await h.bridge.startQuery(session, "again", undefined, null, INITIATORS.LOOP);
    await sleep(40);
    assert.equal(h.sent.filter(function (m) { return m.source === "identity"; }).length, 1);
    assert.equal(IDENTITY_ENV in lastFakeQuery().env, false);
    session.queryInstance.close();
    await sleep(60);
  } finally {
    if (before === undefined) delete process.env[IDENTITY_ENV];
    else process.env[IDENTITY_ENV] = before;
    issuer.cleanup();
  }
});

test("class 2: with no issuer installed the console signs an assertion the contract's verifier accepts against its published key set", async function () {
  var dir = scratch();
  var cfg = jwksSelfConfig(dir);
  var h = await runSession(cfg, { agentName: "builder-agent" }, INITIATORS.LOOP);
  var sessionDir = h.query.env[IDENTITY_ENV];
  assert.ok(sessionDir, "the session's environment names its directory");
  assert.equal(path.dirname(sessionDir), path.join(dir, "spawn"));
  assert.deepEqual(h.session.identity, { provider: "jwks-self", grade: "harness", origin: "loop" });

  var issuerName = pathToFileURL(cfg.identity.jwks_path).href;
  var verified = await verifier.verifyToken(fs.readFileSync(path.join(sessionDir, "identity.jwt"), "utf8"), {
    trusted: { [issuerName]: JSON.parse(fs.readFileSync(cfg.identity.jwks_path, "utf8")) },
    mode: "local", now: Math.floor(Date.now() / 1000), observedDir: sessionDir,
  });
  assert.equal(verified.ok, true, verified.error);
  assert.equal(verified.actor, "agent:builder-agent");
  assert.equal(verified.claims.origin, "loop");

  await h.end();
  assert.equal(fs.existsSync(sessionDir), false, "the directory is removed when the session ends");
});

test("a session that fails to start does not leave its identity directory behind", async function () {
  var dir = scratch();
  var cfg = jwksSelfConfig(dir);
  var failing = { vendor: "claude", createQuery: function () { return Promise.reject(new Error("no CLI")); },
    init: function () { return Promise.resolve({ models: [], skills: [] }); }, supportedModels: function () { return Promise.resolve([]); } };
  var h = makeBridge(cfg, failing);
  var session = makeSession();
  h.sm.sessions.set(session.localId, session);
  await h.bridge.startQuery(session, "hello", undefined, null, INITIATORS.HUMAN);
  assert.equal(session.queryInstance, null);
  await sleep(60);
  var left = fs.existsSync(path.join(dir, "spawn")) ? fs.readdirSync(path.join(dir, "spawn")) : [];
  assert.deepEqual(left, []);
});

test("a Codex session is not given an assertion: its record says declared and nothing is shown", async function () {
  var dir = scratch();
  var seen = [];
  var codexLike = {
    vendor: "codex",
    createQuery: function (opts) {
      seen.push(opts);
      return Promise.resolve({ pushMessage: function () {}, close: function () {}, abort: function () {}, endInput: function () {},
        [Symbol.asyncIterator]: function () { return { next: function () { return Promise.resolve({ done: true, value: undefined }); } }; } });
    },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
  };
  var h = makeBridge(jwksSelfConfig(dir), codexLike);
  var session = makeSession({ vendor: "codex" });
  h.sm.sessions.set(session.localId, session);
  await h.bridge.startQuery(session, "hello", undefined, null, INITIATORS.HUMAN);
  await sleep(60);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].identity, { dir: null });
  assert.deepEqual(session.identity, { provider: "declared", grade: null, origin: "human", unavailable: "runtime_unsupported" });
  assert.equal(h.sent.some(function (m) { return m.source === "identity"; }), false);
  assert.equal(fs.existsSync(path.join(dir, "spawn")), false, "no directory was made for it");
});

// --- The child's environment ---

test("the identity variable is the console's alone: Settings cannot set it, the issued directory wins, and none removes it", function () {
  var base = { PATH: "/bin", [IDENTITY_ENV]: "/inherited" };
  var overlay = { [IDENTITY_ENV]: "/from/settings", KEEP: "1" };
  var withDir = turnInitiator.claudeProcessEnv(base, overlay, { dir: "/run/issued" });
  assert.equal(withDir[IDENTITY_ENV], "/run/issued");
  assert.equal(withDir.KEEP, "1");
  assert.equal(IDENTITY_ENV in turnInitiator.claudeProcessEnv(base, overlay, { dir: null }), false);
  assert.equal(IDENTITY_ENV in turnInitiator.claudeProcessEnv(base, overlay, { dir: "" }), false);
  assert.equal(turnInitiator.claudeProcessEnv(base, overlay)[IDENTITY_ENV], "/inherited", "without a provider the environment is untouched");
  assert.equal(turnInitiator.claudeProcessEnv(base, null, INITIATORS.HUMAN)[IDENTITY_ENV], "/inherited", "a non-object third argument is not an identity");
});

// --- Worker path ---

function fakeWorker() {
  var sent = [];
  return {
    sent: sent, ready: true, process: { killed: false, pid: 4242 }, messageHandlers: [], exitPromise: Promise.resolve(),
    send: function (msg) { sent.push(msg); },
    onMessage: function (handler) { this.messageHandlers.push(handler); },
  };
}

test("the adapter sends a worker the identity directory only when there is a provider", async function () {
  var adapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var withIdentity = fakeWorker();
  await adapter.createQuery({ cwd: os.tmpdir(), identity: { dir: "/run/issued" }, adapterOptions: { CLAUDE: { linuxUser: "alice", _workerState: { worker: withIdentity } } } });
  assert.deepEqual(withIdentity.sent.find(function (m) { return m.type === "query_start"; }).options.identity, { dir: "/run/issued" });

  var unavailable = fakeWorker();
  await adapter.createQuery({ cwd: os.tmpdir(), identity: { dir: null }, adapterOptions: { CLAUDE: { linuxUser: "alice", _workerState: { worker: unavailable } } } });
  assert.deepEqual(unavailable.sent.find(function (m) { return m.type === "query_start"; }).options.identity, { dir: null });

  var plain = fakeWorker();
  await adapter.createQuery({ cwd: os.tmpdir(), adapterOptions: { CLAUDE: { linuxUser: "alice", _workerState: { worker: plain } } } });
  assert.equal("identity" in plain.sent.find(function (m) { return m.type === "query_start"; }).options, false);
});

var WORKER = path.join(__dirname, "..", "lib", "yoke", "adapters", "claude-worker.js");
var REGISTER = pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "register.mjs")).href;

// A real worker process; resolves with the environment its Claude process was given.
async function workerEnvFor(workerEnv, queryOptions) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-worker-id-"));
  var socketPath = path.join(dir, "w.sock");
  var received = [];
  var connection = null;
  var buffer = "";
  var server = net.createServer(function (conn) {
    connection = conn;
    conn.on("data", function (chunk) {
      buffer += chunk.toString();
      var lines = buffer.split("\n");
      buffer = lines.pop();
      lines.filter(Boolean).forEach(function (line) { received.push(JSON.parse(line)); });
    });
    conn.on("error", function () {});
  });
  await new Promise(function (resolve) { server.listen(socketPath, resolve); });
  var child = spawn(process.execPath, ["--import", REGISTER, WORKER, socketPath], {
    env: Object.assign({ PATH: process.env.PATH, HOME: dir }, workerEnv), cwd: dir, stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await until(function () { return received.some(function (m) { return m.type === "ready"; }); }, "worker ready");
    connection.write(JSON.stringify({ type: "query_start", prompt: null, options: Object.assign({ cwd: os.tmpdir() }, queryOptions), singleTurn: false }) + "\n");
    await until(function () { return received.some(function (m) { return m.type === "sdk_event" && m.event.call === "env"; }); }, "the env probe");
    var probe = received.find(function (m) { return m.type === "sdk_event" && m.event.call === "env"; });
    return { env: probe.event.env, optionKeys: probe.event.optionKeys };
  } finally {
    try { child.kill("SIGKILL"); } catch (e) { /* already gone */ }
    await new Promise(function (resolve) { server.close(resolve); if (connection) connection.destroy(); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a real worker puts the identity directory in its Claude process's environment, removes an inherited one when there is none, and leaves it alone without a provider", async function () {
  var withDir = await workerEnvFor({ [IDENTITY_ENV]: "/inherited" }, { identity: { dir: "/run/issued/cc-1" } });
  assert.equal(withDir.env[IDENTITY_ENV], "/run/issued/cc-1");
  assert.equal(withDir.optionKeys.indexOf("identity"), -1, "the SDK is not handed the identity member");

  var none = await workerEnvFor({ [IDENTITY_ENV]: "/inherited" }, { identity: { dir: null } });
  assert.equal(IDENTITY_ENV in none.env, false);

  var plain = await workerEnvFor({ [IDENTITY_ENV]: "/inherited" }, {});
  assert.equal(plain.env[IDENTITY_ENV], "/inherited");
  assert.equal(plain.env.CLAUDE_AGENT_SDK_CLIENT_APP, APP_ID);
});
