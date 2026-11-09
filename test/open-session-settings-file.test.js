"use strict";
// open-session --settings <path>: a per-session additive settings file, checked
// at open, saved with the session, and passed to the runtime on every turn.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { createSessionInput } = require("../lib/session-input");
var { handleSessionCommand } = require("../lib/session-input-ipc");
var { parseSessionArgs } = require("../lib/cli/session-subcommands");
var { composeSettings } = require("../lib/session-settings-file");
var { claudeCapabilities } = require("../lib/yoke/adapters/claude-capabilities");
var { codexCapabilities } = require("../lib/yoke/adapters/codex-capabilities");

test.before(function () { return require("../lib/prompt-kinds/codecs").load(); });

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "open-settings-file-"));
test.after(function () { fs.rmSync(tmp, { recursive: true, force: true }); });

var FILE = path.join(tmp, "extra.json");
fs.writeFileSync(FILE, JSON.stringify({ permissions: { allow: ["Read"] } }));

function makeProject() {
  var created = [];
  var sm = {
    sessions: new Map(),
    defaultVendor: "claude",
    createSession: function (options) {
      created.push(options);
      var s = { localId: created.length, history: [], vendor: options.vendor || null, settingsFile: options.settingsFile || null };
      sm.sessions.set(s.localId, s);
      return s;
    },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    recordHistoryEntry: function (s, e) { s.history.push(e); },
    appendToSessionFile: function () {},
    deleteSession: function () {},
  };
  return {
    created: created,
    cwd: "/unused",
    sm: sm,
    sdk: { startQuery: function () {} },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
    supportsSettingsFileFor: function (session) {
      var caps = (session.vendor || "claude") === "codex" ? codexCapabilities() : claudeCapabilities();
      return caps.additiveSettings === true;
    },
  };
}

function open(project, request) {
  var input = createSessionInput({
    getProject: function (slug) { return slug === "p" ? project : null; },
    getPermissionSettings: function () { return null; },
  });
  return input.openSession(Object.assign({ projectSlug: "p", prompt: "go" }, request || {}));
}

test("a readable settings file is passed into createSession options and saved on the session", function () {
  var project = makeProject();
  var r = open(project, { settingsFile: FILE });
  assert.equal(r.result, "opened");
  assert.equal(project.created[0].settingsFile, FILE);
  assert.equal(project.sm.sessions.get(1).settingsFile, FILE);
});

test("without the option the create options are unchanged", function () {
  var project = makeProject();
  assert.equal(open(project, {}).result, "opened");
  assert.equal("settingsFile" in project.created[0], false);
});

test("a missing path, a directory, a relative path and an unreadable file refuse and create nothing", function () {
  var missing = path.join(tmp, "nope.json");
  var cases = [missing, tmp, "relative.json"];
  var locked = path.join(tmp, "locked.json");
  fs.writeFileSync(locked, "{}");
  fs.chmodSync(locked, 0);
  // Root reads a mode-0 file; only count it when the check can fail here.
  var canLock = true;
  try { fs.accessSync(locked, fs.constants.R_OK); canLock = false; } catch (e) { canLock = true; }
  if (canLock) cases.push(locked);
  cases.forEach(function (p) {
    var project = makeProject();
    var r = open(project, { settingsFile: p });
    assert.equal(r.ok, false, p);
    assert.equal(r.result, "refused");
    assert.ok(r.reason.indexOf(JSON.stringify(p)) !== -1, "the reason names the path: " + r.reason);
    assert.equal(project.created.length, 0);
  });
});

test("a vendor without the capability refuses and starts nothing", function () {
  var project = makeProject();
  var r = open(project, { settingsFile: FILE, vendor: "codex" });
  assert.equal(r.result, "refused");
  assert.equal(project.created.length, 0);
});

test("the CLI flag resolves to an absolute path and the IPC handler passes it on", function () {
  var parsed = parseSessionArgs("open-session", ["--project", "p", "--prompt", "go", "--settings", "rel/x.json"]);
  assert.equal(parsed.request.settingsFile, path.resolve("rel/x.json"));
  assert.match(parseSessionArgs("open-session", ["--project", "p", "--prompt", "go", "--settings"]).error, /Missing value/);
  assert.match(parseSessionArgs("send-input", ["--project", "p", "--session", "s", "--prompt", "go", "--settings", "x"]).error, /Unknown option/);
  var seen = null;
  handleSessionCommand({ openSession: function (req) { seen = req; return { ok: true }; } },
    { cmd: "open_session", projectSlug: "p", prompt: "go", settingsFile: FILE });
  assert.equal(seen.settingsFile, FILE);
});

test("composeSettings passes the path alone, and merges with a console object, the console's keys winning", function () {
  assert.deepEqual(composeSettings(FILE, null), { settings: FILE });
  assert.deepEqual(composeSettings(FILE, {}), { settings: FILE });
  var both = composeSettings(FILE, { disableAllHooks: true });
  assert.deepEqual(both.settings, { permissions: { allow: ["Read"] }, disableAllHooks: true });
  var clash = path.join(tmp, "clash.json");
  fs.writeFileSync(clash, JSON.stringify({ disableAllHooks: false }));
  assert.equal(composeSettings(clash, { disableAllHooks: true }).settings.disableAllHooks, true);
  var bad = path.join(tmp, "bad.json");
  fs.writeFileSync(bad, "not json");
  assert.match(composeSettings(bad, { disableAllHooks: true }).error, /not valid JSON/);
  assert.match(composeSettings(path.join(tmp, "gone.json"), null).error, /gone\.json/);
});

// --- persistence and launch -------------------------------------------------

function freshSessions(home) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
  var orig = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = home;
  try { return require("../lib/sessions"); } finally {
    if (orig === undefined) delete process.env.CLAGENTIC_HOME; else process.env.CLAGENTIC_HOME = orig;
  }
}

function manager(home) {
  return freshSessions(home).createSessionManager({ cwd: home, send: function () {}, sendTo: function () {}, sendEach: function () {} });
}

test("the settings path survives a restart and a resume record", function () {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "open-settings-persist-"));
  try {
    var sm1 = manager(home);
    var s = sm1.createSession({ settingsFile: FILE, activate: false });
    s.cliSessionId = "sess-with";
    sm1.sendAndRecord(s, { type: "user_message", text: "hello" });
    sm1.saveSessionFile(s);
    var plain = sm1.createSessionRaw({});
    plain.cliSessionId = "sess-without";
    sm1.sendAndRecord(plain, { type: "user_message", text: "hello" });
    sm1.saveSessionFile(plain);
    var all = Array.from(manager(home).sessions.values());
    assert.equal(all.find(function (x) { return x.cliSessionId === "sess-with"; }).settingsFile, FILE);
    assert.ok(!all.find(function (x) { return x.cliSessionId === "sess-without"; }).settingsFile);
    var resumed = manager(home).resumeSession("sess-resumed", { settingsFile: FILE, history: [] });
    assert.equal(resumed.settingsFile, FILE);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function bridgeWith(session, onCreate) {
  var modPath = require.resolve("../lib/sdk-bridge");
  delete require.cache[modPath];
  var { createSDKBridge } = require("../lib/sdk-bridge");
  var messages = [];
  var sm = {
    sessions: new Map(), currentModel: null, currentPermissionMode: null, currentEffort: null, currentBetas: [],
    modelsByVendor: {}, availableVendors: [], installedVendors: [], defaultVendor: "claude",
    saveSessionFile: function () {}, broadcastSessionList: function () {}, getActiveSession: function () { return null; },
    setSlashCommandsForVendor: function () {},
    sendAndRecord: function (s, obj) { messages.push(obj); },
    sendToSession: function (s, obj) { messages.push(obj); },
  };
  var adapter = {
    vendor: "claude",
    createQuery: async function (opts) {
      onCreate(opts);
      return { _adapterState: null, [Symbol.asyncIterator]: function () { return { next: function () { return Promise.resolve({ done: true }); } }; }, pushMessage: function () {}, close: function () {}, endInput: function () {}, abort: function () {} };
    },
    init: function () { return Promise.resolve({ models: [], skills: [] }); },
    supportedModels: function () { return Promise.resolve([]); },
  };
  var bridge = createSDKBridge({
    cwd: "/tmp/test-project", slug: "test-project", sessionManager: sm, send: function (m) { messages.push(m); },
    adapter: adapter, adapters: { claude: adapter }, onProcessingChanged: function () {}, getConfig: null,
  });
  sm.sessions.set(session.localId, session);
  return { bridge: bridge, messages: messages };
}

var seq = 9000;
function launchSession(extra) {
  return Object.assign({
    localId: seq++, queryInstance: null, messageQueue: null, abortController: null, isProcessing: true,
    cliSessionId: null, history: [], blocks: {}, sentToolResults: {}, pendingPermissions: {}, pendingAskUser: {},
    pendingElicitations: {}, activeTaskToolIds: {}, singleTurn: false, lastActivityAt: Date.now(),
    _isCountedLive: false, _adapterWorkerState: null, _workerExitPromise: null,
  }, extra);
}

async function turn(session) {
  var seen = [];
  var b = bridgeWith(session, function (opts) { seen.push(opts.adapterOptions.CLAUDE); });
  await b.bridge.startQuery(session, "hello", null, null);
  if (session.streamPromise) await session.streamPromise;
  return { seen: seen, messages: b.messages };
}

test("the runtime is launched with the file on a first and a later turn; without it the option is absent", async function () {
  var s = launchSession({ settingsFile: FILE });
  var first = await turn(s);
  assert.equal(first.seen[0].settings, FILE);
  s.isProcessing = true;
  var later = await turn(s);
  assert.equal(later.seen[0].settings, FILE);
  var plain = await turn(launchSession({}));
  assert.equal("settings" in plain.seen[0], false);
});

test("a loop's disableAllHooks and the file both take effect", async function () {
  var r = await turn(launchSession({ settingsFile: FILE, loopSettings: { disableAllHooks: true } }));
  assert.deepEqual(r.seen[0].settings, { permissions: { allow: ["Read"] }, disableAllHooks: true });
  var only = await turn(launchSession({ loopSettings: { disableAllHooks: true } }));
  assert.deepEqual(only.seen[0].settings, { disableAllHooks: true });
});

test("a saved path that is gone fails the turn naming the path and starts nothing", async function () {
  var gone = path.join(tmp, "removed.json");
  var r = await turn(launchSession({ settingsFile: gone }));
  assert.equal(r.seen.length, 0);
  var err = r.messages.find(function (m) { return m.type === "error"; });
  assert.ok(err && err.text.indexOf("removed.json") !== -1);
});
