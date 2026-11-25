// verify:installed-build runs BOTH independent checks every time and fails if
// either fails. Chained with `&&`, the always-failing-until-restart process
// check (PROCESS_MISMATCH) stopped the SDK drift check from ever running.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { spawnSync } = require("child_process");
var verify = require("../scripts/verify-installed");

function fakeScripts(spec) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-verify-all-"));
  Object.keys(spec).forEach(function (name) {
    var s = spec[name];
    var src = (s.stderr ? "console.error(" + JSON.stringify(s.stderr) + ");" : "") +
      (s.stdout ? "console.log(" + JSON.stringify(s.stdout) + ");" : "") +
      "process.exit(" + s.exit + ");";
    fs.writeFileSync(path.join(dir, name), src);
  });
  return dir;
}

function runReal(dir) {
  var driver = "var v=require(" + JSON.stringify(path.join(__dirname, "..", "scripts", "verify-installed.js")) + ");" +
    "var r=v.runAll({scriptsDir:" + JSON.stringify(dir) + "});process.exit(r.ok?0:1);";
  return spawnSync(process.execPath, ["-e", driver], { encoding: "utf8" });
}

test("simulated PROCESS_MISMATCH still runs the drift check and prints both results; exit non-zero", function () {
  var dir = fakeScripts({
    "verify-installed-build.js": { exit: 1, stderr: "[verify-installed-build] PROCESS_MISMATCH: simulated" },
    "check-sdk-lock-drift.js": { exit: 0, stdout: "[check-sdk-lock-drift] OK: simulated" },
  });
  var res = runReal(dir);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /PROCESS_MISMATCH: simulated/);
  assert.match(res.stdout, /check-sdk-lock-drift\] OK: simulated/, "drift check must have run");
  assert.match(res.stdout, /installed-build: FAIL \(exit 1\)/);
  assert.match(res.stdout, /sdk-lock-drift: PASS \(exit 0\)/);
  assert.match(res.stdout, /FAILED: installed-build/);
});

test("a drift failure is reported even when the build check passes", function () {
  var dir = fakeScripts({
    "verify-installed-build.js": { exit: 0, stdout: "ok" },
    "check-sdk-lock-drift.js": { exit: 1, stderr: "DRIFT simulated" },
  });
  var res = runReal(dir);
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /installed-build: PASS/);
  assert.match(res.stdout, /sdk-lock-drift: FAIL \(exit 1\)/);
});

test("both failing reports both and exits non-zero", function () {
  var dir = fakeScripts({
    "verify-installed-build.js": { exit: 1 },
    "check-sdk-lock-drift.js": { exit: 2 },
  });
  var res = runReal(dir);
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /FAILED: installed-build, sdk-lock-drift/);
  assert.match(res.stdout, /sdk-lock-drift: FAIL \(exit 2\)/);
});

test("both passing exits 0", function () {
  var dir = fakeScripts({
    "verify-installed-build.js": { exit: 0 },
    "check-sdk-lock-drift.js": { exit: 0 },
  });
  var res = runReal(dir);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /all checks passed/);
});

test("runAll runs every check in order even when the first throws a non-zero status", function () {
  var ran = [];
  var logs = [];
  var out = verify.runAll({
    scriptsDir: "/s",
    runScript: function (p) { ran.push(path.basename(p)); return { status: ran.length === 1 ? 1 : 0 }; },
    log: function (m) { logs.push(m); },
  });
  assert.deepStrictEqual(ran, ["verify-installed-build.js", "check-sdk-lock-drift.js"]);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(logs.length, 3);
});

// One row per outcome of the process leg, run through the real entry point
// (scripts/verify-installed.js spawning scripts/verify-installed-build.js)
// copied into a temp git repo with three commits, so ancestry is real git.
// HEAD is c2: c1 is its ancestor, c3 is a descendant that exists but is not
// reachable from HEAD, and "e" * 40 is unknown to the repo.
var UNKNOWN_SHA = "e".repeat(40);
var GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(repo, args) {
  return require("child_process").execFileSync("git", args, {
    cwd: repo, env: Object.assign({}, process.env, GIT_ENV), stdio: ["ignore", "pipe", "pipe"],
  }).toString().trim();
}

function runEntryPoint(installedSha, daemon) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "console-verify-entry-"));
  try {
    var repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    ["verify-installed.js", "verify-installed-build.js"].forEach(function (f) {
      fs.copyFileSync(path.join(__dirname, "..", "scripts", f), path.join(repo, "scripts", f));
    });
    fs.writeFileSync(path.join(repo, "scripts", "check-sdk-lock-drift.js"), "process.exit(0);\n");
    git(repo, ["init", "-q"]);
    var shas = [];
    ["c1", "c2", "c3"].forEach(function (name) {
      fs.writeFileSync(path.join(repo, "f.txt"), name);
      git(repo, ["add", "f.txt"]);
      git(repo, ["commit", "-q", "-m", name]);
      shas.push(git(repo, ["rev-parse", "HEAD"]));
    });
    git(repo, ["checkout", "-q", "--detach", shas[1]]);
    var names = { c1: shas[0], c2: shas[1], c3: shas[2], unknown: UNKNOWN_SHA };

    var globalRoot = path.join(root, "global");
    var installedLib = path.join(globalRoot, "@clagentic", "console", "lib");
    fs.mkdirSync(installedLib, { recursive: true });
    fs.writeFileSync(path.join(installedLib, "build-sha.json"), JSON.stringify({ sha: names[installedSha] }));
    var binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "npm"),
      "#!/usr/bin/env node\nprocess.stdout.write(" + JSON.stringify(globalRoot) + " + '\\n');\n", { mode: 0o755 });
    var status = Object.assign({ pid: 4242, staleInodes: false }, daemon, { loadedBuildSha: names[daemon.loaded] });
    delete status.loaded;
    if (status.installedBuildSha) status.installedBuildSha = names[status.installedBuildSha];
    fs.writeFileSync(path.join(binDir, "clagentic-console"),
      "#!/usr/bin/env node\nprocess.stdout.write(" + JSON.stringify(JSON.stringify(status)) + ");\n", { mode: 0o755 });
    var res = spawnSync(process.execPath, [path.join(repo, "scripts", "verify-installed.js")], {
      env: Object.assign({}, process.env, { PATH: binDir + path.delimiter + process.env.PATH }),
      encoding: "utf8",
    });
    return { res: res, shas: names };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

[
  { id: "AC1 pending restart: loaded is an ancestor of HEAD", installed: "c2", daemon: { loaded: "c1", state: "stale", installedBuildSha: "c2" },
    exit: 0, out: /PENDING_RESTART:[\s\S]*NOT live[\s\S]*restart pending/, loaded: "c1", installed_sha: "c2", noClaim: true },
  { id: "AC1 daemon-reported stale with loaded === HEAD", installed: "c2", daemon: { loaded: "c2", state: "stale", reason: "content", detail: "files differ" },
    exit: 0, out: /PENDING_RESTART:[\s\S]*files differ/, loaded: "c2", installed_sha: "c2", noClaim: true },
  { id: "AC2 installed build is not merged HEAD", installed: "c1", daemon: { loaded: "c1", state: "adopted" },
    exit: 1, err: /ARTIFACT_MISMATCH/, installed_sha: "c1", head: "c2" },
  { id: "AC3 loaded is a descendant of HEAD", installed: "c2", daemon: { loaded: "c3", state: "stale", installedBuildSha: "c2" },
    exit: 1, err: /PROCESS_MISMATCH:[\s\S]*would not move the service forward/, loaded: "c3", installed_sha: "c2" },
  { id: "AC3 loaded sha unknown to the repo", installed: "c2", daemon: { loaded: "unknown", state: "stale", installedBuildSha: "c2" },
    exit: 1, err: /PROCESS_MISMATCH:[\s\S]*would not move the service forward/, loaded: "unknown", installed_sha: "c2" },
].forEach(function (row) {
  test("verify:installed-build entry point: " + row.id, function () {
    var out = runEntryPoint(row.installed, row.daemon);
    var res = out.res;
    assert.strictEqual(res.status, row.exit, res.stdout + res.stderr);
    if (row.out) assert.match(res.stdout, row.out);
    if (row.err) assert.match(res.stderr, row.err);
    var text = res.stdout + res.stderr;
    if (row.loaded) assert.ok(text.indexOf(out.shas[row.loaded]) !== -1, "names the loaded sha");
    if (row.installed_sha) assert.ok(text.indexOf(out.shas[row.installed_sha]) !== -1, "names the installed sha");
    if (row.head) assert.ok(res.stderr.indexOf(out.shas[row.head]) !== -1, "names the expected HEAD sha");
    if (row.noClaim) {
      assert.doesNotMatch(res.stdout, /PROCESS_VERIFIED|adopted/i, "never claims the process is verified or adopted");
      assert.doesNotMatch(res.stdout, /installed-build: PASS \(exit/, "summary is not a bare PASS");
    }
  });
});

test("package.json points verify:installed-build at the wrapper, with no && chain", function () {
  var pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.strictEqual(pkg.scripts["verify:installed-build"], "node scripts/verify-installed.js");
});
