var test = require("node:test");
var assert = require("node:assert");
var path = require("path");
var { pathToFileURL } = require("url");

function load() {
  return import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "loop-hooks-warning.js")).href);
}

test("a loop with disableAllHooks on shows the warning naming guard hooks", async function () {
  var mod = await load();
  var html = mod.loopHooksWarningHtml({ disableAllHooks: true, permissionMode: "default" });
  assert.match(html, /disableAllHooks/);
  assert.match(html, /PreToolUse guard hooks/);
});

test("a loop with disableAllHooks off, absent or not true shows nothing", async function () {
  var mod = await load();
  assert.strictEqual(mod.loopHooksWarningHtml({ disableAllHooks: false }), "");
  assert.strictEqual(mod.loopHooksWarningHtml({ model: "x" }), "");
  assert.strictEqual(mod.loopHooksWarningHtml({ disableAllHooks: "true" }), "");
  assert.strictEqual(mod.loopHooksWarningHtml(null), "");
  assert.strictEqual(mod.loopHooksWarningHtml(undefined), "");
});
