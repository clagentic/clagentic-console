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
  var hostile = ["x&calc", "a|b", "100%", "p q", "say \"hi\"", "tail\\", "(x)", "a^b", "!x!"];
  hostile.forEach(function (arg) {
    var line = codexCommand.invocationFor("C:\\a\\codex.cmd", [arg], { platform: "win32", comSpec: COMSPEC }).args[3];
    var inner = line.slice(1, -1);
    var afterCommand = inner.slice("C:\\a\\codex.cmd ".length);
    ["&", "|", "%", "!", "(", ")", " ", "\""].forEach(function (meta) {
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
