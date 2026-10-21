var test = require("node:test");
var assert = require("node:assert/strict");

var { createSessionInput } = require("../lib/session-input");
var promptRegistry = require("../lib/prompt-registry");
var { summarize, SUMMARY_MAX } = require("../lib/permission-summary");
var { pendingPrompts } = require("../lib/pending-prompts");

var NOW = 1700000100000;

function makeSession(localId) {
  return {
    localId: localId,
    cliSessionId: "cli-" + localId,
    agentName: null,
    vendor: "claude",
    title: "t" + localId,
    lastActivity: 1700000000000,
    isProcessing: true,
    queryInstance: {},
    history: [],
    pendingPermissions: Object.create(null),
  };
}

function world(sessions) {
  var sm = { sessions: new Map(), defaultVendor: "claude" };
  sessions.forEach(function (s) { sm.sessions.set(s.localId, s); });
  var project = { sm: sm };
  var input = createSessionInput({
    getProject: function (slug) { return slug === "lore" ? project : null; },
    listProjects: function () { return [{ slug: "lore", project: project }]; },
    agentCatalog: function () { return []; },
  });
  var registry = promptRegistry.createPromptRegistry({
    index: Object.create(null),
    getSession: function (id) { return sm.sessions.get(id); },
    sendAndRecord: function () {},
    saveSessionFile: function () {},
  });
  return { input: input, registry: registry };
}

function byId(r, id) {
  return r.sessions.filter(function (s) { return s.consoleSessionId === String(id); })[0];
}

test("a session waiting on a permission prompt shows tool, summary, requestId and age", async function (t) {
  var s = makeSession(1);
  var w = world([s, makeSession(2)]);
  await promptRegistry.ready();
  var realNow = Date.now;
  t.after(function () { Date.now = realNow; });
  var openedAt = realNow();
  var opened = w.registry.open(s, "permission", { toolName: "Bash", toolInput: { command: "loadout-profile check" }, vendor: "claude" });
  Date.now = function () { return openedAt + 42500; };
  var r = w.input.listSessions({});
  var entry = byId(r, 1);
  assert.equal(entry.pendingPrompts.length, 1);
  assert.deepEqual(entry.pendingPrompts[0], {
    requestId: opened.requestId,
    kind: "permission",
    tool: "Bash",
    summary: "loadout-profile check",
    ageSeconds: 42,
  });
  assert.deepEqual(byId(r, 2).pendingPrompts, []);
});

test("a resolved prompt disappears", async function () {
  var s = makeSession(1);
  var w = world([s]);
  await promptRegistry.ready();
  var opened = w.registry.open(s, "permission", { toolName: "Bash", toolInput: { command: "ls" }, vendor: "claude" });
  assert.equal(byId(w.input.listSessions({}), 1).pendingPrompts.length, 1);
  w.registry.respond(opened.requestId, { decision: "allow" }, { session: s });
  assert.deepEqual(byId(w.input.listSessions({}), 1).pendingPrompts, []);
});

test("prompts are listed oldest first", function () {
  var s = makeSession(1);
  s.pendingPermissions.b = { kind: "permission", toolName: "Read", toolInput: { file_path: "/x/b.txt" }, createdAt: NOW - 1000 };
  s.pendingPermissions.a = { kind: "permission", toolName: "Bash", toolInput: { command: "ls" }, createdAt: NOW - 5000 };
  var views = pendingPrompts(s, NOW);
  assert.deepEqual(views.map(function (v) { return v.requestId; }), ["a", "b"]);
  assert.deepEqual(views.map(function (v) { return v.ageSeconds; }), [5, 1]);
});

test("summary is one line, control characters stripped, bounded", function () {
  var c = String.fromCharCode;
  var nasty = "echo a" + c(10) + c(27) + "[31mred" + c(27) + "[0m" + c(13) + c(10) + "b" + c(0) + "c" + c(0x2028) + "d" + c(0x85) + c(0x7f) + "e";
  var line = summarize("Bash", { command: nasty });
  assert.equal(line, "echo a [31mred [0m b c d e");
  for (var i = 0; i < line.length; i++) {
    var code = line.charCodeAt(i);
    assert.ok(code > 0x1f && (code < 0x7f || code > 0x9f) && code !== 0x2028 && code !== 0x2029, "control character at " + i);
  }

  var long = summarize("Bash", { command: "x".repeat(5000) });
  assert.equal(long.length, SUMMARY_MAX);
  assert.ok(long.endsWith("..."));
});

test("summary carries no more of a call than the banner body, and none for a question", function () {
  assert.equal(summarize("Bash", { command: "ls", description: "SECRET" }), "ls");
  assert.equal(summarize("Bash", null), "");
  assert.equal(summarize("Bash", { command: { not: "a string" } }), "");

  var s = makeSession(1);
  s.pendingAskUser = { q1: { kind: "ask_user", toolName: "AskUserQuestion", input: { questions: [{ question: "private?" }] }, createdAt: NOW } };
  var views = pendingPrompts(s, NOW);
  assert.equal(views.length, 1);
  assert.equal(views[0].kind, "ask_user");
  assert.equal(views[0].summary, "");
  assert.equal(JSON.stringify(views).indexOf("private"), -1);
});

test("an empty record or a session with no stores lists nothing", function () {
  var s = makeSession(1);
  s.pendingPermissions.dead = null;
  assert.deepEqual(pendingPrompts(s, NOW), []);
  assert.deepEqual(pendingPrompts({}, NOW), []);
});
