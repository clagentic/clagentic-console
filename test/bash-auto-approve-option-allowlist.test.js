/**
 * The Bash auto-approve accepts only option tokens a command declares, exactly.
 * GNU long options accept unique prefixes, so a denylist of full spellings was
 * bypassed by abbreviations ("tail --fol f", "git diff --outp f").
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { createSDKBridge } = require("../lib/sdk-bridge");
var { isAutoApprovableSegment } = require("../lib/bash-auto-approve");

function makeBridge() {
  var adapter = {
    vendor: "claude",
    createQuery: function () { return Promise.resolve(null); },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
    generateTitle: null, renameSession: null, forkSession: null,
  };
  return createSDKBridge({
    cwd: "/tmp/test-project",
    slug: "test-project",
    sessionManager: {
      sessions: new Map(), currentModel: null, currentPermissionMode: null,
      currentEffort: null, currentBetas: [], modelsByVendor: {},
      availableVendors: [], installedVendors: [], defaultVendor: "claude",
      saveSessionFile: function () {}, broadcastSessionList: function () {},
      getActiveSession: function () { return null; },
      setSlashCommandsForVendor: function () {}, sendAndRecord: function () {},
      sendToSession: function () {},
    },
    send: function () {},
    adapter: adapter,
    adapters: { claude: adapter },
    onProcessingChanged: function () {},
    getConfig: null,
  });
}

var bridge = makeBridge();
function result(command) {
  return bridge.checkToolWhitelist("Bash", { command: command });
}

var prompts = [
  "tail --fol f",
  "tail -f f",
  "ss --kil",
  "ss -K",
  "file --comp -m m",
  "file -C -m m",
  "git diff --outp f",
  "git diff --ext",
  "git diff --textc",
  "git diff --output f",
  "git log --exec-path",
  "rg --pre x y",
  "rg --pr x y",
  "ls --colo",
  "ls --color",
  "git status --porc",
  "git status -z",
  "git log -51",
  "git log -0",
  "git diff -5",
  "git show -5",
  "cat -xyz f",
  "cat -",
  "ls -lz",
  "grep -rn -Z foo .",
];

prompts.forEach(function (cmd) {
  test("option not declared exactly prompts: " + cmd, function () {
    assert.equal(result(cmd), null);
  });
});

var allowed = [
  "git status",
  "git diff",
  "git log --oneline -5",
  "git log -n 5",
  "git diff --stat",
  "git diff main~1 main..feat",
  "git status --porcelain",
  "ls -la src/",
  "cat README.md | grep foo",
  "ls && pwd",
  "head -5 f",
];

allowed.forEach(function (cmd) {
  test("declared options still auto-approve: " + cmd, function () {
    var r = result(cmd);
    assert.ok(r && r.behavior === "allow");
  });
});

test("an entry that declares no options accepts none", function () {
  assert.equal(isAutoApprovableSegment(["pwd"]), true);
  assert.equal(isAutoApprovableSegment(["pwd", "-P"]), false);
  assert.equal(isAutoApprovableSegment(["constructor"]), false);
});
