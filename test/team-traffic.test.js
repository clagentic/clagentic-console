"use strict";
// The Team view's agent-messages query (lib/team-traffic.js) and its socket side
// (lib/team-traffic-ws.js): the outbound ledger grouped by counterpart pair under
// the ledger's own read rules, the routes the ledger does not see filled from the
// receiving session's history, pending scheduled inputs, and the live nudge.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createOutboundLedger } = require("../lib/outbound-ledger");
var { createOutboundAccess } = require("../lib/outbound-access");
var { createProjectAccess } = require("../lib/project-access");
var { attachPermissions } = require("../lib/users-permissions");
var { createSessionInput } = require("../lib/session-input");
var { createTeamTraffic, MAX_MESSAGES, MAX_TEXT_CHARS } = require("../lib/team-traffic");
var teamWs = require("../lib/team-traffic-ws");

var HOUR = 60 * 60 * 1000;
var NOW = Date.parse("2026-06-30T12:00:00Z");

function quiet() {
  return { error: function () {}, warn: function () {}, log: function () {} };
}

var USERS = {
  admin: { id: "u-admin", role: "admin" },
  alice: { id: "u-alice", role: "user" },
  bob: { id: "u-bob", role: "user" },
};
var users = attachPermissions({
  loadUsers: function () { return { users: Object.keys(USERS).map(function (k) { return USERS[k]; }) }; },
  saveUsers: function () {},
  findUserById: function (id) {
    return Object.keys(USERS).map(function (k) { return USERS[k]; }).filter(function (u) { return u.id === id; })[0] || null;
  },
});

// Project "work": 100 shared (alice), 101 private to alice, 102 private to bob.
// Project "side": one session, for the sender.
function projects(over) {
  over = over || {};
  var work = new Map();
  [
    { localId: 100, cliSessionId: "cli-shared", ownerId: "u-alice", sessionVisibility: "shared", agentName: "reviewer", history: [] },
    { localId: 101, cliSessionId: "cli-alice-private", ownerId: "u-alice", sessionVisibility: "private", history: [] },
    { localId: 102, cliSessionId: "cli-bob-private", ownerId: "u-bob", sessionVisibility: "private", history: [] },
  ].forEach(function (s) { work.set(s.localId, s); });
  var side = new Map();
  side.set(7, { localId: 7, cliSessionId: "cli-sender", agentName: "worker-a", history: [], isProcessing: true, queryInstance: {} });
  return {
    work: { sm: { sessions: work }, getLinuxUserForSession: over.linuxUser || function () { return null; } },
    side: { sm: { sessions: side }, getLinuxUserForSession: function () { return null; } },
  };
}

function build(opts) {
  opts = opts || {};
  var dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), "team-traffic-"));
  var held = opts.projects || projects();
  var ledger = createOutboundLedger({
    getBaseDir: function () { return dir; },
    now: function () { return NOW; },
    getRetentionDays: function () { return opts.retentionDays; },
    log: quiet(),
  });
  var projectAccess = createProjectAccess({
    users: users,
    onGetProjectAccess: function (slug) {
      return slug === "work" ? { visibility: "private", ownerId: "u-admin", allowedUsers: ["u-alice", "u-bob"] } : { visibility: "public" };
    },
    isMultiUser: function () { return opts.multiUser === true; },
  });
  var access = createOutboundAccess({ projectAccess: projectAccess, getProject: function (slug) { return held[slug] || null; } });
  var traffic = createTeamTraffic({
    ledger: ledger,
    access: access,
    getProject: function (slug) { return held[slug] || null; },
    listProjects: function () { return Object.keys(held).map(function (slug) { return { slug: slug, project: held[slug] }; }); },
    scheduledInput: opts.scheduledInput,
    now: function () { return NOW; },
  });
  return { dir: dir, ledger: ledger, traffic: traffic, held: held, access: access };
}

var OWNER = { user: null, authenticated: true };

var counter = 0;
function entry(over) {
  counter++;
  var base = {
    formatVersion: 1,
    ts: new Date(NOW - 3 * HOUR + counter * 1000).toISOString(),
    verb: "send_input",
    result: "delivered",
    messageId: "m" + counter,
    initiator: "trigger",
    sender: { kind: "extracted", attribution: "extracted", project: "side", sessionId: "7", cliSessionId: "cli-sender", name: "worker-a@side", agent: "worker-a" },
    target: { project: "work", sessionId: "100", cliSessionId: "cli-shared", agent: "reviewer", runsAs: "daemon" },
    prompt: "text " + counter,
  };
  return Object.assign(base, over || {});
}

test("entries are grouped by sender and target, with count, last seen, kind, result and text", function () {
  var t = build();
  t.ledger.record(entry({ prompt: "first" }));
  t.ledger.record(entry({ prompt: "second", initiator: "scheduled" }));
  t.ledger.record(entry({ verb: "open_session", result: "opened", prompt: "open one" }));
  t.ledger.record(entry({ prompt: "to another", target: { project: "work", sessionId: "101", cliSessionId: "cli-alice-private", agent: "reviewer", runsAs: "daemon" } }));

  var snap = t.traffic.snapshot(OWNER);
  assert.equal(snap.ok, true);
  assert.equal(snap.pairs.length, 2);
  var shared = snap.pairs.filter(function (p) { return p.target.link && p.target.link.id === 100; })[0];
  assert.equal(shared.count, 3);
  assert.equal(shared.sender.fromName, "worker-a@side");
  assert.equal(shared.sender.senderAgent, "worker-a");
  assert.equal(shared.target.agent, "reviewer");

  var thread = snap.messages.filter(function (m) { return m.pairKey === shared.key; });
  assert.deepEqual(thread.map(function (m) { return m.text; }), ["first", "second", "open one"], "in order");
  assert.deepEqual(thread.map(function (m) { return m.kind; }), ["input", "scheduled", "open"]);
  assert.deepEqual(thread.map(function (m) { return m.result; }), ["delivered", "delivered", "opened"]);
  assert.equal(shared.lastAt, thread[2].ts);
  assert.ok(snap.pairs[0].lastAt >= snap.pairs[1].lastAt, "most recent pair first");
});

test("a reply is its own kind and takes precedence over the verb", function () {
  var t = build();
  t.ledger.record(entry({ target: { project: "work", sessionId: "100", cliSessionId: "cli-shared", reply: true, runsAs: "daemon" } }));
  assert.equal(t.traffic.snapshot(OWNER).messages[0].kind, "reply");
});

test("only sent and opened calls are listed: an end or an answer is not agent traffic", function () {
  var t = build();
  t.ledger.record(entry({ verb: "end_session", result: "ended" }));
  t.ledger.record(entry({ verb: "answer_prompt", result: "answered", prompt: undefined }));
  var snap = t.traffic.snapshot(OWNER);
  assert.equal(snap.pairs.length, 0);
  assert.equal(snap.messages.length, 0);
});

test("a refused or failed call is listed with its result and reason", function () {
  var t = build();
  t.ledger.record(entry({ result: "refused", reason: "unknown project" }));
  var m = t.traffic.snapshot(OWNER).messages[0];
  assert.equal(m.result, "refused");
  assert.equal(m.reason, "unknown project");
});

test("senders that only named themselves are separate pairs, labelled unverified", function () {
  var t = build();
  t.ledger.record(entry({ sender: { kind: "declared", attribution: "unverified", name: "script-x" } }));
  t.ledger.record(entry({ sender: { kind: "undeclared", attribution: "unverified" } }));
  t.ledger.record(entry({}));
  var snap = t.traffic.snapshot(OWNER);
  assert.equal(snap.pairs.length, 3);
  var attributions = snap.pairs.map(function (p) { return p.sender.attribution; }).sort();
  assert.deepEqual(attributions, ["extracted", "unverified", "unverified"]);
  assert.deepEqual(snap.pairs.map(function (p) { return p.sender.senderKind; }).sort(), ["declared", "extracted", "undeclared"]);
});

test("a user sees only the entries whose target they may read; the rest are counted with the reason", function () {
  var t = build({ multiUser: true });
  t.ledger.record(entry({ prompt: "to shared" }));
  t.ledger.record(entry({ prompt: "to alice private", target: { project: "work", sessionId: "101", cliSessionId: "cli-alice-private", runsAs: "daemon" } }));
  t.ledger.record(entry({ prompt: "to bob private", target: { project: "work", sessionId: "102", cliSessionId: "cli-bob-private", runsAs: "daemon" } }));

  var bob = t.traffic.snapshot({ user: USERS.bob, authenticated: true });
  assert.deepEqual(bob.messages.map(function (m) { return m.text; }).sort(), ["to bob private", "to shared"]);
  assert.equal(bob.withheld.count, 1);
  assert.match(bob.withheld.reasons[0], /cannot read the target session/);

  var nobody = t.traffic.snapshot({ user: null, authenticated: false });
  assert.equal(nobody.messages.length, 0);
  assert.equal(nobody.pairs.length, 0);
  assert.equal(nobody.withheld.count, 3);
});

test("a target that runs as another OS user was never stored with text, so it is not listed and the reason is given", function () {
  var t = build();
  t.ledger.record(entry({
    prompt: undefined,
    promptWithheld: true,
    promptWithheldReason: "the target session runs as another OS user",
    target: { project: "work", sessionId: "100", cliSessionId: "cli-shared", runsAs: "svc-user" },
  }));
  t.ledger.record(entry({ prompt: "visible" }));
  var snap = t.traffic.snapshot(OWNER);
  assert.deepEqual(snap.messages.map(function (m) { return m.text; }), ["visible"]);
  assert.equal(snap.withheld.count, 1);
  assert.deepEqual(snap.withheld.reasons, ["the target session runs as another OS user"]);
});

test("links resolve at read time to the session as it is now numbered, and are absent once it is gone", function () {
  var t = build();
  t.ledger.record(entry({}));
  t.ledger.record(entry({ target: { project: "work", sessionId: "55", cliSessionId: "cli-deleted", runsAs: "daemon" } }));
  var snap = t.traffic.snapshot(OWNER);
  var live = snap.pairs.filter(function (p) { return p.target.link; })[0];
  assert.deepEqual(live.target.link, { project: "work", id: 100 });
  assert.deepEqual(live.sender.link, { project: "side", id: 7 });
  var gone = snap.pairs.filter(function (p) { return !p.target.link; })[0];
  assert.ok(gone, "a pair whose target no longer exists has no target link");
  assert.deepEqual(gone.sender.link, { project: "side", id: 7 });
});

test("a link is not given for a session the caller may not read", function () {
  var t = build({ multiUser: true });
  t.ledger.record(entry({}));
  var snap = t.traffic.snapshot({ user: USERS.bob, authenticated: true });
  assert.deepEqual(snap.pairs[0].target.link, { project: "work", id: 100 });
  var other = build({ multiUser: true, projects: projects() });
  other.held.work.sm.sessions.get(100).sessionVisibility = "private";
  other.ledger.record(entry({ target: { project: "work", sessionId: "100", cliSessionId: "cli-shared", runsAs: "daemon" } }));
  var hidden = other.traffic.snapshot({ user: USERS.bob, authenticated: true });
  assert.equal(hidden.pairs.length, 0, "a private session of another owner is withheld entirely");
});

test("a rebuild from the same ledger after a restart gives the same view", function () {
  var t = build();
  t.ledger.record(entry({ prompt: "one" }));
  t.ledger.record(entry({ prompt: "two" }));
  var before = t.traffic.snapshot(OWNER);
  var restarted = build({ dir: t.dir });
  assert.deepEqual(restarted.traffic.snapshot(OWNER), before);
});

test("retention 0 turns the view off and says why; an unreadable ledger is an error, not an empty list", function () {
  var off = build({ retentionDays: 0 });
  var snap = off.traffic.snapshot(OWNER);
  assert.equal(snap.pairs.length, 0);
  assert.match(snap.note, /turned off/);

  var broken = build();
  fs.mkdirSync(path.join(broken.dir, "outbound"), { recursive: true });
  fs.writeFileSync(path.join(broken.dir, "outbound", "sessions"), "not a directory");
  var err = broken.traffic.snapshot(OWNER);
  assert.equal(err.ok, false);
  assert.equal(err.result, "error");
});

test("text over the limit is cut and said to be, and old messages beyond the cap are counted", function () {
  var t = build();
  t.ledger.record(entry({ prompt: "x".repeat(MAX_TEXT_CHARS + 50) }));
  var m = t.traffic.snapshot(OWNER).messages[0];
  assert.equal(m.text.length, MAX_TEXT_CHARS);
  assert.equal(m.truncated, true);

  var many = build();
  for (var i = 0; i < MAX_MESSAGES + 3; i++) many.ledger.record(entry({ prompt: "n" + i }));
  var snap = many.traffic.snapshot(OWNER);
  assert.equal(snap.messages.length, MAX_MESSAGES);
  assert.equal(snap.messagesTruncated, 3);
  assert.equal(snap.pairs[0].count, MAX_MESSAGES + 3, "the pair counts every visible message");
});

// --- Routes the ledger does not see ---

function sessionInputFor(t, hooks) {
  var recorded = [];
  var sm = t.held.work.sm;
  sm.defaultVendor = "claude";
  sm.recordHistoryEntry = function (s, e) { s.history.push(e); recorded.push(e); };
  sm.appendToSessionFile = function () {};
  t.held.work.sdk = { startQuery: function () {}, pushMessage: function () {} };
  t.held.work.onProcessingChanged = function () {};
  var input = createSessionInput({
    getProject: function (slug) { return t.held[slug] || null; },
    outboundLedger: t.ledger,
    onAutomationInjected: hooks && hooks.onAutomationInjected,
    now: function () { return NOW - HOUR; },
  });
  return { input: input, recorded: recorded };
}

test("a scheduled firing leaves no ledger entry and is filled from the target's history in the same view", function () {
  var t = build();
  var fired = 0;
  var si = sessionInputFor(t, { onAutomationInjected: function () { fired++; } });
  t.held.work.sm.sessions.get(100).queryInstance = {};

  var sent = si.input.sendInput({ projectSlug: "work", sessionId: "cli-shared", prompt: "from an agent", senderProject: "side", senderSessionId: "7" });
  assert.equal(sent.result, "delivered");
  assert.equal(fired, 0, "a send-input is announced through the ledger, not this hook");
  t.held.work.sm.sessions.get(100).isProcessing = false;
  var tick = si.input.fireScheduled({ projectSlug: "work", sessionId: "cli-shared", prompt: "tick", note: "scheduled message" });
  assert.equal(tick.ok, true);
  assert.equal(fired, 1);
  assert.equal(t.ledger.readAttributed().concat(t.ledger.readUnattributed()).length, 1, "only the send-input is in the ledger");

  // The fixture's history is not the clock under test: stamp the firing at NOW.
  t.held.work.sm.sessions.get(100).history.forEach(function (h) { if (h.senderKind === "automation") h._ts = NOW - HOUR; });
  var snap = t.traffic.snapshot(OWNER);
  assert.equal(snap.pairs.length, 2);
  var auto = snap.pairs.filter(function (p) { return p.sender.senderKind === "automation"; })[0];
  assert.equal(auto.sender.fromName, "Scheduled message");
  assert.equal(auto.sender.attribution, "console");
  assert.equal(auto.count, 1);
  assert.deepEqual(auto.target.link, { project: "work", id: 100 });
  var m = snap.messages.filter(function (x) { return x.pairKey === auto.key; })[0];
  assert.equal(m.kind, "scheduled");
  assert.equal(m.text, "tick");
  assert.equal(m.source, "session");
});

test("a loop iteration is filled from the session's history as its own kind", function () {
  var t = build();
  var { consoleTurnEntry } = require("../lib/injected-sender");
  var e = consoleTurnEntry("loop", "do the next step", "nightly · iteration 2");
  e._ts = NOW - HOUR;
  t.held.work.sm.sessions.get(100).history.push(e);
  var snap = t.traffic.snapshot(OWNER);
  assert.equal(snap.messages.length, 1);
  assert.equal(snap.messages[0].kind, "loop");
  assert.equal(snap.messages[0].contextNote, "nightly · iteration 2");
  assert.equal(snap.pairs[0].sender.fromName, "Loop");
});

test("filled entries follow the ledger's rules: another OS user's session and an unreadable session are withheld", function () {
  var { consoleTurnEntry } = require("../lib/injected-sender");
  function withTurn(t, id) {
    var e = consoleTurnEntry("scheduled", "tick", "scheduled message");
    e._ts = NOW - HOUR;
    t.held.work.sm.sessions.get(id).history.push(e);
  }
  var os1 = build({ projects: projects({ linuxUser: function () { return "svc-user"; } }) });
  withTurn(os1, 100);
  var a = os1.traffic.snapshot(OWNER);
  assert.equal(a.messages.length, 0);
  assert.equal(a.withheld.count, 1);

  var multi = build({ multiUser: true });
  withTurn(multi, 102);
  var b = multi.traffic.snapshot({ user: USERS.alice, authenticated: true });
  assert.equal(b.messages.length, 0);
  assert.equal(b.withheld.count, 1);
});

test("an entry older than the retention is not filled in", function () {
  var t = build({ retentionDays: 1 });
  var { consoleTurnEntry } = require("../lib/injected-sender");
  var e = consoleTurnEntry("scheduled", "old tick", "scheduled message");
  e._ts = NOW - 3 * 24 * HOUR;
  t.held.work.sm.sessions.get(100).history.push(e);
  assert.equal(t.traffic.snapshot(OWNER).messages.length, 0);
});

test("armed scheduled inputs are listed as pending in the scheduled pair's thread, read-only", function () {
  var asked = [];
  var t = build({
    scheduledInput: {
      armedForSession: function (slug, session) {
        asked.push(slug + "/" + session.localId);
        if (slug !== "work" || session.localId !== 100) return [];
        return [{ id: "si_1", kind: "recurring", nextAt: NOW + HOUR, every: HOUR, createdBy: "browser:someone", text: "check in" }];
      },
    },
  });
  var snap = t.traffic.snapshot(OWNER);
  assert.equal(snap.pending.length, 1);
  assert.equal(snap.pending[0].id, "si_1");
  assert.equal(snap.pending[0].text, "check in");
  assert.equal(snap.pending[0].nextAt, NOW + HOUR);
  assert.equal(snap.pairs.length, 1, "a pair with only a pending input is listed");
  assert.equal(snap.pairs[0].count, 0);
  assert.equal(snap.pairs[0].pendingCount, 1);
  assert.equal(snap.pending[0].pairKey, snap.pairs[0].key);
  assert.equal(snap.messages.length, 0, "a pending input is not a sent message");
  assert.ok(asked.length >= 3);

  var { consoleTurnEntry } = require("../lib/injected-sender");
  var e = consoleTurnEntry("scheduled", "check in", "scheduled repeat");
  e._ts = NOW - HOUR;
  t.held.work.sm.sessions.get(100).history.push(e);
  var after = t.traffic.snapshot(OWNER);
  assert.equal(after.pairs.length, 1, "the fired and the pending share one pair");
  assert.equal(after.pairs[0].count, 1);
  assert.equal(after.pairs[0].pendingCount, 1);
});

test("a pending input of a session the caller may not read is not listed", function () {
  var t = build({
    multiUser: true,
    scheduledInput: { armedForSession: function (slug, s) { return s.localId === 102 ? [{ id: "si_2", kind: "once", nextAt: NOW + HOUR, createdBy: "x", text: "secret" }] : []; } },
  });
  assert.equal(t.traffic.snapshot({ user: USERS.alice, authenticated: true }).pending.length, 0);
  assert.equal(t.traffic.snapshot({ user: USERS.bob, authenticated: true }).pending.length, 1);
});

// --- Socket side ---

test("team_traffic_request answers the connection's own view, never another's", function () {
  var t = build({ multiUser: true });
  t.ledger.record(entry({ target: { project: "work", sessionId: "102", cliSessionId: "cli-bob-private", runsAs: "daemon" } }));
  var sent = [];
  var h = teamWs.createWsHandlers({ service: t.traffic, sendTo: function (ws, obj) { sent.push({ ws: ws, obj: obj }); } });

  var bobWs = { _clagenticUser: USERS.bob, _clagenticAuthenticated: true };
  var aliceWs = { _clagenticUser: USERS.alice, _clagenticAuthenticated: true };
  assert.equal(h.handle(bobWs, { type: "team_traffic_request" }), true);
  assert.equal(h.handle(aliceWs, { type: "team_traffic_request" }), true);
  assert.equal(sent[0].obj.type, "team_traffic");
  assert.equal(sent[0].obj.messages.length, 1);
  assert.equal(sent[1].obj.messages.length, 0);
  assert.equal(sent[1].obj.withheld.count, 1);
  assert.equal(h.handle(bobWs, { type: "something_else" }), false);
});

test("without a service the request is answered with an error, and a throwing service does not escape", function () {
  var sent = [];
  var none = teamWs.createWsHandlers({ service: null, sendTo: function (ws, o) { sent.push(o); } });
  none.handle({}, { type: "team_traffic_request" });
  assert.equal(sent[0].ok, false);

  var bad = teamWs.createWsHandlers({ service: { snapshot: function () { throw new Error("boom"); } }, sendTo: function (ws, o) { sent.push(o); } });
  var realError = console.error;
  console.error = function () {};
  try { bad.handle({}, { type: "team_traffic_request" }); } finally { console.error = realError; }
  assert.equal(sent[1].ok, false);
  assert.doesNotMatch(JSON.stringify(sent[1]), /boom/, "the internal message is not sent to the browser");
});

test("the live nudge carries no content and a burst makes one broadcast", async function () {
  var got = [];
  var n = teamWs.createNotifier({ broadcast: function (m) { got.push(m); }, delayMs: 5 });
  n.notify();
  n.notify();
  n.notify();
  await new Promise(function (r) { setTimeout(r, 40); });
  assert.deepEqual(got, [{ type: "team_traffic_changed" }]);
  n.notify();
  n.stop();
  await new Promise(function (r) { setTimeout(r, 30); });
  assert.equal(got.length, 1, "stopped before it fired");
});
