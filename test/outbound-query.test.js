"use strict";
// list-outbound: what one session sent out, filtered, with the prompt text
// shown only to a caller who could read the target session.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createOutboundLedger } = require("../lib/outbound-ledger");
var { createOutboundQuery } = require("../lib/outbound-query");
var { createOutboundAccess } = require("../lib/outbound-access");
var outboundEntry = require("../lib/outbound-entry");
var { createProjectAccess } = require("../lib/project-access");
var { attachPermissions } = require("../lib/users-permissions");
var { handleOutboundCommand } = require("../lib/session-input-ipc");

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

// The real access rules (project then owner, shared or private), over a fixed user table.
var users = attachPermissions({
  loadUsers: function () { return { users: Object.keys(USERS).map(function (k) { return USERS[k]; }) }; },
  saveUsers: function () {},
  findUserById: function (id) {
    return Object.keys(USERS).map(function (k) { return USERS[k]; }).filter(function (u) { return u.id === id; })[0] || null;
  },
});

// Sessions of project "work": 100 shared (owned by alice), 101 private to alice, 102 private to bob.
function workProject(over) {
  var sessions = new Map();
  [
    { localId: 100, cliSessionId: "cli-shared", ownerId: "u-alice", sessionVisibility: "shared", createdAt: NOW - 24 * HOUR },
    { localId: 101, cliSessionId: "cli-alice-private", ownerId: "u-alice", sessionVisibility: "private", createdAt: NOW - 24 * HOUR },
    { localId: 102, cliSessionId: "cli-bob-private", ownerId: "u-bob", sessionVisibility: "private", createdAt: NOW - 24 * HOUR },
  ].forEach(function (s) { sessions.set(s.localId, s); });
  return Object.assign({ sm: { sessions: sessions }, getLinuxUserForSession: function () { return null; } }, over || {});
}

function build(opts) {
  opts = opts || {};
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-q-"));
  var ledger = createOutboundLedger({
    getBaseDir: function () { return dir; },
    now: function () { return NOW; },
    getRetentionDays: function () { return opts.retentionDays; },
    log: quiet(),
  });
  var project = opts.project || workProject();
  var projectAccess = createProjectAccess({
    users: users,
    // alice and bob are members of "work"; the table is the daemon's access lookup.
    onGetProjectAccess: function (slug) { return slug === "work" ? { visibility: "private", ownerId: "u-admin", allowedUsers: ["u-alice", "u-bob"] } : null; },
    isMultiUser: function () { return opts.multiUser === true; },
  });
  var access = createOutboundAccess({ projectAccess: projectAccess, getProject: function (slug) { return slug === "work" ? project : null; } });
  var query = createOutboundQuery({ ledger: ledger, access: access, caller: opts.caller || { user: null, authenticated: true } });
  return { dir: dir, ledger: ledger, query: query, access: access };
}

var counter = 0;
function entry(over) {
  counter++;
  var base = {
    formatVersion: 1,
    ts: new Date(NOW - counter * 1000).toISOString(),
    verb: "send_input",
    result: "delivered",
    messageId: "m" + counter,
    initiator: "trigger",
    sender: { kind: "extracted", attribution: "extracted", project: "alpha", sessionId: "7", cliSessionId: "cli-sender", name: "agent-a@alpha", agent: "agent-a" },
    target: { project: "work", sessionId: "100", cliSessionId: "cli-shared", agent: "reviewer" },
    prompt: "text " + counter,
  };
  var e = Object.assign(base, over || {});
  return e;
}

// An entry as the writer builds it (lib/outbound-entry.js), so the write-time
// decision on message text applies. args: { target, req, verb?, out? }
function written(args) {
  counter++;
  return outboundEntry.buildEntry({
    verb: args.verb || outboundEntry.VERB.SEND_INPUT,
    ts: new Date(NOW - counter * 1000).toISOString(),
    req: args.req || {},
    out: args.out || null,
    initiator: "trigger",
    messageId: "w" + counter,
    sender: { senderKind: "extracted", senderProject: "alpha", senderSessionId: "7", senderCliSessionId: "cli-sender" },
    target: args.target,
  });
}

function prompts(res) {
  return res.messages.map(function (m) { return m.prompt; });
}

test("lists a session's outbound calls by the vendor id or the console id, oldest first", function () {
  var t = build();
  t.ledger.record(entry({ ts: new Date(NOW - 2 * HOUR).toISOString(), prompt: "first" }));
  t.ledger.record(entry({ ts: new Date(NOW - 1 * HOUR).toISOString(), prompt: "second", verb: "open_session", result: "opened" }));
  t.ledger.record(entry({ sender: { kind: "extracted", attribution: "extracted", project: "alpha", sessionId: "8", cliSessionId: "cli-other" }, prompt: "someone else" }));

  var byVendor = t.query.list({ sessionId: "cli-sender" });
  assert.equal(byVendor.ok, true);
  assert.equal(byVendor.result, "listed");
  assert.equal(byVendor.count, 2);
  assert.deepEqual(prompts(byVendor), ["first", "second"]);
  assert.equal(byVendor.retentionDays, 30);
  assert.deepEqual(prompts(t.query.list({ sessionId: "7" })), ["first", "second"]);
  assert.deepEqual(prompts(t.query.list({ sessionId: "7", projectSlug: "alpha" })), ["first", "second"]);
  assert.equal(t.query.list({ sessionId: "7", projectSlug: "elsewhere" }).count, 0);
  assert.equal(t.query.list({ sessionId: "nobody" }).count, 0);
});

test("each message carries target, prompt, time, initiator and the kind", function () {
  var t = build();
  t.ledger.record(entry({ prompt: "do it", contextNote: "pr 3" }));
  var m = t.query.list({ sessionId: "cli-sender" }).messages[0];
  assert.equal(m.kind, "sent");
  assert.equal(m.verb, "send_input");
  assert.equal(m.prompt, "do it");
  assert.equal(m.initiator, "trigger");
  assert.equal(m.contextNote, "pr 3");
  assert.deepEqual({ project: m.target.project, agent: m.target.agent }, { project: "work", agent: "reviewer" });
  assert.ok(Date.parse(m.ts) > 0);
  assert.equal(m.sender.attribution, "extracted");
  assert.equal("formatVersion" in m, false);
});

test("--kind selects sent or opens, and an unknown kind is refused", function () {
  var t = build();
  t.ledger.record(entry({ prompt: "a send" }));
  t.ledger.record(entry({ prompt: "an open", verb: "open_session", result: "opened" }));
  t.ledger.record(entry({ prompt: "a refused send", result: "refused", reason: "nope" }));
  assert.deepEqual(prompts(t.query.list({ sessionId: "cli-sender", kind: "sent" })).sort(), ["a refused send", "a send"]);
  assert.deepEqual(prompts(t.query.list({ sessionId: "cli-sender", kind: "opens" })), ["an open"]);
  assert.equal(t.query.list({ sessionId: "cli-sender" }).count, 3);
  var bad = t.query.list({ sessionId: "cli-sender", kind: "everything" });
  assert.equal(bad.ok, false);
  assert.equal(bad.result, "refused");
  assert.match(bad.reason, /sent, opens/);
});

test("--since keeps only entries at or after the time", function () {
  var t = build();
  t.ledger.record(entry({ ts: new Date(NOW - 5 * HOUR).toISOString(), prompt: "five hours ago" }));
  t.ledger.record(entry({ ts: new Date(NOW - 1 * HOUR).toISOString(), prompt: "an hour ago" }));
  assert.deepEqual(prompts(t.query.list({ sessionId: "cli-sender", sinceMs: NOW - 2 * HOUR })), ["an hour ago"]);
  assert.deepEqual(prompts(t.query.list({ sessionId: "cli-sender", sinceMs: NOW - 6 * HOUR })), ["five hours ago", "an hour ago"]);
  assert.equal(t.query.list({ sessionId: "cli-sender", sinceMs: "yesterday" }).result, "refused");
});

test("a refused or failed call is listed with its reason", function () {
  var t = build();
  t.ledger.record(entry({ result: "refused", reason: "unknown project \"nowhere\"", messageId: undefined }));
  var m = t.query.list({ sessionId: "cli-sender" }).messages[0];
  assert.equal(m.result, "refused");
  assert.match(m.reason, /unknown project/);
});

test("a console id that two projects hold is ambiguous until the project is named", function () {
  var t = build();
  t.ledger.record(entry({ sender: { kind: "extracted", attribution: "extracted", project: "alpha", sessionId: "7", cliSessionId: "cli-a" }, prompt: "in alpha" }));
  t.ledger.record(entry({ sender: { kind: "extracted", attribution: "extracted", project: "beta", sessionId: "7", cliSessionId: "cli-b" }, prompt: "in beta" }));
  var res = t.query.list({ sessionId: "7" });
  assert.equal(res.ok, false);
  assert.equal(res.result, "ambiguous");
  assert.deepEqual(res.projects, ["alpha", "beta"]);
  assert.deepEqual(prompts(t.query.list({ sessionId: "7", projectSlug: "beta" })), ["in beta"]);
  assert.deepEqual(prompts(t.query.list({ sessionId: "cli-a" })), ["in alpha"]);
});

test("a session id that is not a plain id is refused, and nothing is read", function () {
  var t = build();
  ["", "../x", "a/b", undefined, 7].forEach(function (id) {
    assert.equal(t.query.list({ sessionId: id }).result, "refused", String(id));
  });
  assert.equal(t.query.list({ sessionId: "7", projectSlug: "" }).result, "refused");
});

test("calls whose sender only named itself are listed apart, labelled unverified, never as the session's own", function () {
  var t = build();
  t.ledger.record(entry({ prompt: "identified" }));
  t.ledger.record(entry({
    sender: { kind: "declared", attribution: "unverified", name: "nightly-job", fromSession: "cli-sender" },
    prompt: "claims to be that session",
  }));
  t.ledger.record(entry({ sender: { kind: "declared", attribution: "unverified", name: "other", fromSession: "someone-else" }, prompt: "not related" }));
  t.ledger.record(entry({ sender: { kind: "undeclared", attribution: "unverified" }, prompt: "anonymous" }));

  var res = t.query.list({ sessionId: "cli-sender" });
  assert.deepEqual(prompts(res), ["identified"]);
  assert.equal(res.unattributedCount, 1);
  assert.deepEqual(res.unattributed.map(function (m) { return m.prompt; }), ["claims to be that session"]);
  assert.equal(res.unattributed[0].sender.attribution, "unverified");
  assert.match(res.unattributedNote, /cannot verify/);
  res.messages.forEach(function (m) { assert.equal(m.sender.attribution, "extracted"); });
});

test("an expired entry is not listed, and a ledger turned off lists nothing and says so", function () {
  var t = build();
  t.ledger.record(entry({ ts: new Date(NOW - 31 * 24 * HOUR).toISOString(), prompt: "expired" }));
  t.ledger.record(entry({ prompt: "current" }));
  assert.deepEqual(prompts(t.query.list({ sessionId: "cli-sender" })), ["current"]);

  var off = build({ retentionDays: 0 });
  var res = off.query.list({ sessionId: "cli-sender" });
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.equal(res.retentionDays, 0);
  assert.match(res.note, /turned off/);
});

// ---- the prompt-text access rule, per caller shape ----

function withheld(m) {
  return m.prompt === null && m.promptWithheld === true && typeof m.promptWithheldReason === "string";
}

// Records the targets the way the writer does: with the OS user each one ran as.
function seedTargets(t, project) {
  project = project || workProject();
  [["100", "cli-shared", "shared"], ["101", "cli-alice-private", "alice private"], ["102", "cli-bob-private", "bob private"]].forEach(function (x) {
    var session = project.sm.sessions.get(Number(x[0]));
    var runsAs = project.getLinuxUserForSession(session) || "daemon";
    t.ledger.record(written({ target: { project: "work", consoleSessionId: x[0], sessionId: x[1], runsAs: runsAs }, req: { prompt: x[2] } }));
  });
}

test("caller shape: the single-user daemon owner reads every prompt, private sessions included", function () {
  var t = build({ multiUser: false });
  seedTargets(t);
  var res = t.query.list({ sessionId: "cli-sender" });
  assert.deepEqual(prompts(res).sort(), ["alice private", "bob private", "shared"]);
  res.messages.forEach(function (m) { assert.equal("promptWithheld" in m, false); });
});

test("caller shape: the single-user owner also reads the prompt of a target the console no longer holds", function () {
  var t = build({ multiUser: false });
  t.ledger.record(entry({ target: { project: "gone", sessionId: "5" }, prompt: "to a removed project" }));
  assert.deepEqual(prompts(t.query.list({ sessionId: "cli-sender" })), ["to a removed project"]);
});

test("caller shape: in multi-user mode the daemon-owner socket reads the text of a target that runs as the daemon OS user", function () {
  var t = build({ multiUser: true });
  seedTargets(t);
  var res = t.query.list({ sessionId: "cli-sender" });
  assert.deepEqual(prompts(res).sort(), ["alice private", "bob private", "shared"]);
  res.messages.forEach(function (m) { assert.equal("promptWithheld" in m, false); });
});

test("caller shape: in os-users mode the socket caller gets metadata only for a target that runs as another OS user", function () {
  var project = workProject({ getLinuxUserForSession: function (s) { return s.localId === 100 ? "alice-os" : null; } });
  var t = build({ multiUser: true, project: project });
  seedTargets(t, project);
  var res = t.query.list({ sessionId: "cli-sender" });
  assert.equal(res.count, 3);
  var byText = {};
  res.messages.forEach(function (m) { byText[m.target.cliSessionId] = m; });
  assert.ok(withheld(byText["cli-shared"]));
  assert.match(byText["cli-shared"].promptWithheldReason, /another OS user/);
  assert.equal(byText["cli-shared"].target.project, "work");
  assert.equal(byText["cli-alice-private"].prompt, "alice private");
  assert.equal(byText["cli-bob-private"].prompt, "bob private");
  assert.equal(JSON.stringify(res).indexOf('"shared"'), -1);
});

test("write time: an entry that did not record its target's OS user stores no text", function () {
  var t = build({ multiUser: true });
  var e = written({ target: { project: "gone", sessionId: "5" }, req: { prompt: "to a removed project", contextNote: "a note" } });
  assert.equal("prompt" in e, false);
  assert.equal("contextNote" in e, false);
  t.ledger.record(e);
  var m = t.query.list({ sessionId: "cli-sender" }).messages[0];
  assert.ok(withheld(m));
  assert.match(m.promptWithheldReason, /not recorded/);
  assert.equal(m.contextNoteWithheld, true);
});

test("write time: text for an other-OS-user target is never stored, so switching os-users off does not return it", function () {
  var project = workProject({ getLinuxUserForSession: function () { return "alice-os"; } });
  var writer = build({ multiUser: true, project: project });
  var e = written({ target: { project: "work", consoleSessionId: "100", sessionId: "cli-shared", runsAs: "alice-os" }, req: { prompt: "for alice-os", contextNote: "note for alice-os" } });
  writer.ledger.record(e);
  // The same ledger directory read in every mode and by every caller shape.
  [{ multiUser: true }, { multiUser: false }, { multiUser: true, caller: { user: USERS.admin, authenticated: true } }].forEach(function (mode) {
    var reader = build(Object.assign({ project: workProject() }, mode));
    reader.ledger = createOutboundLedger({ getBaseDir: function () { return writer.dir; }, now: function () { return NOW; }, log: quiet() });
    reader.query = createOutboundQuery({ ledger: reader.ledger, access: reader.access, caller: mode.caller || { user: null, authenticated: true } });
    var res = reader.query.list({ sessionId: "cli-sender" });
    assert.equal(res.count, 1);
    assert.ok(withheld(res.messages[0]));
    assert.equal(JSON.stringify(res).indexOf("for alice-os"), -1);
  });
  var raw = JSON.stringify(writer.ledger.readAttributed());
  assert.equal(raw.indexOf("for alice-os"), -1);
});

test("caller shape: in os-users mode a daemon-user target stays readable after the console no longer holds it", function () {
  var t = build({ multiUser: true, osUsers: true });
  t.ledger.record(entry({ target: { project: "gone", sessionId: "5", cliSessionId: "cli-gone", runsAs: "daemon" }, prompt: "to a removed session" }));
  assert.deepEqual(prompts(t.query.list({ sessionId: "cli-sender" })), ["to a removed session"]);
});

test("restart renumbering: an other-OS-user target whose console id is later taken by a daemon-user session stays withheld", function () {
  // At write time 100 was alice's session, running as alice-os. After a restart
  // the console id 100 belongs to an older session that runs as the daemon user.
  var project = workProject({ getLinuxUserForSession: function () { return null; } });
  project.sm.sessions.get(100).cliSessionId = "cli-someone-else";
  project.sm.sessions.get(100).createdAt = NOW - 48 * HOUR;
  var asSocket = build({ multiUser: true, project: project });
  var asAdmin = build({ multiUser: true, project: project, caller: { user: USERS.admin, authenticated: true } });
  [asSocket, asAdmin].forEach(function (t) {
    t.ledger.record(written({ target: { project: "work", consoleSessionId: "100", runsAs: "alice-os" }, req: { prompt: "for alice-os" } }));
    t.ledger.record(written({ target: { project: "work", consoleSessionId: "100", sessionId: "cli-shared-before", runsAs: "alice-os" }, req: { prompt: "for alice-os, by vendor id" } }));
    var res = t.query.list({ sessionId: "cli-sender" });
    assert.equal(res.count, 2);
    res.messages.forEach(function (m) {
      assert.ok(withheld(m));
      assert.equal(JSON.stringify(res).indexOf("for alice-os"), -1);
    });
  });
});

test("a context note is withheld whenever the prompt is, and shown whenever it is shown", function () {
  var project = workProject({ getLinuxUserForSession: function (s) { return s.localId === 100 ? "alice-os" : null; } });
  var t = build({ multiUser: true, project: project });
  t.ledger.record(written({ target: { project: "work", consoleSessionId: "100", sessionId: "cli-shared", runsAs: "alice-os" }, req: { prompt: "p-hidden", contextNote: "note-hidden" } }));
  t.ledger.record(written({ target: { project: "work", consoleSessionId: "101", sessionId: "cli-alice-private", runsAs: "daemon" }, req: { prompt: "p-shown", contextNote: "note-shown" } }));
  t.ledger.record(written({ target: { project: "work", consoleSessionId: "100", sessionId: "cli-shared", runsAs: "alice-os" }, out: { result: "refused", reason: "nope" }, req: { contextNote: "note-on-refusal" } }));
  var res = t.query.list({ sessionId: "cli-sender" });
  var text = JSON.stringify(res);
  assert.equal(text.indexOf("note-hidden"), -1);
  assert.equal(text.indexOf("note-on-refusal"), -1);
  assert.equal(text.indexOf("p-hidden"), -1);
  var shown = res.messages.filter(function (m) { return m.prompt === "p-shown"; })[0];
  assert.equal(shown.contextNote, "note-shown");
  assert.equal("contextNoteWithheld" in shown, false);
  var hidden = res.messages.filter(function (m) { return m.contextNoteWithheld === true; });
  assert.equal(hidden.length, 2);
  hidden.forEach(function (m) { assert.equal("contextNote" in m, false); });
});

test("caller shape: a console user reads a prompt only for a target session canAccessSession lets them read", function () {
  var asAlice = build({ multiUser: true, caller: { user: USERS.alice, authenticated: true } });
  seedTargets(asAlice);
  var res = asAlice.query.list({ sessionId: "cli-sender" });
  var byText = {};
  res.messages.forEach(function (m) { byText[m.target.cliSessionId] = m; });
  assert.equal(byText["cli-shared"].prompt, "shared");
  assert.equal(byText["cli-alice-private"].prompt, "alice private");
  assert.ok(withheld(byText["cli-bob-private"]));
  assert.match(byText["cli-bob-private"].promptWithheldReason, /cannot read the target session/);
  assert.equal(JSON.stringify(res).indexOf("bob private"), -1);

  var asBob = build({ multiUser: true, caller: { user: USERS.bob, authenticated: true } });
  seedTargets(asBob);
  var bobSees = {};
  asBob.query.list({ sessionId: "cli-sender" }).messages.forEach(function (m) { bobSees[m.target.cliSessionId] = m; });
  assert.equal(bobSees["cli-shared"].prompt, "shared");
  assert.ok(withheld(bobSees["cli-alice-private"]));
  assert.equal(bobSees["cli-bob-private"].prompt, "bob private");
});

test("caller shape: a user outside the target project, or with the target gone, gets metadata only", function () {
  var stranger = { id: "u-stranger", role: "user" };
  USERS.stranger = stranger;
  var t = build({ multiUser: true, caller: { user: stranger, authenticated: true } });
  delete USERS.stranger;
  seedTargets(t);
  t.query.list({ sessionId: "cli-sender" }).messages.forEach(function (m) {
    assert.ok(withheld(m));
    assert.match(m.promptWithheldReason, /cannot access the target project/);
  });

  var admin = build({ multiUser: true, caller: { user: USERS.admin, authenticated: true } });
  admin.ledger.record(entry({ target: { project: "work", sessionId: "55", cliSessionId: "cli-deleted" }, prompt: "to a deleted session" }));
  var m = admin.query.list({ sessionId: "cli-sender" }).messages[0];
  assert.ok(withheld(m));
  assert.match(m.promptWithheldReason, /not held by the console/);
});

test("caller shape: a target that runs as another OS user is withheld even from a user who owns the project", function () {
  var project = workProject({ getLinuxUserForSession: function () { return "alice-os"; } });
  var t = build({ multiUser: true, project: project, caller: { user: USERS.admin, authenticated: true } });
  seedTargets(t, project);
  t.query.list({ sessionId: "cli-sender" }).messages.forEach(function (m) {
    assert.ok(withheld(m));
    assert.match(m.promptWithheldReason, /another OS user/);
  });
});

test("an unauthenticated caller is no principal in any mode", function () {
  var t = build({ multiUser: false, caller: { user: null, authenticated: false } });
  seedTargets(t);
  t.query.list({ sessionId: "cli-sender" }).messages.forEach(function (m) { assert.ok(withheld(m)); });
});

test("a console id in a target is trusted only for a session that existed when the call was made", function () {
  var project = workProject();
  // A session numbered 100 that was created after the call: not the one it was sent to.
  project.sm.sessions.get(100).createdAt = NOW + HOUR;
  var t = build({ multiUser: true, project: project, caller: { user: USERS.alice, authenticated: true } });
  t.ledger.record(entry({ target: { project: "work", sessionId: "100" }, prompt: "to an earlier 100" }));
  var m = t.query.list({ sessionId: "cli-sender" }).messages[0];
  assert.ok(withheld(m));
});

test("the verb writes nothing", function () {
  var t = build();
  t.ledger.record(entry({}));
  var snapshot = function () {
    var out = {};
    (function walk(d) {
      fs.readdirSync(d).forEach(function (n) {
        var p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) walk(p); else out[p] = fs.readFileSync(p, "utf8");
      });
    })(t.dir);
    return out;
  };
  var before = snapshot();
  t.query.list({ sessionId: "cli-sender" });
  t.query.list({ sessionId: "7", kind: "opens", sinceMs: NOW - HOUR });
  assert.deepEqual(snapshot(), before);
});

test("the IPC command passes only the four fields of the request", function () {
  var seen;
  var fake = { list: function (req) { seen = req; return { ok: true }; } };
  handleOutboundCommand(fake, { cmd: "list_outbound", sessionId: "s", projectSlug: "p", sinceMs: 5, kind: "sent", prompt: "ignored", cwd: "/x" });
  assert.deepEqual(seen, { sessionId: "s", projectSlug: "p", sinceMs: 5, kind: "sent" });
});

test("an unreadable ledger is an error result naming the path and errno, never an empty listing", function () {
  var cli = require("../lib/cli/session-subcommands");
  var t = build();
  fs.mkdirSync(path.join(t.dir, "outbound"), { recursive: true });
  fs.writeFileSync(path.join(t.dir, "outbound", "sessions"), "not a directory");
  var res = t.query.list({ sessionId: "cli-sender" });
  assert.equal(res.ok, false);
  assert.equal(res.result, "error");
  assert.equal(res.code, "ENOTDIR");
  assert.ok(res.reason.indexOf(path.join(t.dir, "outbound", "sessions")) !== -1, res.reason);
  assert.equal("messages" in res, false);
  assert.equal(cli.exitCodeFor(res, {}), 1);
});

test("an unreadable unattributed side is an error result too", function () {
  var t = build();
  t.ledger.record(entry());
  fs.writeFileSync(path.join(t.dir, "outbound", "unattributed"), "not a directory");
  var res = t.query.list({ sessionId: "cli-sender" });
  assert.equal(res.result, "error");
  assert.equal(res.code, "ENOTDIR");
});

test("a ledger directory that does not exist lists nothing, as a success", function () {
  var t = build();
  var res = t.query.list({ sessionId: "cli-sender" });
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
});

test("access has no os-users branch: the implicit principal gets the entry as stored", function () {
  var access = createOutboundAccess({
    projectAccess: { principalFor: function () { return { implicit: true }; } },
    getProject: function () { return null; },
    isOsUsers: function () { return true; },
  });
  var caller = { user: null, authenticated: true };
  assert.equal(access.canReadPrompt({ target: { project: "work", runsAs: "alice-os" } }, caller).allowed, true);
  assert.equal(access.canReadPrompt({ target: { project: "work" } }, caller).allowed, true);
});

test("the implicit principal outside os-users still reads every target", function () {
  var access = createOutboundAccess({
    projectAccess: { principalFor: function () { return { implicit: true }; } },
    getProject: function () { return null; },
  });
  assert.equal(access.canReadPrompt({ target: { project: "work", runsAs: "alice-os" } }, { user: null, authenticated: true }).allowed, true);
});
