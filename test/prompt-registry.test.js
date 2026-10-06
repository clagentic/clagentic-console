"use strict";
// Unit coverage for lib/prompt-registry.js, the single owner of every
// operator-prompt lifecycle, its kind adapters (lib/prompt-kinds/), and the
// server paths that delegate to it (paged history replay, the HTTP
// push-response endpoint, the WS response handler).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { EventEmitter } = require("events");

var { createPromptRegistry, promptsFor } = require("../lib/prompt-registry");

function makeRegistry() {
  var recorded = [];
  var saved = [];
  var dismissed = [];
  var notified = [];
  var badgeRefreshes = 0;
  var sessions = new Map();
  var index = {};
  var registry = createPromptRegistry({
    index: index,
    getSession: function (id) { return sessions.get(id) || null; },
    sendAndRecord: function (session, msg) { recorded.push(msg); },
    saveSessionFile: function (session) { saved.push(session.localId); },
    getNotificationsModule: function () {
      return {
        notify: function (type, data) { notified.push(data.requestId); },
        dismissByRequestId: function (id) { dismissed.push(id); },
      };
    },
    onProcessingChanged: function () { badgeRefreshes++; },
  });
  function addSession(localId) {
    var s = { localId: localId, queryInstance: null };
    sessions.set(localId, s);
    return s;
  }
  return {
    registry: registry, recorded: recorded, saved: saved, dismissed: dismissed, notified: notified, index: index,
    addSession: addSession, badgeRefreshes: function () { return badgeRefreshes; },
  };
}

function openBash(h, session, toolUseId, opts) {
  return h.registry.open(session, "permission", { toolName: "Bash", toolInput: { command: "make" }, vendor: "claude" },
    Object.assign({ toolUseId: toolUseId }, opts || {}));
}

var ASK_INPUT = { questions: [{ question: "Which target?" }, { question: "Notify?" }] };

// One opener per session-scoped kind, for the scope tests that hold for all.
var KIND_OPENERS = {
  permission: function (h, s, toolUseId) { return openBash(h, s, toolUseId); },
  plan: function (h, s, toolUseId) {
    return h.registry.open(s, "plan", { toolName: "ExitPlanMode", toolInput: { plan: "p" } }, { toolUseId: toolUseId });
  },
  ask_user: function (h, s, toolUseId) { return h.registry.open(s, "ask_user", { input: ASK_INPUT }, { toolUseId: toolUseId }); },
  elicitation: function (h, s, toolUseId) {
    return h.registry.open(s, "elicitation", { serverName: "srv", message: "?" }, { toolUseId: toolUseId });
  },
};

function eventsOf(h, type) {
  return h.recorded.filter(function (m) { return m.type === type; });
}

function isPending(h, requestId) {
  return !!h.registry.lookup(requestId);
}

test("open records the prompt, indexes it, notifies when asked, and refreshes the badge", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var opened = openBash(h, s, "tu-1", { notification: { title: "t" } });

  assert.ok(s.pendingPermissions[opened.requestId]);
  assert.equal(h.index[opened.requestId], 1);
  assert.deepEqual(eventsOf(h, "prompt_request"), [{
    type: "prompt_request", requestId: opened.requestId, kind: "permission", toolUseId: "tu-1",
    toolName: "Bash", toolInput: { command: "make" }, decisionReason: "", vendor: "claude",
  }]);
  assert.deepEqual(h.notified, [opened.requestId]);
  assert.equal(h.badgeRefreshes(), 1);
});

test("each kind keeps its prompts in its own store and the ask prompt takes its tool-use id", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var perm = KIND_OPENERS.permission(h, s, "tu-p");
  var plan = KIND_OPENERS.plan(h, s, "tu-plan");
  var ask = KIND_OPENERS.ask_user(h, s, "tu-ask");
  var el = KIND_OPENERS.elicitation(h, s);

  assert.ok(s.pendingPermissions[perm.requestId]);
  assert.ok(s.pendingPermissions[plan.requestId]);
  assert.equal(ask.requestId, "tu-ask");
  assert.ok(s.pendingAskUser["tu-ask"]);
  assert.ok(s.pendingElicitations[el.requestId]);
  assert.equal(h.registry.pendingCount(s), 4);
  assert.deepEqual(h.registry.pendingMessages(s).map(function (m) { return [m.type, m.kind]; }).sort(), [
    ["prompt_pending", "ask_user"], ["prompt_pending", "elicitation"], ["prompt_pending", "permission"], ["prompt_pending", "plan"],
  ]);
});

test("an answer settles exactly once; a second answer is stale and still retires the banner", async function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var opened = openBash(h, s, "tu-1");

  var first = h.registry.respond(opened.requestId, { decision: "allow" });
  var second = h.registry.respond(opened.requestId, { decision: "deny" });

  assert.equal(first.status, "resolved");
  assert.equal(second.status, "stale");
  assert.deepEqual(await opened.answer, { behavior: "allow", updatedInput: { command: "make" } });
  assert.deepEqual(eventsOf(h, "prompt_resolved"), [{ type: "prompt_resolved", requestId: opened.requestId, kind: "permission", decision: "allow" }]);
  assert.deepEqual(s.pendingPermissions, {});
  assert.equal(h.index[opened.requestId], undefined);
  assert.deepEqual(h.dismissed, [opened.requestId, opened.requestId]);
});

test("permission decisions map to the vendor outcome and anything unknown fails closed", async function () {
  var cases = [
    ["allow", { behavior: "allow", updatedInput: { command: "make" } }, "allow"],
    ["deny", { behavior: "deny", message: "User denied permission" }, "deny"],
    ["allow_accept_edits", { behavior: "deny", message: "User denied permission" }, "deny"],
    ["something-new", { behavior: "deny", message: "User denied permission" }, "deny"],
  ];
  for (var i = 0; i < cases.length; i++) {
    var h = makeRegistry();
    var opened = openBash(h, h.addSession(1), "tu");
    h.registry.respond(opened.requestId, { decision: cases[i][0] });
    assert.deepEqual(await opened.answer, cases[i][1], cases[i][0]);
    assert.equal(eventsOf(h, "prompt_resolved")[0].decision, cases[i][2], "the recorded decision is the applied one");
  }
});

test("plan decisions map to the vendor outcome and never grant anything", async function () {
  var cases = [
    [{ decision: "allow" }, { behavior: "allow", updatedInput: { plan: "p" } }],
    [{ decision: "allow_accept_edits" }, { behavior: "allow", updatedInput: { plan: "p" } }],
    [{ decision: "allow_clear_context", planContent: "x" }, { behavior: "deny", message: "User chose to clear context and restart" }],
    [{ decision: "deny_with_feedback", feedback: "use make test" }, { behavior: "deny", message: "use make test" }],
    [{ decision: "deny" }, { behavior: "deny", message: "User denied permission" }],
    [{ decision: "allow_always" }, { behavior: "deny", message: "User denied permission" }],
  ];
  for (var i = 0; i < cases.length; i++) {
    var h = makeRegistry();
    var s = h.addSession(1);
    var opened = KIND_OPENERS.plan(h, s, "tu");
    var outcome = h.registry.respond(opened.requestId, cases[i][0]);
    assert.deepEqual(await opened.answer, cases[i][1], cases[i][0].decision);
    assert.equal(outcome.kind, "plan");
    assert.equal(s.allowedTools, undefined, "a plan answer grants nothing");
  }
});

test("an AskUserQuestion answer becomes the tool's input, keyed by question text; skip denies", async function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var ask = KIND_OPENERS.ask_user(h, s, "tu-ask");
  h.registry.respond("tu-ask", { answers: { 0: "prod", 1: "yes" } });
  var expected = Object.assign({}, ASK_INPUT, { answers: { "Which target?": "prod", "Notify?": "yes" } });
  assert.deepEqual(await ask.answer, { behavior: "allow", updatedInput: expected, updated_input: expected });
  assert.deepEqual(eventsOf(h, "prompt_resolved")[0], { type: "prompt_resolved", requestId: "tu-ask", kind: "ask_user", answers: { 0: "prod", 1: "yes" } });

  var skipped = KIND_OPENERS.ask_user(h, s, "tu-skip");
  h.registry.respond("tu-skip", { decision: "skip" });
  assert.deepEqual(await skipped.answer, { behavior: "deny", message: "The user skipped the question." });
  assert.equal(eventsOf(h, "prompt_resolved")[1].skipped, true);
});

test("an elicitation answer passes the content on but never records it", async function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var el = KIND_OPENERS.elicitation(h, s);
  h.registry.respond(el.requestId, { action: "accept", content: { token: "secret" } });
  assert.deepEqual(await el.answer, { action: "accept", content: { token: "secret" } });
  assert.deepEqual(eventsOf(h, "prompt_resolved")[0], { type: "prompt_resolved", requestId: el.requestId, kind: "elicitation", action: "accept" });

  var rejected = KIND_OPENERS.elicitation(h, s);
  h.registry.respond(rejected.requestId, { action: "decline" });
  assert.deepEqual(await rejected.answer, { action: "reject" });
});

test("an answer is applied only to the kinds it names", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var ask = KIND_OPENERS.ask_user(h, s, "tu-ask");

  var outcome = h.registry.respond(ask.requestId, { decision: "allow" }, { kinds: ["permission", "plan"] });

  assert.equal(outcome.status, "stale");
  assert.ok(isPending(h, ask.requestId), "a response for another kind leaves the prompt pending");
});

test("allow_always writes the grant through the registry and flushes it", function () {
  var h = makeRegistry();
  var s = h.addSession(7);
  var opened = h.registry.open(s, "permission", { toolName: "Skill", toolInput: { skill: "deploy" } }, { toolUseId: "tu" });

  h.registry.respond(opened.requestId, { decision: "allow_always" });

  assert.equal(h.registry.isGranted(s, "Skill", { skill: "deploy" }), true);
  assert.equal(h.registry.isGranted(s, "Skill", { skill: "other" }), false, "a grant is scoped to its discriminator");
  assert.deepEqual(h.saved, [7]);
});

test("an answer finds its session by index, or falls back to the given session", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var opened = openBash(h, s, "tu");
  delete h.index[opened.requestId];

  assert.equal(h.registry.lookup(opened.requestId), null);
  assert.equal(h.registry.lookup(opened.requestId, s).session, s);
});

test("an abort cancels with reason aborted; a relayed expiry cancels with reason expired", async function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var ac = new AbortController();
  var aborted = openBash(h, s, "tu-a", { signal: ac.signal });
  var ex = new AbortController();
  var expired = openBash(h, s, "tu-e", { signal: ex.signal });

  ac.abort();
  ex.abort("expired");

  assert.deepEqual(await aborted.answer, { behavior: "deny", message: "Request cancelled" });
  assert.deepEqual(await expired.answer, { behavior: "deny", message: "Permission request timed out" });
  assert.deepEqual(eventsOf(h, "prompt_cancel").map(function (m) { return m.reason; }), ["aborted", "expired"]);
});

test("a signal that is already aborted ends the prompt at once, for every kind", async function () {
  var names = Object.keys(KIND_OPENERS);
  for (var i = 0; i < names.length; i++) {
    var h = makeRegistry();
    var s = h.addSession(1);
    var ac = new AbortController();
    ac.abort();
    var req = names[i] === "permission" || names[i] === "plan"
      ? { toolName: names[i] === "plan" ? "ExitPlanMode" : "Bash", toolInput: {} }
      : names[i] === "ask_user" ? { input: ASK_INPUT } : { serverName: "srv" };
    var opened = h.registry.open(s, names[i], req, { toolUseId: "tu", signal: ac.signal, notification: { title: "t" } });

    assert.equal(isPending(h, opened.requestId), false, names[i]);
    assert.deepEqual(eventsOf(h, "prompt_cancel").map(function (m) { return m.reason; }), ["aborted"], names[i]);
    assert.deepEqual(h.notified, [], names[i] + ": no banner for a prompt that never waited");
    await opened.answer;
  }
});

test("a settled prompt detaches its abort listener", async function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var ac = new AbortController();
  var opened = openBash(h, s, "tu", { signal: ac.signal });
  h.registry.respond(opened.requestId, { decision: "allow" });

  ac.abort();

  assert.equal(eventsOf(h, "prompt_cancel").length, 0);
  assert.equal((await opened.answer).behavior, "allow");
});

test("a project-scope extension command resolves with its result, or null once it times out", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var h = makeRegistry();
  var answered = h.registry.open(null, "extension", { command: "tab_console", args: {} });
  var unanswered = h.registry.open(null, "extension", { command: "tab_page_text", args: {} }, { timeoutMs: 500 });

  assert.equal(h.registry.respond(answered.requestId, { result: { lines: 3 } }, { kinds: ["extension"] }).status, "resolved");
  t.mock.timers.tick(500);

  assert.deepEqual(await answered.answer, { lines: 3 });
  assert.equal(await unanswered.answer, null);
  assert.deepEqual(h.recorded, [], "extension commands are never recorded");
  assert.equal(h.registry.respond(unanswered.requestId, { result: 1 }, { kinds: ["extension"] }).status, "stale");
});

test("the turn boundary ends top-level prompts of every kind and keeps a tracked sub-agent's", async function () {
  var names = Object.keys(KIND_OPENERS).filter(function (k) { return k !== "elicitation"; });
  for (var i = 0; i < names.length; i++) {
    var h = makeRegistry();
    var s = h.addSession(1);
    h.registry.taskStarted(s, "task-1");
    h.registry.noteSubagentTool(s, "tu-sub", "task-1");
    var sub = KIND_OPENERS[names[i]](h, s, "tu-sub");
    var top = KIND_OPENERS[names[i]](h, s, "tu-top");

    h.registry.endTurn(s);

    assert.ok(isPending(h, sub.requestId), names[i] + ": the sub-agent's prompt survives the parent turn");
    assert.equal(isPending(h, top.requestId), false, names[i]);
    assert.deepEqual(eventsOf(h, "prompt_cancel").map(function (m) { return [m.requestId, m.kind, m.reason]; }), [[top.requestId, names[i], "turn_ended"]]);
  }
  var he = makeRegistry();
  var el = KIND_OPENERS.elicitation(he, he.addSession(1));
  he.registry.endTurn(he.registry.lookup(el.requestId).session);
  assert.deepEqual(await el.answer, { action: "reject" }, "an elicitation, which has no owner, ends with its turn and rejects");
});

test("a sub-agent prompt made after an earlier turn boundary is still the sub-agent's", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  h.registry.taskStarted(s, "task-1");
  h.registry.endTurn(s);
  h.registry.noteSubagentTool(s, "tu-late", "task-1");
  var late = openBash(h, s, "tu-late");

  h.registry.endTurn(s);

  assert.ok(isPending(h, late.requestId), "Task tracking is not trimmed by a turn that had nothing to keep");
});

test("a prompt owned by a Task that is not tracked is treated as top-level", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  h.registry.noteSubagentTool(s, "tu-sub", "task-unknown");
  var sub = openBash(h, s, "tu-sub");

  h.registry.endTurn(s);

  assert.equal(isPending(h, sub.requestId), false);
});

test("a Task that ends while its prompt is pending stays tracked until the prompt settles", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  h.registry.taskStarted(s, "task-1");
  h.registry.noteSubagentTool(s, "tu-sub", "task-1");
  h.registry.noteSubagentTool(s, "tu-done", "task-1");
  var sub = openBash(h, s, "tu-sub");

  h.registry.taskEnded(s, "task-1");
  assert.equal(s.activeTaskToolIds["task-1"], "ending");
  assert.equal(s.subagentToolOwners["tu-sub"], "task-1");
  assert.equal(s.subagentToolOwners["tu-done"], undefined, "unreferenced ownership is pruned at once");

  h.registry.endTurn(s);
  h.registry.endQuery(s, null, true);
  assert.ok(isPending(h, sub.requestId), "an ending Task still keeps its prompt across the turn and the query");

  h.registry.respond(sub.requestId, { decision: "allow" });
  assert.equal(s.activeTaskToolIds["task-1"], undefined);
  assert.equal(s.subagentToolOwners["tu-sub"], undefined);
});

test("query end keeps a tracked sub-agent's prompt answerable and its Task tracked", async function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var query = {};
  s.queryInstance = query;
  h.registry.taskStarted(s, "task-1");
  h.registry.taskStarted(s, "task-idle");
  h.registry.noteSubagentTool(s, "tu-sub", "task-1");
  var sub = KIND_OPENERS.ask_user(h, s, "tu-sub");
  var top = openBash(h, s, "tu-top");

  h.registry.endTurn(s);
  h.registry.endQuery(s, query, true);

  assert.ok(isPending(h, sub.requestId));
  assert.equal(isPending(h, top.requestId), false);
  assert.deepEqual(Object.keys(s.activeTaskToolIds), ["task-1"], "a Task that owns nothing is forgotten with its query");
  assert.equal(h.registry.respond(sub.requestId, { answers: { 0: "prod" } }).status, "resolved");
  assert.equal((await sub.answer).behavior, "allow");
});

test("query end ends only that query's prompts; an owner also ends unstamped ones", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var oldQuery = {};
  var newQuery = {};
  s.queryInstance = oldQuery;
  openBash(h, s, "tu-old");
  s.queryInstance = newQuery;
  var fromNew = openBash(h, s, "tu-new");
  s.queryInstance = null;
  var unstamped = openBash(h, s, "tu-none");
  h.registry.taskStarted(s, "task-1");

  h.registry.endQuery(s, oldQuery, false);
  assert.deepEqual(Object.keys(s.pendingPermissions).sort(), [fromNew.requestId, unstamped.requestId].sort());
  assert.equal(s.activeTaskToolIds["task-1"], true, "a superseded query does not touch the session's Task tracking");

  h.registry.endQuery(s, newQuery, true);
  assert.deepEqual(s.pendingPermissions, {});
  assert.deepEqual(s.activeTaskToolIds, {});
  assert.ok(eventsOf(h, "prompt_cancel").every(function (m) { return m.reason === "query_ended"; }));
});

test("a new query forgets Tasks that own nothing and keeps one whose prompt is still open", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  h.registry.taskStarted(s, "task-owner");
  h.registry.taskStarted(s, "task-idle");
  h.registry.noteSubagentTool(s, "tu-sub", "task-owner");
  openBash(h, s, "tu-sub");

  h.registry.beginQuery(s);

  assert.deepEqual(Object.keys(s.activeTaskToolIds), ["task-owner"]);
});

test("cancelSession without recording settles every resolver and emits no event", async function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var a = openBash(h, s, "tu-a");
  var ask = KIND_OPENERS.ask_user(h, s, "tu-ask");

  h.registry.cancelSession(s, "session_deleted", { record: false });

  assert.deepEqual(await a.answer, { behavior: "deny", message: "Session deleted" });
  assert.deepEqual(await ask.answer, { behavior: "deny", message: "Cancelled" });
  assert.equal(eventsOf(h, "prompt_cancel").length, 0);
  assert.deepEqual(h.dismissed.sort(), [a.requestId, "tu-ask"].sort());
});

test("shutdown ends every pending prompt, recorded, sub-agent ones included", async function () {
  var h = makeRegistry();
  var s1 = h.addSession(1);
  var s2 = h.addSession(2);
  h.registry.taskStarted(s1, "task-1");
  h.registry.noteSubagentTool(s1, "tu-sub", "task-1");
  var sub = openBash(h, s1, "tu-sub");
  var el = KIND_OPENERS.elicitation(h, s2);
  var ext = h.registry.open(null, "extension", { command: "tab_console" }, { timeoutMs: 60000 });

  h.registry.shutdown();

  assert.deepEqual(await sub.answer, { behavior: "deny", message: "Daemon shut down" });
  assert.deepEqual(await el.answer, { action: "reject" });
  assert.equal(await ext.answer, null);
  assert.deepEqual(eventsOf(h, "prompt_cancel").map(function (m) { return m.reason; }), ["shutdown", "shutdown"]);
  assert.equal(h.registry.pendingCount(s1) + h.registry.pendingCount(s2), 0);
});

test("a hand-built record in a session store is classified by its store", async function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var got = null;
  s.pendingPermissions = { legacy: { resolve: function (v) { got = v; }, requestId: "legacy", toolName: "Bash", toolInput: {} } };
  h.index.legacy = 1;

  assert.equal(h.registry.respond("legacy", { decision: "deny" }).kind, "permission");
  assert.deepEqual(got, { behavior: "deny", message: "User denied permission" });
});

test("replayAnnotator stamps the authoritative state on every prompt opener, from any recorded shape", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var live = openBash(h, s, "tu-live");
  var liveAsk = KIND_OPENERS.ask_user(h, s, "tu-ask-live");
  var history = [
    { type: "prompt_request", requestId: "r-allowed", kind: "permission" },
    { type: "permission_request", requestId: "r-cancelled" },
    { type: "permission_request", requestId: "r-lost" },
    { type: "prompt_request", requestId: live.requestId, kind: "permission" },
    { type: "elicitation_request", requestId: "r-el" },
    { type: "tool_executing", id: "tu-ask-old", name: "AskUserQuestion", input: ASK_INPUT },
    { type: "tool_executing", id: "tu-ask-live", name: "AskUserQuestion", input: ASK_INPUT },
    { type: "tool_executing", id: "tu-bash", name: "Bash", input: {} },
    { type: "prompt_resolved", requestId: "r-allowed", kind: "permission", decision: "allow_always" },
    { type: "permission_cancel", requestId: "r-cancelled", reason: "turn_ended" },
    { type: "elicitation_resolved", requestId: "r-el", action: "accept" },
    { type: "ask_user_answered", toolId: "tu-ask-old", answers: { 0: "prod" } },
    { type: "delta", text: "x" },
  ];

  var annotate = h.registry.replayAnnotator(s, history, 0);
  var states = history.slice(0, 7).map(function (it) { return annotate(it).promptState; });

  assert.deepEqual(states, [
    { state: "resolved", decision: "allow_always" },
    { state: "cancelled", reason: "turn_ended" },
    { state: "cancelled", reason: "stale" },
    { state: "pending" },
    { state: "resolved", action: "accept" },
    { state: "resolved", answers: { 0: "prod" } },
    { state: "pending" },
  ]);
  assert.equal(annotate(history[7]), history[7], "an ordinary tool call is untouched");
  assert.equal(history[0].promptState, undefined, "stored history is not mutated");
  assert.equal(annotate(history[12]), history[12]);
  assert.ok(liveAsk);
});

test("promptsFor attaches one registry to a lightweight session manager", function () {
  var recorded = [];
  var sm = {
    sessions: new Map(),
    sendAndRecord: function (s, m) { recorded.push(m); },
    saveSessionFile: function () {},
  };
  var reg = promptsFor(sm);
  assert.equal(promptsFor(sm), reg);
  var s = { localId: 3 };
  sm.sessions.set(3, s);
  var opened = reg.open(s, "permission", { toolName: "Bash", toolInput: {} });
  assert.equal(sm.permissionRequestIndex[opened.requestId], 3);
  assert.equal(reg.respond(opened.requestId, { decision: "deny" }).status, "resolved");
});

// --- Server paths that delegate to the registry -------------------------

function withHome(fn) {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-prompt-registry-"));
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessionsModule;
  try {
    sessionsModule = require("../lib/sessions");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  try {
    return fn(tmpHome, sessionsModule);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function attachSessionsFor(tmpHome, sm, sendTo) {
  var { attachSessions } = require("../lib/project-sessions");
  return attachSessions({
    cwd: tmpHome, slug: "test-prompt-registry", osUsers: false, currentVersion: "0.0.0",
    sm: sm, sdk: null, tm: null, clients: [], opts: {},
    send: function () {}, sendTo: sendTo, sendToAdmins: function () {},
    sendToSession: function () {}, sendToSessionOthers: function () {},
    usersModule: { isMultiUser: function () { return false; } },
    userPresence: null, pushModule: null,
    getSessionForWs: function (ws) { return ws._session || null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return true; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (o) { return o; },
    onProcessingChanged: function () {}, broadcastPresence: function () {},
    adapter: null, getProjectList: function () { return []; },
    getProjectCount: function () { return 0; }, getScheduleCount: function () { return 0; },
  });
}

// 120 filler entries, then request, user message, resolution: the last-turn
// start lands on the user message, so the first page carries the resolution
// and an older page carries the request.
test("an older history page carries the prompt's authoritative state", function () {
  withHome(function (tmpHome, sessionsModule) {
    var sent = [];
    var sendTo = function (ws, msg) { sent.push(msg); };
    var sm = sessionsModule.createSessionManager({ cwd: tmpHome, send: function () {}, sendTo: sendTo, sendEach: function () {} });
    var handlers = attachSessionsFor(tmpHome, sm, sendTo);
    var session = sm.createSessionRaw({});
    var history = [];
    for (var i = 0; i < 120; i++) history.push({ type: "delta", text: "x" + i });
    history.push({ type: "prompt_request", requestId: "req-1", kind: "permission", toolName: "Write", toolInput: { file_path: "/tmp/x" } });
    history.push({ type: "user_message", text: "typed while the card was open" });
    history.push({ type: "prompt_resolved", requestId: "req-1", kind: "permission", decision: "allow" });
    session.history = history;
    session._historyLoaded = true;
    session._historyBaseIndex = 0;
    sm.sessions.set(session.localId, session);

    sm.replayHistory(session, undefined, {});
    var meta = sent.filter(function (m) { return m.type === "history_meta"; })[0];
    handlers.handleSessionsMessage({ _session: session }, { type: "load_more_history", before: meta.from });

    var page = sent.filter(function (m) { return m.type === "history_prepend"; })[0];
    var req = page.items.filter(function (it) { return it.type === "prompt_request"; })[0];
    assert.deepEqual(req.promptState, { state: "resolved", decision: "allow" });
    assert.equal(history[120].promptState, undefined, "stored history is not mutated");
    sm.destroy();
  });
});

test("a WS prompt_response must name the prompt's kind; a mismatch is answered stale", function () {
  withHome(function (tmpHome, sessionsModule) {
    var sent = [];
    var sendTo = function (ws, msg) { sent.push(msg); };
    var sm = sessionsModule.createSessionManager({ cwd: tmpHome, send: function () {}, sendTo: sendTo, sendEach: function () {} });
    var handlers = attachSessionsFor(tmpHome, sm, sendTo);
    var session = sm.createSessionRaw({});
    sm.sessions.set(session.localId, session);
    var ask = sm.prompts.open(session, "ask_user", { input: ASK_INPUT }, { toolUseId: "tu-ask" });
    var ws = { _session: session };

    handlers.handleSessionsMessage(ws, { type: "prompt_response", requestId: "tu-ask", kind: "permission", decision: "allow" });
    handlers.handleSessionsMessage(ws, { type: "prompt_response", requestId: "tu-ask", decision: "allow" });
    assert.ok(sm.prompts.lookup("tu-ask"), "neither a wrong nor a missing kind answers the prompt");
    assert.deepEqual(sent.filter(function (m) { return m.reason === "stale"; }).map(function (m) { return m.type; }), ["prompt_cancel", "prompt_cancel"]);

    handlers.handleSessionsMessage(ws, { type: "ask_user_response", toolId: "tu-ask", answers: { 0: "prod" } });
    assert.equal(sm.prompts.lookup("tu-ask"), null, "the older ask_user_response alias still answers");
    sm.destroy();
    return ask.answer;
  });
});

function postJson(handleHTTP, urlPath, body) {
  var req = new EventEmitter();
  req.method = "POST";
  var res = {
    status: null, body: null,
    writeHead: function (code) { this.status = code; },
    end: function (b) { this.body = b; this.done(); },
  };
  var finished = new Promise(function (resolve) { res.done = resolve; });
  handleHTTP(req, res, urlPath);
  req.emit("data", JSON.stringify(body));
  req.emit("end");
  return finished.then(function () { return res; });
}

test("the HTTP push response answers tool approvals with allow or deny only, and 404s anything else", async function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-prompt-http-"));
  try {
    var saved = [];
    var sm = {
      sessions: new Map(),
      sendAndRecord: function () {},
      saveSessionFile: function (s) { saved.push(s.localId); },
    };
    var session = { localId: 5 };
    sm.sessions.set(5, session);
    var bash = promptsFor(sm).open(session, "permission", { toolName: "Bash", toolInput: { command: "make" } });
    var ask = promptsFor(sm).open(session, "ask_user", { input: ASK_INPUT }, { toolUseId: "tu-ask" });
    var { attachHTTP } = require("../lib/project-http");
    var http = attachHTTP({ cwd: tmpHome, slug: "s", sm: sm, send: function () {} });

    var grant = await postJson(http.handleHTTP, "/api/permission-response", { requestId: bash.requestId, decision: "allow_always" });
    assert.equal(grant.status, 400, "no session grant over HTTP");
    assert.ok(promptsFor(sm).lookup(bash.requestId), "a refused decision leaves the request pending");

    var wrongKind = await postJson(http.handleHTTP, "/api/permission-response", { requestId: ask.requestId, decision: "allow" });
    assert.equal(wrongKind.status, 404, "HTTP answers tool approvals only");
    assert.ok(promptsFor(sm).lookup(ask.requestId));

    var ok = await postJson(http.handleHTTP, "/api/permission-response", { requestId: bash.requestId, decision: "allow" });
    var stale = await postJson(http.handleHTTP, "/api/permission-response", { requestId: bash.requestId, decision: "deny" });
    assert.equal(ok.status, 200);
    assert.equal(stale.status, 404);
    assert.deepEqual(await bash.answer, { behavior: "allow", updatedInput: { command: "make" } });
    assert.equal(promptsFor(sm).isGranted(session, "Bash", {}), false);
    assert.deepEqual(saved, []);

    var denied = promptsFor(sm).open(session, "permission", { toolName: "Bash", toolInput: { command: "rm" } });
    await postJson(http.handleHTTP, "/api/permission-response", { requestId: denied.requestId, decision: "deny" });
    assert.deepEqual(await denied.answer, { behavior: "deny", message: "Denied via push notification" });
    promptsFor(sm).cancelSession(session, "session_deleted", { record: false });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
