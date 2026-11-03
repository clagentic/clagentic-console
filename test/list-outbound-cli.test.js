"use strict";
// The list-outbound verb: its arguments, the request it sends, its exit codes,
// and the same request answered over a real Unix socket.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var cli = require("../lib/cli/session-subcommands");
var { createIPCServer, sendIPCCommand } = require("../lib/ipc");
var { handleOutboundCommand } = require("../lib/session-input-ipc");
var { createOutboundLedger } = require("../lib/outbound-ledger");
var { createOutboundQuery } = require("../lib/outbound-query");

var NOW = Date.parse("2026-06-30T12:00:00Z");

test("list-outbound is a session verb with its own usage", function () {
  assert.ok(cli.SESSION_VERBS.indexOf("list-outbound") !== -1);
  var res = cli.parseSessionArgs("list-outbound", []);
  assert.match(res.error, /--session/);
});

test("--session is required; --project, --since and --kind are optional", function () {
  var res = cli.parseSessionArgs("list-outbound", ["--session", "abc"], NOW);
  assert.deepEqual(res.request, { sessionId: "abc" });
  var full = cli.parseSessionArgs("list-outbound", ["--session", "7", "--project", "p", "--since", "2h", "--kind", "opens"], NOW);
  assert.deepEqual(full.request, { sessionId: "7", projectSlug: "p", kind: "opens", sinceMs: NOW - 2 * 3600000 });
});

test("--since takes a duration back from now: 90 is minutes, 1h30m and 3d work, nonsense is an error", function () {
  var since = function (v) { return cli.parseSessionArgs("list-outbound", ["--session", "1", "--since", v], NOW); };
  assert.equal(since("90").request.sinceMs, NOW - 90 * 60000);
  assert.equal(since("1h30m").request.sinceMs, NOW - 90 * 60000);
  assert.equal(since("3d").request.sinceMs, NOW - 3 * 86400000);
  assert.match(since("yesterday").error, /--since: not a duration/);
  assert.match(since("0m").error, /longer than zero/);
});

test("--kind accepts sent and opens only", function () {
  var kind = function (v) { return cli.parseSessionArgs("list-outbound", ["--session", "1", "--kind", v], NOW); };
  assert.equal(kind("sent").request.kind, "sent");
  assert.equal(kind("opens").request.kind, "opens");
  assert.match(kind("all").error, /accepted: sent, opens/);
});

test("options of the other verbs are not accepted", function () {
  ["--prompt", "--to", "--agent", "--state", "--from"].forEach(function (flag) {
    var res = cli.parseSessionArgs("list-outbound", ["--session", "1", flag, "x"], NOW);
    assert.match(res.error, /Unknown option for list-outbound/, flag);
  });
  assert.match(cli.parseSessionArgs("list-outbound", ["--session"], NOW).error, /Missing value/);
});

test("the request that reaches the daemon is the list_outbound command, with no sender reference", async function () {
  var sent;
  var env = { CLAGENTIC_CONSOLE_PROJECT: "p", CLAGENTIC_CONSOLE_SESSION_ID: "3" };
  var parsed = cli.parseSessionArgs("list-outbound", ["--session", "9"], NOW);
  parsed.request.cmd = "list_outbound";
  var res = await cli.requestDaemon(parsed.request, {
    isDaemonAlive: function () { return true; },
    sendIPC: function (req) { sent = req; return Promise.resolve({ ok: true, result: "listed", count: 0, messages: [] }); },
  });
  assert.equal(res.result, "listed");
  assert.deepEqual(sent, { sessionId: "9", cmd: "list_outbound" });
  // Unlike the verbs that send, reading needs no caller identity.
  assert.equal(cli.withSenderRef({}, {}).senderProject, undefined);
  assert.equal(cli.withSenderRef({}, env).senderProject, "p");
});

test("exit codes: listed is 0, a session id several projects hold is 3, a refusal is 1", function () {
  assert.equal(cli.exitCodeFor({ ok: true, result: "listed" }, {}), 0);
  assert.equal(cli.exitCodeFor({ ok: false, result: "ambiguous" }, {}), 3);
  assert.equal(cli.exitCodeFor({ ok: false, result: "refused" }, {}), 1);
});

test("with no daemon the verb reports it as the other verbs do", async function () {
  var res = await cli.requestDaemon({ cmd: "list_outbound", sessionId: "1" }, { isDaemonAlive: function () { return false; } });
  assert.deepEqual(res, { ok: false, result: "error", reason: "no running daemon" });
});

test("over a real Unix socket: the daemon-owner socket answers list_outbound from the ledger", async function () {
  if (process.platform === "win32") return;
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lo-"));
  var ledger = createOutboundLedger({ getBaseDir: function () { return dir; }, now: function () { return NOW; }, log: { error() {}, warn() {}, log() {} } });
  ledger.record({
    ts: new Date(NOW - 1000).toISOString(), verb: "send_input", result: "delivered", initiator: "trigger",
    sender: { kind: "extracted", attribution: "extracted", project: "p", sessionId: "3", cliSessionId: "cli-3" },
    target: { project: "q", sessionId: "4" }, prompt: "over the socket",
  });
  var query = createOutboundQuery({
    ledger: ledger,
    access: { canReadPrompt: function () { return { allowed: true }; } },
    caller: { user: null, authenticated: true },
  });
  var sock = path.join(dir, "d.sock");
  var server = createIPCServer(sock, function (msg) {
    return msg.cmd === "list_outbound" ? handleOutboundCommand(query, msg) : { ok: false, error: "unknown" };
  });
  try {
    for (var i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise(function (r) { setTimeout(r, 20); });
    var res = await sendIPCCommand(sock, { cmd: "list_outbound", sessionId: "cli-3", sinceMs: NOW - 60000, kind: "sent" }, 3000);
    assert.equal(res.result, "listed");
    assert.equal(res.count, 1);
    assert.equal(res.messages[0].prompt, "over the socket");
    assert.equal(res.messages[0].target.project, "q");
  } finally {
    server.close();
  }
});

test("daemon.js routes list_outbound to the outbound query beside the other session commands", function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  assert.match(src, /case "list_outbound":\s*return require\("\.\/session-input-ipc"\)\.handleOutboundCommand\(relay\.outboundQuery, msg\);/);
  var server = fs.readFileSync(path.join(__dirname, "..", "lib", "server.js"), "utf8");
  assert.match(server, /outboundQuery: _outboundQuery,/);
  assert.match(server, /outboundLedger: _outboundLedger,/);
});
