// postinstall: installs the systemd unit for a GLOBAL install only, runs the
// daemon through `clagentic-console daemon`, and removes the old hand-placed
// wrapper only when it is the known legacy content. Every host effect is a stub;
// nothing here touches /etc/systemd, /usr/local/bin or systemctl.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var postinstall = require("../scripts/postinstall");
var svc = require("../lib/service-install");

var REPO = path.join(__dirname, "..");
var UNIT_TEMPLATE = fs.readFileSync(path.join(REPO, "deploy", "clagentic-console.service"), "utf8");
var PKG_DIR = "/usr/lib/node_modules/@clagentic/console";

// In-memory filesystem + recorder for the calls postinstall makes.
function makeDeps(over) {
  over = over || {};
  var files = Object.assign({}, over.files || {});
  var calls = { writes: [], unlinks: [], cmds: [], dropIns: [], logs: [] };
  var deps = {
    fs: {
      readFileSync: function (p) {
        if (p === "/unit-src") return UNIT_TEMPLATE;
        if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
        var e = new Error("ENOENT: " + p); e.code = "ENOENT"; throw e;
      },
      writeFileSync: function (p, c) { calls.writes.push({ path: p, content: c }); files[p] = c; },
      unlinkSync: function (p) { calls.unlinks.push(p); delete files[p]; },
      existsSync: function (p) { return Object.prototype.hasOwnProperty.call(files, p); },
    },
    env: over.env || { npm_config_global: "true", npm_config_prefix: "/usr" },
    platform: over.platform || "linux",
    getuid: function () { return over.uid === undefined ? 0 : over.uid; },
    systemdDir: "/etc/systemd/system",
    legacyWrapperPath: "/usr/local/bin/clagentic-daemon.sh",
    pkgDir: PKG_DIR,
    unitSrc: "/unit-src",
    log: function (m) { calls.logs.push(m); },
    runCmd: function (cmd, args) {
      calls.cmds.push([cmd].concat(args).join(" "));
      if (over.runCmd) return over.runCmd(cmd, args);
      return "";
    },
    loadConfig: function () { return null; },
    applyDropIn: function (limits) { calls.dropIns.push(limits); },
    parseMemoryLimit: function () { return { ok: true }; },
  };
  return { deps: deps, calls: calls, files: files };
}

function assertNoHostEffects(calls) {
  assert.deepStrictEqual(calls.writes, []);
  assert.deepStrictEqual(calls.unlinks, []);
  assert.deepStrictEqual(calls.cmds, []);
  assert.deepStrictEqual(calls.dropIns, []);
}

test("local install (npm ci / npm install in a checkout) as root touches nothing and logs the skip", function () {
  var h = makeDeps({ env: { npm_config_prefix: "/usr" }, files: { "/usr/local/bin/clagentic-daemon.sh": svc.LEGACY_WRAPPER_CONTENT } });
  assert.strictEqual(postinstall.run(h.deps), "skipped-not-global");
  assertNoHostEffects(h.calls);
  assert.ok(h.files["/usr/local/bin/clagentic-daemon.sh"], "legacy wrapper must survive a local install");
  assert.ok(h.calls.logs.some(function (l) { return /not a global install/.test(l); }), "skip must be logged");
});

test("npm_config_global=false and an npx-style install are also skipped", function () {
  [{ npm_config_global: "false" }, { npm_config_location: "project" }, {}].forEach(function (env) {
    var h = makeDeps({ env: env });
    assert.strictEqual(postinstall.run(h.deps), "skipped-not-global", JSON.stringify(env));
    assertNoHostEffects(h.calls);
  });
});

test("non-linux and non-root are still skipped", function () {
  var win = makeDeps({ platform: "win32" });
  assert.strictEqual(postinstall.run(win.deps), "skipped-platform");
  assertNoHostEffects(win.calls);

  var user = makeDeps({ uid: 1000 });
  assert.strictEqual(postinstall.run(user.deps), "skipped-not-root");
  assertNoHostEffects(user.calls);
});

test("global install as root writes the rendered unit and reloads systemd", function () {
  var h = makeDeps({});
  assert.strictEqual(postinstall.run(h.deps), "installed");
  var unit = h.files["/etc/systemd/system/clagentic-console.service"];
  assert.ok(unit, "unit written");
  assert.match(unit, /^ExecStart=\/usr\/bin\/clagentic-console daemon$/m);
  assert.match(unit, /^Description=Clagentic: Console daemon$/m);
  assert.doesNotMatch(unit, /@CLAGENTIC_CONSOLE_/);
  assert.doesNotMatch(unit, /clagentic-daemon\.sh/);
  assert.match(unit, /^Environment=PATH=\/usr\/bin:/m);
  assert.ok(h.calls.cmds.indexOf("systemctl daemon-reload") !== -1);
  assert.ok(h.calls.cmds.indexOf("systemctl enable clagentic-console.service") !== -1);
  assert.strictEqual(h.calls.dropIns.length, 1);
});

test("self-update never starts or restarts the service", function () {
  var h = makeDeps({ env: { npm_config_global: "true", npm_config_prefix: "/usr", CLAGENTIC_CONSOLE_SELF_UPDATE: "1" } });
  assert.strictEqual(postinstall.run(h.deps), "installed");
  assert.ok(!h.calls.cmds.some(function (c) { return /^systemctl (start|restart)/.test(c); }));
});

test("legacy wrapper with the known content is removed", function () {
  var h = makeDeps({ files: { "/usr/local/bin/clagentic-daemon.sh": svc.LEGACY_WRAPPER_CONTENT + "\n" } });
  postinstall.run(h.deps);
  assert.deepStrictEqual(h.calls.unlinks, ["/usr/local/bin/clagentic-daemon.sh"]);
});

test("the known legacy content matches the wrapper byte for byte apart from line endings and trailing space", function () {
  assert.ok(svc.isLegacyWrapperContent(svc.LEGACY_WRAPPER_CONTENT));
  assert.ok(svc.isLegacyWrapperContent(svc.LEGACY_WRAPPER_CONTENT.replace(/\n/g, "\r\n") + "\r\n"));
  assert.ok(svc.isLegacyWrapperContent(svc.LEGACY_WRAPPER_CONTENT + "\n\n"));
});

test("an operator-modified wrapper is never deleted", function () {
  var modified = svc.LEGACY_WRAPPER_CONTENT.replace("exec /usr/bin/node", "exec /opt/node/bin/node");
  var h = makeDeps({ files: { "/usr/local/bin/clagentic-daemon.sh": modified } });
  postinstall.run(h.deps);
  assert.deepStrictEqual(h.calls.unlinks, []);
  assert.strictEqual(h.files["/usr/local/bin/clagentic-daemon.sh"], modified);
  assert.ok(h.calls.logs.some(function (l) { return /differs from the known legacy wrapper/.test(l); }));

  ["#!/bin/sh\necho mine\n", "", svc.LEGACY_WRAPPER_CONTENT + "\necho appended"].forEach(function (content) {
    var hh = makeDeps({ files: { "/usr/local/bin/clagentic-daemon.sh": content } });
    postinstall.run(hh.deps);
    assert.deepStrictEqual(hh.calls.unlinks, [], JSON.stringify(content.slice(0, 20)));
  });
});

test("absent wrapper is fine", function () {
  var h = makeDeps({});
  assert.strictEqual(postinstall.removeLegacyWrapper(h.deps), "absent");
  assert.deepStrictEqual(h.calls.unlinks, []);
});

test("old clagentic.service cutover still stops the old unit and starts the new one when it was active", function () {
  var h = makeDeps({
    files: { "/etc/systemd/system/clagentic.service": "[Unit]\n" },
    runCmd: function (cmd, args) { return args[0] === "is-active" ? "active" : ""; },
  });
  postinstall.run(h.deps);
  assert.ok(h.calls.cmds.indexOf("systemctl stop clagentic.service") !== -1);
  assert.ok(h.calls.cmds.indexOf("systemctl start clagentic-console.service") !== -1);
  assert.deepStrictEqual(h.calls.unlinks, ["/etc/systemd/system/clagentic.service"]);
});

test("unresolvable bin path: no unit is written", function () {
  var h = makeDeps({ env: { npm_config_global: "true" } });
  h.deps.pkgDir = "/work/some-checkout";
  assert.strictEqual(postinstall.run(h.deps), "error-no-bin");
  assertNoHostEffects(h.calls);
});

test("resolveCliBin: npm prefix first, else derived from the package location", function () {
  assert.strictEqual(svc.resolveCliBin({ env: { npm_config_prefix: "/opt/node" }, pkgDir: PKG_DIR }), "/opt/node/bin/clagentic-console");
  assert.strictEqual(svc.resolveCliBin({ env: {}, pkgDir: "/usr/lib/node_modules/@clagentic/console" }), "/usr/bin/clagentic-console");
  assert.strictEqual(svc.resolveCliBin({ env: { npm_config_prefix: "relative" }, pkgDir: "/usr/local/lib/node_modules/@clagentic/console" }), "/usr/local/bin/clagentic-console");
  assert.strictEqual(svc.resolveCliBin({ env: {}, pkgDir: "/work/checkout" }), null);
});

test("renderUnit refuses a template with an unfilled placeholder", function () {
  assert.throws(function () { svc.renderUnit("ExecStart=@CLAGENTIC_CONSOLE_OTHER@\n", "/usr/bin/clagentic-console"); }, /unfilled placeholder/);
});

test("the shipped unit template", function () {
  assert.match(UNIT_TEMPLATE, /^Description=Clagentic: Console daemon$/m);
  assert.match(UNIT_TEMPLATE, /^ExecStart=@CLAGENTIC_CONSOLE_BIN@ daemon$/m);
  assert.match(UNIT_TEMPLATE, /^Type=simple$/m);
  assert.match(UNIT_TEMPLATE, /^RestartPreventExitStatus=78$/m);
  assert.match(UNIT_TEMPLATE, /^SyslogIdentifier=clagentic-console$/m);
  assert.doesNotMatch(UNIT_TEMPLATE, /clagentic-daemon\.sh/);
});

test("isGlobalInstall reads npm's lifecycle environment", function () {
  assert.strictEqual(svc.isGlobalInstall({ npm_config_global: "true" }), true);
  assert.strictEqual(svc.isGlobalInstall({ npm_config_location: "global" }), true);
  assert.strictEqual(svc.isGlobalInstall({}), false);
  assert.strictEqual(svc.isGlobalInstall({ npm_config_global: "" }), false);
});

test("package.json still runs postinstall.js on install", function () {
  var pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.strictEqual(pkg.scripts.postinstall, "node scripts/postinstall.js");
});

test("loading the module has no host effect: zero filesystem writes and zero process spawns", function (t) {
  var childProcess = require("child_process");
  var writers = ["writeFileSync", "appendFileSync", "mkdirSync", "unlinkSync", "rmSync", "renameSync",
    "copyFileSync", "symlinkSync", "chmodSync", "chownSync", "writeFile", "unlink", "rm"];
  var spawners = ["execFileSync", "execSync", "spawnSync", "spawn", "exec", "execFile", "fork"];
  var seen = [];
  writers.forEach(function (name) {
    t.mock.method(fs, name, function () { seen.push("fs." + name); });
  });
  spawners.forEach(function (name) {
    t.mock.method(childProcess, name, function () { seen.push("child_process." + name); });
  });

  var modPath = require.resolve("../scripts/postinstall");
  var svcPath = require.resolve("../lib/service-install");
  var savedPost = require.cache[modPath];
  var savedSvc = require.cache[svcPath];
  delete require.cache[modPath];
  delete require.cache[svcPath];
  var fresh;
  try {
    fresh = require("../scripts/postinstall");
  } finally {
    delete require.cache[modPath];
    delete require.cache[svcPath];
    if (savedPost) require.cache[modPath] = savedPost;
    if (savedSvc) require.cache[svcPath] = savedSvc;
  }

  assert.deepStrictEqual(seen, [], "require() must not write files or spawn processes");
  assert.strictEqual(typeof fresh.run, "function");
});

test("the main guard is what runs postinstall: executed as a script it acts, required it does not", function () {
  var src = fs.readFileSync(path.join(REPO, "scripts", "postinstall.js"), "utf8");
  var tail = src.slice(src.lastIndexOf("module.exports"));
  assert.match(tail, /if \(require\.main === module\) \{[\s\S]*run\(realDeps\(\)\)/);
  assert.doesNotMatch(src.slice(0, src.lastIndexOf("module.exports")), /^run\(/m);
});

test("daemon-reload failure: the new unit is written but the legacy wrapper is kept and the result is an error", function () {
  var wrapper = "/usr/local/bin/clagentic-daemon.sh";
  var h;
  h = makeDeps({
    files: { [wrapper]: svc.LEGACY_WRAPPER_CONTENT },
    runCmd: function (cmd, args) {
      if (args[0] === "daemon-reload") { var e = new Error("boom"); e.stderr = Buffer.from("Failed to connect to bus"); throw e; }
      return "";
    },
  });
  assert.strictEqual(postinstall.run(h.deps), "error-reload");
  assert.deepStrictEqual(h.calls.unlinks, [], "wrapper must survive a failed reload");
  assert.ok(h.files[wrapper], "wrapper still on disk");
  assert.ok(h.files["/etc/systemd/system/clagentic-console.service"], "unit written");
  assert.ok(h.calls.logs.some(function (l) { return /daemon-reload failed: Failed to connect to bus/.test(l) && /kept/.test(l); }), "reason logged");
  assert.ok(!h.calls.cmds.some(function (c) { return /^systemctl (enable|start|restart)/.test(c); }), "nothing proceeds on top of an unloaded unit");
});

test("daemon-reload success: the wrapper is removed only after the reload, with the new unit already in place", function () {
  var wrapper = "/usr/local/bin/clagentic-daemon.sh";
  var atReload = null;
  var h = makeDeps({
    files: { [wrapper]: svc.LEGACY_WRAPPER_CONTENT },
    runCmd: function (cmd, args) {
      if (args[0] === "daemon-reload" && atReload === null) {
        atReload = {
          wrapperPresent: Object.prototype.hasOwnProperty.call(h.files, wrapper),
          unitPresent: Object.prototype.hasOwnProperty.call(h.files, "/etc/systemd/system/clagentic-console.service"),
        };
      }
      return "";
    },
  });
  assert.strictEqual(postinstall.run(h.deps), "installed");
  assert.deepStrictEqual(atReload, { wrapperPresent: true, unitPresent: true }, "at reload time the wrapper still exists and the unit is written");
  assert.deepStrictEqual(h.calls.unlinks, [wrapper]);
});
