"use strict";
// The lifecycle of one identity session (lib/identity/index.js begin, owned by
// lib/identity/holder.js). Every way a begin call can end, against every thing a
// provider can do, judged by what is left under the spawn root, how often the
// provider's release ran, and what the provider's own directory still holds.
// Providers are real modules loaded from disk, as a person configures them.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var configModule = require("../lib/identity/config");
var contract = require("../lib/identity/contract");
var delivery = require("../lib/identity/delivery");
var ownerModule = require("../lib/identity/owner");
var recordModule = require("../lib/identity/record");
var signingKey = require("../lib/identity/providers/signing-key");
var gatekeeperProvider = require("../lib/identity/providers/gatekeeper");
var unavailableModule = require("../lib/identity/unavailable");
var { createIdentity } = require("../lib/identity");
var { INITIATORS } = require("../lib/turn-initiator");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "identity-lifecycle-"));
}

function pause(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function entries(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

var REQUEST = { definition: null, initiator: INITIATORS.LOOP, rt: "claude-code" };

// A provider module whose behaviour is data. `mode`:
//   own            makes its own directory (outside the spawn root) holding
//                  identity.jwt, tmp/ and keep.txt, instead of asking the console
//   claim          origin written into the assertion (default: the turn's own)
//   waitMs         time spent after the directory exists and before answering
//   never          never answers (after the directory exists)
//   unavailable    answers with a typed unavailability (after the directory exists)
//   throws         throws (after the directory exists)
//   release        "ok" | "hang" | "throw"
//   lateAllocate   waits, then asks the console for its directory
function providerSource(mode, logFile, ownRoot) {
  return [
    "const fs = require('fs'), path = require('path');",
    "const MODE = " + JSON.stringify(mode) + ";",
    "const log = (e) => fs.appendFileSync(" + JSON.stringify(logFile) + ", JSON.stringify(e) + '\\n');",
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    "module.exports = {",
    "  name: 'matrix',",
    "  async obtainSession(definition, origin, rt, ctx) {",
    "    if (MODE.lateAllocate) { await sleep(MODE.lateAllocate); }",
    "    let dir;",
    "    if (MODE.own) {",
    "      dir = fs.mkdtempSync(path.join(" + JSON.stringify(ownRoot) + ", 'own-'));",
    "      fs.mkdirSync(path.join(dir, 'tmp')); fs.writeFileSync(path.join(dir, 'keep.txt'), 'mine');",
    "    } else { dir = ctx.allocateDir(); }",
    "    log({ obtained: dir });",
    "    if (MODE.never) return new Promise(() => {});",
    "    if (MODE.waitMs) await sleep(MODE.waitMs);",
    "    if (MODE.throws) throw new Error('provider broke');",
    "    if (MODE.unavailable) return ctx.unavailable('matrix_unavailable', 'the matrix provider has nothing');",
    "    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');",
    "    const now = Math.floor(Date.now() / 1000);",
    "    const claims = { iss: 'matrix://x', sub: 'runtime:' + rt, act: { sub: 'runtime:' + rt }, roles: [], grade: 'workload',",
    "      rt: { id: rt, version: '1' }, sid: 's', origin: MODE.claim || origin, dir, iat: now, exp: now + 600, jti: 'j', cia: 1 };",
    "    const assertion = enc({ alg: 'EdDSA', kid: 'k' }) + '.' + enc(claims) + '.sig';",
    "    if (MODE.own) { fs.writeFileSync(path.join(dir, 'identity.jwt'), assertion, { mode: 0o600 }); return { dir }; }",
    "    return { dir, assertion };",
    "  },",
    "  release(info) {",
    "    log({ released: info.dir });",
    "    if (MODE.release === 'hang') return new Promise(() => {});",
    "    if (MODE.release === 'throw') throw new Error('release broke');",
    "    return undefined;",
    "  },",
    "};",
  ].join("\n");
}

function setup(mode) {
  var base = scratch();
  var logFile = path.join(base, "provider.log");
  var ownRoot = path.join(base, "own");
  fs.mkdirSync(ownRoot, { mode: 0o700 });
  var file = path.join(base, "provider.js");
  fs.writeFileSync(file, providerSource(mode, logFile, ownRoot));
  var warnings = [];
  var identity = createIdentity({
    getConfig: function () { return { provider_module: file }; },
    configDir: base,
    providerTimeoutMs: 100,
    releaseTimeoutMs: 80,
    warn: function (message) { warnings.push(message); },
  });
  var spawnRoot = path.join(base, "identity", "spawn");
  return {
    identity: identity,
    warnings: warnings,
    spawnRoot: spawnRoot,
    ownRoot: ownRoot,
    spawnEntries: function () { return entries(spawnRoot); },
    log: function () {
      return fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
        : [];
    },
    releases: function () { return this.log().filter(function (e) { return e.released; }); },
    obtained: function () { return this.log().filter(function (e) { return e.obtained; }).map(function (e) { return e.obtained; }); },
  };
}

// --- Exit: the lease is issued and then released ---

test("lease issued, directory from ctx.allocateDir: lease.release removes it at once and the provider is released once", async function () {
  var s = setup({});
  var lease = await s.identity.begin(REQUEST);
  assert.ok(lease.dir);
  assert.deepEqual(s.spawnEntries(), [path.basename(lease.dir)]);
  lease.release();
  assert.deepEqual(s.spawnEntries(), [], "removed before release() returned: nothing waited on the provider");
  lease.release();
  await pause(100);
  assert.equal(s.releases().length, 1, "release ran once although lease.release ran twice");
  assert.equal(s.releases()[0].released, lease.dir);
});

test("lease issued, provider made its own directory: only identity.jwt and tmp are removed from it", async function () {
  var s = setup({ own: true });
  var lease = await s.identity.begin(REQUEST);
  assert.ok(lease.dir, lease.notice);
  assert.equal(path.dirname(lease.dir), s.ownRoot);
  lease.release();
  assert.deepEqual(fs.readdirSync(lease.dir), ["keep.txt"], "the provider's other content is untouched");
  await pause(100);
  assert.equal(s.releases().length, 1);
});

test("lease issued, provider made its own directory with nothing else in it: the emptied directory goes too", async function () {
  var s = setup({ own: true });
  var lease = await s.identity.begin(REQUEST);
  fs.rmSync(path.join(lease.dir, "keep.txt"));
  lease.release();
  assert.equal(fs.existsSync(lease.dir), false);
});

test("lease issued, release hangs: removal does not wait for it, it is called once, and the hang only produces a warning", async function () {
  var s = setup({ release: "hang" });
  var lease = await s.identity.begin(REQUEST);
  lease.release();
  assert.deepEqual(s.spawnEntries(), [], "removed at once");
  await pause(250);
  assert.equal(s.releases().length, 1);
  assert.ok(s.warnings.some(function (w) { return /release did not finish in time/.test(w); }), s.warnings.join("|"));
});

test("lease issued, release throws: the directory is removed, release ran once, and the failure is a warning", async function () {
  var s = setup({ release: "throw" });
  var lease = await s.identity.begin(REQUEST);
  lease.release();
  assert.deepEqual(s.spawnEntries(), []);
  await pause(100);
  assert.equal(s.releases().length, 1);
  assert.ok(s.warnings.some(function (w) { return /release failed: release broke/.test(w); }), s.warnings.join("|"));
});

// --- Exit: the provider is unavailable or fails before the timeout ---

test("provider unavailable after taking a directory: the directory is removed, the typed answer is kept, nothing was yielded to release", async function () {
  var s = setup({ unavailable: true });
  var lease = await s.identity.begin(REQUEST);
  assert.equal(lease.dir, null);
  assert.equal(lease.record.unavailable, "matrix_unavailable");
  assert.equal(s.obtained().length, 1, "a directory was taken");
  assert.deepEqual(s.spawnEntries(), []);
  await pause(50);
  assert.equal(s.releases().length, 0);
});

test("provider that throws after taking a directory: the directory is removed", async function () {
  var s = setup({ throws: true });
  var lease = await s.identity.begin(REQUEST);
  assert.equal(lease.dir, null);
  assert.equal(lease.record.unavailable, "provider_error");
  assert.deepEqual(s.spawnEntries(), []);
  await pause(50);
  assert.equal(s.releases().length, 0);
});

// --- Exit: the session is refused ---

test("refused session from a ctx-allocated directory: removed, and the provider is released once", async function () {
  var s = setup({ claim: "human" });
  var lease = await s.identity.begin(REQUEST);
  assert.equal(lease.dir, null);
  assert.equal(lease.record.unavailable, "origin_mismatch");
  assert.deepEqual(s.spawnEntries(), []);
  await pause(100);
  assert.equal(s.releases().length, 1, "a refused session was yielded, so the provider is told it ended");
});

test("refused session from the provider's own directory: contract entries removed, its other content kept, provider released once", async function () {
  var s = setup({ own: true, claim: "human" });
  var lease = await s.identity.begin(REQUEST);
  assert.equal(lease.record.unavailable, "origin_mismatch");
  var own = fs.readdirSync(s.ownRoot).map(function (n) { return path.join(s.ownRoot, n); });
  assert.equal(own.length, 1);
  assert.deepEqual(fs.readdirSync(own[0]), ["keep.txt"]);
  await pause(100);
  assert.equal(s.releases().length, 1);
});

// --- Exit: the console stops waiting ---

test("provider that never answers: the console's directory is gone the moment begin returns, and nothing is released", async function () {
  var s = setup({ never: true });
  var lease = await s.identity.begin(REQUEST);
  assert.equal(lease.dir, null);
  assert.equal(lease.record.unavailable, "provider_timeout");
  assert.equal(s.obtained().length, 1, "a directory was taken");
  assert.deepEqual(s.spawnEntries(), [], "removed with no help from the provider");
  await pause(200);
  assert.equal(s.releases().length, 0);
});

test("late success from a ctx-allocated directory: nothing remains and the provider is released once", async function () {
  var s = setup({ waitMs: 400 });
  var lease = await s.identity.begin(REQUEST);
  assert.equal(lease.dir, null);
  assert.deepEqual(s.spawnEntries(), [], "already removed at the timeout");
  await pause(700);
  assert.deepEqual(s.spawnEntries(), []);
  assert.equal(s.releases().length, 1);
});

test("late success from the provider's own directory: contract entries removed, its content kept, released once", async function () {
  var s = setup({ own: true, waitMs: 400 });
  var lease = await s.identity.begin(REQUEST);
  assert.equal(lease.dir, null);
  await pause(700);
  var own = fs.readdirSync(s.ownRoot).map(function (n) { return path.join(s.ownRoot, n); });
  assert.equal(own.length, 1);
  assert.deepEqual(fs.readdirSync(own[0]), ["keep.txt"]);
  assert.equal(s.releases().length, 1);
});

test("late error after the timeout: nothing remains, nothing is released, and the failure is a warning", async function () {
  var s = setup({ waitMs: 400, throws: true });
  var lease = await s.identity.begin(REQUEST);
  assert.equal(lease.record.unavailable, "provider_timeout");
  await pause(700);
  assert.deepEqual(s.spawnEntries(), []);
  assert.equal(s.releases().length, 0);
  assert.ok(s.warnings.some(function (w) { return /provider broke/.test(w); }), s.warnings.join("|"));
});

test("the owner settles once: a second end releases nothing more, and nothing can be allocated after it", async function () {
  var base = scratch();
  var released = [];
  var holder = require("../lib/identity/holder").createHolder({
    provider: { release: function (info) { released.push(info.dir); } },
    spawnRoot: path.join(base, "spawn"), owner: null, ownerUid: process.getuid(), warn: function () {},
  });
  var dir = holder.allocateDir();
  assert.equal(fs.existsSync(dir), true);
  holder.abandon();
  assert.equal(fs.existsSync(dir), false, "removed at the abandon, with no provider promise involved");
  assert.throws(function () { holder.allocateDir(); }, /no longer waits/);
  holder.end({ provider: "x", dir: dir });
  holder.end({ provider: "x", dir: dir });
  holder.end(null);
  await pause(30);
  assert.deepEqual(released, [dir]);
  assert.deepEqual(entries(path.join(base, "spawn")), []);
});

test("a provider that asks for a directory after the timeout is refused one", async function () {
  var s = setup({ lateAllocate: 400 });
  var lease = await s.identity.begin(REQUEST);
  assert.equal(lease.record.unavailable, "provider_timeout");
  await pause(700);
  assert.deepEqual(s.spawnEntries(), []);
  assert.deepEqual(s.obtained(), [], "the provider never got a directory");
  assert.ok(s.warnings.some(function (w) { return /no longer waits/.test(w); }), s.warnings.join("|"));
});

// --- A provider module is given the typed-unavailable helper ---

test("the typed unavailability accepts only a well-formed string code", function () {
  var made = unavailableModule.unavailable("Not A Code", "x");
  assert.equal(made.code, "provider_error");
  [true, null, 5, {}, ["a"]].forEach(function (code) {
    assert.equal(unavailableModule.unavailable(code, "x").code, "provider_error", String(code));
  });
});

// --- Names are strings, not whatever coerces to one ---

test("a value that is not a string is never taken for a name, a role, a code or a definition", async function () {
  [[null], [true], [5], [{}], ["ok", null]].forEach(function (roles) {
    var cfg = configModule.resolveConfig({ provider: "jwks-self", roles: roles }, "/cfg");
    assert.equal(cfg.provider, "invalid", JSON.stringify(roles));
  });
  assert.equal(configModule.resolveConfig({ provider: "jwks-self", roles: ["builder", "reviewer"] }, "/cfg").provider, "jwks-self");

  assert.equal(recordModule.sanitizeRecord({ provider: true }), null);
  assert.equal(recordModule.sanitizeRecord({ provider: "p", unavailable: true }).unavailable, undefined);

  var args = [];
  var provider = gatekeeperProvider.createGatekeeperProvider(
    { binary: "gk", socket: "/s", timeoutMs: 1000 },
    { warn: function () {}, execFile: function (bin, argv, opts, cb) { args.push(argv); cb(new Error("stop")); } }
  );
  await provider.obtainSession(true, "loop", "claude-code", { owner: null });
  await provider.obtainSession(5, "loop", "claude-code", { owner: null });
  args.forEach(function (a) { assert.equal(a.indexOf("--definition"), -1, JSON.stringify(a)); });
  args.forEach(function (a) { a.forEach(function (v) { assert.equal(typeof v, "string"); }); });
});

test("no module of the identity surface tests a value against a contract pattern without checking it is a string", function () {
  var root = path.join(__dirname, "..", "lib", "identity");
  var offenders = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      if (!/\.js$/.test(e.name) || full === path.join(root, "contract.js")) return undefined;
      fs.readFileSync(full, "utf8").split("\n").forEach(function (line, i) {
        if (/PATTERN\.test\(/.test(line)) offenders.push(path.relative(root, full) + ":" + (i + 1));
      });
      return undefined;
    });
  })(root);
  assert.deepEqual(offenders, [], "use contract.matches(PATTERN, value)");
  assert.equal(contract.matches(contract.ROLE_PATTERN, null), false);
});

// --- The spawn root is traversable by a session of another user ---

function withUmask(mask, fn) {
  var before = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(before);
  }
}

var OTHER_OWNER = { uid: process.getuid() + 1, gid: process.getgid() };

// Creating the directory for another user needs the right to change its owner;
// the root's mode is set before that step, which is what is judged.
function allocateForOther(root) {
  try {
    return delivery.allocateDir(root, OTHER_OWNER);
  } catch (e) {
    if (e.identityCode !== "spawn_dir_failed") throw e;
    return null;
  }
}

test("a pre-existing 0700 root gets other-execute when the session belongs to another user", function () {
  withUmask(0o077, function () {
    var root = path.join(scratch(), "spawn");
    fs.mkdirSync(root, { mode: 0o700 });
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    allocateForOther(root);
    assert.equal(fs.statSync(root).mode & 0o001, 0o001, "the session's user can traverse the root");
    assert.equal(fs.statSync(root).mode & 0o022, 0, "and nobody gained write");
    assert.equal(fs.statSync(root).mode & 0o044, 0, "and nobody gained read");
  });
});

test("a root created under a restrictive umask is traversable by another user's session", function () {
  withUmask(0o077, function () {
    var root = path.join(scratch(), "spawn");
    allocateForOther(root);
    assert.equal(fs.statSync(root).mode & 0o001, 0o001);
  });
});

test("a root for the console's own sessions is left as it is", function () {
  withUmask(0o077, function () {
    var root = path.join(scratch(), "spawn");
    delivery.allocateDir(root);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    delivery.allocateDir(root, { uid: process.getuid(), gid: process.getgid() });
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  });
});

// --- Delivery advisories ---

test("an assertion whose segments are not base64url is refused, whatever the lenient decoder would make of it", function () {
  var enc = function (o) { return Buffer.from(JSON.stringify(o)).toString("base64url"); };
  var good = enc({ alg: "EdDSA" }) + "." + enc({ cia: 1 }) + ".c2ln";
  assert.deepEqual(delivery.decodeClaims(good), { cia: 1 });
  var payload = enc({ cia: 1 });
  [
    enc({ alg: "EdDSA" }) + "." + payload.slice(0, 4) + "!!" + payload.slice(4) + ".c2ln",
    enc({ alg: "EdDSA" }) + "." + payload + "==.c2ln",
    enc({ alg: "EdDSA" }) + "." + payload + ".c2ln!",
    "!!." + payload + ".c2ln",
    enc({ alg: "EdDSA" }) + ".abcde.c2ln",
    enc({ alg: "EdDSA" }) + "." + payload + ".a",
  ].forEach(function (token) {
    assert.equal(delivery.decodeClaims(token), null, token);
  });
});

test("the assertion file is read with a bound, not by the size a check saw earlier", function () {
  var root = path.join(scratch(), "spawn");
  var dir = delivery.allocateDir(root);
  fs.writeFileSync(path.join(dir, "identity.jwt"), "x".repeat(contract.MAX_FILE_BYTES * 4));
  var real = fs.fstatSync;
  fs.fstatSync = function (fd) {
    var st = real.call(fs, fd);
    // The file looks small when it is checked and has grown by the time it is read.
    return Object.create(st, { size: { value: 10 } });
  };
  try {
    assert.throws(function () { delivery.inspect(dir, process.getuid()); }, /size limit/);
  } finally {
    fs.fstatSync = real;
  }
});

// --- The signing key ---

test("a key another process created first is the one used, not an error", function () {
  var dir = scratch();
  var keyPath = path.join(dir, "identity", "signing-key.pem");
  var first = signingKey.createKeyIfAbsent(keyPath);
  var second = signingKey.createKeyIfAbsent(keyPath);
  var jwk = function (k) { return require("crypto").createPublicKey(k).export({ format: "jwk" }); };
  assert.deepEqual(jwk(second), jwk(first), "the existing key is reused");
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
});

test("a key file a peer is still writing is waited for, and an unusable one is reported", function () {
  var dir = scratch();
  var keyPath = path.join(dir, "k.pem");
  fs.writeFileSync(keyPath, "not a key", { mode: 0o600 });
  assert.throws(function () { signingKey.createKeyIfAbsent(keyPath); }, function (e) { return e.identityCode === "key_unreadable"; });
});

// --- The session's OS user ---

test("only a failure the lookup is expected to have is quiet; others are logged, and the session still starts without an identity", function () {
  var warnings = [];
  var warn = function (m) { warnings.push(m); };
  var ok = ownerModule.resolveOwner("alice", function () { return { uid: 1001, gid: 1002 }; }, warn);
  assert.deepEqual(ok, { owner: { uid: 1001, gid: 1002 } });

  [
    new Error("Invalid Linux username"),
    new Error("Unexpected getent output for user bob"),
    Object.assign(new Error("Command failed: getent passwd nobody-here"), { status: 2 }),
  ].forEach(function (err) {
    assert.deepEqual(ownerModule.resolveOwner("x", function () { throw err; }, warn), { unresolved: true });
  });
  assert.deepEqual(warnings, [], "expected lookup failures are not logged");

  assert.deepEqual(ownerModule.resolveOwner("x", function () { throw new TypeError("a bug"); }, warn), { unresolved: true });
  assert.deepEqual(ownerModule.resolveOwner("x", function () { throw Object.assign(new Error("spawn getent ENOENT"), { code: "ENOENT" }); }, warn), { unresolved: true });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /unexpected failure resolving the session's OS user: a bug/);

  assert.deepEqual(ownerModule.resolveOwner("x", function () { return { uid: NaN, gid: 1 }; }, warn), { unresolved: true });
});
