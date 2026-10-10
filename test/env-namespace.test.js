// env-namespace: console owns CLAGENTIC_CONSOLE_* only. `clagentic` alone is the
// shared brand of every clagentic product, so a bare CLAGENTIC_<NAME> variable
// read by console collides with theirs. This fails on any new bare read in
// lib/, bin/, scripts/ or deploy/, so the rename does not regress.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

var REPO = path.join(__dirname, "..");
var SCAN_DIRS = ["lib", "bin", "scripts", "deploy"];
var SCAN_EXT = /\.(js|mjs|cjs|sh|service)$/;

// Another product's own variable, read for lite detection (lib/lite-detect.js).
var OTHER_PRODUCT_VARS = ["CLAGENTIC_LITE_HOME"];
// The deprecated-alias table: the one place old names are spelled out.
var ALLOWLISTED_FILES = [path.join("lib", "env-compat.js")];

var BARE = "CLAGENTIC_(?!CONSOLE_)";
var PATTERNS = [
  // process.env.CLAGENTIC_X and process.env["CLAGENTIC_X"]
  { name: "process.env access", re: new RegExp("process\\.env(?:\\.|\\[\\s*[\"'`])" + BARE + "[A-Z0-9_]+", "g") },
  // Environment=CLAGENTIC_X in a unit file
  { name: "unit Environment=", re: new RegExp("^\\s*Environment=\"?" + BARE + "[A-Z0-9_]+", "gm") },
  // "CLAGENTIC_X" as a string literal (lookups by name, quoted env-object keys)
  { name: "string literal", re: new RegExp("[\"'`]" + BARE + "[A-Z0-9_]+[\"'`]", "g") },
];

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__pycache__") return;
      walk(p, out);
    } else if (SCAN_EXT.test(e.name)) {
      out.push(p);
    }
  });
  return out;
}

function findBareReads(text) {
  var hits = [];
  PATTERNS.forEach(function (p) {
    var m;
    p.re.lastIndex = 0;
    while ((m = p.re.exec(text)) !== null) {
      var name = (m[0].match(/CLAGENTIC_[A-Z0-9_]+/) || [""])[0];
      if (OTHER_PRODUCT_VARS.indexOf(name) !== -1) continue;
      hits.push(p.name + ": " + m[0].trim());
    }
  });
  return hits;
}

test("scanner flags a bare CLAGENTIC_ read in each form", function () {
  assert.ok(findBareReads("var x = process.env.CLAGENTIC_FOO;").length);
  assert.ok(findBareReads("var x = process.env['CLAGENTIC_FOO'];").length);
  assert.ok(findBareReads("Environment=CLAGENTIC_FOO=1").length);
  assert.ok(findBareReads("spawn(a, b, { env: { 'CLAGENTIC_FOO': 1 } })").length);
  assert.ok(findBareReads("var n = 'CLAGENTIC_FOO';").length);
});

test("scanner accepts scoped names and another product's variable", function () {
  assert.deepStrictEqual(findBareReads("process.env.CLAGENTIC_CONSOLE_DEV; Environment=CLAGENTIC_CONSOLE_X=1"), []);
  assert.deepStrictEqual(findBareReads("process.env.CLAGENTIC_LITE_HOME || x"), []);
});

test("lib/, bin/, scripts/ and deploy/ read no bare CLAGENTIC_ variable", function () {
  var files = [];
  SCAN_DIRS.forEach(function (d) {
    var dir = path.join(REPO, d);
    if (fs.existsSync(dir)) walk(dir, files);
  });
  assert.ok(files.length > 50, "scan found suspiciously few files: " + files.length);

  var offenders = [];
  files.forEach(function (file) {
    var rel = path.relative(REPO, file);
    if (ALLOWLISTED_FILES.indexOf(rel) !== -1) return;
    var hits = findBareReads(fs.readFileSync(file, "utf8"));
    if (hits.length) offenders.push(rel + " -> " + hits.join("; "));
  });
  assert.deepStrictEqual(offenders, [],
    "Console env vars must be CLAGENTIC_CONSOLE_<NAME>; add old names to lib/env-compat.js only.\n" + offenders.join("\n"));
});

test("the shipped systemd unit sets only scoped env vars", function () {
  var unit = fs.readFileSync(path.join(REPO, "deploy", "clagentic-console.service"), "utf8");
  assert.match(unit, /^Environment=CLAGENTIC_CONSOLE_MAX_CONCURRENT_SESSIONS=50$/m);
  assert.deepStrictEqual(findBareReads(unit), []);
});
