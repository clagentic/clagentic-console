// `clagentic-console daemon` runs the daemon in the foreground, in-process, and
// refuses an npm-link install with exit 78 (EX_CONFIG, which the unit does not
// restart-loop).

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { spawnSync } = require("child_process");
var { findLinkTrap, linkTrapMessage, LinkTrapProbeError } = require("../lib/link-trap");

var CLI = path.resolve(__dirname, "..", "bin", "cli.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "console-daemon-sub-"));
}

test("scoped global install with an unscoped symlink beside it is a link trap", function () {
  var root = tmp();
  var nm = path.join(root, "lib", "node_modules");
  fs.mkdirSync(path.join(nm, "@clagentic", "console"), { recursive: true });
  fs.symlinkSync(path.join(root, "workspace"), path.join(nm, "clagentic-console"));
  var trap = findLinkTrap(path.join(nm, "@clagentic", "console"));
  assert.strictEqual(trap, path.join(nm, "clagentic-console"));
  assert.match(linkTrapMessage(trap), /npm link trap/);
});

test("trap is found through the bin path when the package dir resolved into a working tree", function () {
  var root = tmp();
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib", "node_modules"), { recursive: true });
  fs.symlinkSync(path.join(root, "workspace"), path.join(root, "lib", "node_modules", "clagentic-console"));
  var trap = findLinkTrap("/work/checkout", { binPath: path.join(root, "bin", "clagentic-console") });
  assert.strictEqual(trap, path.join(root, "lib", "node_modules", "clagentic-console"));
});

test("clean global install and a plain dev checkout are not traps", function () {
  var root = tmp();
  var nm = path.join(root, "lib", "node_modules");
  fs.mkdirSync(path.join(nm, "@clagentic", "console"), { recursive: true });
  assert.strictEqual(findLinkTrap(path.join(nm, "@clagentic", "console")), null);
  assert.strictEqual(findLinkTrap(path.resolve(__dirname, "..")), null);
  // A real (non-symlink) directory at the unscoped name is not the trap.
  fs.mkdirSync(path.join(nm, "clagentic-console"));
  assert.strictEqual(findLinkTrap(path.join(nm, "@clagentic", "console")), null);
});

test("cli.js `daemon` is wired in-process (no fork) and lists itself in --help", function () {
  var src = fs.readFileSync(CLI, "utf8");
  var block = src.slice(src.indexOf('args[0] === "daemon"'), src.indexOf('args[0] === "release"'));
  assert.match(block, /process\.exit\(78\)/);
  assert.match(block, /require\("\.\.\/lib\/daemon"\)/);
  assert.doesNotMatch(block, /spawn|fork|detached/);

  var help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /clagentic-console daemon/);
});

test("`clagentic-console daemon` starts lib/daemon.js in the same process: EX_CONFIG guard exits 78 from the daemon itself", function () {
  if (process.platform === "win32") return;
  // Same mis-set-home scenario daemon-bootstrap-guard.test.js uses against
  // lib/daemon.js, driven through the new subcommand.
  var tmpDir = tmp();
  var dotClagentic = path.join(tmpDir, ".clagentic");
  var consoleDir = path.join(dotClagentic, "console");
  fs.mkdirSync(consoleDir, { recursive: true });
  fs.writeFileSync(path.join(dotClagentic, "daemon.json"),
    JSON.stringify({ port: 2633, projects: [{ path: "/p", slug: "p" }], mode: "single", setupCompleted: true }), { mode: 0o600 });

  var res = spawnSync(process.execPath, [CLI, "daemon"], {
    env: { PATH: process.env.PATH, HOME: tmpDir, CLAGENTIC_CONSOLE_HOME: consoleDir },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.strictEqual(res.status, 78, "stderr: " + res.stderr);
  assert.match(res.stderr, /CLAGENTIC_CONSOLE_HOME appears to point at the console\/ socket subdirectory/);
  assert.ok(!fs.existsSync(path.join(consoleDir, "daemon.json")));
});

// --- link-trap probe failures fail closed ---

function fsThatFailsWith(code) {
  return {
    lstatSync: function (p) {
      var e = new Error(code + ": simulated lstat failure for " + p);
      e.code = code;
      throw e;
    },
  };
}

test("only ENOENT and ENOTDIR mean 'no trap'", function () {
  var pkgDir = "/g/lib/node_modules/@clagentic/console";
  assert.strictEqual(findLinkTrap(pkgDir, { fs: fsThatFailsWith("ENOENT") }), null);
  assert.strictEqual(findLinkTrap(pkgDir, { fs: fsThatFailsWith("ENOTDIR") }), null);
});

["EACCES", "ELOOP", "EIO"].forEach(function (code) {
  test("lstat " + code + " is not read as 'no trap': findLinkTrap throws naming the path and errno", function () {
    var pkgDir = "/g/lib/node_modules/@clagentic/console";
    assert.throws(function () { findLinkTrap(pkgDir, { fs: fsThatFailsWith(code) }); }, function (err) {
      assert.ok(err instanceof LinkTrapProbeError);
      assert.strictEqual(err.code, "LINK_TRAP_PROBE_FAILED");
      assert.strictEqual(err.errno, code);
      assert.strictEqual(err.path, "/g/lib/node_modules/clagentic-console");
      assert.ok(err.message.indexOf(err.path) !== -1 && err.message.indexOf(code) !== -1, err.message);
      return true;
    });
  });
});

test("a lstat failure on the bin-path candidate also throws", function () {
  assert.throws(function () {
    findLinkTrap("/work/checkout", { binPath: "/p/bin/clagentic-console", fs: fsThatFailsWith("EACCES") });
  }, LinkTrapProbeError);
});

test("`clagentic-console daemon` exits 78 and names the path and errno when the candidate cannot be inspected (ELOOP)", function () {
  if (process.platform === "win32") return;
  var root = tmp();
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  // <root>/lib/node_modules points at itself, so lstat on a path beneath it fails with ELOOP.
  fs.symlinkSync(path.join(root, "lib", "node_modules"), path.join(root, "lib", "node_modules"));
  var binLink = path.join(root, "bin", "clagentic-console");
  fs.symlinkSync(CLI, binLink);

  var res = spawnSync(process.execPath, [binLink, "daemon"], {
    env: { PATH: process.env.PATH, HOME: root, CLAGENTIC_CONSOLE_HOME: path.join(root, "home") },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.strictEqual(res.status, 78, "stderr: " + res.stderr);
  assert.match(res.stderr, /ELOOP/);
  assert.ok(res.stderr.indexOf(path.join(root, "lib", "node_modules", "clagentic-console")) !== -1, res.stderr);
  assert.ok(!fs.existsSync(path.join(root, "home")), "the daemon must not have started");
});

test("the unit and the subcommand agree: ExecStart ends in `daemon`", function () {
  var unit = fs.readFileSync(path.join(__dirname, "..", "deploy", "clagentic-console.service"), "utf8");
  assert.match(unit, /^ExecStart=\S+ daemon$/m);
});
