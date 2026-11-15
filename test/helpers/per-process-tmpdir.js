"use strict";

// Preload for every `node --test` process (node --require): gives the process
// its own temp root and removes it on exit. Tests build their scratch dirs with
// fs.mkdtempSync(path.join(os.tmpdir(), ...)); os.tmpdir() reads TMPDIR on each
// call and child processes inherit the environment, so every such dir, in this
// process and in the processes it spawns, lands inside the one directory this
// file removes. No test file needs its own cleanup for the dirs it leaves.
//
// Limit: a process killed by a signal never runs its exit handlers, so its dir
// stays; it is still one dir under the inherited root, not one per test.

var fs = require("fs");
var os = require("os");
var path = require("path");

var root = fs.mkdtempSync(path.join(os.tmpdir(), "node-test-"));
process.env.TMPDIR = root;
process.env.TMP = root;
process.env.TEMP = root;

process.on("exit", function () {
  // maxRetries covers a spawned child that is still writing as the process ends.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
