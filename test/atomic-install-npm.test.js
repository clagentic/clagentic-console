// Regression test of the installer: the clagentic-console command must stay
// resolvable while a second build is installed over the first.
//
// Packs this repo's package twice (two builds that differ in the build-sha
// record, as two install:local-test runs of different commits do), installs
// build one and then build two into a prefix under os.tmpdir() through
// lib/atomic-install.js (the helper install:local-test and the self-update
// use), and polls `clagentic-console --help` through the shell for the whole
// second install. `--help` is the probe because it prints usage and exits
// before bin/cli.js touches IPC, config or the daemon; the HOME the probes run
// under is asserted to stay empty. Exit 127 is the shell's "command not found".
//
// This is the only test that runs npm. It never touches the live global
// install: the prefix, the HOME and every pack output live under os.tmpdir().
// The copy of the package drops `dependencies` and `scripts` so the install
// needs no network and runs no lifecycle script; the probes find the repo's own
// node_modules through NODE_PATH.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { execFile } = require("child_process");

var { installGlobalAtomically, runProcess } = require("../lib/atomic-install");

var REPO = path.join(__dirname, "..");
var SHA_ONE = "1".repeat(40);
var SHA_TWO = "2".repeat(40);
var POLLERS = 4;

function copyPackage(dest) {
  var pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  (pkg.files || []).forEach(function (entry) {
    var from = path.join(REPO, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, entry), { recursive: true });
  });
  delete pkg.dependencies;
  delete pkg.devDependencies;
  delete pkg.scripts;
  fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify(pkg, null, 2));
}

async function pack(srcDir, sha, outDir) {
  fs.writeFileSync(path.join(srcDir, "lib", "build-sha.json"), JSON.stringify({ sha: sha, writtenAt: new Date().toISOString() }));
  fs.mkdirSync(outDir, { recursive: true });
  await runProcess("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", outDir], { cwd: srcDir });
  var tarballs = fs.readdirSync(outDir).filter(function (f) { return f.endsWith(".tgz"); });
  assert.equal(tarballs.length, 1);
  return path.join(outDir, tarballs[0]);
}

// Resolves the exit status of `clagentic-console --help` run through the shell.
function probe(env) {
  return new Promise(function (resolve) {
    execFile("sh", ["-c", "clagentic-console --help"], { env: env }, function (err) {
      resolve(err ? (typeof err.code === "number" ? err.code : -1) : 0);
    });
  });
}

async function pollUntilStopped(env, state) {
  while (!state.stop) {
    var started = Date.now();
    var code = await probe(env);
    state.samples.push({ code: code, started: started, ended: Date.now() });
  }
}

function installedSha(prefix) {
  var file = path.join(prefix, "lib", "node_modules", "@clagentic", "console", "lib", "build-sha.json");
  return JSON.parse(fs.readFileSync(file, "utf8")).sha;
}

test("installing a second build over the first never leaves clagentic-console unresolvable", { timeout: 240000 }, async function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-install-npm-"));
  try {
    var src = path.join(root, "src");
    var prefix = path.join(root, "prefix");
    var home = path.join(root, "home");
    fs.mkdirSync(src);
    fs.mkdirSync(home);
    fs.mkdirSync(prefix);
    copyPackage(src);
    var tarballOne = await pack(src, SHA_ONE, path.join(root, "pack-one"));
    var tarballTwo = await pack(src, SHA_TWO, path.join(root, "pack-two"));

    var npmEnv = Object.assign({}, process.env, {
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    });
    delete npmEnv.npm_config_global;
    delete npmEnv.npm_config_location;
    var probeEnv = Object.assign({}, process.env, {
      PATH: path.join(prefix, "bin") + path.delimiter + process.env.PATH,
      HOME: home,
      NODE_PATH: path.join(REPO, "node_modules"),
    });

    await installGlobalAtomically({ spec: tarballOne, prefix: prefix, env: npmEnv });
    assert.equal(installedSha(prefix), SHA_ONE);
    assert.equal(await probe(probeEnv), 0, "build one answers the probe before the second install");

    var state = { stop: false, samples: [] };
    var pollers = [];
    for (var i = 0; i < POLLERS; i++) pollers.push(pollUntilStopped(probeEnv, state));
    var installStart = Date.now();
    var failure = null;
    try {
      await installGlobalAtomically({ spec: tarballTwo, prefix: prefix, env: npmEnv });
    } catch (err) {
      failure = err;
    }
    var installEnd = Date.now();
    state.stop = true;
    await Promise.all(pollers);
    if (failure) throw failure;

    var during = state.samples.filter(function (s) { return s.ended > installStart && s.started < installEnd; });
    var notFound = state.samples.filter(function (s) { return s.code === 127; });
    assert.ok(during.length >= POLLERS, "the probes overlapped the second install (" + during.length + " samples)");
    assert.ok(during.some(function (s) { return s.code === 0; }), "at least one probe during the install ran the command");
    assert.equal(notFound.length, 0, notFound.length + " of " + state.samples.length + " probes exited 127 (command not found)");

    assert.equal(installedSha(prefix), SHA_TWO, "the final installed build is the second one");
    assert.equal(await probe(probeEnv), 0, "the final build answers the probe");
    assert.deepEqual(fs.readdirSync(home), [], "the probe wrote no state under HOME");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
