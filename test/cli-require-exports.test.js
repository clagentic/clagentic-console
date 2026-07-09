// Regression test for lr-56df: bin/cli.js destructured a name
// (generateAuthToken) that had been removed from lib/server.js's exports.
// The import silently resolved to `undefined` and only threw when the
// PIN-hashing call sites were actually invoked (multi-user start with a
// CLI PIN, and the settings-menu "change PIN" flow).
//
// This test guards two things directly tied to the fix:
//   1. bin/cli.js no longer references the removed `generateAuthToken` name
//      (import or call site) and no longer pulls in the whole lib/server
//      dependency tree just to hash a PIN.
//   2. The PIN-hashing helper it now uses (`hashPin`) is genuinely exported
//      by the module bin/cli.js imports it from (lib/users), so this
//      wouldn't have silently regressed the same way.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

var CLI_PATH = path.join(__dirname, "..", "bin", "cli.js");

test("bin/cli.js: does not reference the removed generateAuthToken export", function () {
  var source = fs.readFileSync(CLI_PATH, "utf8");
  assert.ok(
    source.indexOf("generateAuthToken") === -1,
    "bin/cli.js still references generateAuthToken, which lib/server.js no longer exports (lr-56df)"
  );
});

test("bin/cli.js: does not require the full lib/server dependency tree just for PIN hashing", function () {
  var source = fs.readFileSync(CLI_PATH, "utf8");
  assert.ok(
    source.indexOf('require("../lib/server")') === -1,
    "bin/cli.js should not require lib/server — it pulls in the whole server dependency tree with load-time side effects (lr-56df)"
  );
});

test("bin/cli.js: hashPin is imported from lib/users and is a real export of that module", function () {
  var source = fs.readFileSync(CLI_PATH, "utf8");
  assert.match(
    source,
    /require\("\.\.\/lib\/users"\)/,
    "bin/cli.js should import PIN-hashing from ../lib/users"
  );

  var usersMod = require("../lib/users");
  assert.strictEqual(
    typeof usersMod.hashPin,
    "function",
    "lib/users.js must export hashPin as a function"
  );
});

test("bin/cli.js: both PIN call sites use hashPin(pin)", function () {
  var source = fs.readFileSync(CLI_PATH, "utf8");
  var matches = source.match(/hashPin\(cliPin\)|hashPin\(pin\)/g) || [];
  assert.strictEqual(
    matches.length,
    2,
    "expected exactly two hashPin() call sites (multi-user start with CLI PIN, settings-menu change PIN), found " + matches.length
  );
});
