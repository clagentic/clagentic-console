// Regression test for lr-56df: bin/cli.js destructured a name
// (generateAuthToken) that had been removed from lib/server.js's exports.
// The import silently resolved to `undefined` and only threw when the
// PIN-hashing call sites were actually invoked (multi-user start with a
// CLI PIN, and the settings-menu "change PIN" flow).
//
// lr-4e49 Part 1 split bin/cli.js into lib/cli/*.js modules. The PIN-hashing
// call sites that used to live directly in bin/cli.js now live in
// lib/cli/daemon-launch.js (multi-user start with CLI PIN) and
// lib/cli/menus.js (settings-menu "change PIN" flow) — this test follows
// them there so the same guarantees still hold:
//   1. None of the CLI-split files reference the removed `generateAuthToken`
//      name (import or call site), and none pulls in the whole lib/server
//      dependency tree just to hash a PIN.
//   2. The PIN-hashing helper used (`hashPin`) is genuinely exported by the
//      module it's imported from (lib/users), so this wouldn't have
//      silently regressed the same way.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

var CLI_PATH = path.join(__dirname, "..", "bin", "cli.js");
// Files that resulted from splitting bin/cli.js (lr-4e49 Part 1) and may
// carry lib/users / PIN-hashing responsibilities that used to live directly
// in bin/cli.js.
var CLI_SPLIT_PATHS = [
  CLI_PATH,
  path.join(__dirname, "..", "lib", "cli", "daemon-launch.js"),
  path.join(__dirname, "..", "lib", "cli", "menus.js"),
  path.join(__dirname, "..", "lib", "cli", "tui.js"),
  path.join(__dirname, "..", "lib", "cli", "net-detect.js"),
  path.join(__dirname, "..", "lib", "cli", "ipc-subcommands.js"),
];

function readAllCliSplitSources() {
  return CLI_SPLIT_PATHS.map(function (p) {
    return { path: p, source: fs.readFileSync(p, "utf8") };
  });
}

test("bin/cli.js + lib/cli/*: does not reference the removed generateAuthToken export", function () {
  readAllCliSplitSources().forEach(function (f) {
    assert.ok(
      f.source.indexOf("generateAuthToken") === -1,
      f.path + " still references generateAuthToken, which lib/server.js no longer exports (lr-56df)"
    );
  });
});

test("bin/cli.js + lib/cli/*: does not require the full lib/server dependency tree just for PIN hashing", function () {
  readAllCliSplitSources().forEach(function (f) {
    assert.ok(
      f.source.indexOf('require("../lib/server")') === -1 && f.source.indexOf('require("../../lib/server")') === -1,
      f.path + " should not require lib/server — it pulls in the whole server dependency tree with load-time side effects (lr-56df)"
    );
  });
});

test("hashPin is imported from lib/users somewhere in the CLI split and is a real export of that module", function () {
  var anyRequiresUsers = readAllCliSplitSources().some(function (f) {
    return /require\("(\.\.\/)+(lib\/)?users"\)/.test(f.source);
  });
  assert.ok(
    anyRequiresUsers,
    "expected at least one of the CLI-split files to import PIN-hashing from lib/users"
  );

  var usersMod = require("../lib/users");
  assert.strictEqual(
    typeof usersMod.hashPin,
    "function",
    "lib/users.js must export hashPin as a function"
  );
});

test("bin/cli.js + lib/cli/*: both PIN call sites use hashPin(pin)", function () {
  var totalMatches = 0;
  readAllCliSplitSources().forEach(function (f) {
    var matches = f.source.match(/hashPin\(cliPin\)|hashPin\(pin\)/g) || [];
    totalMatches += matches.length;
  });
  assert.strictEqual(
    totalMatches,
    2,
    "expected exactly two hashPin() call sites across the CLI split (multi-user start with CLI PIN in lib/cli/daemon-launch.js, settings-menu change PIN in lib/cli/menus.js), found " + totalMatches
  );
});

// Regression test for lr-e41f: bin/cli.js also destructured enableMultiUser,
// disableMultiUser, and isMultiUser from lib/users — none of the three were
// ever exported by that module (removed in lr-ec2d when single-user mode was
// consolidated into an always-on multi-user model). Same failure shape as
// lr-56df: the destructure silently resolved to undefined and only threw a
// TypeError when a caller actually invoked one of them (daemon startup,
// settings-menu multi-user toggle).
test("bin/cli.js + lib/cli/*: does not destructure or invoke enableMultiUser/disableMultiUser/isMultiUser from lib/users", function () {
  readAllCliSplitSources().forEach(function (f) {
    ["enableMultiUser", "disableMultiUser", "isMultiUser"].forEach(function (name) {
      assert.ok(
        f.source.indexOf(name) === -1,
        f.path + " still references " + name + ", which lib/users.js does not export (lr-e41f)"
      );
    });
  });
});

test("bin/cli.js + lib/cli/*: no undefined export from lib/users is destructured or invoked (generic guard)", function () {
  var usersMod = require("../lib/users");

  var filesRequiringUsers = readAllCliSplitSources().filter(function (f) {
    return /require\("(\.\.\/)+(lib\/)?users"\)/.test(f.source);
  });
  assert.ok(filesRequiringUsers.length > 0, "expected at least one CLI-split file to require lib/users");

  // For each file that destructures lib/users, verify every named binding it
  // pulls in is a real, defined export of lib/users.js. This generalizes the
  // lr-56df / lr-e41f fix so a future lib/users.js export removal fails a
  // test instead of shipping a live TypeError, regardless of which CLI-split
  // file does the requiring.
  filesRequiringUsers.forEach(function (f) {
    var destructureLine = f.source.split("\n").filter(function (line) {
      return /require\("(\.\.\/)+(lib\/)?users"\)/.test(line);
    })[0];
    assert.ok(destructureLine, "expected a destructuring require of lib/users in " + f.path);

    var namesMatch = destructureLine.match(/\{([^}]+)\}/);
    assert.ok(namesMatch, "expected a destructuring pattern for the lib/users require in " + f.path);

    var names = namesMatch[1].split(",").map(function (n) { return n.trim(); }).filter(Boolean);
    assert.ok(names.length > 0, "expected at least one destructured name from lib/users in " + f.path);

    names.forEach(function (name) {
      assert.notStrictEqual(
        usersMod[name],
        undefined,
        f.path + " destructures '" + name + "' from lib/users, but lib/users.js does not export it"
      );
    });
  });
});
