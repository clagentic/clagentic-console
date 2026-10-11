// Sweep guard: the tables below are keyed by names and ids that arrive from
// outside (a worker, the app-server, an MCP server, a file name, a server
// message). Each must be a prototype-less map, never a plain {} that answers
// for "constructor" or "__proto__". A new assignment of {} to one of them
// fails here; the behaviour is covered where the table can be driven
// (test/hostile-keys-stores.test.js, test/client-supplied-keys.test.js).

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var ROOT = path.resolve(__dirname, "..");

var TABLES = {
  "lib/yoke/adapters/claude-worker.js": ["pendingPermissions", "pendingAskUser", "pendingElicitations", "pendingMcpToolCalls"],
  "lib/yoke/adapters/claude.js": ["pendingRewinds", "pendingSetModel", "promptAborts"],
  "lib/yoke/codex-app-server.js": ["pendingRequests"],
  "lib/mcp-local.js": ["_configCache", "_processes", "_pendingRequests", "_initCallbacks"],
  "lib/project-mcp.js": ["_availableServers", "_proxyServers", "_pendingCalls"],
  "lib/public/modules/filebrowser.js": ["treeData", "gitDiffCache", "fileAtCache", "expandedSet", "tree", "oldSet", "newSet"],
  "lib/public/modules/app-cursors.js": ["remoteCursors", "userColorMap", "remoteSelections"],
  "lib/public/modules/sticky-notes.js": ["updateTimers", "textTimers"],
  "lib/public/modules/team-panel.js": ["_memberStatuses", "_memberActivities"],
  "lib/public/modules/app-messages.js": ["handlers"],
};

Object.keys(TABLES).forEach(function (file) {
  test(file + ": its tables keyed by outside names are prototype-free", function () {
    var source = fs.readFileSync(path.join(ROOT, file), "utf8");
    TABLES[file].forEach(function (name) {
      var plain = new RegExp("\\b" + name + "\\s*=\\s*(?:[^;=\\n]*\\|\\|\\s*)?\\{\\s*\\}");
      assert.equal(plain.test(source), false, name + " is assigned a plain {}");
      var safe = new RegExp("\\b" + name + "\\s*=\\s*(?:[^;=\\n]*\\|\\|\\s*)?Object\\.create\\(null\\)");
      assert.equal(safe.test(source), true, name + " is never made with Object.create(null)");
    });
  });
});
