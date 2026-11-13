// The agent verbs as one literal command: list-sessions defaults and filters,
// the compact and verbose output of the listing verbs, -h/--help on every verb,
// and the ipc subcommands printing the daemon's whole answer with the output
// flushed. Each group is one table; a case is one row.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var net = require("net");
var os = require("os");
var path = require("path");
var childProcess = require("child_process");

var directory = require("../lib/session-directory");
var { createSessionInput } = require("../lib/session-input");
var cli = require("../lib/cli/session-subcommands");
var scheduleCli = require("../lib/cli/schedule-input-subcommands");
var agentUsage = require("../lib/cli/agent-usage");
var compact = require("../lib/cli/compact-output");
var { exitFlushed } = require("../lib/cli/output");
var { printDaemonJson } = require("../lib/cli/ipc-subcommands");

test.before(function () { return require("../lib/prompt-kinds/codecs").load(); });

var ROOT = path.join(__dirname, "..");
var CLI = path.join(ROOT, "bin", "cli.js");
var NOW = 1700000100000;

// A session as the manager holds it. runtime: "running" | "idle" | "reaped".
function session(localId, runtime, extra) {
  return Object.assign({
    localId: localId,
    cliSessionId: "cli-" + localId,
    agentName: "agent-a",
    vendor: "claude",
    title: "t" + localId,
    lastActivity: 1700000000000 + localId * 1000,
    createdAt: 1699990000000 + localId * 1000,
    isProcessing: runtime === "running",
    queryInstance: runtime === "reaped" ? null : {},
    history: [],
    pendingPermissions: {},
  }, extra || {});
}

function projectsOf(sessions) {
  var sm = { sessions: new Map(), defaultVendor: "claude" };
  sessions.forEach(function (s) { sm.sessions.set(s.localId, s); });
  return [{ slug: "lane", project: { sm: sm } }];
}

// One live, one idle, three reaped: ids 1 (reaped) to 5.
var FIVE = [session(1, "reaped"), session(2, "reaped"), session(3, "idle"), session(4, "running"), session(5, "reaped")];

function ids(result) {
  return result.entries.map(function (e) { return e.consoleSessionId; });
}

// --- directory: state filter and limit ---

[
  { name: "no state: live and idle only, newest first", filter: {}, ids: ["4", "3"], total: 2 },
  { name: "a comma list names each state", filter: { state: "live,reaped" }, ids: ["5", "4", "2", "1"], total: 4 },
  { name: "a list tolerates spaces and repeats", filter: { state: " idle , idle" }, ids: ["3"], total: 1 },
  { name: "reaped alone", filter: { state: "reaped" }, ids: ["5", "2", "1"], total: 3 },
  { name: "any returns every state", filter: { state: "any" }, ids: ["5", "4", "3", "2", "1"], total: 5 },
  { name: "limit keeps the newest after the sort", filter: { state: "any", limit: 2 }, ids: ["5", "4"], total: 5 },
  { name: "limit larger than the matches returns them all", filter: { limit: 50 }, ids: ["4", "3"], total: 2 },
].forEach(function (row) {
  test("directory list: " + row.name, function () {
    var found = directory.list(projectsOf(FIVE), Object.assign({ now: NOW }, row.filter));
    assert.deepEqual(ids(found), row.ids);
    assert.equal(found.total, row.total);
  });
});

[
  { name: "an unknown state names the valid ones", filter: { state: "asleep" }, match: /asleep.*live, idle, reaped, any/ },
  { name: "one bad name in a list refuses the list", filter: { state: "live,asleep" }, match: /asleep/ },
  { name: "an empty list entry is refused", filter: { state: "live," }, match: /unknown state ""/ },
  { name: "a limit of zero is refused", filter: { limit: 0 }, match: /limit/ },
  { name: "a fractional limit is refused", filter: { limit: 1.5 }, match: /limit/ },
  { name: "a text limit is refused", filter: { limit: "2" }, match: /limit/ },
].forEach(function (row) {
  test("directory list refuses: " + row.name, function () {
    var found = directory.list(projectsOf(FIVE), row.filter);
    assert.match(found.error, row.match);
  });
});

test("directory list: 200 sessions with one live lane give one row by default", function () {
  var many = [];
  for (var i = 1; i <= 199; i++) many.push(session(i, "reaped"));
  many.push(session(200, "running"));
  var found = directory.list(projectsOf(many), { now: NOW });
  assert.deepEqual(ids(found), ["200"]);
});

// --- list-sessions through session-input: verbose fields and host load ---

function inputFor(sessions, extra) {
  var projects = projectsOf(sessions);
  projects[0].project.sdk = {};
  return createSessionInput(Object.assign({
    getProject: function (slug) { return slug === "lane" ? projects[0].project : null; },
    listProjects: function () { return projects; },
  }, extra || {}));
}

var INJECTED = {
  type: "user_message", text: "hi", initiator: "trigger", entryFormat: 1, senderKind: "extracted",
  fromName: "user@example", senderProject: "ops", senderVendor: "claude", senderCliSessionId: "cli-sender",
};

test("list-sessions: the daemon's rows carry no verbose fields and no host by default", function () {
  var out = inputFor(FIVE).listSessions({});
  assert.equal(out.count, 2);
  assert.equal(out.total, 2);
  assert.equal(out.host, undefined);
  assert.equal(out.sessions[0].turnCount, undefined);
});

test("list-sessions: verbose adds opened-at, opener, last sender, turn count, mid-turn, memory and the host load", function () {
  var withHistory = session(4, "running", { turnCount: 7, history: [INJECTED, { type: "assistant" }] });
  var out = inputFor([session(3, "idle"), withHistory], { readMemAvailableMB: function () { return 2048; } }).listSessions({ verbose: true });
  var row = out.sessions[0];
  assert.equal(row.consoleSessionId, "4");
  assert.equal(row.openedAt, new Date(1699990004000).toISOString());
  assert.deepEqual(row.opener, { kind: "extracted", name: "user@example", project: "ops", initiator: "trigger" });
  assert.deepEqual(row.lastInjectedSender, { project: "ops", vendor: "claude", sessionId: "cli-sender", name: "user@example" });
  assert.equal(row.turnCount, 7);
  assert.equal(row.midTurn, true);
  assert.deepEqual(row.memory, { heapEntries: 2 });
  assert.deepEqual(out.host, { memAvailableMB: 2048, newWorkRefused: false });
  var quiet = out.sessions[1];
  assert.equal(quiet.opener, null);
  assert.equal(quiet.lastInjectedSender, null);
  assert.equal(quiet.midTurn, false);
});

test("list-sessions: a session whose history starts after its first message has no opener", function () {
  var trimmed = session(4, "idle", { history: [INJECTED], _historyBaseIndex: 40 });
  var row = inputFor([trimmed]).listSessions({ verbose: true }).sessions[0];
  assert.equal(row.opener, null);
  assert.equal(row.lastInjectedSender.name, "user@example");
});

test("list-sessions: the host load reads null free memory when the daemon gives no reader", function () {
  assert.equal(inputFor(FIVE).listSessions({ verbose: true }).host.memAvailableMB, null);
});

test("send-input: the candidates of an ambiguous address carry the verbose fields", function () {
  var twins = [session(1, "idle", { turnCount: 3 }), session(2, "idle", { turnCount: 9 })];
  var out = inputFor(twins).sendInput({ to: "agent-a@lane", prompt: "go" });
  assert.equal(out.result, "ambiguous");
  assert.deepEqual(out.candidates.map(function (c) { return c.turnCount; }).sort(), [3, 9]);
  out.candidates.forEach(function (c) {
    assert.ok("openedAt" in c && "midTurn" in c && "memory" in c && "lastInjectedSender" in c);
  });
});

// --- CLI parsing ---

[
  { args: [], request: {} },
  { args: ["--state", "live,idle"], request: { state: "live,idle" } },
  { args: ["--limit", "3"], request: { limit: 3 } },
  { args: ["--verbose"], request: { verbose: true } },
  { args: ["--project", "p", "--state", "any", "--limit", "1", "--verbose"], request: { projectSlug: "p", state: "any", limit: 1, verbose: true } },
].forEach(function (row) {
  test("cli list-sessions parses " + JSON.stringify(row.args), function () {
    assert.deepEqual(cli.parseSessionArgs("list-sessions", row.args).request, row.request);
  });
});

[
  { verb: "list-sessions", args: ["--limit", "0"], match: /--limit/ },
  { verb: "list-sessions", args: ["--limit", "two"], match: /--limit/ },
  { verb: "list-sessions", args: ["--limit"], match: /Missing value/ },
  { verb: "list-outbound", args: ["--session", "x", "--limit", "2"], match: /Unknown option/ },
  { verb: "send-input", args: ["--to", "a@b", "--prompt", "x", "--verbose"], match: /Unknown option/ },
].forEach(function (row) {
  test("cli " + row.verb + " refuses " + JSON.stringify(row.args), function () {
    assert.match(cli.parseSessionArgs(row.verb, row.args).error, row.match);
  });
});

test("cli list-outbound takes --verbose", function () {
  assert.equal(cli.parseSessionArgs("list-outbound", ["--session", "abc", "--verbose"]).request.verbose, true);
});

test("cli schedule-input list takes --verbose, create does not", function () {
  assert.equal(scheduleCli.parseScheduleArgs("list", ["--verbose"], NOW, {}).verbose, true);
  assert.equal(scheduleCli.parseScheduleArgs("list", [], NOW, {}).verbose, false);
  assert.match(scheduleCli.parseScheduleArgs("delete", ["--id", "x", "--verbose"], NOW, {}).error, /Unknown option/);
});

// --- compact and verbose output ---

var SESSION_RESULT = {
  ok: true, result: "listed", count: 1, total: 1,
  sessions: [Object.assign(directory.collect(projectsOf([session(4, "running")]), NOW)[0], { turnCount: 2 })],
};
var OUTBOUND_RESULT = {
  ok: true, result: "listed", retentionDays: 30, session: { id: "s", project: "p" }, count: 1,
  messages: [{
    formatVersion: 1, ts: "2026-01-01T00:00:00Z", verb: "send_input", kind: "sent", result: "delivered", messageId: "m1",
    initiator: "trigger", sender: { kind: "extracted" }, target: { project: "p", sessionId: "4", cliSessionId: "c", agent: "a", vendor: "claude", name: "n", runsAs: "daemon", address: "a@p" },
    prompt: "hello", contextNote: "note",
  }],
  unattributedCount: 1, unattributed: [{ ts: "x" }], unattributedNote: "text",
};
var SCHEDULED_RESULT = {
  ok: true, result: "listed", count: 1,
  inputs: [{ id: "i1", project: "p", sessionId: "4", kind: "once", state: "armed", preview: "go", createdBy: "cli", at: 5, nextAt: 5, every: null, until: null, count: null, firedCount: 0, lastFiredAt: null, lastOutcome: null, endReason: null }],
  storeErrors: [{ project: "p", state: "unhealthy" }],
};

[
  { name: "list-sessions rows", fn: compact.compactSessions, input: SESSION_RESULT, rows: function (r) { return r.sessions; }, keys: compact.SESSION_ROW },
  { name: "schedule-input list rows", fn: compact.compactScheduled, input: SCHEDULED_RESULT, rows: function (r) { return r.inputs; }, keys: compact.SCHEDULED_ROW },
  { name: "list-outbound rows", fn: compact.compactOutbound, input: OUTBOUND_RESULT, rows: function (r) { return r.messages; }, keys: compact.OUTBOUND_ROW.concat(["target"]) },
].forEach(function (row) {
  test("compact: " + row.name + " keep only the compact field set", function () {
    var out = row.fn(row.input);
    row.rows(out).forEach(function (r) {
      Object.keys(r).forEach(function (k) { assert.ok(row.keys.indexOf(k) !== -1, "unexpected field " + k); });
    });
    assert.ok(Object.keys(row.rows(out)[0]).length >= 5);
  });
});

test("compact: list-sessions drops what the label and state already say, and keeps what a next call needs", function () {
  var row = compact.compactSessions(SESSION_RESULT).sessions[0];
  ["agent", "vendor", "title", "turnCount"].forEach(function (k) { assert.equal(k in row, false, k); });
  ["consoleSessionId", "sessionId", "label", "state", "pendingPrompts"].forEach(function (k) { assert.equal(k in row, true, k); });
});

test("compact: list-outbound keeps the prompt and the target address, counts what it leaves out", function () {
  var out = compact.compactOutbound(OUTBOUND_RESULT);
  assert.equal(out.messages[0].prompt, "hello");
  assert.deepEqual(out.messages[0].target, { project: "p", sessionId: "4", agent: "a", name: "n", address: "a@p" });
  assert.equal(out.unattributedCount, 1);
  ["unattributed", "unattributedNote", "retentionDays"].forEach(function (k) { assert.equal(k in out, false, k); });
});

test("compact: a store health report is kept on schedule-input list", function () {
  assert.deepEqual(compact.compactScheduled(SCHEDULED_RESULT).storeErrors, SCHEDULED_RESULT.storeErrors);
});

[
  { verb: "list-sessions", res: SESSION_RESULT },
  { verb: "list-outbound", res: OUTBOUND_RESULT },
  { verb: "send-input", res: { ok: true, result: "delivered", extra: 1 } },
].forEach(function (row) {
  test("verbose: " + row.verb + " prints the daemon's whole answer", function () {
    assert.deepEqual(cli.presentResult(row.verb, row.res, true), row.res);
  });
});

test("verbose: schedule-input list prints the whole record, compact otherwise", function () {
  assert.deepEqual(scheduleCli.presentResult("list", SCHEDULED_RESULT, true), SCHEDULED_RESULT);
  assert.equal("createdBy" in scheduleCli.presentResult("list", SCHEDULED_RESULT, false).inputs[0], false);
  assert.deepEqual(scheduleCli.presentResult("delete", { ok: true, result: "deleted" }, false), { ok: true, result: "deleted" });
});

[
  { name: "a refusal", res: { ok: false, result: "refused", reason: "unknown project" } },
  { name: "an ambiguity", res: { ok: false, result: "ambiguous", candidates: [{ consoleSessionId: "1", title: "kept" }] } },
].forEach(function (row) {
  test("compact: " + row.name + " passes through whole", function () {
    [compact.compactSessions, compact.compactOutbound, compact.compactScheduled].forEach(function (fn) {
      assert.deepEqual(fn(row.res), row.res);
    });
  });
});

// --- help: the usage source and what a verb does with -h ---

[
  { name: "a flag", args: ["--limit", "2", "--help"], help: true },
  { name: "-h alone", args: ["-h"], help: true },
  { name: "the text of a value that reads --help", args: ["--prompt", "--help"], help: false },
  { name: "no help", args: ["--verbose"], help: false },
].forEach(function (row) {
  test("wantsHelp: " + row.name, function () {
    assert.equal(agentUsage.wantsHelp(row.args, ["--prompt", "--limit"]), row.help);
  });
});

test("usage source: every verb has usage naming the product command, no bare brand word", function () {
  agentUsage.VERB_ORDER.forEach(function (key) {
    assert.match(agentUsage.usageLine(key), /^Usage: clagentic-console /);
    assert.doesNotMatch(agentUsage.helpText(key), /clagentic(?!-console)/);
  });
  assert.equal(agentUsage.topLevelLines().length, agentUsage.VERB_ORDER.length + 3);
});

test("usage source: the session verbs and schedule-input subcommands read it", function () {
  assert.equal(scheduleCli.USAGE.list, agentUsage.usageLine("schedule-input list"));
  assert.match(scheduleCli.helpFor(["--help"]), /schedule-input create[\s\S]*schedule-input list[\s\S]*schedule-input delete/);
  assert.equal(scheduleCli.helpFor(["list", "--help"]), agentUsage.helpText("schedule-input list"));
  assert.equal(scheduleCli.helpFor(["list", "--state", "any"]), null);
});

// A console home the CLI finds already migrated: a first run over an empty home
// prints migration notices (the data dir, a legacy recent-projects file) on
// stdout, which these tests must not see.
function quietHome(prefix) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, "console"), { recursive: true });
  fs.writeFileSync(path.join(home, "console", ".migrated"), "");
  fs.writeFileSync(path.join(home, "console", "recent-projects.json"), "[]");
  return home;
}

// One in-process table: every agent verb and subcommand, each with -h and --help.
// The verb prints through console.log and sets process.exitCode; the capture below
// feeds that output to exitFlushed's injected io, so the stream and the exit code
// are read the way the CLI ends.
var CASES = [];
agentUsage.VERB_ORDER.forEach(function (key) {
  ["-h", "--help"].forEach(function (flag) {
    CASES.push({ key: key, args: key.split(" ").concat([flag]) });
  });
});
CASES.push({ key: "schedule-input", args: ["schedule-input", "--help"] });
CASES.push({ key: "schedule-input", args: ["schedule-input", "-h"] });

function runVerbInProcess(args) {
  var original = console.log;
  var savedExitCode = process.exitCode;
  var text = "";
  console.log = function (s) { text += s + "\n"; };
  process.exitCode = undefined;
  var code;
  try {
    if (args[0] === "schedule-input") scheduleCli.runScheduleInput(args.slice(1));
    else cli.runSessionVerb(args[0], args.slice(1));
    code = process.exitCode;
  } finally {
    console.log = original;
    process.exitCode = savedExitCode;
  }
  return new Promise(function (resolve) {
    var err = "";
    var sink = function (collect) {
      return { write: function (chunk, cb) { collect(chunk); cb(); } };
    };
    exitFlushed(code, {
      out: sink(function () {}),
      err: sink(function (c) { err += c; }),
      exit: function (exitCode) { resolve({ stdout: text, stderr: err, status: exitCode }); },
    });
  });
}

CASES.forEach(function (c) {
  test("help: " + c.args.join(" ") + " prints usage on stdout and exits 0", async function () {
    var res = await runVerbInProcess(c.args);
    assert.equal(res.status, 0);
    assert.match(res.stdout, new RegExp("^Usage: clagentic-console " + c.key));
    assert.equal(res.stderr, "");
  });
});

// The one real process: dispatch from bin/cli.js, the stream and the exit code.
test("help: a real process answers send-input --help with usage on stdout and exit 0", function () {
  var home = quietHome("agentverbs-");
  try {
    var res = childProcess.spawnSync(process.execPath, [CLI, "send-input", "--help"], {
      encoding: "utf8",
      timeout: 15000,
      cwd: home,
      env: Object.assign({}, process.env, { CLAGENTIC_CONSOLE_HOME: home }),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^Usage: clagentic-console send-input/);
    assert.equal(res.stderr, "");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- ipc subcommands: the whole answer, flushed ---

test("printDaemonJson prints every field but the ok envelope", function () {
  var lines = [];
  var original = console.log;
  console.log = function (s) { lines.push(s); };
  try {
    printDaemonJson({ ok: true, activeLiveCount: 1, openSockets: { p: 2 }, aFieldAddedLater: [1] });
  } finally {
    console.log = original;
  }
  assert.deepEqual(JSON.parse(lines[0]), { activeLiveCount: 1, openSockets: { p: 2 }, aFieldAddedLater: [1] });
});

test("exitFlushed exits only after stderr and then stdout have drained", function () {
  var events = [];
  var stream = function (name) {
    return { write: function (chunk, cb) { events.push(name + " write"); setImmediate(function () { events.push(name + " drained"); cb(); }); } };
  };
  return new Promise(function (resolve) {
    exitFlushed(3, { out: stream("out"), err: stream("err"), exit: function (code) { events.push("exit " + code); resolve(); } });
  }).then(function () {
    assert.deepEqual(events, ["err write", "err drained", "out write", "out drained", "exit 3"]);
  });
});

// A stand-in daemon on the socket the CLI looks for, answering every command
// with `answer`. The test's own pid stands in for the daemon's.
function fakeDaemon(home, answer) {
  var dir = path.join(home, "console");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "daemon.json"), JSON.stringify({ pid: process.pid }));
  var server = net.createServer(function (conn) {
    var buffer = "";
    conn.on("data", function (chunk) {
      buffer += chunk;
      if (buffer.indexOf("\n") === -1) return;
      conn.end(JSON.stringify(answer) + "\n");
    });
    conn.on("error", function () {});
  });
  return new Promise(function (resolve) {
    server.listen(path.join(dir, "daemon.sock"), function () { resolve(server); });
  });
}

// Runs the CLI with stdout piped and left unread for a moment, so a large answer
// has to wait for the reader; resolves { status, stdout }.
function runPiped(home, args) {
  return new Promise(function (resolve) {
    var child = childProcess.spawn(process.execPath, [CLI].concat(args), {
      cwd: home,
      env: Object.assign({}, process.env, { CLAGENTIC_CONSOLE_HOME: home }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    var chunks = [];
    child.stdout.pause();
    setTimeout(function () {
      child.stdout.on("data", function (c) { chunks.push(c); });
      child.stdout.resume();
    }, 400);
    child.on("close", function (status) { resolve({ status: status, stdout: Buffer.concat(chunks).toString("utf8") }); });
  });
}

// --- --restart: the sessions in flight, a wait that only a new pid ends, the build read ---

var { runRestart, humanLines, EXIT } = require("../lib/cli/restart-verb");

var OLD = 100;
var NEW = 200;
var BUILD = { loadedBuildSha: "aaa", installedBuildSha: "aaa", state: "adopted" };
var STATUS_OLD = Object.assign({ ok: true, pid: OLD }, BUILD);
var STATUS_NEW = Object.assign({ ok: true, pid: NEW }, BUILD);
var FLIGHT = { ok: true, sessions: [{ project: "lane", session: 4, processing: true, activity: "running" }] };

// The daemon's answers in order per command; the last one repeats. Records the
// commands sent and moves the clock on each sleep.
function scripted(answers) {
  var sent = [];
  var seen = {};
  var clock = 0;
  return {
    sent: sent,
    deps: {
      send: function (msg) {
        sent.push(msg.cmd);
        var list = answers[msg.cmd];
        var i = seen[msg.cmd] || 0;
        seen[msg.cmd] = i + 1;
        return Promise.resolve(list[Math.min(i, list.length - 1)]);
      },
      sleep: function (ms) { clock += ms; return Promise.resolve(); },
      now: function () { return clock; },
    },
  };
}

[
  { name: "sessions in flight are reported and the restart still proceeds",
    answers: { get_build_status: [STATUS_OLD, STATUS_NEW], get_interruptions: [FLIGHT], restart: [{ ok: true }] },
    code: EXIT.OK, outcome: "restarted", sessions: FLIGHT.sessions, newPid: NEW, sent: ["get_build_status", "get_interruptions", "restart", "get_build_status"] },
  { name: "the old process answering after the restart is never accepted",
    answers: { get_build_status: [STATUS_OLD, STATUS_OLD, STATUS_OLD, { ok: false, error: "daemon not responding" }, STATUS_NEW], get_interruptions: [FLIGHT], restart: [{ ok: true }] },
    code: EXIT.OK, outcome: "restarted", sessions: FLIGHT.sessions, newPid: NEW, sent: ["get_build_status", "get_interruptions", "restart", "get_build_status", "get_build_status", "get_build_status", "get_build_status"] },
  { name: "no new process in time: timeout, with what was last seen",
    answers: { get_build_status: [STATUS_OLD], get_interruptions: [FLIGHT], restart: [{ ok: true }] },
    opts: { timeoutMs: 2000, pollMs: 500 },
    code: EXIT.TIMEOUT, outcome: "timeout", sessions: FLIGHT.sessions, newPid: null, lastSeen: { pid: OLD, state: "adopted", error: null } },
  { name: "a new process that loaded another build than the installed one is a mismatch",
    answers: { get_build_status: [STATUS_OLD, { ok: true, pid: NEW, loadedBuildSha: "aaa", installedBuildSha: "bbb", state: "stale" }], get_interruptions: [{ ok: true, sessions: [] }], restart: [{ ok: true }] },
    code: EXIT.BUILD_MISMATCH, outcome: "build-mismatch", sessions: [], newPid: NEW, state: "stale", loadedBuildSha: "aaa", installedBuildSha: "bbb" },
  { name: "a daemon that cannot list sessions still restarts, sessions null",
    answers: { get_build_status: [STATUS_OLD, STATUS_NEW], get_interruptions: [{ ok: false, error: "unknown command" }], restart: [{ ok: true }] },
    code: EXIT.OK, outcome: "restarted", sessions: null, newPid: NEW },
  { name: "a restart the daemon does not acknowledge fails",
    answers: { get_build_status: [STATUS_OLD], get_interruptions: [FLIGHT], restart: [{ ok: false, error: "timeout" }] },
    code: EXIT.FAILED, outcome: "restart-not-acknowledged", newPid: null, sent: ["get_build_status", "get_interruptions", "restart"] },
  { name: "an unknown old pid sends no restart, as the new process could not be told apart",
    answers: { get_build_status: [{ ok: false, error: "timeout" }], get_interruptions: [FLIGHT], restart: [{ ok: true }] },
    code: EXIT.FAILED, outcome: "old-pid-unknown", newPid: null, sent: ["get_build_status"] },
].forEach(function (row) {
  test("restart verb: " + row.name, async function () {
    var run = scripted(row.answers);
    var result = await runRestart(run.deps, row.opts);
    assert.equal(result.code, row.code);
    assert.equal(result.report.outcome, row.outcome);
    assert.equal(result.report.newPid, row.newPid);
    ["sessions", "lastSeen", "state", "loadedBuildSha", "installedBuildSha"].forEach(function (field) {
      if (row[field] !== undefined) assert.deepEqual(result.report[field], row[field]);
    });
    if (row.sent) assert.deepEqual(run.sent, row.sent);
    if (row.outcome !== "old-pid-unknown") assert.equal(result.report.oldPid, OLD);
  });
});

test("restart verb: human text names the new process only after it is up, and the mismatch with both shas", function () {
  var ok = humanLines({ code: 0, report: { outcome: "restarted", oldPid: OLD, newPid: NEW, loadedBuildSha: "aaa", sessions: FLIGHT.sessions } });
  assert.match(ok.join("\n"), /Server restarted \(pid 100 -> 200/);
  var bad = humanLines({ code: 3, report: { outcome: "build-mismatch", oldPid: OLD, newPid: NEW, loadedBuildSha: "aaa", installedBuildSha: "bbb", state: "stale" } });
  assert.match(bad.join("\n"), /loaded aaa, installed bbb, state stale/);
});

// Runs the CLI and reads its output as it comes; resolves { status, stdout }.
function runCli(home, args) {
  return new Promise(function (resolve) {
    var child = childProcess.spawn(process.execPath, [CLI].concat(args), {
      cwd: home,
      env: Object.assign({}, process.env, { CLAGENTIC_CONSOLE_HOME: home }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    var chunks = [];
    child.stdout.on("data", function (c) { chunks.push(c); });
    child.on("close", function (status) { resolve({ status: status, stdout: Buffer.concat(chunks).toString("utf8") }); });
  });
}

// The real CLI against a daemon that answers as the old process until it is asked
// to restart, then as a new pid.
function restartingDaemon(home, build) {
  var dir = path.join(home, "console");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "daemon.json"), JSON.stringify({ pid: process.pid }));
  var restarted = false;
  var server = net.createServer(function (conn) {
    var buffer = "";
    conn.on("data", function (chunk) {
      buffer += chunk;
      if (buffer.indexOf("\n") === -1) return;
      var cmd = JSON.parse(buffer.split("\n")[0]).cmd;
      var answer = { ok: false, error: "unknown command" };
      if (cmd === "get_interruptions") answer = FLIGHT;
      if (cmd === "restart") { restarted = true; answer = { ok: true }; }
      if (cmd === "get_build_status") answer = Object.assign({ ok: true, pid: restarted ? process.pid + 1 : process.pid }, build);
      conn.end(JSON.stringify(answer) + "\n");
    });
    conn.on("error", function () {});
  });
  return new Promise(function (resolve) {
    server.listen(path.join(dir, "daemon.sock"), function () { resolve(server); });
  });
}

[
  { name: "--restart --json prints one report and exits 0", args: ["--restart", "--json"], build: BUILD, status: 0,
    check: function (out) {
      var r = JSON.parse(out);
      assert.equal(r.outcome, "restarted");
      assert.equal(r.newPid, r.oldPid + 1);
      assert.deepEqual(r.sessions, FLIGHT.sessions);
      assert.equal(r.loadedBuildSha, "aaa");
      assert.equal(r.state, "adopted");
    } },
  { name: "--restart --json exits 3 when the new process did not load the installed build", args: ["--restart", "--json"],
    build: { loadedBuildSha: "aaa", installedBuildSha: "bbb", state: "stale" }, status: 3,
    check: function (out) { assert.equal(JSON.parse(out).installedBuildSha, "bbb"); } },
  { name: "--restart without --json keeps human text", args: ["--restart"], build: BUILD, status: 0,
    check: function (out) { assert.match(out, /Server restarted \(pid \d+ -> \d+/); } },
].forEach(function (row) {
  test("clagentic-console " + row.name, async function () {
    var home = quietHome("restartverb-");
    var server = await restartingDaemon(home, row.build);
    try {
      var run = await runCli(home, row.args);
      assert.equal(run.status, row.status);
      row.check(run.stdout);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

var BIG = [];
for (var n = 0; n < 40000; n++) BIG.push({ rawIsProcessing: true, derivedIsActive: false, note: "x".repeat(40) });

[
  { flag: "--activity-diagnostics", answer: { ok: true, activeLiveCount: 2, activityDivergenceCount: 40000, activityDivergenceRecentSamples: BIG, openSockets: { lane: { open: 3 } }, aFieldAddedLater: "kept" }, field: "openSockets", value: { lane: { open: 3 } } },
  { flag: "--usage", answer: { ok: true, generatedAt: "t", staleAfterSeconds: 60, vendors: { claude: { big: BIG } }, aFieldAddedLater: "kept" }, field: "aFieldAddedLater", value: "kept" },
  { flag: "--process-build-status", answer: { ok: true, loadedBuildSha: "abc", state: "adopted", pid: 1, aFieldAddedLater: BIG }, field: "loadedBuildSha", value: "abc" },
].forEach(function (row) {
  test("clagentic-console " + row.flag + " prints the whole daemon answer, complete on a slow pipe", async function () {
    var home = quietHome("ipcflush-");
    var server = await fakeDaemon(home, row.answer);
    try {
      var run = await runPiped(home, [row.flag]);
      assert.equal(run.status, 0);
      var printed = JSON.parse(run.stdout);
      assert.deepEqual(printed[row.field], row.value);
      var expected = Object.assign({}, row.answer);
      delete expected.ok;
      assert.deepEqual(printed, expected);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
