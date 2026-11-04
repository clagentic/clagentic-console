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

// The daemon's own IPC routing: the real lib/daemon.js, in a temporary home,
// answering list_outbound on its real socket (the harness of
// daemon-ipc-memory-setter-parity-lr-553d27.test.js). The handler under test is
// the one the daemon registers, not one the test installs.
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function freePort() {
  return new Promise(function (resolve, reject) {
    var srv = require("net").createServer();
    srv.listen(0, "127.0.0.1", function () {
      var p = srv.address().port;
      srv.close(function () { resolve(p); });
    });
    srv.on("error", reject);
  });
}

function stopProcess(proc) {
  return new Promise(function (resolve) {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.once("exit", resolve);
    try { proc.kill("SIGTERM"); } catch (e) { /* already gone */ }
    setTimeout(function () {
      try { proc.kill("SIGKILL"); } catch (e) { /* already gone */ }
      resolve();
    }, 4000);
  });
}

test("daemon routing: list_outbound reaches the outbound query through the daemon's own IPC handler", { timeout: 60000 }, async function (t) {
  if (process.platform === "win32") return;
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "lo-daemon-"));
  var consoleDir = path.join(home, "console");
  fs.mkdirSync(consoleDir, { recursive: true });
  var sock = path.join(consoleDir, "daemon.sock");
  var configFile = path.join(consoleDir, "daemon.json");
  fs.writeFileSync(configFile, JSON.stringify({ port: await freePort(), host: "127.0.0.1", tls: false, debug: false, projects: [] }), { mode: 0o600 });

  var now = Date.now();
  var seeded = createOutboundLedger({ getBaseDir: function () { return consoleDir; }, log: { error() {}, warn() {}, log() {} } });
  seeded.record({
    ts: new Date(now - 1000).toISOString(), verb: "send_input", result: "delivered", initiator: "trigger",
    sender: { kind: "extracted", attribution: "extracted", project: "p", sessionId: "3", cliSessionId: "cli-3" },
    target: { project: "q", sessionId: "4", runsAs: "daemon" }, prompt: "through the daemon",
  });

  var log = [];
  var proc = require("child_process").spawn(process.execPath, [path.resolve(__dirname, "..", "lib", "daemon.js")], {
    env: Object.assign({}, process.env, { CLAGENTIC_HOME: home, CLAGENTIC_CONFIG: configFile }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", function (d) { log.push(d.toString()); });
  proc.stderr.on("data", function (d) { log.push("[err] " + d.toString()); });
  t.after(function () {
    return stopProcess(proc).then(function () { fs.rmSync(home, { recursive: true, force: true }); });
  });

  var started = Date.now();
  for (;;) {
    if (Date.now() - started > 20000) throw new Error("daemon IPC did not answer\n" + log.slice(-20).join(""));
    if (fs.existsSync(sock)) {
      var status = await sendIPCCommand(sock, { cmd: "get_status" }, 1000).catch(function () { return null; });
      if (status && status.ok) break;
    }
    await sleep(100);
  }

  var listed = await sendIPCCommand(sock, { cmd: "list_outbound", sessionId: "cli-3", kind: "sent" }, 3000);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.result, "listed");
  assert.equal(listed.count, 1);
  assert.equal(listed.messages[0].prompt, "through the daemon");
  assert.equal(listed.messages[0].kind, "sent");
  assert.equal(listed.messages[0].target.project, "q");
  assert.equal(listed.retentionDays, 30);

  var refusedRes = await sendIPCCommand(sock, { cmd: "list_outbound", sessionId: "../x" }, 3000);
  assert.equal(refusedRes.result, "refused");
  assert.equal(cli.exitCodeFor(refusedRes, {}), 1);

  // A ledger the daemon cannot read comes back as an error, not an empty list.
  fs.rmSync(path.join(consoleDir, "outbound"), { recursive: true });
  fs.mkdirSync(path.join(consoleDir, "outbound"));
  fs.writeFileSync(path.join(consoleDir, "outbound", "sessions"), "not a directory");
  var broken = await sendIPCCommand(sock, { cmd: "list_outbound", sessionId: "cli-3" }, 3000);
  assert.equal(broken.ok, false);
  assert.equal(broken.result, "error");
  assert.match(broken.reason, /ENOTDIR/);
  assert.equal(cli.exitCodeFor(broken, {}), 1);
});
