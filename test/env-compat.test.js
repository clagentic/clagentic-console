// env-compat: console env vars are CLAGENTIC_CONSOLE_<NAME>; the old un-scoped
// names keep working for one release and warn once, naming the replacement.

var test = require("node:test");
var assert = require("node:assert");
var path = require("path");
var { spawnSync } = require("child_process");
var { readConsoleEnv, ALIASES } = require("../lib/env-compat");

function reader(env) {
  var warnings = [];
  var warned = new Set();
  return {
    warnings: warnings,
    read: function (name) {
      return readConsoleEnv(name, { env: env, warn: function (m) { warnings.push(m); }, warned: warned });
    },
  };
}

test("every console variable is read by its CLAGENTIC_CONSOLE_ name", function () {
  Object.keys(ALIASES).forEach(function (name) {
    assert.match(name, /^CLAGENTIC_CONSOLE_[A-Z_]+$/);
    ALIASES[name].forEach(function (legacy) {
      assert.doesNotMatch(legacy, /^CLAGENTIC_CONSOLE_/, "alias must be an old name: " + legacy);
    });
  });
  var expected = ["HOME", "CONFIG", "DEV", "DEBUG", "SELF_UPDATE", "MAX_CONCURRENT_SESSIONS"];
  expected.forEach(function (suffix) {
    assert.ok(ALIASES["CLAGENTIC_CONSOLE_" + suffix], "missing console variable " + suffix);
  });
});

test("new name is read without a warning", function () {
  var r = reader({ CLAGENTIC_CONSOLE_DEV: "1" });
  assert.strictEqual(r.read("CLAGENTIC_CONSOLE_DEV"), "1");
  assert.deepStrictEqual(r.warnings, []);
});

test("new name wins over every old name and does not warn", function () {
  var r = reader({ CLAGENTIC_CONSOLE_HOME: "/new", CLAGENTIC_HOME: "/old" });
  assert.strictEqual(r.read("CLAGENTIC_CONSOLE_HOME"), "/new");
  assert.deepStrictEqual(r.warnings, []);
});

test("old name is accepted and warns once naming the new one", function () {
  var r = reader({ CLAGENTIC_DEV: "1" });
  assert.strictEqual(r.read("CLAGENTIC_CONSOLE_DEV"), "1");
  assert.strictEqual(r.read("CLAGENTIC_CONSOLE_DEV"), "1");
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /CLAGENTIC_DEV is deprecated/);
  assert.match(r.warnings[0], /CLAGENTIC_CONSOLE_DEV/);
});

test("each old name of a variable is accepted", function () {
  Object.keys(ALIASES).forEach(function (name) {
    ALIASES[name].forEach(function (legacy) {
      var env = {};
      env[legacy] = "v";
      var r = reader(env);
      assert.strictEqual(r.read(name), "v", legacy + " -> " + name);
      assert.strictEqual(r.warnings.length, 1);
    });
  });
});

test("empty values are treated as unset", function () {
  var r = reader({ CLAGENTIC_CONSOLE_DEV: "", CLAGENTIC_DEV: "" });
  assert.strictEqual(r.read("CLAGENTIC_CONSOLE_DEV"), undefined);
  assert.deepStrictEqual(r.warnings, []);
});

test("lib/config.js honours CLAGENTIC_CONSOLE_DEV (dev socket) and the old CLAGENTIC_DEV", function () {
  var script = "var c=require(" + JSON.stringify(path.join(__dirname, "..", "lib", "config.js")) + ");" +
    "process.stdout.write(JSON.stringify({dev:c.isDevMode,sock:require('path').basename(c.socketPath())}));";
  function probe(extraEnv) {
    var tmpHome = require("fs").mkdtempSync(path.join(require("os").tmpdir(), "console-env-"));
    var env = { PATH: process.env.PATH, HOME: tmpHome, CLAGENTIC_CONSOLE_HOME: path.join(tmpHome, "h") };
    Object.assign(env, extraEnv);
    var res = spawnSync(process.execPath, ["-e", script], { env: env, encoding: "utf8" });
    assert.strictEqual(res.status, 0, res.stderr);
    return { out: JSON.parse(res.stdout), stderr: res.stderr + res.stdout };
  }
  var scoped = probe({ CLAGENTIC_CONSOLE_DEV: "1" });
  assert.strictEqual(scoped.out.dev, true);
  assert.strictEqual(scoped.out.sock, "daemon-dev.sock");
  assert.doesNotMatch(scoped.stderr, /deprecated/);

  var legacy = probe({ CLAGENTIC_DEV: "1" });
  assert.strictEqual(legacy.out.dev, true);
  assert.match(legacy.stderr, /CLAGENTIC_DEV is deprecated.*CLAGENTIC_CONSOLE_DEV/);

  var none = probe({});
  assert.strictEqual(none.out.dev, false);
});
