// A running daemon serves the client files of the build it loaded, not of the
// build an install has since put on disk.
//
// The server is loaded from a private copy of lib/, started, and then every
// file under that copy's lib/public and lib/themes is replaced, as an npm
// install without a restart would do. Each static root and themed route is
// then requested: the bytes must be the ones served before the swap.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var http = require("http");
var { removeTempHome } = require("./helpers/remove-temp-home");

var REPO = path.resolve(__dirname, "..");
var SWAPPED = "SWAPPED-BUILD";

// Every row is one route the server answers from client assets, with the file
// under lib/ it is built from.
var ROUTES = [
  { url: "/index.html", root: "lib/public", ct: /text\/html/ },
  { url: "/p/pinned/", root: "project route: index.html", ct: /text\/html/ },
  { url: "/p/pinned/app.js", root: "project route: lib/public", ct: /javascript/ },
  { url: "/p/pinned/theme-core.js", root: "project route: themed", ct: /javascript/ },
  { url: "/p/pinned/sw.js", root: "project route: service worker", ct: /javascript/ },
  { url: "/app.js", root: "lib/public", ct: /javascript/ },
  { url: "/style.css", root: "lib/public", ct: /text\/css/ },
  { url: "/css/base.css", root: "lib/public subdirectory", ct: /text\/css/ },
  { url: "/modules/theme.js", root: "lib/public/modules", ct: /javascript/ },
  { url: "/modules/diagnostics.js", root: "lib/public/modules: restart-to-update offer", ct: /javascript/, body: /applyBuildOffer/ },
  { url: "/modules/prompt-kinds/own-key.js", root: "lib/public/modules subdirectory", ct: /javascript/ },
  { url: "/emoji-data.json", root: "lib/public (json)", ct: /json/ },
  { url: "/icon-192.png", root: "lib/public (image)", ct: /image\/png/ },
  { url: "/icon-mono.svg", root: "lib/public (svg)", ct: /image\/svg/ },
  { url: "/theme-core.js", root: "themed: theme-core.js + lib/themes", ct: /javascript/ },
  { url: "/theme-seed.css", root: "themed: lib/themes", ct: /text\/css/ },
  { url: "/manifest.json", root: "themed: manifest.json", ct: /json/ },
  { url: "/sw.js", root: "service worker", ct: /javascript/ },
  { url: "/api/themes", root: "lib/themes (bundled list)", ct: /json/ },
];

function get(port, urlPath) {
  return new Promise(function (resolve, reject) {
    var req = http.get({ hostname: "127.0.0.1", port: port, path: urlPath }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, function () { req.destroy(new Error("timeout " + urlPath)); });
  });
}

function walkFiles(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else out.push(full);
  });
  return out;
}

// The install a later `npm install` leaves behind: every client file and theme
// carries different content, and a file the loaded build never had is added.
function swapInstall(libDir) {
  walkFiles(path.join(libDir, "public"), []).forEach(function (file) {
    fs.writeFileSync(file, file.endsWith(".json") ? '{"swapped":true}' : "/* " + SWAPPED + " */ throw new Error('swapped');");
  });
  walkFiles(path.join(libDir, "themes"), []).forEach(function (file) {
    fs.writeFileSync(file, '{"name":"' + SWAPPED + '"}');
  });
  fs.writeFileSync(path.join(libDir, "public", "added-by-install.js"), SWAPPED);
}

async function startFromCopy(t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-pinned-"));
  var home = path.join(root, "home");
  fs.mkdirSync(path.join(home, "userhome", ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "console"), { recursive: true });
  var libCopy = path.join(root, "install", "lib");
  fs.mkdirSync(path.dirname(libCopy), { recursive: true });
  fs.cpSync(path.join(REPO, "lib"), libCopy, { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "install", "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "install", "node_modules"), "dir");

  process.env.CLAGENTIC_CONSOLE_HOME = home;
  process.env.HOME = path.join(home, "userhome");
  var relay = require(path.join(libCopy, "server.js")).createServer({ port: 0 });
  await new Promise(function (resolve) { relay.server.listen(0, "127.0.0.1", resolve); });
  var projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir);
  relay.addProject(projectDir, "pinned", "pinned", null, null, null);

  t.after(async function () {
    try { await relay.destroyAll(); } catch (e) { t.diagnostic("destroyAll: " + e.message); }
    await new Promise(function (resolve) { relay.server.close(function () { resolve(); }); });
    if (typeof relay.server.closeAllConnections === "function") relay.server.closeAllConnections();
    await removeTempHome(root);
  });

  return { port: relay.server.address().port, libCopy: libCopy };
}

test("client files: a swapped install is never served; the loaded build's files are", async function (t) {
  var s = await startFromCopy(t);

  // Same-build behaviour: what is served before the swap is the install's own
  // content, with the headers the server has always set.
  var before = {};
  for (var i = 0; i < ROUTES.length; i++) {
    var r = ROUTES[i];
    var res = await get(s.port, r.url);
    assert.equal(res.status, 200, r.url + " served before the swap");
    assert.match(res.headers["content-type"], r.ct, r.url + " content type");
    if (r.body) assert.match(res.body.toString("utf8"), r.body, r.url + " body");
    before[r.url] = res;
  }
  var onDisk = fs.readFileSync(path.join(s.libCopy, "public", "app.js"));
  assert.ok(before["/app.js"].body.equals(onDisk), "same build: app.js is the file on disk");
  assert.equal(before["/app.js"].headers["cache-control"], "no-cache");
  assert.equal(before["/icon-192.png"].headers["cache-control"], "public, max-age=86400, immutable");
  assert.equal(before["/sw.js"].headers["service-worker-allowed"], "/");
  assert.match(before["/theme-core.js"].body.toString("utf8"), /ClagenticThemeCore\.builtin = /);

  swapInstall(s.libCopy);

  for (var j = 0; j < ROUTES.length; j++) {
    var row = ROUTES[j];
    var after = await get(s.port, row.url);
    assert.equal(after.status, 200, row.url + " (" + row.root + ") still served");
    assert.ok(!after.body.toString("utf8").includes(SWAPPED), row.url + " (" + row.root + ") served the swapped install");
    assert.ok(after.body.equals(before[row.url].body), row.url + " (" + row.root + ") changed after the swap");
    assert.equal(after.headers["cache-control"], before[row.url].headers["cache-control"], row.url + " cache-control");
    assert.equal(after.headers["content-type"], before[row.url].headers["content-type"], row.url + " content-type");
  }

  var added = await get(s.port, "/added-by-install.js");
  assert.equal(added.status, 404, "a file only the swapped install has is not served");
});

// Each row breaks one read in a private copy of lib/ and loads the module the
// daemon loads at startup; the load must throw and name the path.
var CAPTURE_FAILURES = [
  { name: "a client file that cannot be inspected",
    module: "client-files.js",
    break: function (lib) { fs.symlinkSync(path.join(lib, "no-such-target"), path.join(lib, "public", "dangling.js")); },
    named: function (lib) { return path.join(lib, "public", "dangling.js"); } },
  { name: "a bundled theme is not a readable palette",
    module: "theme-seed.js",
    break: function (lib) { fs.writeFileSync(path.join(lib, "themes", "clagentic-dark.json"), "{}"); },
    named: function (lib) { return path.join(lib, "themes", "clagentic-dark.json"); } },
];

CAPTURE_FAILURES.forEach(function (row) {
  test("client files: startup fails and names the path when " + row.name, function (t) {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-capture-"));
    t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
    var lib = path.join(root, "lib");
    fs.cpSync(path.join(REPO, "lib"), lib, { recursive: true });
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "dir");
    row.break(lib);
    assert.throws(function () { require(path.join(lib, row.module)); }, function (err) {
      assert.match(err.message, /^Clagentic: Console cannot start: /);
      assert.ok(err.message.includes(row.named(lib)), "message names " + row.named(lib) + ": " + err.message);
      return true;
    });
  });
});

test("client files: the pinned set holds the whole tree and reports its size", function () {
  var files = require("../lib/client-files");
  var onDisk = walkFiles(path.join(REPO, "lib", "public"), []);
  assert.equal(files.publicFiles.count, onDisk.length);
  var total = onDisk.reduce(function (sum, f) { return sum + fs.statSync(f).size; }, 0);
  assert.equal(files.publicFiles.bytes, total);
  assert.ok(files.publicFiles.bytes > 0);
});
