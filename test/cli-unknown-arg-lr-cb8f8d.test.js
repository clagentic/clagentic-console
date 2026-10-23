// An unknown CLI word or flag must fail with a usage error before any daemon
// action runs. Unit tests cover the validator; process tests spawn the real
// CLI with an isolated home and no daemon, so any IPC attempt would show up
// as a different exit code or output.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var childProcess = require("child_process");

var { findUnrecognisedArg } = require("../lib/cli/arg-validation");

var CLI = path.join(__dirname, "..", "bin", "cli.js");

function runCli(args) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "cb8f8d-home-"));
  try {
    return childProcess.spawnSync(process.execPath, [CLI].concat(args), {
      encoding: "utf8",
      timeout: 15000,
      cwd: home,
      env: Object.assign({}, process.env, { CLAGENTIC_CONSOLE_HOME: home }),
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- validator ---

test("findUnrecognisedArg: unknown leading word is reported", function () {
  assert.strictEqual(findUnrecognisedArg(["bogus", "--shutdown"]), "bogus");
});

test("findUnrecognisedArg: stray trailing word is reported", function () {
  assert.strictEqual(findUnrecognisedArg(["--shutdown", "bogus"]), "bogus");
});

test("findUnrecognisedArg: unknown flag is reported", function () {
  assert.strictEqual(findUnrecognisedArg(["--bogus"]), "--bogus");
  assert.strictEqual(findUnrecognisedArg(["--port=2633"]), "--port=2633");
});

test("findUnrecognisedArg: every documented flag is accepted", function () {
  var forms = [
    [], ["--shutdown"], ["--restart"], ["--list"], ["--headless"], ["--multi-user"],
    ["--os-users"], ["--dev"], ["--debug"], ["--watch"], ["-w"], ["-y"], ["--yes"],
    ["--no-https"], ["--local-cert"], ["--no-update"], ["--skip-update"],
    ["--no-restart"], ["--activity-diagnostics"], ["--process-build-status"],
    ["-h"], ["--help"], ["--dangerously-skip-permissions"],
    ["--pin", "123456", "--yes"], ["-p", "2700"], ["--port", "2700"],
    ["--host", "127.0.0.1"], ["--bind", "127.0.0.1"],
    ["--add", "."], ["--add", "/some/path"], ["--remove", "/some/path"],
  ];
  forms.forEach(function (form) {
    assert.strictEqual(findUnrecognisedArg(form), null, JSON.stringify(form));
  });
});

test("findUnrecognisedArg: a flag's value is not a stray word", function () {
  assert.strictEqual(findUnrecognisedArg(["--add", "bogus"]), null);
  assert.strictEqual(findUnrecognisedArg(["--host", "bogus", "--shutdown"]), null);
});

test("findUnrecognisedArg: help wins over later tokens, as the flag loop does", function () {
  assert.strictEqual(findUnrecognisedArg(["--help", "bogus"]), null);
  assert.strictEqual(findUnrecognisedArg(["bogus", "--help"]), "bogus");
});

// --- real CLI, isolated home, no daemon ---

[
  ["bogus", "--shutdown"],
  ["--shutdown", "bogus"],
  ["bogus", "--restart", "x"],
  ["bogus", "--add", "."],
  ["--bogus"],
].forEach(function (args) {
  test("cli exits 1 with usage error and no daemon action: " + args.join(" "), function () {
    var res = runCli(args);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /unrecognised argument/);
    assert.match(res.stderr, /clagentic-console --help/);
    // An action that reached the daemon would print its own status or error.
    assert.doesNotMatch(res.stdout + res.stderr, /daemon|No running|Shutting/i);
  });
});

test("cli: --help still prints usage and exits 0", function () {
  var res = runCli(["--help"]);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /Usage: clagentic-console/);
});

test("cli: removed --dangerously-skip-permissions keeps its dedicated message", function () {
  var res = runCli(["--dangerously-skip-permissions"]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /has been removed/);
});

test("cli: release verb is still routed ahead of flag validation", function () {
  var res = runCli(["release", "nope"]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /Unknown release subcommand/);
});
