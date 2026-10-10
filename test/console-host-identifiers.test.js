// Host identifiers console owns are product-scoped: the recent-projects file,
// the Windows pipe, the service-worker cache.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var vm = require("vm");
var { spawnSync } = require("child_process");
var { migrateRc } = require("../lib/rc-migrate");

var REPO = path.join(__dirname, "..");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "console-host-ids-"));
}

// --- recent-projects file ---

test("migrateRc copies the old home dotfile and leaves the original byte-identical", function () {
  var home = tmp();
  var oldRc = path.join(home, ".clagentic-rc");
  var body = JSON.stringify({ recentProjects: [{ path: "/p", slug: "p" }] }, null, 2) + "\n";
  fs.writeFileSync(oldRc, body);
  var before = fs.statSync(oldRc);
  var rcPath = path.join(home, ".clagentic", "console", "recent-projects.json");

  var res = migrateRc({ rcPath: rcPath, legacyPaths: [oldRc], log: function () {} });
  assert.strictEqual(res.copied, true);
  assert.strictEqual(fs.readFileSync(rcPath, "utf8"), body);
  assert.strictEqual(fs.readFileSync(oldRc, "utf8"), body, "original must be untouched");
  assert.strictEqual(fs.statSync(oldRc).mtimeMs, before.mtimeMs);
});

test("migrateRc never deletes, renames or overwrites", function () {
  var home = tmp();
  var oldRc = path.join(home, ".clagentic-rc");
  fs.writeFileSync(oldRc, "OLD");
  var rcPath = path.join(home, "console", "recent-projects.json");
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  fs.writeFileSync(rcPath, "NEW");

  assert.strictEqual(migrateRc({ rcPath: rcPath, legacyPaths: [oldRc], log: function () {} }).copied, false);
  assert.strictEqual(fs.readFileSync(rcPath, "utf8"), "NEW");
  assert.strictEqual(fs.readFileSync(oldRc, "utf8"), "OLD");

  var calls = [];
  var spyFs = {
    existsSync: function (p) { return p === oldRc; },
    mkdirSync: function () {},
    copyFileSync: function (a, b) { calls.push(["copy", a, b]); },
    unlinkSync: function () { calls.push(["unlink"]); },
    renameSync: function () { calls.push(["rename"]); },
    rmSync: function () { calls.push(["rm"]); },
  };
  migrateRc({ rcPath: "/dest/rc.json", legacyPaths: [oldRc], fs: spyFs, log: function () {} });
  assert.deepStrictEqual(calls, [["copy", oldRc, "/dest/rc.json"]]);
});

test("migrateRc prefers the newer old name and falls back to the oldest", function () {
  var home = tmp();
  var a = path.join(home, ".clagentic-rc");
  var b = path.join(home, ".clayrc");
  fs.writeFileSync(b, "B");
  var rcPath = path.join(home, "c", "rc.json");
  migrateRc({ rcPath: rcPath, legacyPaths: [a, b], log: function () {} });
  assert.strictEqual(fs.readFileSync(rcPath, "utf8"), "B");

  var rcPath2 = path.join(home, "c2", "rc.json");
  fs.writeFileSync(a, "A");
  migrateRc({ rcPath: rcPath2, legacyPaths: [a, b], log: function () {} });
  assert.strictEqual(fs.readFileSync(rcPath2, "utf8"), "A");
});

test("config.js keeps recent projects under the console data dir, not in the home directory", function () {
  var home = tmp();
  fs.writeFileSync(path.join(home, ".clagentic-rc"), JSON.stringify({ recentProjects: [{ path: "/existing", slug: "existing" }] }));
  var consoleHome = path.join(home, "chome");
  var script =
    "var c=require(" + JSON.stringify(path.join(REPO, "lib", "config.js")) + ");" +
    "var before=c.loadClayrc().recentProjects.map(function(p){return p.path});" +
    "c.syncClayrc([{path:'/new',slug:'new'}]);" +
    "process.stdout.write(JSON.stringify({rc:c.RC_PATH,before:before,after:c.loadClayrc().recentProjects.map(function(p){return p.path})}));";
  var res = spawnSync(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH, HOME: home, CLAGENTIC_CONSOLE_HOME: consoleHome },
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0, res.stderr);
  var out = JSON.parse(res.stdout.slice(res.stdout.lastIndexOf("{")));
  assert.strictEqual(out.rc, path.join(consoleHome, "console", "recent-projects.json"));
  assert.deepStrictEqual(out.before, ["/existing"], "existing entries carried over by the copy");
  assert.deepStrictEqual(out.after.sort(), ["/existing", "/new"]);
  // The old dotfile is not written to or removed.
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, ".clagentic-rc"), "utf8")).recentProjects.map(function (p) { return p.path; }), ["/existing"]);
});

// --- Windows pipe ---

test("Windows named pipe is scoped to the product, with a distinct dev pipe", function () {
  var config = require("../lib/config");
  assert.strictEqual(config.windowsPipePath(false), "\\\\.\\pipe\\clagentic-console-daemon");
  assert.strictEqual(config.windowsPipePath(true), "\\\\.\\pipe\\clagentic-console-daemon-dev");
});

// --- service-worker cache ---

function loadSw(cacheNames) {
  var src = fs.readFileSync(path.join(REPO, "lib", "public", "sw.js"), "utf8").replace("__VERSION__", "9.9.9");
  var listeners = {};
  var deleted = [];
  var self = {
    addEventListener: function (type, fn) { listeners[type] = fn; },
    skipWaiting: function () { return Promise.resolve(); },
    clients: { claim: function () { return Promise.resolve(); }, matchAll: function () { return Promise.resolve([]); } },
    location: { origin: "http://localhost" },
  };
  var caches = {
    keys: function () { return Promise.resolve(cacheNames.slice()); },
    delete: function (n) { deleted.push(n); return Promise.resolve(true); },
    open: function () { return Promise.resolve({ addAll: function () { return Promise.resolve(); } }); },
  };
  var ctx = vm.createContext({ self: self, caches: caches, URL: URL, Promise: Promise, console: console });
  vm.runInContext(src, ctx);
  return { ctx: ctx, listeners: listeners, deleted: deleted };
}

test("service-worker cache is console-scoped and versioned", function () {
  var sw = loadSw([]);
  assert.strictEqual(vm.runInContext("CACHE_NAME", sw.ctx), "clagentic-console-offline-v9.9.9");
});

test("activating deletes the old-named caches and keeps the current one", async function () {
  var sw = loadSw(["clagentic-offline-v1.0.0", "clagentic-offline-v9.9.9", "clagentic-console-offline-v9.9.9"]);
  var waited;
  sw.listeners.activate({ waitUntil: function (p) { waited = p; } });
  await waited;
  assert.deepStrictEqual(sw.deleted.sort(), ["clagentic-offline-v1.0.0", "clagentic-offline-v9.9.9"]);
});

test("server.js stamps the version into the console-scoped cache name sw.js ships with", function () {
  var serverSrc = fs.readFileSync(path.join(REPO, "lib", "server.js"), "utf8");
  var m = serverSrc.match(/\/(var CACHE_NAME = "clagentic-console-offline-\[\^"\]\*")\//);
  assert.ok(m, "server.js must rewrite the console-scoped CACHE_NAME");
  var re = new RegExp(m[1]);
  var swSrc = fs.readFileSync(path.join(REPO, "lib", "public", "sw.js"), "utf8");
  var stamped = swSrc.replace(re, 'var CACHE_NAME = "clagentic-console-offline-v1.2.3"');
  assert.match(stamped, /var CACHE_NAME = "clagentic-console-offline-v1\.2\.3"/);
  assert.doesNotMatch(stamped, /__VERSION__/);
});
