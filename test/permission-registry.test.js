"use strict";
// Unit coverage for lib/permission-registry.js, the single owner of the
// permission-request lifecycle, plus the server paths that now delegate to
// it (paged history replay, the HTTP push-response endpoint).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { EventEmitter } = require("events");

var { createPermissionRegistry, permissionsFor } = require("../lib/permission-registry");

function makeRegistry() {
  var recorded = [];
  var saved = [];
  var dismissed = [];
  var badgeRefreshes = 0;
  var sessions = new Map();
  var index = {};
  var registry = createPermissionRegistry({
    index: index,
    getSession: function (id) { return sessions.get(id) || null; },
    sendAndRecord: function (session, msg) { recorded.push(msg); },
    saveSessionFile: function (session) { saved.push(session.localId); },
    getNotificationsModule: function () { return { dismissByRequestId: function (id) { dismissed.push(id); } }; },
    onProcessingChanged: function () { badgeRefreshes++; },
  });
  function addSession(localId) {
    var s = { localId: localId, queryInstance: null };
    sessions.set(localId, s);
    return s;
  }
  return {
    registry: registry, recorded: recorded, saved: saved, dismissed: dismissed, index: index,
    addSession: addSession, badgeRefreshes: function () { return badgeRefreshes; },
  };
}

function openBash(h, session, toolUseId, opts) {
  return h.registry.open(session, { toolName: "Bash", toolInput: { command: "make" }, toolUseId: toolUseId, vendor: "claude" }, opts);
}

function eventsOf(h, type) {
  return h.recorded.filter(function (m) { return m.type === type; });
}

test("open records the request, indexes it, and refreshes the badge", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var opened = openBash(h, s, "tu-1");

  assert.ok(s.pendingPermissions[opened.requestId]);
  assert.equal(h.index[opened.requestId], 1);
  assert.deepEqual(eventsOf(h, "permission_request").map(function (m) { return m.requestId; }), [opened.requestId]);
  assert.equal(h.badgeRefreshes(), 1);
});

test("a response settles exactly once; a second response is stale", async function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var opened = openBash(h, s, "tu-1");

  var first = h.registry.respond(opened.requestId, "allow");
  var second = h.registry.respond(opened.requestId, "deny");

  assert.equal(first.status, "resolved");
  assert.equal(second.status, "stale");
  assert.deepEqual(await opened.decision, { behavior: "allow", updatedInput: { command: "make" } });
  assert.deepEqual(eventsOf(h, "permission_resolved"), [{ type: "permission_resolved", requestId: opened.requestId, decision: "allow" }]);
  assert.deepEqual(s.pendingPermissions, {});
  assert.equal(h.index[opened.requestId], undefined);
  assert.deepEqual(h.dismissed, [opened.requestId, opened.requestId], "the stale response also retires any banner for it");
});

test("every decision maps to the vendor outcome, and unknown decisions fail closed", async function () {
  var cases = [
    ["allow", { behavior: "allow", updatedInput: { command: "make" } }],
    ["allow_accept_edits", { behavior: "allow", updatedInput: { command: "make" } }],
    ["deny", { behavior: "deny", message: "User denied permission" }],
    ["allow_clear_context", { behavior: "deny", message: "User chose to clear context and restart" }],
    ["something-new", { behavior: "deny", message: "User denied permission" }],
  ];
  for (var i = 0; i < cases.length; i++) {
    var h = makeRegistry();
    var opened = openBash(h, h.addSession(1), "tu");
    h.registry.respond(opened.requestId, cases[i][0]);
    assert.deepEqual(await opened.decision, cases[i][1], cases[i][0]);
  }
  var hf = makeRegistry();
  var fb = openBash(hf, hf.addSession(1), "tu");
  hf.registry.respond(fb.requestId, "deny_with_feedback", { feedback: "use make test" });
  assert.deepEqual(await fb.decision, { behavior: "deny", message: "use make test" });
});

test("allow_always writes the grant through the registry and flushes it", function () {
  var h = makeRegistry();
  var s = h.addSession(7);
  var opened = h.registry.open(s, { toolName: "Skill", toolInput: { skill: "deploy" }, toolUseId: "tu" });

  h.registry.respond(opened.requestId, "allow_always");

  assert.equal(h.registry.isGranted(s, "Skill", { skill: "deploy" }), true);
  assert.equal(h.registry.isGranted(s, "Skill", { skill: "other" }), false, "a grant is scoped to its discriminator");
  assert.deepEqual(h.saved, [7]);
});

test("a response finds its session by index, or falls back to the given session", function () {
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

  assert.deepEqual(await aborted.decision, { behavior: "deny", message: "Request cancelled" });
  assert.deepEqual(await expired.decision, { behavior: "deny", message: "Permission request timed out" });
  assert.deepEqual(eventsOf(h, "permission_cancel").map(function (m) { return m.reason; }), ["aborted", "expired"]);
});

test("the turn boundary ends top-level requests and keeps a live sub-agent's", async function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  h.registry.taskStarted(s, "task-1");
  h.registry.noteSubagentTool(s, "tu-sub", "task-1");
  var sub = openBash(h, s, "tu-sub");
  var top = openBash(h, s, "tu-top");

  h.registry.endTurn(s);

  assert.ok(s.pendingPermissions[sub.requestId], "sub-agent request survives the parent turn");
  assert.equal(s.pendingPermissions[top.requestId], undefined);
  assert.deepEqual(await top.decision, { behavior: "deny", message: "Session turn ended" });
  assert.deepEqual(eventsOf(h, "permission_cancel"), [{ type: "permission_cancel", requestId: top.requestId, reason: "turn_ended" }]);
  assert.deepEqual(h.registry.retainedTaskIds(s), { "task-1": true });
});

test("a request owned by a Task that never started is treated as top-level", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  h.registry.noteSubagentTool(s, "tu-sub", "task-unknown");
  var sub = openBash(h, s, "tu-sub");

  h.registry.endTurn(s);

  assert.equal(s.pendingPermissions[sub.requestId], undefined);
});

test("a sub-agent request made after an earlier turn boundary is still the sub-agent's", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  h.registry.taskStarted(s, "task-1");
  h.registry.endTurn(s);
  h.registry.noteSubagentTool(s, "tu-late", "task-1");
  var late = openBash(h, s, "tu-late");

  h.registry.endTurn(s);

  assert.ok(s.pendingPermissions[late.requestId], "Task liveness is not trimmed by a turn that had nothing to keep");
});

test("a Task that ends while its request is pending stays in scope until the request settles", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  h.registry.taskStarted(s, "task-1");
  h.registry.noteSubagentTool(s, "tu-sub", "task-1");
  h.registry.noteSubagentTool(s, "tu-done", "task-1");
  var sub = openBash(h, s, "tu-sub");

  h.registry.taskEnded(s, "task-1");
  assert.equal(s.subagentTasks["task-1"], "ending");
  assert.equal(s.subagentToolOwners["tu-sub"], "task-1");
  assert.equal(s.subagentToolOwners["tu-done"], undefined, "unreferenced ownership is pruned at once");

  h.registry.endTurn(s);
  assert.ok(s.pendingPermissions[sub.requestId], "an ending Task still keeps its request across the turn");

  h.registry.respond(sub.requestId, "allow");
  assert.equal(s.subagentTasks["task-1"], undefined);
  assert.equal(s.subagentToolOwners["tu-sub"], undefined);
});

test("query end ends only that query's requests; an owner also ends unstamped ones and resets sub-agent state", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var oldQuery = {};
  var newQuery = {};
  s.queryInstance = oldQuery;
  var fromOld = openBash(h, s, "tu-old");
  s.queryInstance = newQuery;
  var fromNew = openBash(h, s, "tu-new");
  s.queryInstance = null;
  var unstamped = openBash(h, s, "tu-none");
  h.registry.taskStarted(s, "task-1");

  h.registry.endQuery(s, oldQuery, false);
  assert.deepEqual(Object.keys(s.pendingPermissions).sort(), [fromNew.requestId, unstamped.requestId].sort());
  assert.equal(s.subagentTasks["task-1"], "live", "a superseded query does not touch the session's sub-agent state");

  h.registry.endQuery(s, newQuery, true);
  assert.deepEqual(s.pendingPermissions, {});
  assert.deepEqual(s.subagentTasks, {});
  assert.ok(eventsOf(h, "permission_cancel").every(function (m) { return m.reason === "query_ended"; }));
  assert.ok(fromOld.requestId);
});

test("cancelSession without recording settles every resolver and emits no event", async function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var a = openBash(h, s, "tu-a");

  h.registry.cancelSession(s, "session_deleted", { record: false });

  assert.deepEqual(await a.decision, { behavior: "deny", message: "Session deleted" });
  assert.equal(eventsOf(h, "permission_cancel").length, 0);
  assert.deepEqual(h.dismissed, [a.requestId]);
});

test("pendingRequests re-presents every pending request", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var a = openBash(h, s, "tu-a");

  assert.deepEqual(h.registry.pendingRequests(s), [{
    type: "permission_request_pending",
    requestId: a.requestId,
    toolName: "Bash",
    toolInput: { command: "make" },
    toolUseId: "tu-a",
    decisionReason: "",
    mateId: undefined,
  }]);
});

test("replayAnnotator stamps the authoritative state without mutating history", function () {
  var h = makeRegistry();
  var s = h.addSession(1);
  var live = openBash(h, s, "tu-live");
  var history = [
    { type: "permission_request", requestId: "r-allowed" },
    { type: "permission_request", requestId: "r-cancelled" },
    { type: "permission_request", requestId: "r-lost" },
    { type: "permission_request", requestId: live.requestId },
    { type: "permission_resolved", requestId: "r-allowed", decision: "allow_always" },
    { type: "permission_cancel", requestId: "r-cancelled", reason: "turn_ended" },
    { type: "delta", text: "x" },
  ];

  var annotate = h.registry.replayAnnotator(s, history, 0);
  var states = history.slice(0, 4).map(function (it) { return annotate(it).permissionState; });

  assert.deepEqual(states, [
    { state: "resolved", decision: "allow_always" },
    { state: "cancelled", reason: "turn_ended" },
    { state: "cancelled", reason: "stale" },
    { state: "pending" },
  ]);
  assert.equal(history[0].permissionState, undefined);
  assert.equal(annotate(history[6]), history[6]);
});

test("permissionsFor attaches one registry to a lightweight session manager", function () {
  var recorded = [];
  var sm = {
    sessions: new Map(),
    sendAndRecord: function (s, m) { recorded.push(m); },
    saveSessionFile: function () {},
  };
  var reg = permissionsFor(sm);
  assert.equal(permissionsFor(sm), reg);
  var s = { localId: 3 };
  sm.sessions.set(3, s);
  var opened = reg.open(s, { toolName: "Bash", toolInput: {} });
  assert.equal(sm.permissionRequestIndex[opened.requestId], 3);
  assert.equal(reg.respond(opened.requestId, "deny").status, "resolved");
});

// --- Server paths that delegate to the registry -------------------------

function withHome(fn) {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-perm-registry-"));
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
    cwd: tmpHome, slug: "test-perm-registry", osUsers: false, currentVersion: "0.0.0",
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
test("an older history page carries the request's authoritative state", function () {
  withHome(function (tmpHome, sessionsModule) {
    var sent = [];
    var sendTo = function (ws, msg) { sent.push(msg); };
    var sm = sessionsModule.createSessionManager({ cwd: tmpHome, send: function () {}, sendTo: sendTo, sendEach: function () {} });
    var handlers = attachSessionsFor(tmpHome, sm, sendTo);
    var session = sm.createSessionRaw({});
    var history = [];
    for (var i = 0; i < 120; i++) history.push({ type: "delta", text: "x" + i });
    history.push({ type: "permission_request", requestId: "req-1", toolName: "Write", toolInput: { file_path: "/tmp/x" } });
    history.push({ type: "user_message", text: "typed while the card was open" });
    history.push({ type: "permission_resolved", requestId: "req-1", decision: "allow" });
    session.history = history;
    session._historyLoaded = true;
    session._historyBaseIndex = 0;
    sm.sessions.set(session.localId, session);

    sm.replayHistory(session, undefined, {});
    var meta = sent.filter(function (m) { return m.type === "history_meta"; })[0];
    handlers.handleSessionsMessage({ _session: session }, { type: "load_more_history", before: meta.from });

    var page = sent.filter(function (m) { return m.type === "history_prepend"; })[0];
    var req = page.items.filter(function (it) { return it.type === "permission_request"; })[0];
    assert.deepEqual(req.permissionState, { state: "resolved", decision: "allow" });
    assert.equal(history[120].permissionState, undefined, "stored history is not mutated");
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

test("the HTTP push response resolves through the registry, honouring allow_always, and 404s a stale id", async function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-perm-http-"));
  try {
    var saved = [];
    var sm = {
      sessions: new Map(),
      sendAndRecord: function () {},
      saveSessionFile: function (s) { saved.push(s.localId); },
    };
    var session = { localId: 5 };
    sm.sessions.set(5, session);
    var opened = permissionsFor(sm).open(session, { toolName: "Bash", toolInput: { command: "make" } });
    var { attachHTTP } = require("../lib/project-http");
    var http = attachHTTP({ cwd: tmpHome, slug: "s", sm: sm, send: function () {} });

    var ok = await postJson(http.handleHTTP, "/api/permission-response", { requestId: opened.requestId, decision: "allow_always" });
    var stale = await postJson(http.handleHTTP, "/api/permission-response", { requestId: opened.requestId, decision: "allow" });

    assert.equal(ok.status, 200);
    assert.equal(stale.status, 404);
    assert.deepEqual(await opened.decision, { behavior: "allow", updatedInput: { command: "make" } });
    assert.equal(permissionsFor(sm).isGranted(session, "Bash", {}), true);
    assert.deepEqual(saved, [5]);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
