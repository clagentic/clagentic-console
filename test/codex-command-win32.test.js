"use strict";
// Starting a Codex binary on Windows: a native codex.exe is run directly, a
// .cmd/.bat shim only through the command interpreter (ComSpec /d /s /c) with
// every argument quoted for it. Both the version check and the app-server start
// use the one helper. The platform and the process-starting functions are
// stand-ins, so the three shapes (exe only, cmd only, both) run on any host.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { PassThrough } = require("stream");
var { EventEmitter } = require("events");

var codexCommand = require("../lib/yoke/codex-command");
var cmdHarness = require("./cmd-exe-parse-harness");
var codexBinary = require("../lib/yoke/codex-binary");
var { CodexAppServer } = require("../lib/yoke/codex-app-server");

var ENV_NAME = "CLAGENTIC_CONSOLE_CODEX_PATH";
var COMSPEC = "C:\\Windows\\System32\\cmd.exe";
var tmpRoots = [];

test.after(function () {
  tmpRoots.forEach(function (dir) { fs.rmSync(dir, { recursive: true, force: true }); });
});

function tmpFile(name) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win32-"));
  tmpRoots.push(dir);
  var file = path.join(dir, name);
  fs.writeFileSync(file, "");
  fs.chmodSync(file, 0o755);
  return file;
}

function recordingExec() {
  var calls = [];
  return {
    calls: calls,
    deps: {
      platform: "win32",
      comSpec: COMSPEC,
      execFileSync: function (file, args, options) {
        calls.push({ file: file, args: args, options: options });
        return "codex-cli 0.162.1\n";
      },
    },
  };
}

test("a native executable is run directly, on win32 and elsewhere", function () {
  var inv = codexCommand.invocationFor("C:\\Tools\\codex.exe", ["--version"], { platform: "win32", comSpec: COMSPEC });
  assert.deepEqual(inv, { file: "C:\\Tools\\codex.exe", args: ["--version"], verbatim: false });
  var posix = codexCommand.invocationFor("/usr/bin/codex", ["--version"], { platform: "linux" });
  assert.deepEqual(posix, { file: "/usr/bin/codex", args: ["--version"], verbatim: false });
  var shapedLikeShim = codexCommand.invocationFor("/home/u/codex.cmd", ["--version"], { platform: "linux" });
  assert.equal(shapedLikeShim.file, "/home/u/codex.cmd", "only win32 needs the interpreter");
});

test("a .cmd or .bat shim goes through the interpreter with a quoted command line", function () {
  ["codex.cmd", "CODEX.BAT"].forEach(function (name) {
    var shim = "C:\\npm\\" + name;
    var inv = codexCommand.invocationFor(shim, ["--version"], { platform: "win32", comSpec: COMSPEC });
    assert.equal(inv.file, COMSPEC);
    assert.equal(inv.verbatim, true);
    assert.deepEqual(inv.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(inv.args[3], '"' + shim + ' ^^^"--version^^^""');
  });
});

test("the interpreter is ComSpec from the environment, cmd.exe when unset", function () {
  var saved = process.env.ComSpec;
  try {
    process.env.ComSpec = "D:\\sys\\cmd.exe";
    assert.equal(codexCommand.invocationFor("C:\\a\\codex.cmd", [], { platform: "win32" }).file, "D:\\sys\\cmd.exe");
    delete process.env.ComSpec;
    assert.equal(codexCommand.invocationFor("C:\\a\\codex.cmd", [], { platform: "win32" }).file, "cmd.exe");
  } finally {
    if (saved === undefined) delete process.env.ComSpec; else process.env.ComSpec = saved;
  }
});

test("arguments are never left for the interpreter to read: metacharacters are escaped and line breaks refused", function () {
  var hostile = ["x&calc", "a|b", "100%", "p q", "say \"hi\"", "tail\\", "(x)", "a^b", "!x!", "a<b", "a>b", "x>out.txt", "<in.txt"];
  hostile.forEach(function (arg) {
    var line = codexCommand.invocationFor("C:\\a\\codex.cmd", [arg], { platform: "win32", comSpec: COMSPEC }).args[3];
    var inner = line.slice(1, -1);
    var afterCommand = inner.slice("C:\\a\\codex.cmd ".length);
    ["&", "|", "<", ">", "%", "!", "(", ")", " ", "\""].forEach(function (meta) {
      var at = afterCommand.indexOf(meta);
      while (at !== -1) {
        assert.equal(afterCommand[at - 1], "^", JSON.stringify(arg) + ": " + meta + " at " + at + " is escaped");
        at = afterCommand.indexOf(meta, at + 1);
      }
    });
    // The caret is the escape itself, so "preceded by a caret" cannot prove it is
    // escaped. Undo the two escape passes instead: a caret that was escaped twice
    // comes back as exactly the carets the argument held, while an unescaped one
    // would be consumed as an escape and the count would fall short.
    var undone = afterCommand.replace(/\^([\s\S])/g, "$1").replace(/\^([\s\S])/g, "$1");
    var carets = function (text) { return text.split("^").length - 1; };
    assert.equal(carets(undone), carets(arg), JSON.stringify(arg) + ": ^ is escaped");
  });
  assert.throws(function () {
    codexCommand.invocationFor("C:\\a\\codex.cmd", ["a\nb"], { platform: "win32", comSpec: COMSPEC });
  }, /line break/);
  assert.throws(function () {
    codexCommand.invocationFor("C:\\a \"x\\codex.cmd", [], { platform: "win32", comSpec: COMSPEC });
  }, /quote/);
});

// Every character the interpreter reads specially, alone and next to a caret, a
// quote and a space, on either side and on both.
var SPECIALS = ["&", "|", "<", ">", "%", "!", "(", ")", "^", "\"", " ", "`", ",", ";", "*", "?", "[", "]"];
var NEIGHBOURS = ["^", "\"", " "];
var CMD_ENV = { PATH: "EXPANDED", A: "B" };
var SHIM = "C:\\a\\codex.cmd";

function roundTripRows() {
  var rows = [
    "", "plain", "--config", "tools.update_plan.enabled=true", "a b", "=+'{}~#$@",
    "x&calc", "a|b", "a<b", "a>b", "x>out.txt", "<in.txt", "2>&1", "a&&b", "a||b",
    "%A%", "%PATH%", "a%A%b", "100%", "%", "%%", "!x!", "(x)", "a^b", "^", "^^", "^\"",
    "say \"hi\"", "say \"&calc\"", "say \"|x\" >y", "\"", "\"\"", "\\", "tail\\", "tail\\\\", "a\\\"b", "a\\\\\"b", "\\\"", "C:\\Program Files\\x\\",
  ];
  SPECIALS.forEach(function (meta) {
    rows.push(meta);
    NEIGHBOURS.forEach(function (n) { rows.push(meta + n, n + meta, n + meta + n); });
  });
  return rows.filter(function (row, at) { return rows.indexOf(row) === at; });
}

function shimInvocation(args) {
  return codexCommand.invocationFor(SHIM, args, { platform: "win32", comSpec: COMSPEC });
}

test("round trip: every hostile argument reaches the program exactly as given, with no operator reaching the interpreter", function () {
  roundTripRows().forEach(function (row) {
    var got = cmdHarness.receivedArgs(shimInvocation(["before", row, "after"]), SHIM, CMD_ENV);
    assert.deepEqual(got.operators, [], JSON.stringify(row) + ": nothing for the interpreter to run or redirect");
    assert.deepEqual(got.argv, ["before", row, "after"], JSON.stringify(row) + ": the program receives what was given");
  });
  var together = roundTripRows();
  var all = cmdHarness.receivedArgs(shimInvocation(together), SHIM, CMD_ENV);
  assert.deepEqual(all.argv, together, "all of them on one command line, in order");
  assert.deepEqual(all.operators, []);
});

// The same algorithm as lib/yoke/codex-command.js with its choices exposed, so a
// defect can be put in on purpose. With the real choices it must produce the
// real line, or the stand-ins below prove nothing about the shipped escaper.
var REAL_META = /([()\][%!^"`<>&|;, *?])/g;
function escaperWith(meta, passes) {
  return function (arg) {
    var text = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
    text = '"' + text + '"';
    for (var i = 0; i < passes; i++) text = text.replace(meta, "^$1");
    return text;
  };
}
function lineWith(escape, args) {
  return { args: ["/d", "/s", "/c", '"' + [SHIM].concat(args.map(escape)).join(" ") + '"'] };
}

test("the round-trip harness fails an escaper that misses < or >, or applies too few or too many passes", function () {
  var real = escaperWith(REAL_META, 2);
  roundTripRows().forEach(function (row) {
    assert.equal(lineWith(real, [row]).args[3], shimInvocation([row]).args[3], "the stand-in matches the shipped escaper for " + JSON.stringify(row));
  });

  function outcome(escape, row) {
    var got = cmdHarness.receivedArgs(lineWith(escape, [row]), SHIM, CMD_ENV);
    return { ok: got.operators.length === 0 && got.argv.length === 1 && got.argv[0] === row, got: got };
  }

  var noAngles = escaperWith(/([()\][%!^"`&|;, *?])/g, 2);
  ["a<b", "a>b", "x>out.txt", "<in.txt"].forEach(function (row) {
    var r = outcome(noAngles, row);
    assert.equal(r.ok, false, JSON.stringify(row) + " must fail when < and > are not escaped");
    assert.ok(r.got.operators.some(function (op) { return op === "<" || op === ">"; }), "the redirection reaches the interpreter");
  });
  assert.equal(outcome(noAngles, "a&b").ok, true, "the harness fails only the rows the defect touches");

  var onePass = escaperWith(REAL_META, 1);
  // With one pass the quotes survive the first parse as live quotes, and the
  // batch file's parse toggles on the \" the program-level quoting produced, so
  // the & after it is outside any quote.
  assert.equal(outcome(onePass, "say \"&calc\"").ok, false, "one pass lets the batch file's parse run the command");
  assert.equal(outcome(onePass, "\"&").ok, false);
  assert.equal(outcome(onePass, "x&calc").ok, true, "one pass is enough while the argument holds no quote: the second pass is for quotes");

  var threePasses = escaperWith(REAL_META, 3);
  assert.equal(outcome(threePasses, "a^b").ok, false, "a third pass leaves stray carets in what the program receives");
  assert.equal(outcome(threePasses, "a b").ok, false);
});

test("only win32 with a shim changes the command line: other shapes pass the arguments through untouched", function () {
  var rows = roundTripRows();
  [
    { binary: "/usr/bin/codex", platform: "linux" },
    { binary: "/home/u/codex.cmd", platform: "linux" },
    { binary: "/opt/codex", platform: "darwin" },
    { binary: "/home/u/codex.bat", platform: "darwin" },
    { binary: "C:\\Tools\\codex.exe", platform: "win32" },
  ].forEach(function (shape) {
    var inv = codexCommand.invocationFor(shape.binary, rows, { platform: shape.platform, comSpec: COMSPEC });
    assert.deepEqual(inv, { file: shape.binary, args: rows, verbatim: false }, shape.platform + " " + shape.binary);
    assert.notEqual(inv.args, rows, "the caller's array is copied, not shared");
  });
});

test("the version check: exe only runs the exe, cmd only runs the shim through the interpreter", function () {
  var exe = tmpFile("codex.exe");
  var exeRun = recordingExec();
  var exeResult = codexBinary.resolveCodexBinary({ env: { [ENV_NAME]: exe, PATH: "" }, commandDeps: exeRun.deps });
  assert.equal(exeResult.state, "ready");
  assert.equal(exeRun.calls.length, 1);
  assert.equal(exeRun.calls[0].file, exe);
  assert.deepEqual(exeRun.calls[0].args, ["--version"]);
  assert.equal(exeRun.calls[0].options.windowsVerbatimArguments, undefined);

  var shim = tmpFile("codex.cmd");
  var shimRun = recordingExec();
  var shimResult = codexBinary.resolveCodexBinary({ env: { [ENV_NAME]: shim, PATH: "" }, commandDeps: shimRun.deps });
  assert.equal(shimResult.state, "ready");
  assert.equal(shimResult.path, shim, "the path shown is the shim, not the interpreter");
  assert.equal(shimRun.calls[0].file, COMSPEC);
  assert.deepEqual(shimRun.calls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(shimRun.calls[0].args[3], '"' + shim + ' ^^^"--version^^^""');
  assert.equal(shimRun.calls[0].options.windowsVerbatimArguments, true);
});

test("both exe and shim installed: the exe is the one found, in PATHEXT order either way", function () {
  var dir = "C:\\Users\\me\\AppData\\Roaming\\npm";
  var present = {};
  present[dir + "\\codex.cmd"] = true;
  present[dir + "\\codex.exe"] = true;
  function isExecutable(candidate) { return !!present[candidate]; }
  ["", ".COM;.EXE;.BAT;.CMD", ".CMD;.BAT;.EXE", ".CMD;.EXE"].forEach(function (pathext) {
    assert.equal(codexBinary.findOnPath(dir, isExecutable, { platform: "win32", pathext: pathext || undefined }), dir + "\\codex.exe", "PATHEXT=" + pathext);
  });
  delete present[dir + "\\codex.exe"];
  assert.equal(codexBinary.findOnPath(dir, isExecutable, { platform: "win32", pathext: ".CMD;.EXE" }), dir + "\\codex.cmd", "the shim alone is still found");
});

function stubSpawn() {
  var calls = [];
  return {
    calls: calls,
    spawn: function (file, args, options) {
      calls.push({ file: file, args: args, options: options });
      var proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new PassThrough();
      proc.kill = function () {};
      return proc;
    },
  };
}

test("the app-server start: exe only is spawned directly, cmd only through the interpreter", async function () {
  var exeSpawn = stubSpawn();
  var exeServer = new CodexAppServer("C:\\Tools\\codex.exe", { commandDeps: { platform: "win32", comSpec: COMSPEC, spawn: exeSpawn.spawn } });
  await exeServer.start();
  assert.equal(exeSpawn.calls[0].file, "C:\\Tools\\codex.exe");
  assert.deepEqual(exeSpawn.calls[0].args, ["app-server"]);
  assert.equal(exeSpawn.calls[0].options.windowsVerbatimArguments, undefined);
  exeServer.stop();

  var shimSpawn = stubSpawn();
  var shimServer = new CodexAppServer("C:\\npm\\codex.cmd", {
    config: { tools: { update_plan: { enabled: true } } },
    commandDeps: { platform: "win32", comSpec: COMSPEC, spawn: shimSpawn.spawn },
  });
  await shimServer.start();
  assert.equal(shimSpawn.calls[0].file, COMSPEC);
  assert.deepEqual(shimSpawn.calls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
  var line = shimSpawn.calls[0].args[3];
  assert.ok(line.startsWith('"C:\\npm\\codex.cmd '), "the shim path leads the command line");
  assert.ok(line.indexOf("tools.update_plan.enabled=true") !== -1, "the config reaches the shim");
  assert.equal(shimSpawn.calls[0].options.windowsVerbatimArguments, true);
  assert.equal(shimSpawn.calls[0].options.stdio.length, 3, "the other spawn options are kept");
  shimServer.stop();
});

test("both exe and shim given to the app-server: the exe the resolver chose is what is spawned", async function () {
  var spawned = stubSpawn();
  var server = new CodexAppServer("C:\\npm\\codex.exe", { commandDeps: { platform: "win32", comSpec: COMSPEC, spawn: spawned.spawn } });
  await server.start();
  assert.equal(spawned.calls[0].file, "C:\\npm\\codex.exe");
  server.stop();
});
