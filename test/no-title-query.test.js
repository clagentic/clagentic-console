"use strict";
// The console starts no query to title a session, for any vendor: no adapter
// and no bridge exposes or calls a title generator.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var iface = require("../lib/yoke/interface");
var { createClaudeAdapter } = require("../lib/yoke/adapters/claude");
var codexModule = require("../lib/yoke/adapters/codex");
var { createSDKBridge } = require("../lib/sdk-bridge");

test("the adapter interface declares no title generator", function () {
  assert.equal(iface.ADAPTER_OPTIONAL_METHODS.indexOf("generateTitle"), -1);
  assert.equal(iface.ADAPTER_METHODS.indexOf("generateTitle"), -1);
});

test("neither adapter exposes a title generator", function () {
  var claude = createClaudeAdapter({ cwd: os.tmpdir() });
  assert.equal(claude.generateTitle, undefined);
  var codex = codexModule.createCodexAdapter({ cwd: os.tmpdir(), slug: "p" });
  assert.equal(codex.generateTitle, undefined);
  assert.equal(codexModule._test_resolveTitleModel, undefined);
});

test("no module under lib names a title generator", function () {
  var root = path.join(__dirname, "..", "lib");
  var offenders = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      if (!/\.(js|mjs)$/.test(e.name)) return;
      if (/generateTitle|autoGenerateTitle|onAutoTitle/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(root, full));
    });
  })(root);
  assert.deepEqual(offenders, []);
});

test("the bridge exports no title generator", function () {
  assert.equal(typeof createSDKBridge, "function");
  assert.equal(require("../lib/sdk-bridge").generateTitle, undefined);
});
