// projects-dir: where new projects go. A legacy projects directory holds users'
// git repos referenced by absolute path from daemon.json, worktrees and session
// history, so it is used in place: never moved, renamed, copied or linked.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var crypto = require("crypto");
var projectsDir = require("../lib/projects-dir");
var resolveProjectsDir = projectsDir.resolveProjectsDir;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "console-projects-dir-"));
}

// Everything observable about a tree: path, type, size, mtime, content hash.
function snapshot(root) {
  var out = {};
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var p = path.join(dir, e.name);
      var st = fs.lstatSync(p);
      var rel = path.relative(root, p);
      if (e.isDirectory()) {
        out[rel] = { type: "dir", mtimeMs: st.mtimeMs, mode: st.mode };
        walk(p);
      } else if (e.isSymbolicLink()) {
        out[rel] = { type: "link", target: fs.readlinkSync(p) };
      } else {
        out[rel] = { type: "file", size: st.size, mtimeMs: st.mtimeMs, mode: st.mode,
          sha: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") };
      }
    });
  })(root);
  return out;
}

// fs-like whose every method other than statSync fails the test when touched.
function readOnlyFs(existingDirs) {
  var calls = [];
  var stub = new Proxy({}, {
    get: function (_t, prop) {
      if (prop === "statSync") {
        return function (p) {
          calls.push("statSync");
          if (existingDirs.indexOf(p) === -1) { var e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
          return { isDirectory: function () { return true; } };
        };
      }
      return function () { calls.push(String(prop)); throw new Error("projects-dir touched fs." + String(prop)); };
    },
  });
  return { fs: stub, calls: calls };
}

function populateLegacy(home, name) {
  var legacy = path.join(home, name);
  fs.mkdirSync(path.join(legacy, "app", ".git"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "app", "README.md"), "# app\n");
  fs.writeFileSync(path.join(legacy, "app", ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.symlinkSync("app", path.join(legacy, "app-link"));
  return legacy;
}

test("legacy ~/clagentic-projects present: used in place, filesystem byte-identical, no mutating fs call", function () {
  var home = tmp();
  var legacy = populateLegacy(home, "clagentic-projects");
  var before = snapshot(home);

  var real = resolveProjectsDir({ config: {}, realHome: home });
  assert.strictEqual(real.dir, legacy);
  assert.strictEqual(real.source, "legacy");
  assert.strictEqual(real.legacy, true);
  assert.deepStrictEqual(snapshot(home), before);
  assert.ok(!fs.existsSync(path.join(home, "clagentic-console-projects")), "new default must not be created");

  var spy = readOnlyFs([legacy]);
  var viaSpy = resolveProjectsDir({ config: {}, realHome: home, fs: spy.fs });
  assert.strictEqual(viaSpy.dir, legacy);
  spy.calls.forEach(function (c) { assert.strictEqual(c, "statSync"); });
});

test("legacy ~/clay-projects present alone: used in place (the old rename migration is gone)", function () {
  var home = tmp();
  var legacy = populateLegacy(home, "clay-projects");
  var before = snapshot(home);

  var r = resolveProjectsDir({ config: {}, realHome: home });
  assert.strictEqual(r.dir, legacy);
  assert.strictEqual(r.legacy, true);
  assert.deepStrictEqual(snapshot(home), before);
  assert.ok(!fs.existsSync(path.join(home, "clagentic-projects")), "must not be renamed to the bare-brand name");
});

test("both legacy dirs present: ~/clagentic-projects is preferred, neither is touched", function () {
  var home = tmp();
  var a = populateLegacy(home, "clagentic-projects");
  populateLegacy(home, "clay-projects");
  var before = snapshot(home);
  assert.strictEqual(resolveProjectsDir({ config: {}, realHome: home }).dir, a);
  assert.deepStrictEqual(snapshot(home), before);
});

test("no legacy dir: console-scoped default, not created by the resolver", function () {
  var home = tmp();
  var r = resolveProjectsDir({ config: {}, realHome: home });
  assert.strictEqual(r.dir, path.join(home, "clagentic-console-projects"));
  assert.strictEqual(r.source, "default");
  assert.strictEqual(r.legacy, false);
  assert.deepStrictEqual(fs.readdirSync(home), []);
});

test("projectsDir in config wins over a legacy dir and the default", function () {
  var home = tmp();
  populateLegacy(home, "clagentic-projects");
  fs.mkdirSync(path.join(home, "clagentic-console-projects"));
  var custom = path.join(home, "elsewhere");
  var r = resolveProjectsDir({ config: { projectsDir: custom }, realHome: home });
  assert.strictEqual(r.dir, custom);
  assert.strictEqual(r.source, "config");
  assert.strictEqual(r.legacy, false);
});

test("legacy and console-scoped default both present: the console-scoped default wins, legacy untouched", function () {
  // Console only creates its own default when no legacy dir existed, so its
  // presence means console already chose it. A legacy-named dir that appears
  // later (the bare brand is shared) must not redirect new projects.
  var home = tmp();
  var legacy = populateLegacy(home, "clagentic-projects");
  var chosen = path.join(home, "clagentic-console-projects");
  fs.mkdirSync(chosen);
  var before = snapshot(home);

  var r = resolveProjectsDir({ config: {}, realHome: home });
  assert.strictEqual(r.dir, chosen);
  assert.strictEqual(r.legacy, false);
  assert.deepStrictEqual(snapshot(home), before);
  assert.ok(fs.existsSync(legacy));
});

test("a regular file named like a legacy dir is not a directory and is ignored", function () {
  var home = tmp();
  fs.writeFileSync(path.join(home, "clagentic-projects"), "not a dir");
  assert.strictEqual(resolveProjectsDir({ config: {}, realHome: home }).dir, path.join(home, "clagentic-console-projects"));
});

test("os-users: legacy /var/clagentic/projects used in place when it exists", function () {
  var spy = readOnlyFs([projectsDir.OS_USERS_LEGACY_DIR]);
  var r = resolveProjectsDir({ config: { osUsers: true }, realHome: "/home/x", fs: spy.fs });
  assert.strictEqual(r.dir, "/var/clagentic/projects");
  assert.strictEqual(r.legacy, true);
  spy.calls.forEach(function (c) { assert.strictEqual(c, "statSync"); });
});

test("os-users: no legacy dir -> console-scoped system path", function () {
  var spy = readOnlyFs([]);
  var r = resolveProjectsDir({ config: { osUsers: true }, realHome: "/home/x", fs: spy.fs });
  assert.strictEqual(r.dir, "/var/lib/clagentic-console/projects");
  assert.strictEqual(r.legacy, false);
});

test("os-users: console-scoped dir and legacy both present -> console-scoped wins", function () {
  var spy = readOnlyFs([projectsDir.OS_USERS_LEGACY_DIR, projectsDir.OS_USERS_DEFAULT_DIR]);
  var r = resolveProjectsDir({ config: { osUsers: true }, realHome: "/home/x", fs: spy.fs });
  assert.strictEqual(r.dir, projectsDir.OS_USERS_DEFAULT_DIR);
});

test("os-users keeps ignoring config.projectsDir, as before", function () {
  var spy = readOnlyFs([]);
  var r = resolveProjectsDir({ config: { osUsers: true, projectsDir: "/srv/mine" }, realHome: "/home/x", fs: spy.fs });
  assert.strictEqual(r.dir, "/var/lib/clagentic-console/projects");
});

test("legacyNotice names the legacy dir and projectsDir; null otherwise", function () {
  var msg = projectsDir.legacyNotice({ dir: "/h/clagentic-projects", legacy: true }, "/h/.clagentic/console/daemon.json");
  assert.match(msg, /legacy location/);
  assert.match(msg, /\/h\/clagentic-projects/);
  assert.match(msg, /projectsDir/);
  assert.strictEqual(projectsDir.legacyNotice({ dir: "/x", legacy: false }, "f"), null);
});

test("daemon.js has no inline projects-dir logic and no rename of project dirs", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  assert.doesNotMatch(src, /clagentic-projects|clay-projects|\/var\/clagentic/);
  assert.doesNotMatch(src, /renameSync\(oldDir/);
  assert.strictEqual((src.match(/resolveProjectsDir\(/g) || []).length >= 3, true);
});

test("os-users ensureProjectsDir creates the resolved dir and leaves an existing legacy dir's contents alone", function () {
  var osUsers = require("../lib/os-users");
  var dir = path.join(tmp(), "projects");
  osUsers.ensureProjectsDir(dir);
  assert.ok(fs.statSync(dir).isDirectory());

  var legacy = populateLegacy(tmp(), "clagentic-projects");
  var before = snapshot(legacy);
  osUsers.ensureProjectsDir(legacy);
  assert.deepStrictEqual(snapshot(legacy), before);
});
