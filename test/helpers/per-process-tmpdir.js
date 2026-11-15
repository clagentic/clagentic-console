"use strict";

// Preload for every `node --test` process (node --require): gives the process
// its own temp root and removes it on exit. Tests build their scratch dirs with
// fs.mkdtempSync(path.join(os.tmpdir(), ...)); os.tmpdir() reads TMPDIR on each
// call and child processes inherit the environment, so every such dir, in this
// process and in the processes it spawns, lands inside the one directory this
// file removes. No test file needs its own cleanup for the dirs it leaves.
//
// Limit: a process killed by a signal never runs its exit handlers, so its dir
// stays; it is still one dir under the root, not one per test.

var fs = require("fs");
var os = require("os");
var path = require("path");

// A Unix socket path holds about 107 bytes, and tests bind sockets at
// <tmp root>/<test dir ~30>/<name ~20>.sock. The per-process dir adds one level,
// so an inherited root longer than this would push those paths over the limit.
// Such a root is replaced by the platform default temp dir for this process.
var MAX_INHERITED_ROOT = 40;

var base = os.tmpdir();
if (base.length > MAX_INHERITED_ROOT) {
  delete process.env.TMPDIR;
  delete process.env.TMP;
  delete process.env.TEMP;
  base = os.tmpdir();
}

var root = fs.mkdtempSync(path.join(base, "n-"));
// mkdtemp makes the dir 0700. Tests that run a child as another OS user chmod
// their own sandbox open and need to traverse into it, as they could under the
// shared tmp root. The dir holds only throwaway test fixtures and is removed on
// exit, so r-x for others exposes nothing beyond what the tests' own modes allow.
fs.chmodSync(root, 0o755);
process.env.TMPDIR = root;
process.env.TMP = root;
process.env.TEMP = root;

process.on("exit", function () {
  // A test may call process.emit("exit") to exercise its own exit handler; only
  // the real exit (process._exiting) may remove the root the rest of the run uses.
  if (!process._exiting) return;
  // maxRetries covers a spawned child that is still writing as the process ends.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
