"use strict";
// open-session, send-input and schedule-input create deliver the text of a
// prompt file, never its bare path: --prompt-file <path>, and a --prompt whose
// whole value is one @-token naming an existing regular file. One row per
// acceptance criterion runs the real bin/cli.js against a fake daemon on the
// console's IPC socket and reads the request the daemon received; the variants
// of the loader's rules are rows of one table over the loader itself.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var net = require("net");
var os = require("os");
var path = require("path");
var { spawn } = require("child_process");

var { loadPrompt } = require("../lib/cli/prompt-text");
var { parseSessionArgs } = require("../lib/cli/session-subcommands");
var agentUsage = require("../lib/cli/agent-usage");

var CLI = path.join(__dirname, "..", "bin", "cli.js");
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-file-"));
var home = path.join(tmp, "home");
var received = [];
var server;

test.before(function () {
  fs.mkdirSync(path.join(home, "console"), { recursive: true });
  fs.writeFileSync(path.join(home, "console", "daemon.json"), JSON.stringify({ pid: process.pid }));
  server = net.createServer(function (conn) {
    var buf = "";
    conn.setEncoding("utf8");
    conn.on("data", function (chunk) {
      buf += chunk;
      var i = buf.indexOf("\n");
      if (i === -1) return;
      received.push(JSON.parse(buf.slice(0, i)));
      conn.write(JSON.stringify({ ok: true, result: "delivered" }) + "\n");
    });
    conn.on("error", function () {});
  });
  return new Promise(function (resolve) { server.listen(path.join(home, "console", "daemon.sock"), resolve); });
});

test.after(function () {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(name, text) {
  var p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
}

// Runs the CLI once; resolves to { code, stderr, request } where request is what
// the daemon received (null when nothing reached it).
function runCli(args) {
  received.length = 0;
  return new Promise(function (resolve) {
    var child = spawn(process.execPath, [CLI].concat(args), {
      env: { PATH: process.env.PATH, HOME: tmp, CLAGENTIC_CONSOLE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    var stderr = "";
    child.stderr.on("data", function (d) { stderr += d; });
    child.stdout.on("data", function () {});
    child.on("close", function (code) {
      resolve({ code: code, stderr: stderr, request: received[0] || null });
    });
  });
}

var SEND = ["send-input", "--project", "p", "--session", "s"];
var OPEN = ["open-session", "--project", "p"];
var SCHED = ["schedule-input", "create", "--session", "s", "--project", "p", "--in", "5m"];

// --- through the real entry point: one run per acceptance criterion ---

test("AC1: send-input --prompt-file delivers the file text, one trailing newline removed", async function () {
  var file = write("note.txt", "line one\nline two\n\n");
  var r = await runCli(SEND.concat(["--prompt-file", file]));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.request.prompt, "line one\nline two\n");
  assert.equal("promptFile" in r.request, false, "no path field crosses IPC");
});

test("AC2: open-session --prompt @<file> delivers the file text, not the token", async function () {
  var file = write("open.txt", "open text\n");
  var r = await runCli(OPEN.concat(["--prompt", "@" + file]));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.request.prompt, "open text");
});

test("AC2: schedule-input create --prompt @<file> delivers the file text, not the token", async function () {
  var file = write("sched.txt", "sched text\n");
  var r = await runCli(SCHED.concat(["--prompt", "@" + file]));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.request.prompt, "sched text");
});

test("AC3: an @-token naming no file is sent as given, with no warning", async function () {
  var token = "@" + path.join(tmp, "absent.txt");
  var r = await runCli(SEND.concat(["--prompt", token]));
  assert.equal(r.code, 0);
  assert.equal(r.request.prompt, token);
  assert.equal(r.stderr, "");
});

test("AC4: --prompt together with --prompt-file exits 1 before any daemon request", async function () {
  var r = await runCli(SEND.concat(["--prompt", "a", "--prompt-file", write("both.txt", "x")]));
  assert.equal(r.code, 1);
  assert.equal(r.request, null);
  assert.match(r.stderr, /--prompt <text\|-> or --prompt-file <path>/);
});

test("AC5: an unreadable --prompt-file exits 1 naming the path and the reason, before any daemon request", async function () {
  var gone = path.join(tmp, "missing.txt");
  var r = await runCli(SEND.concat(["--prompt-file", gone]));
  assert.equal(r.code, 1);
  assert.equal(r.request, null);
  assert.ok(r.stderr.indexOf("Cannot read --prompt-file " + gone + ": ") !== -1, r.stderr);
});

// --- the loader's rules: one table, real files where the file system decides ---

function statError(code) {
  return function () { var e = new Error(code + ": stat failed"); e.code = code; throw e; };
}

test("the loader: what each --prompt value becomes", function () {
  var real = write("real.txt", "file text\n");
  var dir = path.join(tmp, "a-dir");
  fs.mkdirSync(dir);
  var absent = path.join(tmp, "nope.txt");
  var underFile = path.join(real, "child");
  var rows = [
    { name: "whole-value @file", prompt: "@" + real, want: "file text" },
    { name: "@file followed by words", prompt: "@" + real + " and more", want: "@" + real + " and more" },
    { name: "@token naming no file", prompt: "@" + absent, want: "@" + absent },
    { name: "@token under a regular file (ENOTDIR)", prompt: "@" + underFile, want: "@" + underFile },
    { name: "@token naming a directory", prompt: "@" + dir, want: "@" + dir },
    { name: "a bare @", prompt: "@", want: "@" },
    { name: "plain text keeps its newline", prompt: "kept\n", want: "kept\n" },
    { name: "stdin", prompt: "-", want: "piped", stdin: "piped\n" },
    { name: "existing file whose read fails", prompt: "@" + real, isFile: function () { return true; },
      readFile: function () { throw new Error("EACCES: permission denied"); }, error: new RegExp("^Cannot read --prompt @" + real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ": EACCES") },
    { name: "stat fails with EACCES: an error, never the literal token", prompt: "@/some/file", isFile: statError("EACCES"),
      error: /^Cannot read --prompt @\/some\/file: EACCES/ },
  ];
  rows.forEach(function (row) {
    var request = { prompt: row.prompt };
    var error = loadPrompt(request, row.stdin === undefined ? null : function () { return row.stdin; }, row.readFile || null, row.isFile || null);
    if (row.error) {
      assert.match(error, row.error, row.name);
    } else {
      assert.equal(error, null, row.name);
      assert.equal(request.prompt, row.want, row.name);
    }
  });
  var fromFile = { promptFile: real };
  assert.equal(loadPrompt(fromFile), null);
  assert.equal(fromFile.prompt, "file text");
  assert.equal("promptFile" in fromFile, false);
});

test("the parser accepts --prompt-file on open-session and send-input only, once", function () {
  assert.equal(parseSessionArgs("send-input", SEND.slice(1).concat(["--prompt-file", "f"])).request.promptFile, "f");
  assert.equal(parseSessionArgs("open-session", OPEN.slice(1).concat(["--prompt-file", "f"])).request.promptFile, "f");
  assert.match(parseSessionArgs("end-session", ["--project", "p", "--session", "s", "--prompt-file", "f"]).error, /Unknown option/);
  assert.match(parseSessionArgs("send-input", SEND.slice(1).concat(["--prompt-file", "f", "--prompt-file", "g"])).error, /given twice/);
  assert.match(parseSessionArgs("send-input", SEND.slice(1)).error, /one way only/);
  assert.match(parseSessionArgs("open-session", OPEN.slice(1)).error, /one way only/);
});

test("--help of open-session and send-input shows --prompt-file", function () {
  ["open-session", "send-input"].forEach(function (verb) {
    assert.match(agentUsage.helpText(verb), /\(--prompt <text\|-> \| --prompt-file <path>\)/, verb);
  });
});
