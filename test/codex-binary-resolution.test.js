"use strict";
// Resolving the Codex the user installed: override, then PATH, then common
// locations, each validated by its version. The binaries here are stand-in
// scripts that print a version line (no Codex is run), and the lookups for an
// OS user are injected, so every caller shape is exercised without a real
// account: absent, below the floor, at the floor, newer, an invalid override
// path, and an OS user whose lookups are its own.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var codexBinary = require("../lib/yoke/codex-binary");
var yoke = require("../lib/yoke");

var ENV_NAME = "CLAGENTIC_CONSOLE_CODEX_PATH";
var tmpRoots = [];

function tmpDir() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-resolve-"));
  tmpRoots.push(dir);
  return dir;
}

test.after(function () {
  tmpRoots.forEach(function (dir) { fs.rmSync(dir, { recursive: true, force: true }); });
});

// A stand-in `codex`: a shell script that prints the given line for --version.
function standIn(dir, name, versionLine, exitCode) {
  var file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\n" + (versionLine ? "echo '" + versionLine + "'\n" : "") + "exit " + (exitCode || 0) + "\n");
  fs.chmodSync(file, 0o755);
  return file;
}

function envFor(extra) {
  return Object.assign({ PATH: "", HOME: tmpDir() }, extra);
}

test("no Codex anywhere: absent, with the install reason", function () {
  var result = codexBinary.resolveCodexBinary({ env: envFor(), deps: stubDeps({ home: "/nonexistent-home" }) });
  assert.equal(result.state, "absent");
  assert.equal(result.code, "CODEX_ABSENT");
  assert.match(result.reason, /not installed/);
  assert.match(result.reason, /npm install -g @openai\/codex/);
});

test("the override is used first, and its version is read from the binary", function () {
  var dir = tmpDir();
  var onPath = standIn(dir, "codex", "codex-cli 0.150.0");
  var override = standIn(dir, "mine", "codex-cli 0.162.1");
  var result = codexBinary.resolveCodexBinary({ env: envFor({ PATH: dir, [ENV_NAME]: override }) });
  assert.equal(result.state, "ready");
  assert.equal(result.path, override);
  assert.equal(result.version, "0.162.1");
  assert.equal(result.source, "override");
  assert.notEqual(result.path, onPath, "the override outranks PATH");
});

test("an override that is not an absolute path is a named error and does not fall through to PATH", function () {
  var dir = tmpDir();
  standIn(dir, "codex", "codex-cli 0.162.1");
  var result = codexBinary.resolveCodexBinary({ env: envFor({ PATH: dir, [ENV_NAME]: "bin/codex" }) });
  assert.equal(result.state, "invalid-override");
  assert.equal(result.code, "CODEX_OVERRIDE_INVALID");
  assert.match(result.reason, /CLAGENTIC_CONSOLE_CODEX_PATH is set to bin\/codex/);
  assert.match(result.reason, /not an absolute path/);
});

test("an override that points at nothing, at a directory, or at a binary that cannot report a version is a named error", function () {
  var dir = tmpDir();
  var cases = [
    path.join(dir, "missing"),
    dir,
    standIn(dir, "broken", null, 3),
    standIn(dir, "garbled", "no version in this output"),
  ];
  cases.forEach(function (chosen) {
    var result = codexBinary.resolveCodexBinary({ env: envFor({ [ENV_NAME]: chosen }) });
    assert.equal(result.state, "invalid-override", chosen);
    assert.equal(result.code, "CODEX_OVERRIDE_INVALID");
    assert.match(result.reason, new RegExp(chosen.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    var thrown = null;
    try { codexBinary.requireCodex({ env: envFor({ [ENV_NAME]: chosen }), fresh: true }); } catch (e) { thrown = e; }
    assert.equal(thrown && thrown.code, "CODEX_OVERRIDE_INVALID", "the caller that needs Codex gets the named error");
  });
});

test("a blank override is no override", function () {
  var dir = tmpDir();
  var onPath = standIn(dir, "codex", "codex-cli 0.162.1");
  var result = codexBinary.resolveCodexBinary({ env: envFor({ PATH: dir, [ENV_NAME]: "   " }) });
  assert.equal(result.state, "ready");
  assert.equal(result.path, onPath);
  assert.equal(result.source, "path");
});

test("codex on PATH is used when there is no override, first match wins", function () {
  var first = tmpDir();
  var second = tmpDir();
  var wanted = standIn(first, "codex", "codex-cli 0.155.0");
  standIn(second, "codex", "codex-cli 0.162.1");
  var result = codexBinary.resolveCodexBinary({ env: envFor({ PATH: first + path.delimiter + second }) });
  assert.equal(result.path, wanted);
  assert.equal(result.version, "0.155.0");
});

test("a relative entry on PATH is never searched", function () {
  var dir = tmpDir();
  standIn(dir, "codex", "codex-cli 0.162.1");
  var found = codexBinary.findOnPath("." + path.delimiter + path.relative(process.cwd(), dir), function () { return true; });
  assert.equal(found, null);
});

test("with nothing on PATH the common locations under the user's home are searched", function () {
  var home = tmpDir();
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  var installed = standIn(path.join(home, ".local", "bin"), "codex", "codex-cli 0.160.0");
  var result = codexBinary.resolveCodexBinary({ env: envFor({ HOME: home }) });
  assert.equal(result.state, "ready");
  assert.equal(result.path, installed);
  assert.equal(result.source, "location");
});

test("the floor: 0.147.9 is too old with the stated message, 0.148.0 and newer are usable", function () {
  var old = tmpDir();
  standIn(old, "codex", "codex-cli 0.147.9");
  var tooOld = codexBinary.resolveCodexBinary({ env: envFor({ PATH: old }) });
  assert.equal(tooOld.state, "too-old");
  assert.equal(tooOld.code, "CODEX_TOO_OLD");
  assert.equal(tooOld.version, "0.147.9");
  assert.equal(tooOld.reason, "Codex 0.147.9 is too old; Clagentic: Console needs 0.148.0 or newer");
  assert.equal(codexBinary.describe(tooOld).installed, false);
  assert.equal(codexBinary.describe(tooOld).detail.path, path.join(old, "codex"), "the picker can say which binary is too old");

  ["0.148.0", "0.148.3", "0.151.0", "0.152.0", "0.162.1"].forEach(function (version) {
    var dir = tmpDir();
    standIn(dir, "codex", "codex-cli " + version);
    var result = codexBinary.resolveCodexBinary({ env: envFor({ PATH: dir }) });
    assert.equal(result.state, "ready", version);
    assert.equal(result.version, version);
  });
});

test("a binary on PATH that cannot report a version is unusable, with the reason", function () {
  var dir = tmpDir();
  standIn(dir, "codex", null, 2);
  var result = codexBinary.resolveCodexBinary({ env: envFor({ PATH: dir }) });
  assert.equal(result.state, "unusable");
  assert.equal(result.code, "CODEX_UNUSABLE");
  assert.match(result.reason, /could not report its version/);
});

test("what the picker is told: usable shows path and version, otherwise the reason", function () {
  var dir = tmpDir();
  var file = standIn(dir, "codex", "codex-cli 0.162.1");
  var ready = codexBinary.describe(codexBinary.resolveCodexBinary({ env: envFor({ PATH: dir }) }));
  assert.deepEqual(ready, { installed: true, detail: { path: file, version: "0.162.1", source: "path", reason: null } });
  var absent = codexBinary.describe(codexBinary.resolveCodexBinary({ env: envFor(), deps: stubDeps({ home: "/nonexistent-home" }) }));
  assert.equal(absent.installed, false);
  assert.match(absent.detail.reason, /not installed/);
});

// --- An OS user's lookups are the user's own ---

function stubDeps(overrides) {
  return Object.assign({
    isExecutable: function () { return false; },
    pathLookup: function () { return { state: "found", path: null }; },
    home: function () { return "/nonexistent-home"; },
    runVersion: function () { throw new Error("no binary should be run"); },
  }, overrides, overrides && overrides.home ? { home: function () { return overrides.home; } } : {});
}

test("for an OS user the user's PATH and the user's home are searched, never the daemon's", function () {
  var seen = { home: 0, executableChecks: [] };
  var deps = stubDeps({
    pathLookup: function () { return { state: "found", path: null }; },
    isExecutable: function (candidate) {
      seen.executableChecks.push(candidate);
      return candidate === "/home/clay-alice/.local/bin/codex";
    },
    runVersion: function (binary) {
      assert.equal(binary, "/home/clay-alice/.local/bin/codex");
      return "codex-cli 0.162.1";
    },
  });
  deps.home = function () { seen.home++; return "/home/clay-alice"; };
  var result = codexBinary.resolveCodexBinary({ linuxUser: "clay-alice", env: envFor(), deps: deps });
  assert.equal(result.state, "ready");
  assert.equal(result.path, "/home/clay-alice/.local/bin/codex");
  assert.equal(seen.home, 1);
  assert.ok(seen.executableChecks.every(function (c) { return c.indexOf(os.homedir() + "/") !== 0 || os.homedir() === "/home/clay-alice"; }),
    "the daemon account's home was not searched for the user");
});

test("an OS user with no account is reported as not checkable, never resolved as the daemon's user", function () {
  var deps = stubDeps({
    pathLookup: function () { var e = new Error("no account"); e.code = "OS_USER_UNMAPPED"; throw e; },
  });
  var result = codexBinary.resolveCodexBinary({ linuxUser: "clay-ghost", env: envFor(), deps: deps });
  assert.equal(result.state, "failed");
  assert.equal(result.probeClass, "os-user-unmapped");
});

test("a lookup that failed is passed on as a failure, not as an absent Codex", function () {
  var deps = stubDeps({ pathLookup: function () { return { state: "failed", probeClass: "timeout" }; } });
  var result = codexBinary.resolveCodexBinary({ linuxUser: "clay-alice", env: envFor(), deps: deps });
  assert.equal(result.state, "failed");
  assert.equal(result.probeClass, "timeout");
});

// --- The registry's install probe ---

test("the install probe reports the resolution and says Could not check for a lookup that failed", function () {
  var probe = yoke.registry.get("codex").probeInstalled;
  var dir = tmpDir();
  var file = standIn(dir, "codex", "codex-cli 0.162.1");
  var realPath = process.env.PATH;
  var realOverride = process.env[ENV_NAME];
  process.env.PATH = dir;
  delete process.env[ENV_NAME];
  codexBinary.invalidate();
  try {
    var outcome = probe({ linuxUser: null, lookupBinary: function () { throw new Error("not used"); }, failed: function () { throw new Error("not used"); } });
    assert.equal(outcome.installed, true);
    assert.equal(outcome.detail.path, file);
    assert.equal(outcome.detail.version, "0.162.1");

    process.env[ENV_NAME] = "/nonexistent/codex";
    codexBinary.invalidate();
    var invalid = probe({ linuxUser: null, failed: function () { throw new Error("not used"); } });
    assert.equal(invalid.installed, false);
    assert.match(invalid.detail.reason, /CLAGENTIC_CONSOLE_CODEX_PATH is set to \/nonexistent\/codex/);
  } finally {
    process.env.PATH = realPath;
    if (realOverride === undefined) delete process.env[ENV_NAME]; else process.env[ENV_NAME] = realOverride;
    codexBinary.invalidate();
  }
});

test("the install state carries what the probe found, and the registry message hands it to the picker", function () {
  var installProbe = require("../lib/yoke/install-probe");
  var registry = yoke.registry;
  registry.register({
    id: "detail-agent", displayName: "Detail Agent", priority: 98, binaryNames: ["claude"],
    probeInstalled: function () { return { installed: false, detail: { path: null, version: null, reason: "Detail Agent 1 is too old" } }; },
    checkAuth: function () { return true; }, installHint: "Install it.", loginCommand: "detail login",
    osUsersSupported: false, needsRuntimeEnv: false, ownedEnvNames: [], nativeInstructionFiles: [],
    interruptMessage: "x", capabilities: {}, createAdapter: function () { return {}; },
  });
  try {
    var state = installProbe.detectVendorInstallState(null);
    assert.equal(state.installed.indexOf("detail-agent"), -1);
    assert.equal(state.details["detail-agent"].reason, "Detail Agent 1 is too old");
    var described = registry.describeForClient({ installed: state.installed, probeFailures: state.failures, details: state.details });
    var entry = described.filter(function (v) { return v.id === "detail-agent"; })[0];
    assert.equal(entry.installDetail.reason, "Detail Agent 1 is too old");
    var claudeEntry = described.filter(function (v) { return v.id === "claude"; })[0];
    assert.equal(claudeEntry.installDetail, null, "an agent whose probe reports no detail has none");
  } finally {
    registry.unregister("detail-agent");
  }
});

test("a re-check forgets what was found, so a Codex installed or updated since is seen", function () {
  var dir = tmpDir();
  var file = standIn(dir, "codex", "codex-cli 0.147.0");
  var env = envFor({ PATH: dir });
  codexBinary.invalidate();
  assert.equal(codexBinary.resolveCached({ env: env }).state, "too-old");
  standIn(dir, "codex", "codex-cli 0.162.1");
  assert.equal(codexBinary.resolveCached({ env: env }).state, "too-old", "remembered for a short while");
  yoke.invalidateAuthCache();
  var after = codexBinary.resolveCached({ env: env });
  assert.equal(after.state, "ready");
  assert.equal(after.path, file);
  codexBinary.invalidate();
});
