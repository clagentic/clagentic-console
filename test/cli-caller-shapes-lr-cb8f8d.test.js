// CREW_SOP section 6 caller shapes for the unknown-argument guard in bin/cli.js.
// Each test takes its argv from the real caller source (unit template,
// package.json, the module that builds the argv, the CLI's own --help text)
// rather than a retyped copy, then asserts the guard accepts it or that routing
// still happens ahead of the guard.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var childProcess = require("child_process");

var { findUnrecognisedArg } = require("../lib/cli/arg-validation");
var { reExecArgs } = require("../lib/updater");
var { resolveProcessBuildStatus } = require("../scripts/verify-installed-build");
var { SESSION_VERBS } = require("../lib/cli/session-subcommands");

var ROOT = path.join(__dirname, "..");
var CLI = path.join(ROOT, "bin", "cli.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cb8f8d-shape-"));
}

function runCli(args, opts) {
  var home = tmpDir();
  try {
    return childProcess.spawnSync(process.execPath, [(opts && opts.script) || CLI].concat(args), {
      encoding: "utf8",
      timeout: 15000,
      cwd: home,
      env: Object.assign({}, process.env, { CLAGENTIC_CONSOLE_HOME: home }),
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Arguments that follow the CLI script in a shell command string.
function argsAfterCli(command) {
  var tokens = command.trim().split(/\s+/);
  var at = -1;
  tokens.forEach(function (t, i) { if (/(^|\/)cli\.js$/.test(t)) at = i; });
  return at === -1 ? null : tokens.slice(at + 1);
}

// --- shape 1: systemd unit ExecStart ---

test("caller shape 1: unit ExecStart argv is `daemon`, routed ahead of the guard", function () {
  var unit = fs.readFileSync(path.join(ROOT, "deploy", "clagentic-console.service"), "utf8");
  var line = unit.split("\n").filter(function (l) { return /^ExecStart=/.test(l); })[0];
  assert.ok(line, "unit has an ExecStart line");
  var tokens = line.replace(/^ExecStart=/, "").trim().split(/\s+/);
  var args = tokens.slice(1);
  assert.deepStrictEqual(args, ["daemon"]);

  // `daemon` is not a guard word; it must be handled before the guard runs.
  assert.notStrictEqual(findUnrecognisedArg(args), null);
  var src = fs.readFileSync(CLI, "utf8");
  var daemonRoute = src.indexOf('args[0] === "daemon"');
  var guardCall = src.indexOf("findUnrecognisedArg(args)");
  assert.ok(daemonRoute !== -1 && guardCall !== -1);
  assert.ok(daemonRoute < guardCall, "daemon routing precedes the guard");
});

// Runs the captured ExecStart argv through the real CLI without starting a daemon:
// the CLI is invoked through <prefix>/bin/ with an npm-link symlink at
// <prefix>/lib/node_modules/clagentic-console, so the daemon branch refuses with
// its own exit 78 before it would require lib/daemon.
test("caller shape 1: ExecStart argv reaches the daemon branch, not the guard (link-trap refusal, no daemon)", function () {
  var unit = fs.readFileSync(path.join(ROOT, "deploy", "clagentic-console.service"), "utf8");
  var line = unit.split("\n").filter(function (l) { return /^ExecStart=/.test(l); })[0];
  var captured = line.replace(/^ExecStart=/, "").trim().split(/\s+/).slice(1);
  assert.deepStrictEqual(captured, ["daemon"]);

  var dir = tmpDir();
  try {
    var binDir = path.join(dir, "bin");
    var nodeModules = path.join(dir, "lib", "node_modules");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.symlinkSync(CLI, path.join(binDir, "cli.js"));
    fs.symlinkSync(ROOT, path.join(nodeModules, "clagentic-console"));

    // The documented form alone reaches the daemon branch (link-trap probe).
    var ok = runCli(captured, { script: path.join(binDir, "cli.js") });
    assert.strictEqual(ok.status, 78, ok.stderr);
    assert.match(ok.stderr, /npm link trap/);
    assert.doesNotMatch(ok.stderr, /unrecognised argument/);

    // Any extra token is refused with exit 78 before the probe or the daemon.
    var extra = runCli(captured.concat(["--bogus-cb8f8d"]), { script: path.join(binDir, "cli.js") });
    assert.strictEqual(extra.status, 78, extra.stderr);
    assert.match(extra.stderr, /unrecognised argument '--bogus-cb8f8d'/);
    assert.doesNotMatch(extra.stderr, /npm link trap/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- shape 2: in-app updater re-exec ---

test("caller shape 2: updater re-exec argv is accepted for every documented form", function () {
  var forms = helpForms();
  forms.forEach(function (form) {
    var execArgs = reExecArgs([process.execPath, CLI].concat(form));
    assert.strictEqual(execArgs[0], CLI);
    assert.strictEqual(execArgs[execArgs.length - 1], "--no-update");
    var cliArgs = execArgs.slice(1);
    assert.strictEqual(findUnrecognisedArg(cliArgs), null, JSON.stringify(cliArgs));
  });
});

// --- shape 3: scripts/verify-installed-build.js ---

test("caller shape 3: verify-installed-build argv (--process-build-status) is accepted", function () {
  var dir = tmpDir();
  try {
    var capture = path.join(dir, "argv.json");
    var fakeBin = path.join(dir, "fake-clagentic-console");
    fs.writeFileSync(
      fakeBin,
      "#!" + process.execPath + "\n" +
      "require('fs').writeFileSync(" + JSON.stringify(capture) + ", JSON.stringify(process.argv.slice(2)));\n" +
      "console.log(JSON.stringify({ loadedBuildSha: 'x' }));\n",
      { mode: 0o755 }
    );
    resolveProcessBuildStatus(fakeBin);
    var captured = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.deepStrictEqual(captured, ["--process-build-status"]);
    assert.strictEqual(findUnrecognisedArg(captured), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- shape 4: package.json scripts and the dev entry ---

test("caller shape 4: every package.json script that runs the CLI passes the guard", function () {
  var pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  var seen = 0;
  Object.keys(pkg.scripts).forEach(function (name) {
    var args = argsAfterCli(pkg.scripts[name]);
    if (args === null) return;
    seen++;
    assert.strictEqual(findUnrecognisedArg(args), null, name + ": " + JSON.stringify(args));
  });
  assert.ok(seen >= 1, "found at least the dev script");
  assert.deepStrictEqual(argsAfterCli(pkg.scripts.dev), ["--dev"]);
});

test("caller shape 4: clagentic-console-dev by name runs the CLI and the guard still applies", function () {
  var dir = tmpDir();
  try {
    var devBin = path.join(dir, "clagentic-console-dev");
    fs.symlinkSync(CLI, devBin);
    var help = runCli(["--help"], { script: devBin });
    assert.strictEqual(help.status, 0);
    assert.match(help.stdout, /Usage: clagentic-console/);
    var bad = runCli(["bogus", "--shutdown"], { script: devBin });
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stderr, /unrecognised argument/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- shape 5: operator starts documented in --help ---

// Flags the --help text lists for the top-level (non-verb) command: the usage
// line, the `clagentic-console --x` lines and the Options column.
function helpFlags() {
  var res = runCli(["--help"]);
  assert.strictEqual(res.status, 0);
  var flags = [];
  var lines = res.stdout.split("\n");
  var inOptions = false;
  lines.forEach(function (line) {
    var text = null;
    if (/^Usage: clagentic-console/.test(line)) {
      text = line.replace(/^Usage: clagentic-console/, "");
    } else if (/^\s+clagentic-console --/.test(line)) {
      text = line.replace(/^\s+clagentic-console\s+/, "").split(/\s{2,}/)[0];
    } else if (/^Options:/.test(line)) {
      inOptions = true;
      return;
    } else if (inOptions && /^\s+-/.test(line)) {
      text = line.trim().split(/\s{2,}/)[0];
    }
    if (text === null) return;
    var re = /(?:^|[\s[|,])(-{1,2}[A-Za-z][A-Za-z-]*)/g;
    var m;
    while ((m = re.exec(text)) !== null) flags.push(m[1]);
  });
  return flags.filter(function (f, i) { return flags.indexOf(f) === i; });
}

// One argv per flag the help text lists.
function helpForms() {
  return helpFlags().map(function (f) { return [f]; });
}

test("caller shape 5: every flag the --help text lists is accepted by the guard", function () {
  var flags = helpFlags();
  // Guards against the parser silently matching nothing.
  ["-p", "--port", "--host", "--no-https", "--pin", "--shutdown", "--restart", "--add",
    "--remove", "--list", "--headless", "--multi-user", "--os-users", "--yes", "-y",
    "--activity-diagnostics", "--process-build-status"].forEach(function (f) {
    assert.ok(flags.indexOf(f) !== -1, "help lists " + f);
  });
  flags.forEach(function (f) {
    assert.strictEqual(findUnrecognisedArg([f]), null, f);
  });
});

test("caller shape 5: bare start and combined documented starts are accepted", function () {
  [
    [],
    ["--headless"],
    ["-y"],
    ["--multi-user", "--os-users", "--yes"],
    ["--pin", "123456", "--yes"],
    ["-p", "2700", "--host", "127.0.0.1"],
    ["--add", "."],
    ["--remove", "."],
  ].forEach(function (form) {
    assert.strictEqual(findUnrecognisedArg(form), null, JSON.stringify(form));
  });
});

// --- shape 6: crew lanes and other agents ---

test("caller shape 6: session verbs and schedule-input are routed ahead of the guard", function () {
  var src = fs.readFileSync(CLI, "utf8");
  var guardCall = src.indexOf("findUnrecognisedArg(args)");
  assert.ok(src.indexOf("SESSION_VERBS.indexOf(args[0])") < guardCall);
  assert.ok(src.indexOf('args[0] === "schedule-input"') < guardCall);

  // Behavioural check with no daemon: the verb's own error, never the guard's.
  SESSION_VERBS.concat(["schedule-input"]).forEach(function (verb) {
    var res = runCli([verb, "--project", "p", "--prompt", "x", "--only-this-verb-knows"]);
    assert.doesNotMatch(res.stderr, /unrecognised argument/, verb);
  });
});

test("caller shape 6: agent flags --process-build-status and --activity-diagnostics pass the guard", function () {
  assert.strictEqual(findUnrecognisedArg(["--process-build-status"]), null);
  assert.strictEqual(findUnrecognisedArg(["--activity-diagnostics"]), null);
});
