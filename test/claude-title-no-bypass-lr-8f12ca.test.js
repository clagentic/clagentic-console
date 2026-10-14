/**
 * Title generation must not ask the CLI to skip permissions: the CLI refuses
 * --dangerously-skip-permissions under root, so a bypassPermissions title
 * query failed on every turn there.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { createClaudeAdapter } = require("../lib/yoke/adapters/claude");

test("generateTitle runs without bypassPermissions and still returns the title", async function () {
  var adapter = createClaudeAdapter({ cwd: "/tmp" });
  var seen = null;
  adapter.createQuery = async function (queryOpts) {
    seen = queryOpts;
    var events = [
      { yokeType: "text_delta", text: "Fix the idle reaper" },
      { yokeType: "result" },
    ];
    return {
      pushMessage: function () {},
      close: function () {},
      [Symbol.asyncIterator]: async function* () { for (var e of events) yield e; },
    };
  };

  var title = await adapter.generateTitle(["why was my session reaped"], { cwd: "/tmp" });

  assert.equal(title, "Fix the idle reaper");
  var mode = seen.adapterOptions.CLAUDE.permissionMode;
  assert.notEqual(mode, "bypassPermissions");
  assert.equal(mode, "dontAsk");
  assert.ok(!seen.adapterOptions.CLAUDE.allowDangerouslySkipPermissions);
});
