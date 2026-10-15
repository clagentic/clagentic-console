"use strict";
// The identity surface (lib/identity): configuration, delivery directories, the
// three provider classes and the user-supplied provider, each judged from the
// outside. The console's own assertions are checked with the contract verifier
// (test/fixtures/identity-contract/verifier.js), which the vendored conformance
// vectors prove in identity-contract-vectors.test.js. The issuer's client is a
// stand-in executable (fake-issuer.js) run exactly as the real one is run.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var url = require("url");

var configModule = require("../lib/identity/config");
var delivery = require("../lib/identity/delivery");
var originMap = require("../lib/identity/origin");
var recordModule = require("../lib/identity/record");
var { createIdentity } = require("../lib/identity");
var { INITIATORS } = require("../lib/turn-initiator");
var verifier = require("./fixtures/identity-contract/verifier");
var { installFakeIssuer } = require("./fixtures/identity-contract/fake-issuer");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "identity-test-"));
}

function identityFor(raw, configDir, warnings) {
  return createIdentity({
    getConfig: function () { return raw; },
    configDir: configDir,
    warn: function (message) { if (warnings) warnings.push(message); },
  });
}

function readClaims(dir) {
  return delivery.decodeClaims(fs.readFileSync(path.join(dir, "identity.jwt"), "utf8"));
}

function entries(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

// --- Origin ---

test("a turn's initiator maps to the contract's origin, and an unnamed one is never human", function () {
  assert.equal(originMap.originForInitiator(INITIATORS.HUMAN), "human");
  assert.equal(originMap.originForInitiator(INITIATORS.SCHEDULED), "scheduled");
  assert.equal(originMap.originForInitiator(INITIATORS.SCHEDULED_NOW), "scheduled");
  assert.equal(originMap.originForInitiator(INITIATORS.LOOP), "loop");
  assert.equal(originMap.originForInitiator(INITIATORS.TRIGGER), "trigger");
  [undefined, null, "", "robot"].forEach(function (v) {
    assert.equal(originMap.originForInitiator(v), "trigger");
  });
});

// --- Configuration ---

test("no identity block, or provider none, is the default and asks nothing of anyone", function () {
  [undefined, null, {}, { provider: "none" }, { provider: "none", provider_module: "/x.js" }].forEach(function (raw) {
    assert.deepEqual(configModule.resolveConfig(raw, "/cfg"), { provider: "none" }, JSON.stringify(raw));
  });
});

test("each provider's block is read with its defaults, and a block that cannot be understood says so", function () {
  var gk = configModule.resolveConfig({ provider: "gatekeeper", gatekeeper: { socket: "/run/issuer.sock" } }, "/cfg");
  assert.equal(gk.provider, "gatekeeper");
  assert.equal(gk.binary, "gatekeeper");
  assert.equal(gk.spawnRoot, path.join("/cfg", "identity", "spawn"));

  var js = configModule.resolveConfig({ provider: "jwks-self" }, "/cfg");
  assert.equal(js.signingKey, path.join("/cfg", "identity", "signing-key.pem"));
  assert.equal(js.jwksPath, path.join("/cfg", "identity", "jwks.json"));
  assert.equal(js.issuer, url.pathToFileURL(js.jwksPath).href);
  assert.equal(js.generateKey, true);
  assert.equal(configModule.resolveConfig({ provider: "jwks-self", signing_key: "/k.pem" }, "/cfg").generateKey, false);

  assert.equal(configModule.resolveConfig({ provider_module: "/m.js" }, "/cfg").provider, "module");

  [
    "text",
    { provider: "gatekeeper" },
    { provider: "gatekeeper", gatekeeper: { socket: "relative.sock" } },
    { provider: "jwks-self", ttl_seconds: 43201 },
    { provider: "jwks-self", roles: ["Bad Role"] },
    { provider: "jwks-self", signing_key: "key.pem" },
    { provider: "jwks-self", provider_module: "/m.js" },
    { provider: "module", provider_module: "m.js" },
    { provider: "mystery" },
    { provider: 5 },
  ].forEach(function (raw) {
    var cfg = configModule.resolveConfig(raw, "/cfg");
    assert.equal(cfg.provider, "invalid", JSON.stringify(raw));
    assert.ok(cfg.reason.length > 0);
  });
});

// --- Delivery directories ---

test("a delivery directory is private, has tmp, and takes its assertion atomically", function () {
  var root = path.join(scratch(), "spawn");
  var dir = delivery.allocateDir(root);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "tmp")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(root).mode & 0o022, 0, "the root is not writable by others");
  delivery.writeAssertion(dir, "a.b.c");
  assert.equal(fs.readFileSync(path.join(dir, "identity.jwt"), "utf8"), "a.b.c");
  assert.equal(fs.statSync(path.join(dir, "identity.jwt")).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(dir, "tmp")), [], "nothing is left staged");
  assert.throws(function () { delivery.writeAssertion(dir, "x".repeat(16385)); });
});

test("a spawn root that is a link, or writable by others, is refused", function () {
  var base = scratch();
  var real = path.join(base, "real");
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(base, "link"));
  assert.throws(function () { delivery.allocateDir(path.join(base, "link")); }, /not a directory/);
  var loose = path.join(base, "loose");
  fs.mkdirSync(loose);
  fs.chmodSync(loose, 0o777);
  assert.throws(function () { delivery.allocateDir(loose); }, /writable by group or other/);
  assert.throws(function () { delivery.allocateDir("relative/root"); }, /absolute/);
});

test("an orphaned directory of a crashed console is swept, and nothing else under the root is", function () {
  var root = path.join(scratch(), "spawn");
  fs.mkdirSync(root, { mode: 0o711 });
  var old = path.join(root, "cc-" + "a".repeat(32));
  var fresh = path.join(root, "cc-" + "b".repeat(32));
  var foreign = path.join(root, "keep-me");
  [old, fresh, foreign].forEach(function (d) { fs.mkdirSync(d, { mode: 0o700 }); });
  var longAgo = new Date(Date.now() - 20 * 3600 * 1000);
  fs.utimesSync(old, longAgo, longAgo);
  fs.utimesSync(foreign, longAgo, longAgo);
  delivery.allocateDir(root);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(foreign), true);
});

test("a directory a provider hands back is checked the way a consumer checks it", async function () {
  var root = path.join(scratch(), "spawn");
  var uid = process.getuid();
  var now = Math.floor(Date.now() / 1000);
  function make(claims, mutate) {
    var dir = delivery.allocateDir(root);
    var body = Object.assign({ dir: dir, cia: 1, grade: "workload", origin: "human", exp: now + 600 }, claims);
    var enc = function (o) { return Buffer.from(JSON.stringify(o)).toString("base64url"); };
    delivery.writeAssertion(dir, enc({ alg: "EdDSA" }) + "." + enc(body) + ".sig");
    if (mutate) mutate(dir);
    return dir;
  }
  assert.equal(delivery.inspect(make({}), uid).grade, "workload");

  function refused(dir, pattern) { assert.throws(function () { delivery.inspect(dir, uid); }, pattern); }
  refused(make({}, function (d) { fs.chmodSync(d, 0o755); }), /not private/);
  refused(make({}, function (d) { fs.rmSync(path.join(d, "identity.jwt")); }), /no readable assertion/);
  refused(make({}, function (d) {
    fs.rmSync(path.join(d, "identity.jwt"));
    fs.writeFileSync(path.join(d, "elsewhere"), "x.y.z");
    fs.symlinkSync(path.join(d, "elsewhere"), path.join(d, "identity.jwt"));
  }), /no readable assertion/);
  refused(make({ dir: "/somewhere/else" }), /not bound to its delivery directory/);
  refused(make({ cia: 2 }), /contract version/);
  refused(make({ grade: "root" }), /unknown grade or origin/);
  refused(make({ origin: "robot" }), /unknown grade or origin/);
  refused(make({ exp: now - 5 }), /expired/);
  refused(path.join(root, "absent"), /does not exist/);
  refused("relative", /absolute/);
  var linked = make({});
  var viaLink = path.join(root, "via-link");
  fs.symlinkSync(linked, viaLink);
  refused(viaLink, /link or not a directory/);
});

test("removing a delivery directory touches only what was checked", function () {
  var root = path.join(scratch(), "spawn");
  var uid = process.getuid();
  var mine = delivery.allocateDir(root);
  assert.equal(delivery.removeDelivery(mine, uid, true), true);
  assert.equal(fs.existsSync(mine), false);

  // A provider's directory goes only while it still holds an assertion.
  var theirs = path.join(scratch(), "issued");
  fs.mkdirSync(theirs, { mode: 0o700 });
  assert.equal(delivery.removeDelivery(theirs, uid, false), false);
  fs.writeFileSync(path.join(theirs, "identity.jwt"), "a.b.c");
  assert.equal(delivery.removeDelivery(theirs, uid, false), true);

  // Never the wrong owner, a link, a relative path, or a top-level directory.
  var other = delivery.allocateDir(root);
  assert.equal(delivery.removeDelivery(other, uid + 1, true), false);
  assert.equal(delivery.removeDelivery(path.join(root, "nonexistent"), uid, true), false);
  assert.equal(delivery.removeDelivery("relative", uid, true), false);
  assert.equal(delivery.removeDelivery("/tmp", uid, true), false);
  assert.equal(fs.existsSync(other), true);
  var link = path.join(root, "link");
  fs.symlinkSync(other, link);
  assert.equal(delivery.removeDelivery(link, uid, true), false);
  assert.equal(fs.existsSync(other), true);
});

// --- Record ---

test("a record read back from a session file keeps known values only", function () {
  assert.deepEqual(recordModule.sanitizeRecord({ provider: "gatekeeper", grade: "workload", origin: "human", extra: 1 }),
    { provider: "gatekeeper", grade: "workload", origin: "human" });
  assert.deepEqual(recordModule.sanitizeRecord({ provider: "declared", grade: "bogus", origin: "x", unavailable: "issuer_unavailable" }),
    { provider: "declared", grade: null, origin: null, unavailable: "issuer_unavailable" });
  [null, "x", 5, {}, { provider: "has space" }, { provider: 7 }].forEach(function (v) {
    assert.equal(recordModule.sanitizeRecord(v), null);
  });
});

// --- Class 3: none ---

test("with no provider configured nothing is asked, made or logged", async function () {
  var cfgDir = scratch();
  var warnings = [];
  var raws = [undefined, {}, { provider: "none" }];
  for (var i = 0; i < raws.length; i++) {
    var identity = identityFor(raws[i], cfgDir, warnings);
    assert.equal(identity.isEnabled(), false);
    assert.equal(await identity.begin({ definition: "x", initiator: INITIATORS.HUMAN, rt: "claude-code" }), null);
  }
  assert.deepEqual(entries(cfgDir), [], "no file or directory was created");
  assert.deepEqual(warnings, []);
});

// --- Class 2: jwks-self ---

async function jwksSelfSession(cfgDir, extra, request) {
  var raw = Object.assign({ provider: "jwks-self", roles: ["builder"] }, extra);
  var identity = identityFor(raw, cfgDir);
  return { identity: identity, lease: await identity.begin(request), cfg: configModule.resolveConfig(raw, cfgDir) };
}

test("the console signs an assertion that a verifier built from the contract accepts against the JWKS it publishes", async function () {
  var cfgDir = scratch();
  var s = await jwksSelfSession(cfgDir, {}, { definition: "builder-agent", initiator: INITIATORS.HUMAN, rt: "claude-code" });
  assert.ok(s.lease.dir, s.lease.notice);
  assert.deepEqual(s.lease.record, { provider: "jwks-self", grade: "harness", origin: "human" });
  assert.equal(s.lease.notice, null);

  var jwks = JSON.parse(fs.readFileSync(s.cfg.jwksPath, "utf8"));
  assert.equal(jwks.keys.length, 1);
  assert.equal("d" in jwks.keys[0], false, "no private parameter is published");
  assert.equal(jwks.keys[0].alg, "EdDSA");
  assert.equal(jwks.keys[0].use, "sig");

  var token = fs.readFileSync(path.join(s.lease.dir, "identity.jwt"), "utf8");
  var verified = await verifier.verifyToken(token, {
    trusted: { [s.cfg.issuer]: jwks },
    mode: "local",
    now: Math.floor(Date.now() / 1000),
    observedDir: s.lease.dir,
  });
  assert.equal(verified.ok, true, verified.error);
  assert.equal(verified.actor, "agent:builder-agent");
  assert.equal(verified.grade, "harness");
  assert.equal(verified.claims.sub, "runtime:claude-code");
  assert.equal(verified.claims.origin, "human");
  assert.deepEqual(verified.claims.roles, ["builder"]);
  assert.equal(verified.claims.rt.id, "claude-code");
  assert.equal(verified.claims.exp - verified.claims.iat, 3600);

  // The delivery is as the contract lays it out and is bound to its directory.
  assert.equal(verifier.checkDelivery(s.lease.dir).ok, true);
  var copy = path.join(scratch(), "copy");
  fs.mkdirSync(copy, { mode: 0o700 });
  var moved = await verifier.verifyToken(token, {
    trusted: { [s.cfg.issuer]: jwks }, mode: "local", now: Math.floor(Date.now() / 1000), observedDir: copy,
  });
  assert.equal(moved.error, "dir_mismatch");
  s.lease.release();
});

test("the console never signs a human, for any origin, with or without a persona", async function () {
  var cfgDir = scratch();
  var cases = [
    [INITIATORS.HUMAN, "builder-agent"], [INITIATORS.HUMAN, null], [INITIATORS.SCHEDULED, "x"], [INITIATORS.SCHEDULED_NOW, null],
    [INITIATORS.LOOP, "x"], [INITIATORS.TRIGGER, null], [undefined, null],
  ];
  for (var i = 0; i < cases.length; i++) {
    var s = await jwksSelfSession(cfgDir, {}, { definition: cases[i][1], initiator: cases[i][0], rt: "claude-code" });
    var claims = readClaims(s.lease.dir);
    var texts = JSON.stringify([claims.sub, claims.act]);
    assert.equal(/human:/.test(texts), false, texts);
    assert.match(claims.sub, /^runtime:/);
    assert.equal(claims.act.sub, cases[i][1] ? "agent:" + cases[i][1] : "runtime:claude-code");
    assert.equal(claims.origin, originMap.originForInitiator(cases[i][0]));
    s.lease.release();
  }
});

test("the default signing key is created private, reused, and a named key is never replaced", async function () {
  var cfgDir = scratch();
  var first = await jwksSelfSession(cfgDir, {}, { initiator: INITIATORS.LOOP, rt: "claude-code" });
  var keyPath = first.cfg.signingKey;
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  var kid = JSON.parse(fs.readFileSync(first.cfg.jwksPath, "utf8")).keys[0].kid;
  var second = await jwksSelfSession(cfgDir, {}, { initiator: INITIATORS.LOOP, rt: "claude-code" });
  assert.equal(JSON.parse(fs.readFileSync(second.cfg.jwksPath, "utf8")).keys[0].kid, kid, "the same key signs the next session");
  first.lease.release();
  second.lease.release();

  var missing = await jwksSelfSession(scratch(), { signing_key: path.join(scratch(), "named.pem") }, { initiator: INITIATORS.LOOP, rt: "claude-code" });
  assert.equal(missing.lease.dir, null);
  assert.equal(missing.lease.record.unavailable, "key_missing");

  fs.chmodSync(keyPath, 0o644);
  var loose = await jwksSelfSession(cfgDir, {}, { initiator: INITIATORS.LOOP, rt: "claude-code" });
  assert.equal(loose.lease.record.unavailable, "key_unsafe");
  assert.equal(loose.lease.dir, null);

  var notEd = path.join(scratch(), "rsa.pem");
  fs.writeFileSync(notEd, require("crypto").generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  var rsa = await jwksSelfSession(scratch(), { signing_key: notEd }, { initiator: INITIATORS.LOOP, rt: "claude-code" });
  assert.equal(rsa.lease.record.unavailable, "key_unsupported");
});

test("a session that ends removes its directory, and ending twice is harmless", async function () {
  var cfgDir = scratch();
  var s = await jwksSelfSession(cfgDir, {}, { initiator: INITIATORS.HUMAN, rt: "claude-code" });
  var spawnRoot = s.cfg.spawnRoot;
  assert.equal(fs.existsSync(s.lease.dir), true);
  s.lease.release();
  s.lease.release();
  await new Promise(function (resolve) { setTimeout(resolve, 50); });
  assert.equal(fs.existsSync(s.lease.dir), false);
  assert.deepEqual(entries(spawnRoot), []);
});

// A session of another OS user (per-user isolation) needs a directory that user
// owns; the console changes ownership, so this runs only where it may.
test("a session of another OS user gets a directory that user owns, and it is removed at the end", { skip: process.getuid() !== 0 }, async function () {
  var OTHER = { uid: 65534, gid: 65534 };
  var cfgDir = scratch();
  var identity = identityFor({ provider: "jwks-self" }, cfgDir);
  var lease = await identity.begin({ definition: "builder-agent", initiator: INITIATORS.HUMAN, rt: "claude-code", owner: OTHER });
  assert.ok(lease.dir, lease.notice);
  [lease.dir, path.join(lease.dir, "tmp"), path.join(lease.dir, "identity.jwt")].forEach(function (p) {
    assert.equal(fs.lstatSync(p).uid, OTHER.uid, p);
  });
  assert.equal(fs.lstatSync(lease.dir).mode & 0o777, 0o700);
  assert.equal(delivery.inspect(lease.dir, OTHER.uid).grade, "harness");
  assert.throws(function () { delivery.inspect(lease.dir, process.getuid()); }, /not private to the session's user/);
  lease.release();
  await new Promise(function (resolve) { setTimeout(resolve, 50); });
  assert.equal(fs.existsSync(lease.dir), false);
});

// --- Unavailable ---

test("a provider that cannot supply an identity leaves the session without one and says so, never fabricating", async function () {
  var cfgDir = scratch();
  var identity = identityFor({ provider: "mystery" }, cfgDir);
  var lease = await identity.begin({ definition: "builder-agent", initiator: INITIATORS.HUMAN, rt: "claude-code" });
  assert.equal(lease.dir, null);
  assert.deepEqual(lease.record, { provider: "declared", grade: null, origin: "human", unavailable: "config_invalid" });
  assert.match(lease.notice, /^Clagentic: Console could not obtain an identity for this session/);
  assert.deepEqual(entries(cfgDir), []);
});

test("a Codex session runs without an assertion, quietly, and its record says so", async function () {
  var cfgDir = scratch();
  var identity = identityFor({ provider: "jwks-self" }, cfgDir);
  var lease = await identity.begin({ definition: null, initiator: INITIATORS.HUMAN, rt: "codex" });
  assert.equal(lease.dir, null);
  assert.equal(lease.notice, null);
  assert.deepEqual(lease.record, { provider: "declared", grade: null, origin: "human", unavailable: "runtime_unsupported" });
  assert.deepEqual(entries(cfgDir), [], "no key was made for a runtime that gets no assertion");
});

// --- Class 1: gatekeeper (the issuer's client program) ---

function gatekeeperConfig(issuer, socketName, extra) {
  return { provider: "gatekeeper", gatekeeper: Object.assign({ socket: "/run/test/" + socketName, binary: issuer.binary }, extra) };
}

test("the issuer's client is run directly with the documented arguments, and its session is delivered", async function () {
  var issuer = installFakeIssuer();
  try {
    var identity = identityFor(gatekeeperConfig(issuer, "issuer.sock"), scratch());
    var lease = await identity.begin({ definition: "builder-agent", initiator: INITIATORS.LOOP, rt: "claude-code" });
    assert.deepEqual(issuer.invocations(), [["hook", "process", "--socket", "/run/test/issuer.sock", "--definition", "builder-agent", "--origin", "loop"]]);
    assert.equal(lease.dir, issuer.issued()[0]);
    assert.deepEqual(lease.record, { provider: "gatekeeper", grade: "workload", origin: "loop" });
    var claims = readClaims(lease.dir);
    assert.equal(claims.act.sub, "agent:builder-agent");
    assert.equal(claims.origin, "loop");
    assert.equal(claims.rt.id, "claude-code");
    lease.release();
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
    assert.deepEqual(issuer.issued(), [], "the session's directory is removed when it ends");
  } finally {
    issuer.cleanup();
  }
});

test("a scheduled, loop or trigger session passes its own origin, never human", async function () {
  var issuer = installFakeIssuer();
  try {
    var identity = identityFor(gatekeeperConfig(issuer, "issuer.sock"), scratch());
    var expected = [[INITIATORS.SCHEDULED, "scheduled"], [INITIATORS.SCHEDULED_NOW, "scheduled"], [INITIATORS.LOOP, "loop"], [INITIATORS.TRIGGER, "trigger"], [undefined, "trigger"]];
    for (var i = 0; i < expected.length; i++) {
      var lease = await identity.begin({ definition: null, initiator: expected[i][0], rt: "claude-code" });
      assert.equal(readClaims(lease.dir).origin, expected[i][1]);
      assert.equal(lease.record.origin, expected[i][1]);
      lease.release();
    }
    var origins = issuer.invocations().map(function (a) { return a[a.indexOf("--origin") + 1]; });
    assert.deepEqual(origins, ["scheduled", "scheduled", "loop", "trigger", "trigger"]);
    issuer.invocations().forEach(function (a) { assert.equal(a.indexOf("--definition"), -1, "no persona, no definition"); });
  } finally {
    issuer.cleanup();
  }
});

test("an issuer that cannot be reached leaves the session without an identity and with a notice", async function () {
  var issuer = installFakeIssuer();
  try {
    var warnings = [];
    var identity = identityFor(gatekeeperConfig(issuer, "unreachable.sock"), scratch(), warnings);
    var lease = await identity.begin({ definition: "builder-agent", initiator: INITIATORS.LOOP, rt: "claude-code" });
    assert.equal(lease.dir, null);
    assert.equal(lease.record.provider, "declared");
    assert.equal(lease.record.grade, null);
    assert.equal(lease.record.unavailable, "issuer_unavailable");
    assert.match(lease.notice, /could not obtain an identity/);
    assert.deepEqual(issuer.issued(), []);
    assert.ok(warnings.some(function (w) { return /gatekeeper client failed/.test(w); }));
  } finally {
    issuer.cleanup();
  }
});

test("under the gatekeeper provider a typed session makes no issuer call, is declared with a stated reason, and shows no notice", async function () {
  var issuer = installFakeIssuer();
  try {
    var warnings = [];
    var identity = identityFor(gatekeeperConfig(issuer, "issuer.sock"), scratch(), warnings);
    var typed = await identity.begin({ definition: "builder-agent", initiator: INITIATORS.HUMAN, rt: "claude-code" });
    assert.equal(typed.dir, null);
    assert.deepEqual(typed.record, { provider: "declared", grade: null, origin: "human", unavailable: "origin_human_not_issued" });
    assert.equal(typed.notice, null);
    assert.deepEqual(issuer.invocations(), [], "the issuer's client was never run");
    assert.deepEqual(issuer.issued(), []);
    assert.deepEqual(warnings, []);
    var loop = await identity.begin({ definition: null, initiator: INITIATORS.LOOP, rt: "claude-code" });
    assert.ok(loop.dir, "other origins are still issued");
    loop.release();
  } finally {
    issuer.cleanup();
  }
});

test("each other way the issuer's client can fail is its own typed unavailability", async function () {
  var issuer = installFakeIssuer();
  try {
    var request = { definition: null, initiator: INITIATORS.LOOP, rt: "claude-code" };
    var missing = await identityFor({ provider: "gatekeeper", gatekeeper: { socket: "/run/x.sock", binary: path.join(issuer.dir, "no-such-client") } }, scratch()).begin(request);
    assert.equal(missing.record.unavailable, "issuer_client_missing");

    var slow = await identityFor(gatekeeperConfig(issuer, "slow.sock", { timeout_ms: 300 }), scratch()).begin(request);
    assert.equal(slow.record.unavailable, "issuer_timeout");

    var garbage = await identityFor(gatekeeperConfig(issuer, "garbage.sock"), scratch()).begin(request);
    assert.equal(garbage.record.unavailable, "issuer_output_invalid");

    var loose = await identityFor(gatekeeperConfig(issuer, "badmode.sock"), scratch()).begin(request);
    assert.equal(loose.record.unavailable, "delivery_invalid");
    assert.equal(loose.dir, null);

    var foreignOwner = await identityFor(gatekeeperConfig(issuer, "issuer.sock"), scratch()).begin({
      definition: null, initiator: INITIATORS.LOOP, rt: "claude-code", owner: { uid: process.getuid() + 1, gid: 0 },
    });
    assert.equal(foreignOwner.record.unavailable, "owner_unsupported");
    assert.equal(issuer.invocations().filter(function (a) { return a.indexOf("/run/x.sock") !== -1; }).length, 0);
  } finally {
    issuer.cleanup();
  }
});

test("an inherited identity directory is not what the issuer's client sees", async function () {
  var issuer = installFakeIssuer();
  var before = process.env.CLAGENTIC_IDENTITY_DIR;
  process.env.CLAGENTIC_IDENTITY_DIR = "/inherited/value";
  try {
    var lease = await identityFor(gatekeeperConfig(issuer, "issuer.sock"), scratch()).begin({ definition: null, initiator: INITIATORS.LOOP, rt: "claude-code" });
    assert.ok(lease.dir);
    assert.deepEqual(issuer.inheritedDirs(), ["undefined"]);
    lease.release();
  } finally {
    if (before === undefined) delete process.env.CLAGENTIC_IDENTITY_DIR;
    else process.env.CLAGENTIC_IDENTITY_DIR = before;
    issuer.cleanup();
  }
});

// --- A user-supplied provider ---

function writeModule(source, ext) {
  var file = path.join(scratch(), "provider" + (ext || ".js"));
  fs.writeFileSync(file, source);
  return file;
}

var MODULE_SIGNER = [
  "const log = globalThis.__identityTestLog = [];",
  "module.exports = {",
  "  name: 'spiffe-client',",
  "  async obtainSession(definition, origin, rt, ctx) {",
  "    log.push({ definition, origin, rt });",
  "    const dir = ctx.allocateDir();",
  "    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');",
  "    const now = Math.floor(Date.now() / 1000);",
  "    const claims = { iss: 'spiffe://example', sub: 'runtime:' + rt, act: { sub: definition ? 'agent:' + definition : 'runtime:' + rt },",
  "      roles: [], grade: 'workload', rt: { id: rt, version: '1' }, sid: 's', origin, dir, iat: now, exp: now + 600, jti: 'j', cia: 1 };",
  "    return { dir, assertion: enc({ alg: 'EdDSA', kid: 'k' }) + '.' + enc(claims) + '.sig' };",
  "  },",
  "  release(info) { log.push({ released: info.provider }); },",
  "};",
].join("\n");

test("a user-supplied provider's assertion is used and its name recorded", async function () {
  var file = writeModule(MODULE_SIGNER);
  var identity = identityFor({ provider_module: file }, scratch());
  assert.equal(identity.isEnabled(), true);
  var lease = await identity.begin({ definition: "builder-agent", initiator: INITIATORS.SCHEDULED, rt: "claude-code" });
  assert.deepEqual(lease.record, { provider: "spiffe-client", grade: "workload", origin: "scheduled" });
  assert.equal(readClaims(lease.dir).act.sub, "agent:builder-agent");
  var log = globalThis.__identityTestLog;
  assert.deepEqual(log[0], { definition: "builder-agent", origin: "scheduled", rt: "claude-code" });
  lease.release();
  await new Promise(function (resolve) { setTimeout(resolve, 50); });
  assert.equal(fs.existsSync(lease.dir), false, "the session's directory is removed when it ends");
  assert.deepEqual(log[1], { released: "spiffe-client" });
});

test("a user-supplied provider cannot pass its sessions off as a built-in provider's", async function () {
  for (var i = 0; i < 3; i++) {
    var name = ["gatekeeper", "jwks-self", "declared"][i];
    var file = writeModule(MODULE_SIGNER.replace("name: 'spiffe-client'", "name: '" + name + "'"));
    var lease = await identityFor({ provider_module: file }, scratch()).begin({ definition: null, initiator: INITIATORS.LOOP, rt: "claude-code" });
    assert.equal(lease.record.provider, "module", name);
    lease.release();
  }
});

test("a user-supplied provider may be an ES module exporting a factory", async function () {
  var file = writeModule(MODULE_SIGNER.replace("module.exports = {", "export default () => ({").replace(/\};\s*$/, "});").replace("const crypto = require('crypto');", ""), ".mjs");
  var lease = await identityFor({ provider_module: file }, scratch()).begin({ definition: null, initiator: INITIATORS.LOOP, rt: "claude-code" });
  assert.equal(lease.record.provider, "spiffe-client");
  lease.release();
});

test("a user-supplied provider that fails, answers badly or cannot be loaded leaves the session without an identity", async function () {
  var request = { definition: null, initiator: INITIATORS.LOOP, rt: "claude-code" };
  var warnings = [];
  var cases = [
    ["module.exports = { obtainSession() { throw new Error('boom'); } };", "provider_error"],
    ["module.exports = { async obtainSession() { return { nothing: true }; } };", "provider_result_invalid"],
    ["module.exports = { async obtainSession() { return { unavailable: true, code: 'no_workload_api', reason: 'the workload API is not running' }; } };", "no_workload_api"],
    ["module.exports = { notAProvider: 1 };", "module_load_failed"],
    ["throw new Error('syntax');", "module_load_failed"],
  ];
  for (var i = 0; i < cases.length; i++) {
    var lease = await identityFor({ provider_module: writeModule(cases[i][0]) }, scratch(), warnings).begin(request);
    assert.equal(lease.dir, null, cases[i][1]);
    assert.equal(lease.record.unavailable, cases[i][1]);
  }
  var gone = await identityFor({ provider_module: path.join(scratch(), "absent.js") }, scratch(), warnings).begin(request);
  assert.equal(gone.record.unavailable, "module_load_failed");
  assert.ok(warnings.length >= 3);
});

test("a provider claiming a human origin for a turn nobody typed is refused and its directory removed", async function () {
  var file = writeModule(MODULE_SIGNER.replace("origin, dir,", "origin: 'human', dir,"));
  var cfgDir = scratch();
  var lease = await identityFor({ provider_module: file }, cfgDir).begin({ definition: null, initiator: INITIATORS.LOOP, rt: "claude-code" });
  assert.equal(lease.dir, null);
  assert.equal(lease.record.unavailable, "origin_mismatch");
  assert.deepEqual(entries(path.join(cfgDir, "identity", "spawn")), [], "the refused session's directory is gone");
  var typed = await identityFor({ provider_module: file }, scratch()).begin({ definition: null, initiator: INITIATORS.HUMAN, rt: "claude-code" });
  assert.ok(typed.dir, "the same claim on a typed turn is allowed");
  typed.release();
});

// --- A provider that settles after the console stopped waiting ---

function lateIdentityFor(raw, cfgDir, warnings) {
  return createIdentity({
    getConfig: function () { return raw; },
    configDir: cfgDir,
    providerTimeoutMs: 100,
    warn: function (message) { warnings.push(message); },
  });
}

function pause(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

var LATE_REQUEST = { definition: null, initiator: INITIATORS.LOOP, rt: "claude-code" };

// Allocates its directory before the timeout, answers after it.
var LATE_AFTER_ALLOCATE = MODULE_SIGNER
  .replace("return { dir,", "await new Promise((r) => setTimeout(r, 400)); return { dir,");

// Waits past the timeout, then asks for its directory.
var LATE_BEFORE_ALLOCATE = MODULE_SIGNER
  .replace("const dir = ctx.allocateDir();", "await new Promise((r) => setTimeout(r, 400)); const dir = ctx.allocateDir();");

test("a module provider that answers after the timeout has its directory removed and its release called", async function () {
  var cfgDir = scratch();
  var warnings = [];
  var lease = await lateIdentityFor({ provider_module: writeModule(LATE_AFTER_ALLOCATE) }, cfgDir, warnings).begin(LATE_REQUEST);
  assert.equal(lease.dir, null, "the child is given no CLAGENTIC_IDENTITY_DIR");
  assert.equal(lease.record.unavailable, "provider_timeout");
  await pause(700);
  assert.deepEqual(entries(path.join(cfgDir, "identity", "spawn")), [], "no directory remains under the spawn root");
  assert.deepEqual(globalThis.__identityTestLog.filter(function (e) { return e.released; }), [{ released: "spiffe-client" }]);
});

test("a module provider that asks for a directory after the timeout is refused one", async function () {
  var cfgDir = scratch();
  var warnings = [];
  var lease = await lateIdentityFor({ provider_module: writeModule(LATE_BEFORE_ALLOCATE) }, cfgDir, warnings).begin(LATE_REQUEST);
  assert.equal(lease.dir, null);
  await pause(700);
  assert.deepEqual(entries(path.join(cfgDir, "identity", "spawn")), [], "no directory was made for a session nobody waits for");
  assert.ok(warnings.some(function (w) { return /no longer waits/.test(w); }), warnings.join("|"));
});

test("the jwks-self signer settling after the timeout leaves no directory and gives the child none", async function () {
  var cfgDir = scratch();
  var identity = createIdentity({
    getConfig: function () { return { provider: "jwks-self" }; },
    configDir: cfgDir,
    providerTimeoutMs: 1,
    warn: function () {},
  });
  var lease = await identity.begin(LATE_REQUEST);
  assert.equal(lease.dir, null);
  assert.equal(lease.record.unavailable, "provider_timeout");
  await pause(500);
  assert.deepEqual(entries(path.join(cfgDir, "identity", "spawn")), [], "no directory remains under the spawn root");
});

test("a gatekeeper session still pending at the timeout is cancelled: no issued directory remains and no variable is passed", async function () {
  var issuer = installFakeIssuer();
  try {
    var warnings = [];
    var lease = await lateIdentityFor(gatekeeperConfig(issuer, "late.sock"), scratch(), warnings).begin(LATE_REQUEST);
    assert.equal(lease.dir, null);
    assert.equal(lease.record.unavailable, "provider_timeout");
    await pause(1200);
    assert.deepEqual(issuer.issued(), [], "the issuer's late session never came into being or was removed");
    assert.deepEqual(issuer.inheritedDirs(), ["undefined"], "the client was not handed an identity directory");
  } finally {
    issuer.cleanup();
  }
});

// --- A FIFO where the assertion should be ---

test("a FIFO in place of the assertion file is refused without blocking", function () {
  var root = path.join(scratch(), "spawn");
  var dir = delivery.allocateDir(root);
  require("child_process").execFileSync("mkfifo", [path.join(dir, "identity.jwt")]);
  assert.throws(function () { delivery.inspect(dir, process.getuid()); }, /not a regular file/);
});
