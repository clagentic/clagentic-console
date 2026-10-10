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

test("package.json points verify:installed-build at the wrapper, with no && chain", function () {
  var pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.strictEqual(pkg.scripts["verify:installed-build"], "node scripts/verify-installed.js");
});
