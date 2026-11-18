"use strict";
// How each delivered turn was started, kept per session and read back by a hook
// through `clagentic-console turn-origin`: the initiator-to-answer table, the
// lookup, the record at the sdk-bridge hand-off, its bound and release, the
// verb, and that nothing outside the delivery code can write the record.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var childProcess = require("child_process");
var nodeModule = require("node:module");
var { pathToFileURL } = require("url");

nodeModule.register(pathToFileURL(path.join(__dirname, "fixtures", "fake-agent-sdk", "resolve-hook.mjs")).href);

var turnOrigin = require("../lib/turn-origin");
var turnInitiator = require("../lib/turn-initiator");
var claudeModule = require("../lib/yoke/adapters/claude");
var cli = require("../lib/cli/turn-origin-subcommand");
var { createIPCServer, sendIPCCommand } = require("../lib/ipc");
var { INITIATORS } = turnInitiator;

var CLI = path.join(__dirname, "..", "bin", "cli.js");

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function lastFakeQuery() {
  var all = globalThis.__fakeAgentSdkQueries || [];
  return all[all.length - 1];
}

// A store holding the given sessions under one project, as the daemon's
// getProject / forEachProject expose it.
function storeOf(slug, sessions) {
  var project = { sm: { sessions: new Map(sessions.map(function (s) { return [s.localId, s]; })) } };
  return {
    getProject: function (s) { return s === slug ? project : null; },
    forEachProject: function (fn) { fn(project, slug); },
  };
}

// --- The answer for each initiator (AC1-AC5) ---

[
  { initiator: INITIATORS.HUMAN, origin: "user" },
  { initiator: INITIATORS.SCHEDULED, origin: "schedule_wakeup" },
  { initiator: INITIATORS.SCHEDULED_NOW, origin: "schedule_wakeup" },
  { initiator: INITIATORS.LOOP, origin: "loop_wakeup" },
  { initiator: INITIATORS.TRIGGER, origin: "system" },
  { initiator: undefined, origin: "unknown" },
  { initiator: null, origin: "unknown" },
  { initiator: "robot", origin: "unknown" },
].forEach(function (row) {
  test("a turn started as " + String(row.initiator) + " answers " + row.origin, function () {
    var session = {};
    turnOrigin.record(session, { text: "hello", initiator: row.initiator, messageId: "m1" });
    assert.equal(turnOrigin.lookup(session, "hello"), row.origin);
  });
});

// --- Lookup over a store (AC5, AC6, AC9) ---

test("lookup: the session key, the prompt match and the most recent turn win", function () {
  var a = { localId: 1, cliSessionId: "vendor-a" };
  var b = { localId: 2, cliSessionId: "vendor-b" };
  turnOrigin.record(a, { text: "same text", initiator: INITIATORS.HUMAN });
  turnOrigin.record(a, { text: "other", initiator: INITIATORS.LOOP });
  turnOrigin.record(a, { text: "same text", initiator: INITIATORS.TRIGGER });
  turnOrigin.record(b, { text: "same text", initiator: INITIATORS.SCHEDULED });
  var store = storeOf("p", [a, b]);
  var ask = function (req) { return turnOrigin.answer(store, req); };

  [
    { name: "console reference", req: { project: "p", sessionId: "1", prompt: "other" }, origin: "loop_wakeup" },
    { name: "console reference, id as a number", req: { project: "p", sessionId: 2, prompt: "same text" }, origin: "schedule_wakeup" },
    { name: "vendor session id", req: { cliSessionId: "vendor-b", prompt: "same text" }, origin: "schedule_wakeup" },
    { name: "same text twice: the most recent turn", req: { project: "p", sessionId: "1", prompt: "same text" }, origin: "system" },
    { name: "surrounding whitespace is not part of the text", req: { project: "p", sessionId: "1", prompt: "  other\n" }, origin: "loop_wakeup" },
    { name: "text no turn carries", req: { project: "p", sessionId: "1", prompt: "never sent" }, origin: "unknown" },
    { name: "no prompt", req: { project: "p", sessionId: "1" }, origin: "unknown" },
    { name: "a turn of another session is not matched", req: { project: "p", sessionId: "2", prompt: "other" }, origin: "unknown" },
    { name: "a session the console does not host", req: { cliSessionId: "vendor-z", prompt: "other" }, origin: "unknown" },
    { name: "an unknown project", req: { project: "nope", sessionId: "1", prompt: "other" }, origin: "unknown" },
    { name: "an unknown console id", req: { project: "p", sessionId: "99", prompt: "other" }, origin: "unknown" },
    { name: "no key at all", req: { prompt: "other" }, origin: "unknown" },
    { name: "a half reference does not fall back to the vendor id", req: { project: "p", cliSessionId: "vendor-a", prompt: "other" }, origin: "unknown" },
  ].forEach(function (row) {
    var res = ask(row.req);
    assert.equal(res.ok, true, row.name);
    assert.equal(res.origin, row.origin, row.name);
  });
});

// --- Bound and release (AC10) ---

test("the record keeps the newest turns up to its bound", function () {
  var session = {};
  var total = turnOrigin.MAX_TURNS_PER_SESSION + 10;
  for (var i = 0; i < total; i++) turnOrigin.record(session, { text: "turn " + i, initiator: INITIATORS.HUMAN });
  assert.equal(turnOrigin.sizeOf(session), turnOrigin.MAX_TURNS_PER_SESSION);
  assert.equal(turnOrigin.lookup(session, "turn 0"), "unknown");
  assert.equal(turnOrigin.lookup(session, "turn 9"), "unknown");
  assert.equal(turnOrigin.lookup(session, "turn 10"), "user");
  assert.equal(turnOrigin.lookup(session, "turn " + (total - 1)), "user");
});

test("a long prompt costs no more to hold than a short one, and still matches", function () {
  var session = {};
  var long = "x".repeat(1024 * 1024);
  turnOrigin.record(session, { text: long, initiator: INITIATORS.TRIGGER });
  assert.equal(turnOrigin.lookup(session, long), "system");
});

test("releasing a session drops its record; the store no longer answers for it", function () {
  var session = { localId: 1, cliSessionId: "v" };
  turnOrigin.record(session, { text: "kept", initiator: INITIATORS.HUMAN });
  var store = storeOf("p", [session]);
  assert.equal(turnOrigin.answer(store, { project: "p", sessionId: "1", prompt: "kept" }).origin, "user");
  turnOrigin.release(session);
  assert.equal(turnOrigin.sizeOf(session), 0);
  assert.equal(turnOrigin.answer(store, { project: "p", sessionId: "1", prompt: "kept" }).origin, "unknown");
});

test("deleting a session through the session manager releases its record", function () {
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "sessions.js"), "utf8");
  // Both delete paths release it, right where the session leaves the map.
  var releases = source.match(/sessions\.delete\(localId\);\s*turnOrigin\.release\(session\);/g) || [];
  assert.equal(releases.length, 2);
});

test("a record failure is logged and never thrown", function () {
  var original = console.error;
  var logged = [];
  console.error = function (m) { logged.push(String(m)); };
  try {
    var hostile = { get text() { throw new Error("boom"); } };
    assert.doesNotThrow(function () { turnOrigin.record({}, hostile); });
    assert.doesNotThrow(function () { turnOrigin.record(null, { text: "x" }); });
    assert.doesNotThrow(function () { turnOrigin.record({}, { text: 5 }); });
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /could not record a turn/);
});

// --- The record at the sdk-bridge hand-off (AC1-AC4) ---

function makeBridge(slug, localId) {
  var realAdapter = claudeModule.createClaudeAdapter({ cwd: os.tmpdir() });
  var adapter = {
    vendor: "claude",
    createQuery: realAdapter.createQuery,
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
  };
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  var { createSDKBridge } = require("../lib/sdk-bridge");
  var noopFn = function () {};
  var sm = {
    sessions: new Map(), currentModel: null, currentPermissionMode: null, currentEffort: null, currentBetas: [],
    modelsByVendor: {}, availableVendors: [], installedVendors: [], defaultVendor: "claude",
    saveSessionFile: noopFn, broadcastSessionList: noopFn, getActiveSession: function () { return null; },
    setSlashCommandsForVendor: noopFn, sendAndRecord: noopFn, sendToSession: noopFn,
  };
  var bridge = createSDKBridge({
    cwd: os.tmpdir(), slug: slug, sessionManager: sm, send: noopFn,
    adapter: adapter, adapters: { claude: adapter }, onProcessingChanged: noopFn, getConfig: null,
  });
  var session = {
    localId: localId, queryInstance: null, messageQueue: null, abortController: null, isProcessing: false,
    cliSessionId: "vendor-" + localId, history: [], blocks: {}, sentToolResults: {}, pendingPermissions: {}, pendingAskUser: {},
    pendingElicitations: {}, activeTaskToolIds: {}, singleTurn: false, lastActivityAt: Date.now(),
    _isCountedLive: false, _adapterWorkerState: null, _workerExitPromise: null,
  };
  sm.sessions.set(session.localId, session);
  return { bridge: bridge, session: session, sm: sm };
}

test("every hand-off to the agent is recorded with its initiator, and what is delivered is unchanged", async function () {
  var h = makeBridge("turn-origin-handoff", 9100);
  var bridge = h.bridge;
  var session = h.session;

  // Buffered while no query is live, then replayed when one starts.
  bridge.pushMessage(session, "buffered trigger", undefined, INITIATORS.TRIGGER, "u-buf");
  assert.equal(turnOrigin.sizeOf(session), 0, "a buffered turn is recorded when it is handed over, not before");
  await bridge.startQuery(session, "typed turn", undefined, null, INITIATORS.HUMAN, "u-typed", [
    { text: "lead typed", initiator: INITIATORS.HUMAN, messageId: "u-lead" },
  ]);
  bridge.pushMessage(session, "scheduled turn", undefined, INITIATORS.SCHEDULED, "u-sched");
  await bridge.steerMessage(session, "sent now", undefined, INITIATORS.SCHEDULED_NOW, "u-now");
  bridge.pushMessage(session, "loop turn", undefined, INITIATORS.LOOP, "u-loop");
  bridge.pushMessage(session, "unstamped turn");
  await sleep(50);

  [
    ["lead typed", "user"],
    ["typed turn", "user"],
    ["buffered trigger", "system"],
    ["scheduled turn", "schedule_wakeup"],
    ["sent now", "schedule_wakeup"],
    ["loop turn", "loop_wakeup"],
    ["unstamped turn", "unknown"],
    ["never delivered", "unknown"],
  ].forEach(function (row) {
    assert.equal(turnOrigin.lookup(session, row[0]), row[1], row[0]);
  });

  // The vendor received the same turns in the same order, stamped as before.
  var messages = lastFakeQuery().messages;
  assert.deepEqual(messages.map(function (m) { return m.message.content[0].text; }),
    ["lead typed", "typed turn", "buffered trigger", "scheduled turn", "sent now", "loop turn", "unstamped turn"]);
  assert.deepEqual(messages.map(function (m) { return m.uuid; }).slice(0, 4), ["u-lead", "u-typed", "u-buf", "u-sched"]);
  assert.deepEqual(messages[0].origin, { kind: "human" });
  assert.equal("client_composed" in messages[0], false);
  assert.equal(messages[3].origin.fireReason, "scheduled");
  assert.equal(messages[3].client_composed, true);
  assert.equal("origin" in messages[6], false);
  assert.equal(turnOrigin.sizeOf(session), 7);
  if (session.queryInstance) session.queryInstance.close();
});

// --- The verb (AC5, AC8, AC9) ---

function fakeDaemon(reply) {
  var sent = [];
  return {
    sent: sent,
    deps: {
      env: {},
      isDaemonAlive: function () { return Promise.resolve(true); },
      sendIPC: function (req) { sent.push(req); return Promise.resolve(reply); },
    },
  };
}

test("the verb builds its request from the environment pair, else from the input's session id", function () {
  var input = { session_id: "vendor-1", prompt: "go", prompt_id: "ignored", hook_event_name: "UserPromptSubmit" };
  assert.deepEqual(cli.buildRequest(input, { CLAGENTIC_CONSOLE_PROJECT: "p", CLAGENTIC_CONSOLE_SESSION_ID: "3" }),
    { cmd: "get_turn_origin", prompt: "go", project: "p", sessionId: "3" });
  assert.deepEqual(cli.buildRequest(input, {}),
    { cmd: "get_turn_origin", prompt: "go", cliSessionId: "vendor-1" });
  assert.deepEqual(cli.buildRequest({}, {}), { cmd: "get_turn_origin" });
  assert.deepEqual(cli.buildRequest({ session_id: 7, prompt: 8 }, {}), { cmd: "get_turn_origin" });
});

[
  { name: "an answer is printed and exits 0", stdin: '{"session_id":"v","prompt":"go"}', reply: { ok: true, result: "answered", origin: "system" }, code: 0, stdout: "system\n" },
  { name: "unknown is an answer: exit 0", stdin: '{"session_id":"v","prompt":"go"}', reply: { ok: true, result: "answered", origin: "unknown" }, code: 0, stdout: "unknown\n" },
  { name: "input that is not JSON exits 1", stdin: "not json", reply: null, code: 1, stderr: /not JSON/ },
  { name: "input that is not an object exits 1", stdin: "[1]", reply: null, code: 1, stderr: /JSON object/ },
  { name: "a daemon that refuses exits not-available", stdin: "{}", reply: { ok: false, error: "unknown command" }, code: 69, stderr: /did not answer: unknown command/ },
  { name: "no reply from the daemon exits not-available", stdin: "{}", reply: { ok: false, error: "timeout" }, code: 69, stderr: /did not answer/ },
].forEach(function (row) {
  test("verb: " + row.name, async function () {
    var d = fakeDaemon(row.reply);
    d.deps.readStdin = function () { return row.stdin; };
    var out = await cli.turnOrigin([], d.deps);
    assert.equal(out.code, row.code);
    if (row.stdout !== undefined) assert.equal(out.stdout, row.stdout);
    if (row.stderr) assert.match(out.stderr, row.stderr);
    if (row.code === 1) assert.equal(d.sent.length, 0, "unusable input does not reach the daemon");
  });
});

test("verb: the console not running says so on stderr and exits with the not-available code", async function () {
  var out = await cli.turnOrigin([], {
    env: {},
    readStdin: function () { return "{}"; },
    isDaemonAlive: function () { return Promise.resolve(false); },
    sendIPC: function () { throw new Error("must not be called"); },
  });
  assert.equal(out.code, cli.EXIT.NOT_AVAILABLE);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /Clagentic: Console is not running/);
  // Distinct from 0 and from the codes the session verbs document (0, 1, 3, 4).
  assert.ok([0, 1, 3, 4].indexOf(cli.EXIT.NOT_AVAILABLE) === -1);
  var rejected = await cli.turnOrigin([], {
    env: {},
    readStdin: function () { return "{}"; },
    isDaemonAlive: function () { return Promise.reject(new Error("socket gone")); },
  });
  assert.equal(rejected.code, cli.EXIT.NOT_AVAILABLE);
});

test("verb: an option it does not take is refused with its usage", async function () {
  var out = await cli.turnOrigin(["--prompt", "x"], { readStdin: function () { return "{}"; } });
  assert.equal(out.code, 1);
  assert.match(out.stderr, /Unknown option for turn-origin: --prompt[\s\S]*Usage: clagentic-console turn-origin/);
});

test("a real process with no daemon running says so and exits 69", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "turnorigin-"));
  fs.mkdirSync(path.join(home, "console"), { recursive: true });
  fs.writeFileSync(path.join(home, "console", ".migrated"), "");
  fs.writeFileSync(path.join(home, "console", "recent-projects.json"), "[]");
  try {
    var res = childProcess.spawnSync(process.execPath, [CLI, "turn-origin"], {
      encoding: "utf8",
      timeout: 15000,
      cwd: home,
      input: '{"session_id":"v","prompt":"go"}',
      env: Object.assign({}, process.env, { CLAGENTIC_CONSOLE_HOME: home }),
    });
    assert.equal(res.status, 69, res.stderr);
    assert.match(res.stderr, /Clagentic: Console is not running/);
    assert.equal(res.stdout, "");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("over a real Unix socket the verb's request is answered from the record", async function () {
  if (process.platform === "win32") return;
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "to-"));
  var session = { localId: 4, cliSessionId: "vendor-4" };
  turnOrigin.record(session, { text: "scheduled hello", initiator: INITIATORS.SCHEDULED });
  var store = storeOf("p", [session]);
  var sock = path.join(dir, "d.sock");
  var server = createIPCServer(sock, function (msg) {
    return msg.cmd === "get_turn_origin" ? turnOrigin.answer(store, msg) : { ok: false, error: "unknown" };
  });
  try {
    var out = await cli.turnOrigin([], {
      env: {},
      readStdin: function () { return JSON.stringify({ session_id: "vendor-4", prompt: "scheduled hello" }); },
      isDaemonAlive: function () { return Promise.resolve(true); },
      sendIPC: function (req) { return sendIPCCommand(sock, req, 3000); },
    });
    assert.equal(out.code, 0);
    assert.equal(out.stdout, "schedule_wakeup\n");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Read-only (AC7) ---

test("the lookup cannot set or change a record: the answer ignores any origin it is handed, and the daemon reaches only answer()", function () {
  var session = { localId: 1, cliSessionId: "v" };
  turnOrigin.record(session, { text: "typed", initiator: INITIATORS.HUMAN });
  var store = storeOf("p", [session]);
  var before = turnOrigin.sizeOf(session);
  var res = turnOrigin.answer(store, {
    project: "p", sessionId: "1", prompt: "typed",
    initiator: INITIATORS.TRIGGER, origin: "system", text: "forged", record: true,
  });
  assert.equal(res.origin, "user");
  assert.equal(turnOrigin.sizeOf(session), before);
  assert.equal(turnOrigin.lookup(session, "forged"), "unknown");

  var daemon = fs.readFileSync(path.join(__dirname, "..", "lib", "daemon.js"), "utf8");
  var reached = (daemon.match(/require\("\.\/turn-origin"\)\.(\w+)/g) || []).map(function (m) { return m.split(".").pop(); });
  assert.deepEqual(reached, ["answer"]);
  var cases = daemon.match(/case "get_turn_origin":/g) || [];
  assert.equal(cases.length, 1);
  var verbSource = fs.readFileSync(path.join(__dirname, "..", "lib", "cli", "turn-origin-subcommand.js"), "utf8");
  assert.equal(/turn-origin"\)\.(record|release)|turnOrigin\.(record|release)/.test(verbSource), false);
});

// --- Docs ---

test("the agent guide describes the verb: input, answers, exit codes, bound and restart", function () {
  var guide = fs.readFileSync(path.join(__dirname, "..", "docs", "guides", "AGENT-GUIDE.md"), "utf8");
  var start = guide.indexOf("\n## turn-origin");
  assert.ok(start !== -1);
  var rest = guide.slice(start + 1);
  var next = rest.indexOf("\n## ", 3);
  var section = next === -1 ? rest : rest.slice(0, next);
  ["clagentic-console turn-origin", "stdin", "user", "schedule_wakeup", "loop_wakeup", "system", "unknown", "69",
    String(turnOrigin.MAX_TURNS_PER_SESSION), "restart", "optional"].forEach(function (word) {
    assert.ok(section.indexOf(word) !== -1, "the section says " + word);
  });
  assert.doesNotMatch(section, /clagentic(?![-_]console|: Console)/i);
});
