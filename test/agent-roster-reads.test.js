"use strict";

// What a connection may read of the agent roster, and what it may change. One
// access primitive (visibleEntry) answers both: places are limited to the
// projects the caller can read, an agent with none is left out, a write to an
// agent the caller cannot see gets the reply of an unknown key, and no place
// carries a session id. A change is announced to everyone as a nudge with no
// roster content. Neutral fixtures: no real agent, crew or deployment names.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var roster = require("../lib/agent-roster");
var rosterWs = require("../lib/agent-roster-ws");
var { createOutboundAccess } = require("../lib/outbound-access");

// Two users; each may read only their own project. The implicit single-user
// owner (no user record, authenticated) reads everything.
var PROJECT_OF = { "user-a": "proj-a", "user-b": "proj-b" };
var projectAccess = {
  principalFor: function (user, opts) {
    if (user && user.id) return { id: user.id, user: user, admin: false, implicit: false };
    if (user || !opts || opts.authenticated !== true) return null;
    return { id: null, user: null, admin: true, implicit: true };
  },
  canAccess: function (userId, slug) { return PROJECT_OF[userId] === slug; },
};
var access = createOutboundAccess({ projectAccess: projectAccess, getProject: function () { return null; } });

function makeRoster(file) {
  var r = roster.createAgentRoster({
    file: file,
    writeJson: function () { return Promise.resolve(); },
    mayReadProject: function (slug, caller) { return access.canReadProject(slug, caller); },
  });
  // sessionId is offered with every sighting; the roster must not keep it.
  r.observe({ key: "only-a", source: "session", project: "proj-a", sessionId: "sess-a-1" });
  r.observe({ key: "both", source: "session", project: "proj-a", sessionId: "sess-a-2" });
  r.observe({ key: "both", source: "subagent", project: "proj-b", sessionId: "sess-b-1" });
  r.observe({ key: "only-b", source: "sender", project: "proj-b", sessionId: "sess-b-2" });
  return r;
}

var missing = path.join(__dirname, "no-such-agent-roster-file.json");

function socket(user, authenticated) {
  return { _clagenticUser: user ? { id: user } : null, _clagenticAuthenticated: authenticated !== false };
}

function requestRoster(service, ws) {
  var sent = [];
  rosterWs.createWsHandlers({ service: service, sendTo: function (_ws, obj) { sent.push(obj); } })
    .handle(ws, { type: "agent_roster_request" });
  return sent[0];
}

function setAvatarReply(service, ws, key, avatar) {
  var sent = [];
  rosterWs.createWsHandlers({ service: service, sendTo: function (_ws, obj) { sent.push(obj); } })
    .handle(ws, { type: "agent_avatar_set", key: key, avatar: avatar });
  return sent[0];
}

function avatarOf(service, key) {
  var found = service.list().filter(function (a) { return a.key === key; })[0];
  return found ? found.avatar : undefined;
}

var TABLE = [
  { who: "user-a", mustSee: ["only-a", "both"], mustNotContain: ["proj-b", "sess-b-1", "sess-b-2", "only-b"] },
  { who: "user-b", mustSee: ["both", "only-b"], mustNotContain: ["proj-a", "sess-a-1", "sess-a-2", "only-a"] },
];

TABLE.forEach(function (row) {
  test("on request, " + row.who + " receives only the agents and places in projects they may read", function () {
    var msg = requestRoster(makeRoster(missing), socket(row.who));
    assert.equal(msg.type, "agent_roster");
    assert.deepEqual(msg.agents.map(function (a) { return a.key; }).sort(), row.mustSee.slice().sort());
    var wire = JSON.stringify(msg);
    row.mustNotContain.forEach(function (secret) {
      assert.equal(wire.indexOf(secret), -1, row.who + " must not receive " + secret);
    });
  });
});

test("a roster message carries no session id, for any reader", function () {
  var service = makeRoster(missing);
  [socket("user-a"), socket("user-b"), socket(null, true)].forEach(function (ws) {
    var msg = requestRoster(service, ws);
    assert.equal(/sess-/.test(JSON.stringify(msg)), false);
    msg.agents.forEach(function (a) {
      a.places.forEach(function (p) {
        assert.deepEqual(Object.keys(p).sort(), ["lastSeen", "project", "source"]);
      });
    });
  });
});

test("a place is persisted without a session id, and a stored one is read without it", function () {
  var service = makeRoster(missing);
  service.list().forEach(function (a) {
    a.places.forEach(function (p) { assert.equal("session" in p, false); });
  });
  var tmp = path.join(require("os").tmpdir(), "agent-roster-reads-" + process.pid + ".json");
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, agents: [
    { key: "old", firstSeen: 1, lastSeen: 9, avatar: null, places: [
      { source: "session", project: "proj-a", session: "s1", lastSeen: 4 },
      { source: "session", project: "proj-a", session: "s2", lastSeen: 9 },
    ] },
  ] }));
  try {
    var loaded = roster.createAgentRoster({ file: tmp, writeJson: function () { return Promise.resolve(); } }).list();
    assert.deepEqual(loaded[0].places, [{ source: "session", project: "proj-a", lastSeen: 9 }]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("the on-connect message is the same filtered message as the answer to a request", function () {
  var service = makeRoster(missing);
  var ws = socket("user-b");
  var onConnect = rosterWs.rosterMessage(service, rosterWs.callerOf(ws));
  assert.deepEqual(onConnect, requestRoster(service, ws));
  assert.equal(JSON.stringify(onConnect).indexOf("proj-a"), -1);
});

test("the single-user owner reads every place; an unauthenticated connection reads none", function () {
  var service = makeRoster(missing);
  assert.deepEqual(requestRoster(service, socket(null, true)).agents.map(function (a) { return a.key; }).sort(), ["both", "only-a", "only-b"]);
  assert.deepEqual(requestRoster(service, socket(null, false)).agents, []);
});

test("a service that cannot say what a caller may read answers an empty roster, never the whole one", function () {
  var m = rosterWs.rosterMessage({ list: function () { return []; } }, rosterWs.callerOf(socket("user-a")));
  assert.deepEqual(m.agents, []);
  var bare = roster.createAgentRoster({ file: missing, writeJson: function () { return Promise.resolve(); } });
  bare.observe({ key: "x", source: "session", project: "proj-a" });
  assert.deepEqual(bare.listFor({ user: { id: "user-a" }, authenticated: true }), [], "no access dependency means no reader may read");
});

test("reading copies: the stored roster keeps every place", function () {
  var service = makeRoster(missing);
  var before = JSON.stringify(service.list());
  var view = service.listFor({ user: { id: "user-a" }, authenticated: true });
  view.forEach(function (a) { a.places.length = 0; a.avatar = { custom: "mutated" }; });
  assert.equal(JSON.stringify(service.list()), before);
});

var WRITE_TABLE = [
  { who: "user-b", target: "only-a", note: "an agent seen only in another user's project" },
  { who: "user-a", target: "only-b", note: "an agent seen only in another user's project, other direction" },
];

WRITE_TABLE.forEach(function (row) {
  test("setting an avatar: " + row.who + " on " + row.note + " changes nothing and is answered as an unknown key", function () {
    var service = makeRoster(missing);
    var before = avatarOf(service, row.target);
    var ws = socket(row.who);

    var hidden = setAvatarReply(service, ws, row.target, { custom: "intruder" });
    var unknown = setAvatarReply(service, ws, "never-seen", { custom: "intruder" });

    assert.equal(avatarOf(service, row.target), before, "the avatar stays unchanged");
    assert.equal(hidden.ok, false);
    assert.equal(hidden.error, roster.NOT_SEEN);
    // Byte for byte, apart from the key the caller itself sent.
    assert.equal(JSON.stringify(hidden).replace(row.target, "K"), JSON.stringify(unknown).replace("never-seen", "K"));
  });
});

test("setting an avatar on an agent the caller can see works; an invalid choice for a hidden key is still answered as unknown", function () {
  var service = makeRoster(missing);
  assert.deepEqual(setAvatarReply(service, socket("user-a"), "both", { custom: "team-icon" }), { type: "agent_avatar_set_result", key: "both", ok: true });
  assert.deepEqual(avatarOf(service, "both"), { custom: "team-icon" });
  var hiddenInvalid = service.setAvatar({ user: { id: "user-b" }, authenticated: true }, "only-a", "not an object");
  assert.deepEqual(hiddenInvalid, { ok: false, error: roster.NOT_SEEN });
  assert.deepEqual(service.setAvatar({ user: { id: "user-a" }, authenticated: true }, 5, null), { ok: false, error: roster.NOT_SEEN });
});

test("the roster asks canReadProject in one place only", function () {
  var rosterSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "agent-roster.js"), "utf8");
  assert.equal(rosterSrc.split("deps.mayReadProject(").length - 1, 1, "agent-roster.js calls the access dependency once");
  var wsSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "agent-roster-ws.js"), "utf8");
  assert.equal(/canReadProject|mayReadProject/.test(wsSrc.replace(/\/\/[^\n]*/g, "")), false, "the ws layer makes no access decision of its own");
  var serverSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "server.js"), "utf8");
  assert.equal(/filterForReader/.test(serverSrc), false);
});

test("a change is broadcast as a nudge with no roster content, and the server does not broadcast the roster", function () {
  assert.equal(rosterWs.CHANGED, "agent_roster_changed");
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "server.js"), "utf8");
  assert.ok(src.indexOf("{ type: require(\"./agent-roster-ws\").CHANGED }") !== -1, "the notifier builds the content-free nudge");
  assert.equal(/broadcastAll\([^)]*rosterMessage/.test(src), false);
  assert.equal(/build:[^\n]*rosterMessage/.test(src), false, "no roster snapshot is built for a broadcast");
});
