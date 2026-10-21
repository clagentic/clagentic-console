// The installer registers exactly one Claude Code allow rule, idempotently,
// without touching any other key or entry, and leaves an unusable settings
// file alone. Every host effect is an in-memory stub.

var test = require("node:test");
var assert = require("node:assert/strict");
var rule = require("../lib/claude-allow-rule");
var postinstall = require("../scripts/postinstall");

var FILE = "/home/u/.claude/settings.json";

function memFs(initial) {
  var files = Object.assign({}, initial);
  return {
    files: files,
    readFileSync: function (p) {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      var e = new Error("ENOENT"); e.code = "ENOENT"; throw e;
    },
    statSync: function () { return { mode: 0o100600 }; },
    mkdirSync: function () {},
    lstatSync: function () { return { isSymbolicLink: function () { return false; } }; },
    unlinkSync: function (p) {
      if (!Object.prototype.hasOwnProperty.call(files, p)) { var e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      delete files[p];
    },
    writeFileSync: function (p, c) { files[p] = c; },
    renameSync: function (from, to) { files[to] = files[from]; delete files[from]; },
  };
}

test("the rule is the single documented one", function () {
  assert.equal(rule.ALLOW_RULE, "Bash(clagentic-console list-sessions *)");
});

test("settings path honours CLAUDE_CONFIG_DIR, else <home>/.claude", function () {
  assert.equal(rule.settingsPathFor({}, "/home/u"), "/home/u/.claude/settings.json");
  assert.equal(rule.settingsPathFor({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u"), "/cfg/settings.json");
});

test("a missing file is created with just the rule", function () {
  var f = memFs({});
  assert.equal(rule.ensureAllowRule(f, FILE, function () {}), "added");
  assert.deepEqual(JSON.parse(f.files[FILE]), { permissions: { allow: [rule.ALLOW_RULE] } });
});

test("existing keys and entries are kept, the rule is added once across reinstalls", function () {
  var before = { model: "opus", permissions: { allow: ["Bash(ls *)"], deny: ["Bash(rm *)"] }, hooks: { a: [1] } };
  var f = memFs({ [FILE]: JSON.stringify(before) });
  assert.equal(rule.ensureAllowRule(f, FILE, function () {}), "added");
  assert.equal(rule.ensureAllowRule(f, FILE, function () {}), "present");
  assert.equal(rule.ensureAllowRule(f, FILE, function () {}), "present");
  var after = JSON.parse(f.files[FILE]);
  assert.deepEqual(after.permissions.allow, ["Bash(ls *)", rule.ALLOW_RULE]);
  assert.deepEqual(after.permissions.deny, ["Bash(rm *)"]);
  assert.equal(after.model, "opus");
  assert.deepEqual(after.hooks, before.hooks);
});

test("an already-present rule leaves the file byte-for-byte unchanged", function () {
  var text = '{"permissions":{"allow":["Bash(clagentic-console list-sessions *)"]}}';
  var f = memFs({ [FILE]: text });
  assert.equal(rule.ensureAllowRule(f, FILE, function () {}), "present");
  assert.equal(f.files[FILE], text);
});

test("invalid JSON or an unexpected shape is left untouched with a warning", function () {
  [
    "{ not json",
    "[]",
    '{"permissions":"x"}',
    '{"permissions":{"allow":"x"}}',
  ].forEach(function (text) {
    var logs = [];
    var f = memFs({ [FILE]: text });
    assert.equal(rule.ensureAllowRule(f, FILE, function (m) { logs.push(m); }), "skipped", text);
    assert.equal(f.files[FILE], text);
    assert.ok(logs.some(function (m) { return /WARNING/.test(m); }));
  });
});

test("an unreadable file (not ENOENT) is left alone", function () {
  var logs = [];
  var f = memFs({});
  f.readFileSync = function () { var e = new Error("EACCES"); e.code = "EACCES"; throw e; };
  assert.equal(rule.ensureAllowRule(f, FILE, function (m) { logs.push(m); }), "skipped");
  assert.deepEqual(f.files, {});
  assert.ok(logs.some(function (m) { return /WARNING/.test(m); }));
});

test("a failed write fails open", function () {
  var f = memFs({});
  f.writeFileSync = function () { throw new Error("EROFS"); };
  assert.equal(rule.ensureAllowRule(f, FILE, function () {}), "skipped");
});

test("postinstall adds the rule on a global root install, only once, and fails open", function () {
  var f = memFs({ "/unit-src": "[Service]\nExecStart=@@BIN@@ daemon\n", [FILE]: '{"x":1}' });
  var realFs = f;
  var deps = {
    fs: Object.assign({}, realFs, { existsSync: function (p) { return Object.prototype.hasOwnProperty.call(realFs.files, p); }, unlinkSync: function () {} }),
    env: { npm_config_global: "true", npm_config_prefix: "/usr" },
    platform: "linux",
    getuid: function () { return 0; },
    systemdDir: "/etc/systemd/system",
    legacyWrapperPath: "/usr/local/bin/clagentic-daemon.sh",
    pkgDir: "/usr/lib/node_modules/@clagentic/console",
    unitSrc: "/unit-src",
    claudeSettingsPath: FILE,
    log: function () {},
    runCmd: function () { return ""; },
    loadConfig: function () { return null; },
    applyDropIn: function () {},
    parseMemoryLimit: function () { return { ok: true }; },
  };
  assert.equal(postinstall.run(deps), "installed");
  assert.equal(postinstall.run(deps), "installed");
  var after = JSON.parse(f.files[FILE]);
  assert.equal(after.x, 1);
  assert.deepEqual(after.permissions.allow, [rule.ALLOW_RULE]);
});

function postinstallDeps(f, over) {
  return Object.assign({
    fs: Object.assign({}, f, { existsSync: function (p) { return Object.prototype.hasOwnProperty.call(f.files, p); }, unlinkSync: function () {} }),
    env: { npm_config_global: "true", npm_config_prefix: "/usr" },
    platform: "linux",
    getuid: function () { return 0; },
    systemdDir: "/etc/systemd/system",
    legacyWrapperPath: "/usr/local/bin/clagentic-daemon.sh",
    pkgDir: "/usr/lib/node_modules/@clagentic/console",
    unitSrc: "/unit-src",
    claudeSettingsPath: FILE,
    log: function () {},
    runCmd: function () { return ""; },
    loadConfig: function () { return null; },
    applyDropIn: function () {},
    parseMemoryLimit: function () { return { ok: true }; },
  }, over);
}

test("postinstall leaves Claude settings alone on non-Linux, non-root and local installs", function () {
  [
    { platform: "darwin" },
    { getuid: function () { return 1000; } },
    { env: {} },
  ].forEach(function (over, i) {
    var f = memFs({ "/unit-src": "[Service]\nExecStart=@@BIN@@ daemon\n", [FILE]: '{"x":1}' });
    postinstall.run(postinstallDeps(f, over));
    assert.equal(f.files[FILE], '{"x":1}', "shape " + i);
  });
});

test("postinstall writes the settings file named by CLAUDE_CONFIG_DIR", function () {
  var custom = rule.settingsPathFor({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u");
  var f = memFs({ "/unit-src": "[Service]\nExecStart=@@BIN@@ daemon\n" });
  postinstall.run(postinstallDeps(f, { claudeSettingsPath: custom }));
  assert.deepEqual(JSON.parse(f.files["/cfg/settings.json"]).permissions.allow, [rule.ALLOW_RULE]);
  assert.equal(f.files[FILE], undefined);
});

test("the temp file is unpredictable, exclusive, and removed when the rename fails", function () {
  var f = memFs({});
  var seen = [];
  f.writeFileSync = function (p, c, opts) { seen.push({ p: p, opts: opts }); f.files[p] = c; };
  f.unlinkSync = function (p) { delete f.files[p]; };
  f.renameSync = function () { throw new Error("EXDEV"); };
  assert.equal(rule.ensureAllowRule(f, FILE, function () {}), "skipped");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].opts.flag, "wx");
  assert.notEqual(seen[0].p, FILE + ".clagentic-console.tmp");
  assert.match(seen[0].p, /\.[0-9a-f]{16}\.tmp$/);
  assert.deepEqual(f.files, {});
});

test("real filesystem: a symlinked settings file is followed, the link and mode are kept", function () {
  var fs = require("node:fs");
  var os = require("node:os");
  var path = require("node:path");
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "allow-rule-"));
  try {
    var target = path.join(dir, "real.json");
    var link = path.join(dir, "settings.json");
    fs.writeFileSync(target, '{"x":1}', { mode: 0o640 });
    fs.chmodSync(target, 0o640);
    fs.symlinkSync(target, link);
    assert.equal(rule.ensureAllowRule(fs, link, function () {}), "added");
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")).permissions.allow, [rule.ALLOW_RULE]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["real.json", "settings.json"]);

    var dangling = path.join(dir, "dangling.json");
    fs.symlinkSync(path.join(dir, "missing.json"), dangling);
    var logs = [];
    assert.equal(rule.ensureAllowRule(fs, dangling, function (m) { logs.push(m); }), "skipped");
    assert.ok(fs.lstatSync(dangling).isSymbolicLink());
    assert.ok(logs.some(function (m) { return /WARNING/.test(m); }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
