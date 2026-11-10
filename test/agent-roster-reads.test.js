"use strict";

// What a connection may read of the agent roster: places are limited to the
// projects the connection can read, an agent with none is left out, and a change
// is announced to everyone as a nudge that carries no roster content. Neutral
// fixtures: no real agent, crew or deployment names.

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

function place(project, session) {
  return { source: "session", project: project, session: session, lastSeen: 5 };
}
function agentEntry(key, places) {
  return { key: key, firstSeen: 1, lastSeen: 5, places: places, avatar: { style: "bottts", seed: key } };
}
var AGENTS = [
  agentEntry("only-a", [place("proj-a", "sess-a-1")]),
  agentEntry("both", [place("proj-a", "sess-a-2"), place("proj-b", "sess-b-1")]),
  agentEntry("only-b", [place("proj-b", "sess-b-2")]),
];

function viewOf(agents) {
  return {
    listFor: function (caller) {
      return roster.filterForReader(agents, function (slug) { return access.canReadProject(slug, caller); });
    },
    setAvatar: function () { return { ok: false, error: "unused" }; },
  };
}

function socket(user, authenticated) {
  return { _clagenticUser: user ? { id: user } : null, _clagenticAuthenticated: authenticated !== false };
}

function requestRoster(ws) {
  var sent = [];
  rosterWs.createWsHandlers({ service: viewOf(AGENTS), sendTo: function (_ws, obj) { sent.push(obj); } })
    .handle(ws, { type: "agent_roster_request" });
  return sent[0];
}

var TABLE = [
  { who: "user-a", mustSee: ["only-a", "both"], mustNotContain: ["proj-b", "sess-b-1", "sess-b-2", "only-b"] },
  { who: "user-b", mustSee: ["both", "only-b"], mustNotContain: ["proj-a", "sess-a-1", "sess-a-2", "only-a"] },
];

TABLE.forEach(function (row) {
  test("on request, " + row.who + " receives only the agents and places in projects they may read", function () {
    var msg = requestRoster(socket(row.who));
    assert.equal(msg.type, "agent_roster");
    assert.deepEqual(msg.agents.map(function (a) { return a.key; }).sort(), row.mustSee.slice().sort());
    var wire = JSON.stringify(msg);
    row.mustNotContain.forEach(function (secret) {
      assert.equal(wire.indexOf(secret), -1, row.who + " must not receive " + secret);
    });
  });
});

test("the on-connect message is the same filtered message as the answer to a request", function () {
  var view = viewOf(AGENTS);
  var ws = socket("user-b");
  var onConnect = rosterWs.rosterMessage(view, rosterWs.callerOf(ws));
  assert.deepEqual(onConnect, requestRoster(ws));
  assert.equal(JSON.stringify(onConnect).indexOf("proj-a"), -1);
});

test("the single-user owner reads every place; an unauthenticated connection reads none", function () {
  assert.deepEqual(requestRoster(socket(null, true)).agents.map(function (a) { return a.key; }).sort(), ["both", "only-a", "only-b"]);
  assert.deepEqual(requestRoster(socket(null, false)).agents, []);
});

test("a service that cannot say what a caller may read answers an empty roster, never the whole one", function () {
  var m = rosterWs.rosterMessage({ list: function () { return AGENTS; } }, rosterWs.callerOf(socket("user-a")));
  assert.deepEqual(m.agents, []);
});

test("filtering copies: the stored roster keeps every place", function () {
  var before = JSON.stringify(AGENTS);
  viewOf(AGENTS).listFor({ user: { id: "user-a" }, authenticated: true });
  assert.equal(JSON.stringify(AGENTS), before);
});

test("a change is broadcast as a nudge with no roster content, and the server does not broadcast the roster", function () {
  assert.equal(rosterWs.CHANGED, "agent_roster_changed");
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "server.js"), "utf8");
  assert.ok(src.indexOf("{ type: require(\"./agent-roster-ws\").CHANGED }") !== -1, "the notifier builds the content-free nudge");
  assert.equal(/broadcastAll\([^)]*rosterMessage/.test(src), false);
  assert.equal(/build:[^\n]*rosterMessage/.test(src), false, "no roster snapshot is built for a broadcast");
});
