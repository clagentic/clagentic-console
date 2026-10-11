"use strict";
// A project's handlers reach the daemon through callbacks (opts.onSomething)
// that lib/daemon.js gives lib/server.js, and server.js must hand on to each
// project it creates. A callback the daemon defines and a project module reads
// but server.js never forwards fails without a sound: the Settings page that
// uses it is answered "Not supported" or not at all, as saved environment
// variables were. This reads the sources and requires every callback a project
// module reads to be forwarded.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var LIB = path.join(__dirname, "..", "lib");

// The modules that are given the project context's own opts.
var PROJECT_MODULES = ["project.js", "project-sessions.js", "project-filesystem.js", "project-connection.js", "project-user-message.js"];

function read(name) {
  return fs.readFileSync(path.join(LIB, name), "utf8");
}

function callbacksRead(source) {
  var names = new Set();
  var re = /\bopts\.(on[A-Z][A-Za-z]*)\b/g;
  var m;
  while ((m = re.exec(source)) !== null) names.add(m[1]);
  return names;
}

// The object literal server.js builds each project context from.
function projectContextLiteral(serverSource) {
  var start = serverSource.indexOf("var ctx = createProjectContext({");
  var end = serverSource.indexOf("projects.set(slug, ctx);", start);
  assert.ok(start !== -1 && end !== -1, "server.js builds project contexts in addProject");
  return serverSource.slice(start, end);
}

test("every callback a project module reads from its opts is forwarded by server.js", function () {
  var literal = projectContextLiteral(read("server.js"));
  var wanted = new Set();
  PROJECT_MODULES.forEach(function (file) {
    callbacksRead(read(file)).forEach(function (name) { wanted.add(name); });
  });
  assert.ok(wanted.size > 30, "the scan found the callbacks (" + wanted.size + ")");

  var missing = Array.from(wanted).filter(function (name) {
    return !new RegExp("\\b" + name + "\\s*:").test(literal);
  });
  assert.deepEqual(missing, [], "server.js must pass these to createProjectContext: " + missing.join(", "));
});

test("every callback the daemon defines for the environment settings is read by server.js", function () {
  var serverSource = read("server.js");
  ["onGetProjectEnv", "onSetProjectEnv", "onGetSharedEnv", "onSetSharedEnv",
    "onSetAutoContinue", "onSetTokensPerMbHeadroom", "onRestartForBuildUpdate"].forEach(function (name) {
    assert.match(serverSource, new RegExp("opts\\." + name + "\\b"), "server.js reads opts." + name);
  });
});
