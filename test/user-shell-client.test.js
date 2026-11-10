"use strict";
// The page side of the ! command line: which composer lines are commands, how a
// result reads in every way a command can end, and that the new message types
// are documented in the WebSocket registry with handlers that exist.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var { schema } = require("../lib/ws-schema");
var dom = require("./fake-dom-prompt-cards");

function shellLine() { return import("../lib/public/modules/shell-line.js"); }

test("a line is a command when it starts with ! and something follows", async function () {
  var m = await shellLine();
  assert.equal(m.parseShellLine("!ls -la"), "ls -la");
  assert.equal(m.parseShellLine("!   git status  "), "git status");
  assert.equal(m.parseShellLine("!!"), "!");
  ["!", "!   ", "ls", " !ls", "hello !", "", null, undefined, 5].forEach(function (line) {
    assert.equal(m.parseShellLine(line), null, JSON.stringify(line));
  });
});

test("every way a command can end reads in words", async function () {
  var m = await shellLine();
  assert.deepEqual(m.describeResult({ exitCode: 0, durationMs: 1500, truncated: false }), { state: "ok", status: "exit 0 · 1.5 s" });
  assert.equal(m.describeResult({ exitCode: 2, durationMs: 40 }).state, "failed");
  assert.match(m.describeResult({ exitCode: 2, durationMs: 40 }).status, /^exit 2 · 40 ms$/);
  var timed = m.describeResult({ exitCode: null, durationMs: 600000, timedOut: true });
  assert.equal(timed.state, "failed");
  assert.match(timed.status, /timed out and was stopped/);
  assert.match(timed.status, /10 min 0 s/);
  assert.match(m.describeResult({ exitCode: null, durationMs: 5, interrupted: true }).status, /interrupted/);
  assert.match(m.describeResult({ exitCode: 0, durationMs: 5, truncated: true }).status, /output cut at the size limit/);
  assert.equal(m.describeResult({ exitCode: 0, durationMs: 5, truncated: true }).state, "ok");
  assert.match(m.describeResult({ exitCode: null, durationMs: 5 }).status, /ended without an exit code/);
  assert.deepEqual(m.describeResult({ denied: true, reason: "No." }), { state: "denied", status: "No." });
  assert.equal(m.describeResult({ denied: true }).state, "denied");
  assert.deepEqual(m.describeResult({ refused: true, reason: "Plan mode." }), { state: "refused", status: "Plan mode." });
  assert.equal(m.describeResult({ error: true, output: "boom" }).state, "error");
});

test("the result card shows output as text, replaces its running line, and takes its style from the outcome", async function () {
  dom.setupGlobals();
  var card = await import(dom.moduleUrl("shell-card.js"));
  var el = card.buildCard("echo hi", "pending");
  assert.equal(el.querySelector(".shell-cmd").textContent, "!echo hi");
  card.showRunning(el);
  assert.equal(el.querySelectorAll(".shell-status").length, 1);
  assert.equal(el.querySelector(".shell-status").textContent, "Running…");

  var hostile = "<img src=x onerror=alert(1)>\n</pre><script>1</script>";
  card.fillCard(el, { command: "echo hi", exitCode: 1, durationMs: 20, output: hostile, truncated: false });
  assert.equal(el.className, "shell-result failed");
  assert.equal(el.querySelectorAll(".shell-status").length, 1, "the running line was replaced, not added to");
  assert.equal(el.querySelector(".shell-status").textContent, "exit 1 · 20 ms");
  var out = el.querySelector(".shell-output");
  assert.equal(out.textContent, hostile);
  assert.equal(out.children.length, 0, "no element was made from the output");

  card.fillCard(el, { command: "echo hi", exitCode: 0, durationMs: 5, output: "", truncated: false });
  assert.equal(el.className, "shell-result ok");
  assert.equal(el.querySelector(".shell-output"), null, "a command with no output shows none");

  card.fillCard(el, { command: "echo hi", denied: true, reason: "Not approved." });
  assert.equal(el.className, "shell-result denied");
  assert.equal(el.querySelector(".shell-status").textContent, "Not approved.");
});

test("the new message types are in the WebSocket registry with handlers that exist", function () {
  var expected = {
    shell: "c2s",
    shell_result: "s2c",
    set_user_shell_settings: "c2s",
    user_shell_settings: "s2c",
  };
  Object.keys(expected).forEach(function (type) {
    var entry = schema[type];
    assert.ok(entry, type + " is documented");
    assert.equal(entry.direction, expected[type]);
    assert.ok(fs.existsSync(path.join(__dirname, "..", entry.handler)), type + " names a handler file that exists: " + entry.handler);
  });
});

test("the composer routes a ! line to the shell request and the page registers the result handlers", function () {
  var input = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "input.js"), "utf8");
  assert.match(input, /parseShellLine\(text\)/);
  assert.match(input, /startShellRequest\(shellCommand\)/);
  var messages = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "app-messages.js"), "utf8");
  assert.match(messages, /shell_result: handleShellResult/);
  assert.match(messages, /user_shell_settings: handleUserShellSettings/);
});
