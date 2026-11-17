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
var PROJECTS_OF = { "user-a": ["proj-a"], "user-b": ["proj-b"], "user-ab": ["proj-a", "proj-b"] };
var projectAccess = {
  principalFor: function (user, opts) {
    if (user && user.id) return { id: user.id, user: user, admin: false, implicit: false };
    if (user || !opts || opts.authenticated !== true) return null;
    return { id: null, user: null, admin: true, implicit: true };
  },
  canAccess: function (userId, slug) { return (PROJECTS_OF[userId] || []).indexOf(slug) !== -1; },
};
var access = createOutboundAccess({ projectAccess: projectAccess, getProject: function () { return null; } });

// over: extra roster deps (writeJson, onChange, clock). The sightings below
// happen before the caller's own onChange is counted: see changeCount.
function makeRoster(file, over) {
  var r = roster.createAgentRoster(Object.assign({
    file: file,
    writeJson: function () { return Promise.resolve(); },
    mayReadProject: function (slug, caller) { return access.canReadProject(slug, caller); },
  }, over || {}));
  // sessionId is offered with every sighting; the roster must not keep it.
  r.observe({ key: "only-a", source: "session", project: "proj-a", sessionId: "sess-a-1" });
  r.observe({ key: "both", source: "session", project: "proj-a", sessionId: "sess-a-2" });
  r.observe({ key: "both", source: "subagent", project: "proj-b", sessionId: "sess-b-1" });
  r.observe({ key: "only-b", source: "sender", project: "proj-b", sessionId: "sess-b-2" });
  return r;
}

// A roster that counts change nudges from now on.
function countedRoster(over) {
  var counter = { n: 0 };
  var r = makeRoster(missing, Object.assign({ onChange: function () { counter.n++; } }, over || {}));
  counter.n = 0;
  return { roster: r, counter: counter };
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

// The reply is sent once the write settles, so wait for it.
function setAvatarReply(service, ws, key, avatar) {
  return new Promise(function (resolve) {
    rosterWs.createWsHandlers({ service: service, sendTo: function (_ws, obj) { resolve(obj); } })
      .handle(ws, { type: "agent_avatar_set", key: key, avatar: avatar });
  });
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

// refused: the caller may not read every place of the target, so the reply is
// that of an unknown key, nothing changes and no nudge goes out.
var WRITE_TABLE = [
  { who: "user-b", target: "only-a", refused: true, note: "an agent seen only in another user's project" },
  { who: "user-a", target: "only-b", refused: true, note: "an agent seen only in another user's project, other direction" },
  { who: "user-a", target: "both", refused: true, note: "an agent seen in a project the caller reads and one it does not" },
  { who: "user-b", target: "both", refused: true, note: "the same agent, other direction" },
  { who: "user-ab", target: "both", refused: false, note: "an agent seen only in projects the caller reads" },
  { who: null, target: "both", refused: false, note: "an agent, as the implicit single-user owner" },
];

WRITE_TABLE.forEach(function (row) {
  test("setting an avatar: " + (row.who || "the implicit owner") + " on " + row.note + (row.refused ? " changes nothing and is answered as an unknown key" : " succeeds and answers with the caller's own view"), async function () {
    var counted = countedRoster();
    var service = counted.roster;
    var before = avatarOf(service, row.target);
    var ws = socket(row.who);

    var reply = await setAvatarReply(service, ws, row.target, { custom: "chosen" });
    if (row.refused) {
      var unknown = await setAvatarReply(service, ws, "never-seen", { custom: "chosen" });
      assert.equal(avatarOf(service, row.target), before, "the avatar stays unchanged");
      assert.equal(reply.ok, false);
      assert.equal(reply.error, roster.NOT_SEEN);
      // Byte for byte, apart from the key the caller itself sent.
      assert.equal(JSON.stringify(reply).replace(row.target, "K"), JSON.stringify(unknown).replace("never-seen", "K"));
      assert.equal(counted.counter.n, 0, "no change nudge is sent");
    } else {
      assert.deepEqual(reply, { type: "agent_avatar_set_result", key: row.target, ok: true });
      assert.deepEqual(avatarOf(service, row.target), { custom: "chosen" });
      assert.equal(counted.counter.n, 1);
      var own = service.setAvatar({ user: row.who ? { id: row.who } : null, authenticated: true }, row.target, null);
      assert.deepEqual((await own).agent.places.map(function (p) { return p.project; }).sort(), ["proj-a", "proj-b"]);
    }
  });
});

test("an invalid choice or a non-string key for a hidden or unknown agent is still answered as unknown", async function () {
  var service = makeRoster(missing);
  assert.deepEqual(await service.setAvatar({ user: { id: "user-b" }, authenticated: true }, "only-a", "not an object"), { ok: false, error: roster.NOT_SEEN });
  assert.deepEqual(await service.setAvatar({ user: { id: "user-a" }, authenticated: true }, 5, null), { ok: false, error: roster.NOT_SEEN });
});

test("a failed save answers a fixed error naming no project, restores the previous avatar and sends no nudge", async function () {
  var failing = false;
  var counted = countedRoster({
    writeJson: function () { return failing ? Promise.reject(new Error("disk full at /data/proj-a")) : Promise.resolve(); },
  });
  var owner = { user: null, authenticated: true };
  assert.equal((await counted.roster.setAvatar(owner, "both", { custom: "kept" })).ok, true);
  counted.counter.n = 0;
  failing = true;

  var err = console.error;
  console.error = function () {};
  var out;
  try {
    out = await counted.roster.setAvatar(owner, "both", { custom: "lost" });
  } finally {
    console.error = err;
  }
  assert.deepEqual(out, { ok: false, error: roster.SAVE_FAILED });
  assert.equal(/proj-|\/data/.test(JSON.stringify(out)), false, "the error names no project");
  assert.deepEqual(avatarOf(counted.roster, "both"), { custom: "kept" });
  assert.equal(counted.counter.n, 0, "no change nudge is sent");
});

test("agents are listed by the latest sighting in a place the caller may read", function () {
  var now = 0;
  var r = roster.createAgentRoster({
    file: missing,
    writeJson: function () { return Promise.resolve(); },
    clock: function () { return now; },
    mayReadProject: function (slug, caller) { return access.canReadProject(slug, caller); },
  });
  now = 100; r.observe({ key: "x", source: "session", project: "proj-a" });
  now = 200; r.observe({ key: "y", source: "session", project: "proj-a" });
  now = 300; r.observe({ key: "x", source: "session", project: "proj-b" });
  var viewA = r.listFor({ user: { id: "user-a" }, authenticated: true });
  assert.deepEqual(viewA.map(function (a) { return [a.key, a.lastSeen]; }), [["y", 200], ["x", 100]]);
  var viewAB = r.listFor({ user: { id: "user-ab" }, authenticated: true });
  assert.deepEqual(viewAB.map(function (a) { return [a.key, a.lastSeen]; }), [["x", 300], ["y", 200]]);
});

test("what is persisted holds no session id", async function () {
  var written = [];
  var service = makeRoster(missing, { writeJson: function (_file, value) { written.push(value); return Promise.resolve(); } });
  await service.flush();
  assert.equal(written.length, 1);
  var wire = JSON.stringify(written[0]);
  assert.equal(/sess-|sessionId|"session":/.test(wire), false, "the written JSON carries no session id");
  assert.ok(wire.indexOf("proj-a") !== -1, "the capture holds the roster");
});

test("the roster asks canReadProject in one place only", function () {
  var rosterSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "agent-roster.js"), "utf8");
  assert.equal(rosterSrc.split("deps.mayReadProject(").length - 1, 1, "agent-roster.js calls the access dependency once");
  var wsSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "agent-roster-ws.js"), "utf8");
  assert.equal(/canReadProject|mayReadProject/.test(wsSrc.replace(/\/\/[^\n]*/g, "")), false, "the ws layer makes no access decision of its own");
  var serverSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "server.js"), "utf8");
  assert.equal(/filterForReader/.test(serverSrc), false);
});

test("a sighting and an avatar change are each broadcast as exactly the content-free nudge", async function () {
  assert.equal(rosterWs.CHANGED, "agent_roster_changed");
  var broadcasts = [];
  // The notifier is built by the factory server.js uses.
  var notifier = rosterWs.createRosterNotifier({ broadcast: function (msg) { broadcasts.push(msg); }, delayMs: 0 });
  var tick = function () { return new Promise(function (resolve) { setTimeout(resolve, 20); }); };
  var r = makeRoster(missing, { onChange: notifier.notify });
  await tick();
  broadcasts.length = 0;

  r.observe({ key: "fresh", source: "session", project: "proj-a" });
  await tick();
  assert.deepEqual(broadcasts, [{ type: "agent_roster_changed" }]);

  assert.equal((await r.setAvatar({ user: null, authenticated: true }, "fresh", { custom: "chosen" })).ok, true);
  await tick();
  assert.deepEqual(broadcasts, [{ type: "agent_roster_changed" }, { type: "agent_roster_changed" }]);
  notifier.stop();
});
