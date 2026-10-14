"use strict";

// verify:installed-build reports exactly one process verdict: adopted, stale
// (with both shas) or inconclusive (with the reason). The CLI is run for real
// against shims for `npm` and `clagentic-console`, so the exit code and the
// output are what a post-merge step sees.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { execFileSync, spawnSync } = require("child_process");

var SCRIPT = path.join(__dirname, "..", "scripts", "verify-installed-build.js");
var HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.join(__dirname, "..") }).toString().trim();
var OTHER = "e".repeat(40);

// `status` is what the daemon's --process-build-status prints; null makes the
// shim report "no running daemon".
function run(status) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-adoption-"));
  try {
    var globalRoot = path.join(root, "global");
    var installedLib = path.join(globalRoot, "@clagentic", "console", "lib");
    fs.mkdirSync(installedLib, { recursive: true });
    fs.writeFileSync(path.join(installedLib, "build-sha.json"), JSON.stringify({ sha: HEAD }));
    var binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "npm"),
      "#!/usr/bin/env node\nprocess.stdout.write(" + JSON.stringify(globalRoot) + " + '\\n');\n", { mode: 0o755 });
    var cli = status === null
      ? "process.stdout.write(JSON.stringify({ok:false,error:'no running daemon'}));process.exit(1);"
      : "process.stdout.write(" + JSON.stringify(JSON.stringify(status)) + ");";
    fs.writeFileSync(path.join(binDir, "clagentic-console"), "#!/usr/bin/env node\n" + cli + "\n", { mode: 0o755 });
    return spawnSync(process.execPath, [SCRIPT], {
      env: Object.assign({}, process.env, { PATH: binDir + path.delimiter + process.env.PATH }),
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("adopted: an identical reinstall over a running daemon passes although staleInodes is set", function () {
  var r = run({ loadedBuildSha: HEAD, installedBuildSha: HEAD, state: "adopted", reason: "identical", staleInodes: true, pid: 4242 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ARTIFACT_AND_PROCESS_VERIFIED: adopted/);
  assert.doesNotMatch(r.stdout + r.stderr, /PROCESS_MISMATCH/);
});

test("stale: a daemon on an older build fails and prints both shas", function () {
  var r = run({ loadedBuildSha: OTHER, installedBuildSha: HEAD, state: "stale", reason: "sha", detail: "the installed build is not the one loaded", staleInodes: true, pid: 4242 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PROCESS_MISMATCH: stale/);
  assert.ok(r.stderr.indexOf("loadedBuildSha=" + OTHER) !== -1, r.stderr);
  assert.ok(r.stderr.indexOf("installedBuildSha=" + HEAD) !== -1, r.stderr);
});

test("stale: the same sha over different installed files fails", function () {
  var r = run({ loadedBuildSha: HEAD, installedBuildSha: HEAD, state: "stale", reason: "content", detail: "files differ", staleInodes: true, pid: 1 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PROCESS_MISMATCH: stale/);
  assert.match(r.stderr, /files differ/);
});

test("never adopted while the loaded sha differs from the installed build, whatever the daemon says", function () {
  var r = run({ loadedBuildSha: OTHER, installedBuildSha: OTHER, state: "adopted", reason: "identical", staleInodes: false, pid: 1 });
  assert.equal(r.status, 1, "a daemon adopted onto some other build is not adopted onto HEAD");
  assert.doesNotMatch(r.stdout, /adopted/i);
  assert.match(r.stderr, /PROCESS_MISMATCH: stale/);
});

test("inconclusive: a daemon that cannot say is not read as adopted, and the reason is printed", function () {
  var r = run({ loadedBuildSha: HEAD, installedBuildSha: HEAD, state: "inconclusive", reason: "hash-unavailable", detail: "the installed files could not be read", staleInodes: false, pid: 1 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PROCESS_INCONCLUSIVE: inconclusive/);
  assert.match(r.stdout, /could not be read/);
  assert.match(r.stdout, /NOT VERIFIED/);
});

test("inconclusive: a daemon that predates the verdict is not read as adopted", function () {
  var r = run({ loadedBuildSha: HEAD, staleInodes: false, pid: 1 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PROCESS_INCONCLUSIVE: inconclusive/);
  assert.doesNotMatch(r.stdout, /ARTIFACT_AND_PROCESS_VERIFIED/);
});

test("inconclusive: no running daemon", function () {
  var r = run(null);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ARTIFACT_VERIFIED_NO_PROCESS/);
  assert.match(r.stdout, /UNKNOWN/);
});
