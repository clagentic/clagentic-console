"use strict";
// Labelled prompts and scoped "Allow for Session" grants, on the real session
// manager, SDK bridge, notifications module and WS session handlers
// (prompt-harness-world.js). The persisted grant shapes below are the shapes
// older sessions carry in their meta record (allowedTools {Write: true},
// {Bash: true}, {Write: true, Bash: true}); only the shape is used.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");
var { promptsFor } = require("../lib/prompt-registry");
var sessionReclaim = require("../lib/session-reclaim");

var client = world.client;
var withServer = world.withServer;

function answer(server, c, id, decision) {
  server.handlers.handleSessionsMessage(c.ws, { type: "prompt_response", requestId: id, kind: "permission", decision: decision });
}

// The sessions's grant map as a plain object, keys sorted.
function grantKeys(server) {
  return Object.keys(server.session.allowedTools || {}).sort();
}

function persistedGrants(server) {
  var fs = require("fs");
  var path = require("path");
  var dir = server.home;
  var found = null;
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
      if (e.isDirectory()) return walk(path.join(d, e.name));
      if (!e.name.endsWith(".jsonl")) return;
      var meta = JSON.parse(fs.readFileSync(path.join(d, e.name), "utf8").split("\n")[0]);
      if (meta.cliSessionId === server.session.cliSessionId) found = meta.allowedTools || {};
    });
  })(dir);
  return found;
}

test("a grant from a Bash find prompt covers find and not rm", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var first = server.ask("Bash", { command: "find /work -name x" });
    var prompt = c.inbox.filter(function (m) { return m.type === "prompt_request" && m.requestId === first.id; })[0];
    assert.equal(prompt.grantScope, "Allow Bash commands starting with find in this session", "the card states the scope before the click");
    answer(server, c, first.id, "allow_always");
    assert.equal((await first.promise).behavior, "allow");
    assert.deepEqual(grantKeys(server), ["Bash:find"], "the grant is the command prefix, not the whole tool");

    var again = server.ask("Bash", { command: "find /work -name y" });
    assert.equal(again.opened.length, 0, "a later find is answered by the grant");
    assert.equal((await again.promise).behavior, "allow");

    var rm = server.ask("Bash", { command: "rm -rf /work/x" });
    assert.equal(rm.opened.length, 1, "a later rm prompts");
    var destructive = server.ask("Bash", { command: "find /work -delete" });
    assert.equal(destructive.opened.length, 1, "so does a find that deletes");
  });
});

test("a grant on Write to a path covers that file and no other", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var first = server.ask("Write", { file_path: "/work/a/one.txt", content: "x" });
    var prompt = c.inbox.filter(function (m) { return m.type === "prompt_request" && m.requestId === first.id; })[0];
    assert.equal(prompt.grantScope, "Allow Write on this file only (/work/a/one.txt) in this session");
    answer(server, c, first.id, "allow_always");
    await first.promise;
    assert.deepEqual(grantKeys(server), ["Write:/work/a/one.txt"]);

    assert.equal(server.ask("Write", { file_path: "/work/a/one.txt" }).opened.length, 0, "the same file");
    assert.equal(server.ask("Write", { file_path: "/work/a/two.txt" }).opened.length, 1, "a sibling file in the same directory prompts");
    assert.equal(server.ask("Write", { file_path: "/work/b/one.txt" }).opened.length, 1, "a Write to another directory prompts");
    assert.equal(server.ask("Write", { file_path: "/work/a/link/../one.txt" }).opened.length, 1, "another spelling prompts");
    assert.equal(server.ask("Edit", { file_path: "/work/a/one.txt" }).opened.length, 1, "an Edit is another tool");
  });
});

test("a relative path is allowed once only", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var rel = server.ask("Write", { file_path: "work/a.txt" });
    var prompt = c.inbox.filter(function (m) { return m.type === "prompt_request" && m.requestId === rel.id; })[0];
    assert.equal(prompt.grantScope, null);
    answer(server, c, rel.id, "allow_always");
    await world.flush();
    assert.deepEqual(grantKeys(server), []);
  });
});

test("a call that cannot be granted narrowly offers no session grant and the answer settles nothing", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    var bare = server.ask("Write", { content: "no path" });
    var prompt = c.inbox.filter(function (m) { return m.type === "prompt_request" && m.requestId === bare.id; })[0];
    assert.equal(prompt.grantScope, null, "the card is told there is nothing to grant");

    c.inbox.length = 0;
    answer(server, c, bare.id, "allow_always");
    await world.flush();
    assert.deepEqual(server.heldPromptIds(), [bare.id], "still pending");
    assert.deepEqual(grantKeys(server), [], "nothing was granted");
    assert.equal(c.inbox.filter(function (m) { return m.type === "prompt_pending"; }).length, 1, "re-offered to the responder");

    answer(server, c, bare.id, "allow");
    assert.equal((await bare.promise).behavior, "allow", "Allow once still works");
    assert.deepEqual(grantKeys(server), []);
  });
});

test("the push route still answers allow or deny only, so it never writes a grant", async function () {
  await withServer(async function (server) {
    var opened = server.ask("Bash", { command: "find ." });
    assert.equal(await server.httpRespond(opened.id, "allow_always"), 400);
    assert.deepEqual(grantKeys(server), []);
    assert.equal(await server.httpRespond(opened.id, "allow"), 200);
    assert.deepEqual(grantKeys(server), [], "an allow over push grants nothing");
  });
});

// The meta shapes observed on real sessions, as fixtures.
var OBSERVED_SHAPES = [
  { name: "{Write: true}", map: { Write: true }, covered: [["Write", { file_path: "/any/where/x" }]], notCovered: [["Bash", { command: "rm x" }]] },
  { name: "{Bash: true}", map: { Bash: true }, covered: [["Bash", { command: "rm -rf x" }]], notCovered: [["Write", { file_path: "/any/where/x" }]] },
  { name: "{Write: true, Bash: true}", map: { Write: true, Bash: true }, covered: [["Write", { file_path: "/a/b" }], ["Bash", { command: "rm x" }]], notCovered: [["Edit", { file_path: "/a/b" }]] },
];

OBSERVED_SHAPES.forEach(function (shape) {
  test("persisted " + shape.name + ": still in force, listed as whole-tool, revocable, and the revoke is persisted", async function () {
    await withServer(async function (server) {
      var c = client();
      server.connect(c.ws);
      server.session.allowedTools = Object.assign(Object.create(null), shape.map);
      server.sm.saveSessionFile(server.session);

      shape.covered.forEach(function (call) {
        assert.equal(server.ask(call[0], call[1]).opened.length, 0, "readable: " + call[0] + " is still covered");
      });
      shape.notCovered.forEach(function (call) {
        assert.equal(server.ask(call[0], call[1]).opened.length, 1, call[0] + " is not covered");
      });

      c.inbox.length = 0;
      server.handlers.handleSessionsMessage(c.ws, { type: "list_session_grants", sessionId: server.session.localId });
      var listed = c.inbox.filter(function (m) { return m.type === "session_grants"; })[0];
      assert.equal(listed.sessionId, server.session.localId);
      assert.deepEqual(listed.grants.map(function (g) { return g.key; }), Object.keys(shape.map).sort());
      listed.grants.forEach(function (g) {
        assert.equal(g.wholeTool, true, g.key + " is shown as a whole-tool grant");
        assert.match(g.text, /whole-tool/);
      });

      var target = Object.keys(shape.map)[0];
      c.inbox.length = 0;
      server.handlers.handleSessionsMessage(c.ws, { type: "revoke_session_grant", sessionId: server.session.localId, key: target });
      var after = c.inbox.filter(function (m) { return m.type === "session_grants"; })[0];
      assert.ok(after.grants.every(function (g) { return g.key !== target; }), "the revoked grant is gone from the list");
      assert.equal(persistedGrants(server)[target], undefined, "and from the persisted meta, at once");

      var call = shape.covered.filter(function (cv) { return cv[0] === target; })[0];
      assert.equal(server.ask(call[0], call[1]).opened.length, 1, "the next call of the revoked tool prompts");
      Object.keys(shape.map).filter(function (k) { return k !== target; }).forEach(function (k) {
        var other = shape.covered.filter(function (cv) { return cv[0] === k; })[0];
        assert.equal(server.ask(other[0], other[1]).opened.length, 0, k + " is untouched by the revoke");
      });
    });
  });
});

test("a revoked scoped grant survives a daemon restart as revoked, and a held one as held", async function () {
  var first = await world.createServer();
  var home = first.home;
  var cliSessionId = first.session.cliSessionId;
  try {
    await first.startQuery();
    var c = client();
    first.connect(c.ws);
    var a = first.ask("Bash", { command: "find ." });
    answer(first, c, a.id, "allow_always");
    await a.promise;
    var b = first.ask("Write", { file_path: "/work/a/x" });
    answer(first, c, b.id, "allow_always");
    await b.promise;
    assert.deepEqual(grantKeys(first), ["Bash:find", "Write:/work/a/x"]);
    first.handlers.handleSessionsMessage(c.ws, { type: "revoke_session_grant", sessionId: first.session.localId, key: "Bash:find" });
    first.shutdown();

    var second = await world.createServer({ home: home, cliSessionId: cliSessionId });
    try {
      await second.startQuery();
      assert.deepEqual(grantKeys(second), ["Write:/work/a/x"]);
      assert.equal(second.ask("Bash", { command: "find ." }).opened.length, 1, "the revoked grant stays revoked");
      assert.equal(second.ask("Write", { file_path: "/work/a/x" }).opened.length, 0, "the held grant is still held");
      assert.equal(second.ask("Write", { file_path: "/work/a/y" }).opened.length, 1, "a sibling still prompts");
    } finally {
      second.shutdown();
    }
  } finally {
    world.removeHome(home);
  }
});

test("revoke names a key the session does not hold: nothing changes and the list is returned", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    server.session.allowedTools = Object.assign(Object.create(null), { "Bash:find": true });
    c.inbox.length = 0;
    ["Bash:rm", "constructor", "__proto__", 7, null, undefined].forEach(function (key) {
      server.handlers.handleSessionsMessage(c.ws, { type: "revoke_session_grant", sessionId: server.session.localId, key: key });
    });
    assert.deepEqual(grantKeys(server), ["Bash:find"]);
    assert.equal(c.inbox.filter(function (m) { return m.type === "session_grants"; }).length, 6);
  });
});

test("a client that may not see the session can neither list nor revoke its grants, and is told the revoke was refused", async function () {
  await withServer(async function (server) {
    server.session.ownerId = "u-owner";
    server.session.sessionVisibility = "private";
    server.session.allowedTools = Object.assign(Object.create(null), { Bash: true, "Write:/work/a": true });
    var stranger = client();
    stranger.ws._clagenticUser = { id: "u-other" };
    var owner = client();
    owner.ws._clagenticUser = { id: "u-owner" };
    server.connect(stranger.ws);
    server.connect(owner.ws);
    stranger.inbox.length = 0;
    owner.inbox.length = 0;

    var id = server.session.localId;
    server.handlers.handleSessionsMessage(stranger.ws, { type: "list_session_grants", sessionId: id });
    assert.equal(stranger.inbox.filter(function (m) { return m.type === "session_grants"; }).length, 0, "the list is not shown");
    server.handlers.handleSessionsMessage(stranger.ws, { type: "revoke_session_grant", sessionId: id, key: "Bash" });
    var refusal = stranger.inbox.filter(function (m) { return m.type === "session_grants"; });
    assert.equal(refusal.length, 1);
    assert.equal(typeof refusal[0].error, "string");
    assert.equal(refusal[0].grants, undefined, "a refusal carries no grants");
    assert.deepEqual(grantKeys(server), ["Bash", "Write:/work/a"], "nothing was revoked");
    assert.equal(owner.inbox.filter(function (m) { return m.type === "session_grants"; }).length, 0);

    server.handlers.handleSessionsMessage(owner.ws, { type: "revoke_session_grant", sessionId: id, key: "Bash" });
    assert.deepEqual(grantKeys(server), ["Write:/work/a"], "the owner's revoke applies");
  });
});

test("listing and revoking name a session by id; an unknown or non-numeric id is ignored", async function () {
  await withServer(async function (server) {
    var c = client();
    server.connect(c.ws);
    c.inbox.length = 0;
    server.handlers.handleSessionsMessage(c.ws, { type: "list_session_grants", sessionId: 9999 });
    server.handlers.handleSessionsMessage(c.ws, { type: "list_session_grants", sessionId: "1" });
    assert.equal(c.inbox.filter(function (m) { return m.type === "session_grants"; }).length, 0);
    server.handlers.handleSessionsMessage(c.ws, { type: "list_session_grants" });
    assert.equal(c.inbox.filter(function (m) { return m.type === "session_grants"; }).length, 1, "no id means the connection's own session");
  });
});

// --- labels ----------------------------------------------------------------

function notificationFor(server, requestId) {
  var state = null;
  server.notifications.sendConnectionState({}, function (ws, msg) { state = msg; });
  return state.notifications.filter(function (n) { return n.meta && n.meta.requestId === requestId; })[0];
}

function pushRecorder() {
  var sent = [];
  return {
    sent: sent,
    sendPush: function (p) { sent.push(p); },
    sendPushToUser: function (id, p) { sent.push(p); },
  };
}

test("prompts from two projects each carry their own project, session title and agent on the card, banner and push", async function () {
  var pushA = pushRecorder();
  var pushB = pushRecorder();
  var a = await world.createServer({ projectName: "Project Alpha", pushModule: pushA });
  var b = await world.createServer({ projectName: "Project Beta", pushModule: pushB });
  try {
    a.session.title = "DO NOT ANSWER probe";
    b.session.title = "Release notes";
    await a.startQuery();
    await b.startQuery();

    // A background agent in B raised its prompt.
    var prompts = promptsFor(b.sm);
    prompts.taskStarted(b.session, "task-1");
    prompts.noteSubagentTool(b.session, "tu-sub", "task-1");
    sessionReclaim.noteTaskLabel(b.session, "task-1", { description: "scan the repository" });

    var ca = client();
    var cb = client();
    a.connect(ca.ws);
    b.connect(cb.ws);
    var askA = a.ask("Bash", { command: "find /var/tmp -name x" });
    var askB = b.ask("Write", { file_path: "/work/notes.md" }, { toolUseID: "tu-sub" });

    var cardA = ca.inbox.filter(function (m) { return m.type === "prompt_request" && m.requestId === askA.id; })[0];
    var cardB = cb.inbox.filter(function (m) { return m.type === "prompt_request" && m.requestId === askB.id; })[0];
    assert.deepEqual(cardA.label, { project: "Project Alpha", session: "DO NOT ANSWER probe", agent: "" });
    assert.deepEqual(cardB.label, { project: "Project Beta", session: "Release notes", agent: "scan the repository" });

    var bannerA = notificationFor(a, askA.id);
    var bannerB = notificationFor(b, askB.id);
    assert.deepEqual(bannerA.meta.label, cardA.label, "the banner carries the same label as the card");
    assert.deepEqual(bannerB.meta.label, cardB.label);
    assert.equal(bannerA.meta.grantScope, "Allow Bash commands starting with find in this session", "and states the scope");

    assert.equal(pushA.sent.length, 1);
    assert.match(pushA.sent[0].body, /^Project: Project Alpha \| Session: DO NOT ANSWER probe\n/, "the push body leads with whose prompt it is");
    assert.doesNotMatch(pushA.sent[0].body, /Beta/);
    assert.match(pushB.sent[0].body, /^Project: Project Beta \| Session: Release notes \| Agent: scan the repository\n/);
    assert.match(pushB.sent[0].title, /scan the repository/, "the push title still names the background agent");

    var pendingB = promptsFor(b.sm).pendingMessages(b.session)[0];
    assert.deepEqual(pendingB.label, cardB.label, "a client connecting later sees the same label");
  } finally {
    a.shutdown();
    b.shutdown();
    world.removeHome(a.home);
    world.removeHome(b.home);
  }
});

test("a label is bounded and one line whatever the session title holds", async function () {
  await withServer(async function (server) {
    server.session.title = "line one\nline two " + "x".repeat(300);
    var opened = server.ask("Bash", { command: "rm x" });
    var label = promptsFor(server.sm).pendingMessages(server.session)[0].label;
    assert.equal(label.session.indexOf("\n"), -1);
    assert.ok(label.session.length <= 80);
    assert.ok(opened.id);
  });
});

test("an untitled session still says so, and every prompt kind carries a label", async function () {
  await withServer(async function (server) {
    server.session.title = "";
    var prompts = promptsFor(server.sm);    prompts.open(server.session, "ask_user", { input: { questions: [{ question: "Which?" }] } }, { toolUseId: "tu-q" });
    prompts.open(server.session, "elicitation", { serverName: "srv", message: "?" }, {});
    prompts.open(server.session, "plan", { toolName: "ExitPlanMode", toolInput: { plan: "p" } }, {});
    var msgs = prompts.pendingMessages(server.session);
    assert.equal(msgs.length, 3);
    msgs.forEach(function (m) {
      assert.equal(m.label.session, "(untitled session)", m.kind);
    });
  });
});
