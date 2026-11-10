"use strict";
// end-session stands one live session down: pending prompts settle as cancelled
// (reason ended, with who ended it), the turn is aborted, the query closed,
// history kept. A table over the acceptance cases, then the CLI arguments.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { createSessionInput } = require("../lib/session-input");
var { createOutboundLedger } = require("../lib/outbound-ledger");
var { promptsFor } = require("../lib/prompt-registry");
var { handleSessionCommand } = require("../lib/session-input-ipc");
var { parseSessionArgs, exitCodeFor, SESSION_VERBS } = require("../lib/cli/session-subcommands");
var liveness = require("../lib/session-liveness");

var NOW = Date.now();
var BASH = { toolName: "Bash", toolInput: { command: "make" }, vendor: "claude" };

function liveSession(id, extra) {
  var s = {
    localId: id,
    cliSessionId: "cli-" + id,
    history: [{ type: "user_message", text: "earlier work" }],
    isProcessing: true,
    queryInstance: { closed: 0, close: function () { s.queryInstance.closed++; } },
    abortController: { aborted: 0, abort: function () { s.abortController.aborted++; } },
    agentName: null,
  };
  return Object.assign(s, extra || {});
}

function makeWorld(sessions, opts) {
  opts = opts || {};
  var sent = [];
  var broadcasts = [];
  var sm = {
    sessions: new Map(),
    sessionsDir: opts.sessionsDir,
    defaultVendor: "claude",
    sendAndRecord: function (s, m) { sent.push(m); s.history.push(m); },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  sessions.forEach(function (s) { sm.sessions.set(s.localId, s); });
  var project = {
    cwd: "/unused",
    sm: sm,
    sdk: {},
    send: function (m) { broadcasts.push(m); },
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
  };
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "end-session-"));
  var ledger = createOutboundLedger({
    getBaseDir: function () { return dir; },
    now: function () { return NOW; },
    log: { error: function () {}, warn: function () {}, log: function () {} },
  });
  var input = createSessionInput({
    getProject: function (slug) { return slug === "p" ? project : null; },
    outboundLedger: ledger,
    now: function () { return NOW; },
  });
  return { input: input, sm: sm, sent: sent, broadcasts: broadcasts, ledger: ledger };
}

function openPrompt(w, session, toolUseId) {
  return promptsFor(w.sm).open(session, "permission", BASH, { toolUseId: toolUseId });
}

function cancelEvents(w) {
  return w.sent.filter(function (m) { return m.type === "prompt_cancel" || m.type === "permission_cancel"; });
}

test("AC1: a session blocked on a prompt is ended; the prompt settles once as cancelled ended by the caller", async function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  var opened = openPrompt(w, s, "tu-1");
  var r = w.input.endSession({ projectSlug: "p", sessionId: "1", from: "coordinator" });
  assert.equal(r.ok, true);
  assert.equal(r.result, "ended");
  assert.equal(r.endedBy, "caller:coordinator");
  assert.equal(r.consoleSessionId, "1");
  assert.equal(r.sessionId, "cli-1");
  var events = cancelEvents(w);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "ended");
  assert.equal(events[0].source, "caller:coordinator");
  await opened.answer;
  assert.equal(promptsFor(w.sm).lookup(opened.requestId), null);
  assert.equal(s.abortController.aborted, 1);
  assert.equal(s.queryInstance.closed, 1);
});

test("AC1: once the runtime unwinds, the session is reaped for list-sessions", function () {
  var s = liveSession(1);
  var w = makeWorld([s]);
  openPrompt(w, s, "tu-1");
  assert.equal(liveness.activityOf(s), liveness.ACTIVITY.WAITING);
  w.input.endSession({ projectSlug: "p", sessionId: "1" });
  // What processQueryStream's cleanup does when the query ends.
  s.queryInstance = null;
  s.isProcessing = false;
  assert.equal(liveness.activityOf(s), liveness.ACTIVITY.REAPED);
  assert.equal(w.input.listSessions({ projectSlug: "p" }).ok, true);
});

test("AC2: an idle session without --from ends with source user", function () {
  var s = liveSession(2, { isProcessing: false });
  var w = makeWorld([s]);
  var opened = openPrompt(w, s, "tu-2");
  var r = w.input.endSession({ projectSlug: "p", sessionId: "cli-2" });
  assert.equal(r.result, "ended");
  assert.equal(r.endedBy, "user");
  assert.equal(cancelEvents(w)[0].source, "user");
  assert.ok(opened.requestId);
});

test("AC3: an address matching several live sessions ends none and lists candidates", function () {
  var a = liveSession(1);
  var b = liveSession(2);
  var w = makeWorld([a, b]);
  var r = w.input.endSession({ to: "@p" });
  assert.equal(r.ok, false);
  assert.equal(r.result, "ambiguous");
  assert.equal(r.candidates.length, 2);
  assert.equal(a.queryInstance.closed + b.queryInstance.closed, 0);
  assert.equal(a.abortController.aborted + b.abortController.aborted, 0);
});

test("AC3: an address matching one live session ends it", function () {
  var a = liveSession(1);
  var w = makeWorld([a]);
  var r = w.input.endSession({ to: "@p", from: "x" });
  assert.equal(r.result, "ended");
  assert.equal(a.queryInstance.closed, 1);
});

test("AC4: an unknown session id is not-found and nothing changes", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "end-store-"));
  var s = liveSession(1);
  var w = makeWorld([s], { sessionsDir: dir });
  var r = await w.input.endSession({ projectSlug: "p", sessionId: "nope" });
  assert.equal(r.ok, false);
  assert.equal(r.result, "not-found");
  assert.equal(s.queryInstance.closed, 0);
  assert.equal(s.abortController.aborted, 0);
});

test("AC5: a session in memory without a runtime is already-ended and untouched", function () {
  var s = liveSession(3, { isProcessing: false, queryInstance: null });
  var w = makeWorld([s]);
  var r = w.input.endSession({ projectSlug: "p", sessionId: "3", from: "x" });
  assert.equal(r.ok, true);
  assert.equal(r.result, "already-ended");
  assert.equal(r.endedBy, "caller:x");
  assert.equal(s.abortController.aborted, 0);
  assert.equal(w.sent.length, 0);
});

test("AC5: a session only in the store is already-ended and is not resumed", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "end-store-"));
  fs.writeFileSync(path.join(dir, "cli-old.jsonl"), JSON.stringify({ type: "meta", cliSessionId: "cli-old", title: "old" }) + "\n");
  var w = makeWorld([], { sessionsDir: dir });
  var r = await w.input.endSession({ projectSlug: "p", sessionId: "cli-old" });
  assert.equal(r.ok, true);
  assert.equal(r.result, "already-ended");
  assert.equal(r.sessionId, "cli-old");
  assert.equal(w.sm.sessions.size, 0);
});

test("AC5: ending twice is idempotent once the runtime is gone", function () {
  var s = liveSession(4);
  var w = makeWorld([s]);
  assert.equal(w.input.endSession({ projectSlug: "p", sessionId: "4" }).result, "ended");
  s.queryInstance = null;
  s.isProcessing = false;
  assert.equal(w.input.endSession({ projectSlug: "p", sessionId: "4" }).result, "already-ended");
});

test("AC6: the announcement names the background agents, as the idle reaper does", function () {
  var s = liveSession(5, { activeTaskToolIds: { t1: true, t2: true }, taskLabels: { t1: "lint sweep", t2: "type check" } });
  var w = makeWorld([s]);
  var r = w.input.endSession({ projectSlug: "p", sessionId: "5", from: "coordinator", reason: "replaced by a newer lane" });
  assert.equal(r.result, "ended");
  assert.deepEqual(r.agents.slice().sort(), ["lint sweep", "type check"]);
  var notice = w.sent.filter(function (m) { return m.type === "error"; })[0];
  assert.match(notice.text, /lint sweep/);
  assert.match(notice.text, /type check/);
  assert.match(notice.text, /coordinator/);
  assert.match(notice.text, /replaced by a newer lane/);
  assert.equal(w.broadcasts[0].source, "end-session");
  assert.equal(s.pendingAutoResumeReason, "ended_by_request");
});

test("AC7: history is intact and the session stays in the store for resume by id", function () {
  var s = liveSession(6);
  var w = makeWorld([s]);
  var before = s.history[0];
  w.input.endSession({ projectSlug: "p", sessionId: "6" });
  assert.equal(s.history[0], before);
  assert.ok(w.sm.sessions.has(6));
  assert.equal(s.cliSessionId, "cli-6");
});

test("the call is recorded in the outbound ledger, ended or not", function () {
  var s = liveSession(7);
  var w = makeWorld([s]);
  w.input.endSession({ projectSlug: "p", sessionId: "7", from: "coordinator" });
  w.input.endSession({ to: "@p/missing" });
  var entries = w.ledger.readAttributed().concat(w.ledger.readUnattributed());
  assert.deepEqual(entries.map(function (e) { return e.verb; }), ["end_session", "end_session"]);
  assert.deepEqual(entries.map(function (e) { return e.result; }).sort(), ["ended", "not-found"]);
});

test("a --from that cannot name a cancel source is refused and nothing ends", function () {
  var s = liveSession(8);
  var w = makeWorld([s]);
  var r = w.input.endSession({ projectSlug: "p", sessionId: "8", from: "has space" });
  assert.equal(r.result, "refused");
  assert.equal(s.queryInstance.closed, 0);
});

test("target rules: both ways, an unsafe id and an unknown project are refused", function () {
  var w = makeWorld([liveSession(9)]);
  assert.equal(w.input.endSession({ projectSlug: "p", sessionId: "9", to: "@p" }).result, "refused");
  assert.equal(w.input.endSession({ projectSlug: "p", sessionId: "../x" }).result, "refused");
  assert.equal(w.input.endSession({ projectSlug: "zzz", sessionId: "9" }).result, "refused");
});

test("a failing abort does not leave the query open or the prompts pending", function () {
  var s = liveSession(10);
  s.abortController.abort = function () { throw new Error("boom"); };
  var w = makeWorld([s]);
  var opened = openPrompt(w, s, "tu-10");
  var errors = [];
  var original = console.error;
  console.error = function () { errors.push(Array.prototype.join.call(arguments, " ")); };
  var r;
  try { r = w.input.endSession({ projectSlug: "p", sessionId: "10" }); }
  finally { console.error = original; }
  assert.equal(r.result, "ended");
  assert.equal(s.queryInstance.closed, 1);
  assert.equal(promptsFor(w.sm).lookup(opened.requestId), null);
  assert.ok(errors.some(function (l) { return l.indexOf("could not abort") !== -1; }));
});

test("a failing prompt settle is reported: ok false, failures names prompts, result stays ended", function () {
  var s = liveSession(11);
  var w = makeWorld([s]);
  var registry = promptsFor(w.sm);
  registry.cancelSession = function () { throw new Error("settle broke"); };
  var original = console.error;
  console.error = function () {};
  var r;
  try { r = w.input.endSession({ projectSlug: "p", sessionId: "11" }); }
  finally { console.error = original; }
  assert.equal(r.ok, false);
  assert.equal(r.result, "ended");
  assert.deepEqual(r.failures, [{ step: "prompts", error: "settle broke" }]);
  assert.equal(s.abortController.aborted, 1);
  assert.equal(s.queryInstance.closed, 1);
  var entries = w.ledger.readAttributed().concat(w.ledger.readUnattributed());
  assert.deepEqual(entries[0].failures, r.failures);
});

test("a throwing announcement is reported and the later steps still run", function () {
  var s = liveSession(12);
  var w = makeWorld([s]);
  var opened = openPrompt(w, s, "tu-12");
  var sessionReclaim = require("../lib/session-reclaim");
  var originalAnnounce = sessionReclaim.announceLiveAgentReclaim;
  sessionReclaim.announceLiveAgentReclaim = function () { throw new Error("announce broke"); };
  var original = console.error;
  console.error = function () {};
  var r;
  try { r = w.input.endSession({ projectSlug: "p", sessionId: "12" }); }
  finally {
    console.error = original;
    sessionReclaim.announceLiveAgentReclaim = originalAnnounce;
  }
  assert.equal(r.ok, false);
  assert.equal(r.result, "ended");
  assert.deepEqual(r.failures, [{ step: "announce", error: "announce broke" }]);
  assert.equal(promptsFor(w.sm).lookup(opened.requestId), null);
  assert.equal(s.abortController.aborted, 1);
  assert.equal(s.queryInstance.closed, 1);
});

test("the IPC handler passes the end_session fields through", function () {
  var seen;
  var fake = { endSession: function (req) { seen = req; return { ok: true }; } };
  handleSessionCommand(fake, { cmd: "end_session", projectSlug: "p", sessionId: "1", to: "t", reason: "r", from: "f", fromSession: "fs" });
  assert.deepEqual({ p: seen.projectSlug, s: seen.sessionId, t: seen.to, r: seen.reason, f: seen.from, fs: seen.fromSession }, { p: "p", s: "1", t: "t", r: "r", f: "f", fs: "fs" });
});

// ---- CLI arguments ----

test("cli: end-session is a session verb with the usage of the brief", function () {
  assert.ok(SESSION_VERBS.indexOf("end-session") !== -1);
});

test("cli: by id and by address parse; reason and sender flags are kept", function () {
  var byId = parseSessionArgs("end-session", ["--project", "p", "--session", "3", "--from", "coord", "--from-session", "abc", "--reason", "stale"]);
  assert.deepEqual(byId.request, { projectSlug: "p", sessionId: "3", from: "coord", fromSession: "abc", reason: "stale" });
  assert.deepEqual(parseSessionArgs("end-session", ["--to", "a@p"]).request, { to: "a@p" });
  assert.deepEqual(parseSessionArgs("end-session", ["--to", "a@p", "--project", "p"]).request, { to: "a@p", projectSlug: "p" });
});

test("cli: the target rules match send-input", function () {
  assert.match(parseSessionArgs("end-session", []).error, /Missing the target/);
  assert.match(parseSessionArgs("end-session", ["--project", "p"]).error, /--session/);
  assert.match(parseSessionArgs("end-session", ["--session", "3"]).error, /--project/);
  assert.match(parseSessionArgs("end-session", ["--to", "a@p", "--session", "3"]).error, /one way only/);
});

test("cli: options that belong to other verbs are unknown", function () {
  assert.match(parseSessionArgs("end-session", ["--project", "p", "--session", "1", "--prompt", "x"]).error, /Unknown option/);
  assert.match(parseSessionArgs("end-session", ["--reply"]).error, /Unknown option/);
  assert.match(parseSessionArgs("end-session", ["--project"]).error, /Missing value/);
});

test("cli: exit codes follow send-input (ambiguous 3, not found by address 4, by id 1)", function () {
  assert.equal(exitCodeFor({ ok: true, result: "ended" }, { sessionId: "1" }), 0);
  assert.equal(exitCodeFor({ ok: true, result: "already-ended" }, { sessionId: "1" }), 0);
  assert.equal(exitCodeFor({ ok: false, result: "ambiguous" }, { to: "@p" }), 3);
  assert.equal(exitCodeFor({ ok: false, result: "not-found" }, { to: "@p" }), 4);
  assert.equal(exitCodeFor({ ok: false, result: "not-found" }, { sessionId: "1" }), 1);
});
