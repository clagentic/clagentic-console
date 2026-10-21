// The installer must never read or write Claude Code settings. The settings
// file is real (present, absent, symlink) and every fs call postinstall makes
// is recorded, so an access to it fails the test even if it is read-only.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var postinstall = require("../scripts/postinstall");

function installDeps(touched, settingsDir, over) {
  function guard(name) {
    return function (p) {
      if (typeof p === "string" && p.indexOf(settingsDir) === 0) touched.push(name + " " + p);
      var e = new Error("ENOENT"); e.code = "ENOENT"; throw e;
    };
  }
  var unit = "[Service]\nExecStart=@@BIN@@ daemon\n";
  return Object.assign({
    fs: {
      readFileSync: function (p) { return p === "/unit-src" ? unit : guard("read")(p); },
      writeFileSync: guard("write"),
      renameSync: guard("rename"),
      mkdirSync: guard("mkdir"),
      statSync: guard("stat"),
      lstatSync: guard("lstat"),
      realpathSync: guard("realpath"),
      unlinkSync: function () {},
      existsSync: function (p) {
        if (typeof p === "string" && p.indexOf(settingsDir) === 0) touched.push("exists " + p);
        return false;
      },
    },
    env: { npm_config_global: "true", npm_config_prefix: "/usr", CLAUDE_CONFIG_DIR: settingsDir },
    platform: "linux",
    getuid: function () { return 0; },
    systemdDir: "/etc/systemd/system",
    legacyWrapperPath: "/usr/local/bin/clagentic-daemon.sh",
    pkgDir: "/usr/lib/node_modules/@clagentic/console",
    unitSrc: "/unit-src",
    log: function () {},
    runCmd: function () { return ""; },
    loadConfig: function () { return null; },
    applyDropIn: function () {},
    parseMemoryLimit: function () { return { ok: true }; },
  }, over || {});
}

function snapshot(dir) {
  return fs.readdirSync(dir).sort().map(function (n) {
    var p = path.join(dir, n);
    var l = fs.lstatSync(p);
    return n + ":" + (l.isSymbolicLink() ? "link->" + fs.readlinkSync(p) : fs.readFileSync(p, "utf8"));
  });
}

var SHAPES = [
  ["global root linux", {}],
  ["non-root", { getuid: function () { return 1000; } }],
  ["non-linux", { platform: "darwin" }],
  ["local install", { env: null }],
];

SHAPES.forEach(function (shape) {
  ["present", "absent", "symlink"].forEach(function (state) {
    test("postinstall (" + shape[0] + ") leaves a " + state + " Claude settings file untouched", function () {
      var dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-"));
      try {
        var file = path.join(dir, "settings.json");
        if (state === "present") fs.writeFileSync(file, '{"permissions":{"allow":["Bash(ls *)"]}}\n');
        if (state === "symlink") {
          fs.writeFileSync(path.join(dir, "real.json"), '{"x":1}');
          fs.symlinkSync(path.join(dir, "real.json"), file);
        }
        var before = snapshot(dir);
        var touched = [];
        var over = Object.assign({}, shape[1]);
        var deps = installDeps(touched, dir, over);
        if (over.env === null) deps.env = { CLAUDE_CONFIG_DIR: dir };
        postinstall.run(deps);
        assert.deepEqual(touched, []);
        assert.deepEqual(snapshot(dir), before);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
