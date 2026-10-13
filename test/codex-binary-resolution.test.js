"use strict";
// Resolving the Codex the user installed: override, then PATH, then common
// locations, each validated by its version. The binaries here are stand-in
// scripts that print a version line (no Codex is run), so every caller shape
// is exercised: absent, below the floor, at the floor, newer, an invalid
// override path, win32 PATH, and the cache keyed by everything the lookup reads.

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

// Lookups that find nothing and run nothing, with the home to search.
function stubDeps(overrides) {
  return Object.assign({
    isExecutable: function () { return false; },
    pathLookup: function () { return { path: null }; },
    home: function () { return overrides && overrides.home ? overrides.home : "/nonexistent-home"; },
    runVersion: function () { throw new Error("no binary should be run"); },
  });
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

test("on win32 the PATHEXT extensions are tried, codex.cmd and codex.exe as the removed bundle path did", function () {
  var present = {};
  function isExecutable(candidate) { return !!present[candidate]; }
  var dirA = "C:\\Users\\me\\AppData\\Roaming\\npm";
  var dirB = "C:\\Tools";
  var pathVar = dirA + ";" + dirB;

  present[dirA + "\\codex.cmd"] = true;
  assert.equal(codexBinary.findOnPath(pathVar, isExecutable, { platform: "win32", pathext: ".COM;.EXE;.BAT;.CMD" }), dirA + "\\codex.cmd");

  present = {};
  present[dirB + "\\codex.exe"] = true;
  assert.equal(codexBinary.findOnPath(pathVar, isExecutable, { platform: "win32" }), dirB + "\\codex.exe", "the default PATHEXT applies when the variable is unset");

  present = {};
  present[dirA + "\\codex.cmd"] = true;
  present[dirA + "\\codex.exe"] = true;
  assert.equal(codexBinary.findOnPath(pathVar, isExecutable, { platform: "win32", pathext: ".EXE;.CMD" }), dirA + "\\codex.exe", "PATHEXT order decides within a directory");

  present = {};
  assert.equal(codexBinary.findOnPath(pathVar, isExecutable, { platform: "win32" }), null);
  assert.equal(codexBinary.findOnPath("relative\\bin", function () { return true; }, { platform: "win32" }), null, "a relative entry is never searched");
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

// --- The cache is keyed by everything the lookup reads ---

test("a resolution is remembered per environment: PATH, Path, PATHEXT, the override and HOME each make their own", function () {
  var dirA = tmpDir();
  var dirB = tmpDir();
  standIn(dirA, "codex", "codex-cli 0.150.0");
  standIn(dirB, "codex", "codex-cli 0.162.1");
  codexBinary.invalidate();
  var base = { HOME: tmpDir() };

  assert.equal(codexBinary.resolveCached({ env: Object.assign({}, base, { PATH: dirA }) }).version, "0.150.0");
  assert.equal(codexBinary.resolveCached({ env: Object.assign({}, base, { PATH: dirB }) }).version, "0.162.1", "another PATH is not served from the first lookup");

  // win32 spells the variable Path; the lookup reads it when PATH is absent.
  assert.equal(codexBinary.resolveCached({ env: Object.assign({}, base, { Path: dirA }) }).version, "0.150.0");
  assert.equal(codexBinary.resolveCached({ env: Object.assign({}, base, { Path: dirB }) }).version, "0.162.1", "another Path is not served from the first lookup");

  var keyed = ["PATH", "Path", "PATHEXT", ENV_NAME, "HOME"];
  var keys = keyed.map(function (name) {
    var env = Object.assign({}, base);
    env[name] = "x" + name;
    return codexBinary._test_cacheKey({ env: env });
  });
  assert.equal(new Set(keys).size, keyed.length, "each variable the lookup reads changes the key");
  codexBinary.invalidate();
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
    var outcome = probe({ linuxUser: null, lookupBinary: function () { throw new Error("not used"); } });
    assert.equal(outcome.installed, true);
    assert.equal(outcome.detail.path, file);
    assert.equal(outcome.detail.version, "0.162.1");

    process.env[ENV_NAME] = "/nonexistent/codex";
    codexBinary.invalidate();
    var invalid = probe({ linuxUser: null });
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
