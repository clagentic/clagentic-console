"use strict";
// open-session, send-input and schedule-input create deliver the text of a
// prompt file, never its bare path: --prompt-file <path>, and a --prompt whose
// whole value is one @-token naming an existing regular file. The rows run the
// real bin/cli.js against a fake daemon on the console's IPC socket and read the
// request the daemon received.

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

test("--prompt-file and a whole-value @file deliver the file text, one trailing newline removed", async function () {
  var file = write("note.txt", "line one\nline two\n\n");
  var expected = "line one\nline two\n";
  var rows = [
    { verb: "send-input --prompt-file", args: SEND.concat(["--prompt-file", file]) },
    { verb: "open-session --prompt-file", args: OPEN.concat(["--prompt-file", file]) },
    { verb: "send-input @file", args: SEND.concat(["--prompt", "@" + file]) },
    { verb: "open-session @file", args: OPEN.concat(["--prompt", "@" + file]) },
    { verb: "schedule-input create @file", args: SCHED.concat(["--prompt", "@" + file]) },
  ];
  // The fake daemon keeps one shared log, so the rows run one after another.
  for (var i = 0; i < rows.length; i++) {
    var r = await runCli(rows[i].args);
    assert.equal(r.code, 0, rows[i].verb + ": " + r.stderr);
    assert.equal(r.request.prompt, expected, rows[i].verb);
    assert.equal("promptFile" in r.request, false, rows[i].verb + ": no path field crosses IPC");
  }
});

test("any other --prompt value is sent as given: an @-token naming no file, an @file followed by words, a plain text", async function () {
  var file = write("real.txt", "file text\n");
  var values = ["@" + path.join(tmp, "absent.txt"), "@" + file + " and more words", "plain text", "@"];
  for (var i = 0; i < values.length; i++) {
    var r = await runCli(SEND.concat(["--prompt", values[i]]));
    assert.equal(r.code, 0, values[i]);
    assert.equal(r.request.prompt, values[i]);
    assert.equal(r.stderr, "", "no warning");
  }
});

test("both --prompt and --prompt-file, or neither, exits 1 before any daemon request", async function () {
  var file = write("both.txt", "x");
  var bad = [
    SEND.concat(["--prompt", "a", "--prompt-file", file]),
    SEND,
    OPEN.concat(["--prompt", "a", "--prompt-file", file]),
    OPEN,
  ];
  for (var i = 0; i < bad.length; i++) {
    var r = await runCli(bad[i]);
    assert.equal(r.code, 1);
    assert.equal(r.request, null);
    assert.match(r.stderr, /--prompt <text\|-> or --prompt-file <path>/);
  }
});

test("an unreadable --prompt-file exits 1 naming the path and the reason, before any daemon request", async function () {
  var gone = path.join(tmp, "missing.txt");
  var r = await runCli(SEND.concat(["--prompt-file", gone]));
  assert.equal(r.code, 1);
  assert.equal(r.request, null);
  assert.ok(r.stderr.indexOf("Cannot read --prompt-file " + gone + ": ") !== -1, r.stderr);
});

test("the loader: an existing file that cannot be read names the path and the reason; a directory or a missing file is sent as given", function () {
  var thrower = function () { throw new Error("EACCES: permission denied"); };
  var denied = { prompt: "@/some/file" };
  var error = loadPrompt(denied, null, thrower, function () { return true; });
  assert.match(error, /^Cannot read --prompt @\/some\/file: EACCES/);
  var notAFile = { prompt: "@/some/dir" };
  assert.equal(loadPrompt(notAFile, null, thrower, function () { return false; }), null);
  assert.equal(notAFile.prompt, "@/some/dir");
  var stdin = { prompt: "-" };
  assert.equal(loadPrompt(stdin, function () { return "piped\n"; }, null, null), null);
  assert.equal(stdin.prompt, "piped");
});

test("the parser accepts --prompt-file on open-session and send-input only, once", function () {
  assert.equal(parseSessionArgs("send-input", SEND.slice(1).concat(["--prompt-file", "f"])).request.promptFile, "f");
  assert.equal(parseSessionArgs("open-session", OPEN.slice(1).concat(["--prompt-file", "f"])).request.promptFile, "f");
  assert.match(parseSessionArgs("end-session", ["--project", "p", "--session", "s", "--prompt-file", "f"]).error, /Unknown option/);
  assert.match(parseSessionArgs("send-input", SEND.slice(1).concat(["--prompt-file", "f", "--prompt-file", "g"])).error, /given twice/);
});

test("--help of open-session and send-input shows --prompt-file", function () {
  ["open-session", "send-input"].forEach(function (verb) {
    assert.match(agentUsage.helpText(verb), /\(--prompt <text\|-> \| --prompt-file <path>\)/, verb);
  });
});
