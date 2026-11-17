// A private session is private: only its owner can see it, type into it, learn
// that it exists, or change its visibility. A real server, real users and real
// WebSocket clients; only the project-access lookup is a table.
//
// The caller shapes: the owner (two connections), a project member who is not
// the owner, an admin who is not the owner, a session with no owner (admin and
// non-admin), and a connection that already has the session open when its
// visibility changes.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var harness = require("./access-harness");

var H = null;
var SM = null;
var CTX = null;

test.before(async function () {
  H = await harness.start({
    users: [
      { key: "alice", username: "alice" },
      { key: "bob", username: "bob" },
      { key: "carol", username: "carol", role: "admin" },
    ],
    projects: [{ slug: "team", visibility: "public" }],
  });
  H.relay.forEachProject(function (ctx, slug) { if (slug === "team") CTX = ctx; });
  SM = CTX.sm;
});

test.after(async function () {
  if (H) await H.stop();
});

function makeSession(ownerKey, visibility) {
  return SM.createSessionRaw({ ownerId: ownerKey ? H.people[ownerKey].id : null, sessionVisibility: visibility });
}

async function connect(userKey) {
  var c = await H.connect("team", userKey);
  assert.ok(c.ok, "connect " + userKey);
  await c.waitFor(function (m) { return m.type === "session_list"; });
  return c;
}

async function view(client, session) {
  client.inbox.length = 0;
  client.send({ type: "switch_session", id: session.localId });
  await client.waitFor(function (m) { return m.type === "session_switched" && m.id === session.localId; });
}

function boundSessions(userKey) {
  var out = [];
  CTX.forEachClient(function (ws) {
    if (ws._clagenticUser && ws._clagenticUser.id === H.people[userKey].id) out.push(ws._clagenticActiveSession || null);
  });
  return out;
}

function got(client, pred) {
  return client.inbox.filter(pred);
}

function userMessages(session, userKey) {
  return session.history.filter(function (e) {
    return e.type === "user_message" && e.from === H.people[userKey].id;
  });
}

var NOT_AVAILABLE = /not available/i;

// --- who may change a session's visibility ----------------------------------------

var VISIBILITY_ROWS = [
  { name: "owner, shared to private", actor: "alice", owner: "alice", from: "shared", set: "private", applied: true },
  { name: "owner, private to shared", actor: "alice", owner: "alice", from: "private", set: "shared", applied: true },
  { name: "member who is not the owner, shared to private", actor: "bob", owner: "alice", from: "shared", set: "private", applied: false, told: true },
  { name: "admin who is not the owner, shared to private", actor: "carol", owner: "alice", from: "shared", set: "private", applied: false, told: true },
  { name: "admin who is not the owner, private to shared", actor: "carol", owner: "alice", from: "private", set: "shared", applied: false },
  { name: "member who is not the owner, private to shared", actor: "bob", owner: "alice", from: "private", set: "shared", applied: false },
  { name: "ownerless session, admin", actor: "carol", owner: null, from: "shared", set: "private", applied: true },
  { name: "ownerless session, non-admin", actor: "bob", owner: null, from: "shared", set: "private", applied: false },
];

VISIBILITY_ROWS.forEach(function (row) {
  test("visibility: " + row.name, async function () {
    var session = makeSession(row.owner, row.from);
    var watcher = await connect("alice");
    var actor = await connect(row.actor);
    watcher.inbox.length = 0;
    actor.inbox.length = 0;
    actor.send({ type: "set_session_visibility", sessionId: session.localId, visibility: row.set });
    await harness.settle(250);
    assert.equal(session.sessionVisibility, row.applied ? row.set : row.from);
    var lists = got(watcher, function (m) { return m.type === "session_list"; });
    if (!row.applied) assert.equal(lists.length, 0, "a refused change broadcasts nothing");
    var told = got(actor, function (m) { return m.type === "error" && /owner/i.test(m.text || ""); });
    assert.equal(told.length, row.told ? 1 : 0, "the refusal is said to a caller who can read the session");
  });
});

// --- a viewer when the session turns private --------------------------------------

test("private: a viewer is unbound, refused and sent nothing; the owner's connections carry on", async function () {
  var session = makeSession("alice", "shared");
  var a1 = await connect("alice");
  var a2 = await connect("alice");
  var b1 = await connect("bob");
  var c1 = await connect("carol");
  await view(a1, session);
  await view(a2, session);
  await view(b1, session);
  await view(c1, session);

  a1.inbox.length = 0; a2.inbox.length = 0; b1.inbox.length = 0; c1.inbox.length = 0;
  a1.send({ type: "set_session_visibility", sessionId: session.localId, visibility: "private" });
  await b1.waitFor(function (m) { return m.type === "error" && NOT_AVAILABLE.test(m.text || ""); });
  await c1.waitFor(function (m) { return m.type === "error" && NOT_AVAILABLE.test(m.text || ""); });
  assert.equal(session.sessionVisibility, "private");
  assert.deepEqual(boundSessions("bob"), [null], "the member is no longer bound to it");
  assert.deepEqual(boundSessions("carol"), [null], "nor an admin who does not own it");
  assert.deepEqual(boundSessions("alice").sort(), [session.localId, session.localId], "both of the owner's connections stay bound");

  // stream, status and done frames
  b1.inbox.length = 0; c1.inbox.length = 0; a1.inbox.length = 0; a2.inbox.length = 0;
  SM.sendAndRecord(session, { type: "delta", text: "private-stream" });
  SM.sendToSession(session, { type: "status", status: "processing" });
  SM.sendAndRecord(session, { type: "done" });
  await a1.waitFor(function (m) { return m.type === "done"; });
  await a2.waitFor(function (m) { return m.type === "done"; });
  await harness.settle(200);
  [b1, c1].forEach(function (c) {
    assert.deepEqual(got(c, function (m) { return m.type === "delta" || m.type === "status" || m.type === "done"; }), []);
  });
  assert.equal(got(a1, function (m) { return m.type === "delta"; }).length, 1);
  assert.equal(got(a2, function (m) { return m.type === "delta"; }).length, 1);

  // a message, and separately a user mention, on the connection that had it open
  session.isProcessing = true;
  var before = session.history.length;
  b1.inbox.length = 0;
  b1.send({ type: "message", text: "member-typing" });
  b1.send({ type: "user_mention", targetUserId: H.people.carol.id, text: "member-mention" });
  await harness.settle(300);
  assert.equal(session.history.length, before, "nothing was recorded");
  assert.equal(session.pendingMessages ? session.pendingMessages.length : 0, 0, "nothing reached the agent");
  assert.equal(got(b1, function (m) { return m.type === "user_mention_error" && NOT_AVAILABLE.test(m.error || ""); }).length, 1, "the mention is refused and said so");

  // the owner is unaffected: set it back to shared and type into it
  a2.send({ type: "set_session_visibility", sessionId: session.localId, visibility: "shared" });
  await harness.settle(200);
  assert.equal(session.sessionVisibility, "shared");
  a2.send({ type: "message", text: "owner-typing" });
  await harness.settle(300);
  assert.equal(userMessages(session, "alice").length, 1, "the owner's message is recorded");
  session.isProcessing = false;
});

// --- a bound session the user can no longer read, at each caller ---------------------

var BOUND_ROWS = [
  {
    name: "load_more_history (a caller other than the message handler)",
    act: function (b) { b.send({ type: "load_more_history", before: 1 }); },
    leaked: function (m) { return m.type === "history_prepend"; },
  },
  {
    name: "message",
    act: function (b) { b.send({ type: "message", text: "late-typing" }); },
    leaked: function () { return false; },
    recorded: true,
  },
];

BOUND_ROWS.forEach(function (row) {
  test("bound session turned unreadable: " + row.name, async function () {
    var session = makeSession("alice", "shared");
    session.isProcessing = true;
    var b1 = await connect("bob");
    await view(b1, session);
    // Changed without the visibility handler, so the shared primitive alone must refuse.
    session.sessionVisibility = "private";
    var before = session.history.length;
    b1.inbox.length = 0;
    row.act(b1);
    await harness.settle(300);
    assert.deepEqual(got(b1, row.leaked), [], "nothing of the session is served");
    assert.equal(session.history.length, before, "nothing is recorded");
    assert.equal(session.pendingMessages ? session.pendingMessages.length : 0, 0, "nothing reaches the agent");
    assert.deepEqual(boundSessions("bob"), [null]);
    session.isProcessing = false;
  });
});

test("bound session turned unreadable: per-session delivery from and to the connection", async function () {
  var session = makeSession("alice", "shared");
  var a1 = await connect("alice");
  var a2 = await connect("alice");
  var b1 = await connect("bob");
  await view(a1, session);
  await view(a2, session);
  await view(b1, session);
  session.sessionVisibility = "private";
  a1.inbox.length = 0; a2.inbox.length = 0; b1.inbox.length = 0;
  // to the member: a frame the owner's connection sends to the others on the session
  a1.send({ type: "input_sync", text: "owner-draft" });
  await a2.waitFor(function (m) { return m.type === "input_sync"; });
  await harness.settle(200);
  assert.deepEqual(got(b1, function (m) { return m.type === "input_sync"; }), [], "not delivered to a connection that cannot read it");
  // from the member: its frame is not delivered to the owner's other connection
  a2.inbox.length = 0;
  b1.send({ type: "input_sync", text: "member-draft" });
  await harness.settle(250);
  assert.deepEqual(got(a2, function (m) { return m.type === "input_sync"; }), []);
});

// --- presence -------------------------------------------------------------------------

test("presence: a member gets no entry for a private session; the owner and shared sessions are as before", async function () {
  var priv = makeSession("alice", "private");
  var shared = makeSession("alice", "shared");
  var a1 = await connect("alice");
  var b1 = await connect("bob");
  var c1 = await connect("carol");
  await view(a1, priv);
  await view(c1, shared);
  await view(b1, shared);
  await harness.settle(250);
  function lastPresence(c) {
    var all = got(c, function (m) { return m.type === "session_presence"; });
    return all.length ? all[all.length - 1].presence : null;
  }
  var mine = lastPresence(a1);
  var theirs = lastPresence(b1);
  var admins = lastPresence(c1);
  assert.ok(mine && theirs && admins, "presence reached every client");
  assert.ok(mine[priv.localId], "the owner sees who has the private session open");
  assert.equal(theirs[priv.localId], undefined, "a member does not");
  assert.equal(admins[priv.localId], undefined, "nor an admin who does not own it");
  [mine, theirs, admins].forEach(function (p) {
    assert.deepEqual((p[shared.localId] || []).map(function (u) { return u.username; }).sort(), ["bob", "carol"], "the shared session's entry is as before");
  });
});

// --- other broadcasts that carry a session id -------------------------------------------

test("a running private session's activity is not announced to members who cannot read it", async function () {
  var priv = makeSession("alice", "private");
  var shared = makeSession("alice", "shared");
  priv.isProcessing = true;
  var a1 = await connect("alice");
  var b1 = await connect("bob");
  await view(a1, priv);
  await view(b1, shared);
  b1.inbox.length = 0;
  SM.sendAndRecord(priv, { type: "delta", text: "working" });
  await a1.waitFor(function (m) { return m.type === "delta"; });
  await harness.settle(200);
  assert.deepEqual(got(b1, function (m) { return m.type === "session_io" && m.id === priv.localId; }), []);
  priv.isProcessing = false;
});
