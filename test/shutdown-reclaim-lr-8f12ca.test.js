/**
 * A daemon shutdown or restart kills every claude child, background agents
 * included. Every shutdown path ends in relay.destroyAll() -> project destroy(),
 * so this drives a real server through that call: a session with a live
 * background agent is recorded as resumable (reason daemon_restart, agents
 * named, persisted synchronously) and a session without one is untouched. The
 * next startup (a new project context over the same directory) tells the
 * operator which agents were interrupted, once.
 */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var harness = require("./access-harness");
var settle = harness.settle;

var H = null;
var sessions = null;
var sessionReclaim = null;

function ctxOf(slug) {
  var found = null;
  H.relay.forEachProject(function (ctx, s) { if (s === slug) found = ctx; });
  return found;
}

function running(session) {
  session.queryInstance = { close: function () {} };
  return session;
}

function managerOver(cwd) {
  return sessions.createSessionManager({
    cwd: cwd, send: function () {}, sendTo: function () {}, sendEach: function () {},
  });
}

function byCli(sm, cliSessionId) {
  var found = null;
  sm.sessions.forEach(function (s) { if (s.cliSessionId === cliSessionId) found = s; });
  return found;
}

test.before(async function () {
  H = await harness.start({ multiUser: false, users: [], projects: [{ slug: "p" }] });
  sessions = require("../lib/sessions");
  sessionReclaim = require("../lib/session-reclaim");
});

test.after(async function () {
  await H.stop();
});

test("shutdown marks a session with a live background agent resumable and leaves the others alone", async function () {
  var sm = ctxOf("p").getSessionManager();
  var recorded = [];
  var realRecord = sm.sendAndRecord;
  sm.sendAndRecord = function (s, obj) { recorded.push(obj); return realRecord(s, obj); };

  var withAgent = running(sm.createSessionRaw({}));
  withAgent.cliSessionId = "cli-shutdown-agent";
  withAgent.activeTaskToolIds = { toolu_1: true };
  withAgent.taskLabels = { toolu_1: "Review the diff" };
  sm.saveSessionFile(withAgent);

  var noAgent = running(sm.createSessionRaw({}));
  noAgent.cliSessionId = "cli-shutdown-plain";
  sm.saveSessionFile(noAgent);

  var staleRegistration = sm.createSessionRaw({});
  staleRegistration.cliSessionId = "cli-shutdown-stale";
  staleRegistration.activeTaskToolIds = { toolu_2: true };
  sm.saveSessionFile(staleRegistration);

  var started = Date.now();
  await H.relay.destroyAll();
  assert.ok(Date.now() - started < 2000, "the announcer must not stretch the shutdown");

  assert.equal(withAgent.pendingAutoResume, true);
  assert.equal(withAgent.pendingAutoResumeReason, "daemon_restart");
  assert.deepEqual(withAgent.pendingAutoResumeAgents, ["Review the diff"]);
  assert.equal(noAgent.pendingAutoResume, undefined, "no agent, no marker");
  assert.equal(staleRegistration.pendingAutoResume, undefined, "no running query, no marker");
  assert.deepEqual(recorded, [], "nothing is broadcast while the process is exiting");

  // Persisted synchronously: a fresh manager over the same directory sees it.
  var reloaded = managerOver(H.dirs.p);
  var a = byCli(reloaded, "cli-shutdown-agent");
  assert.equal(a.pendingAutoResume, true);
  assert.equal(a.pendingAutoResumeReason, "daemon_restart");
  assert.deepEqual(a.pendingAutoResumeAgents, ["Review the diff"]);
  assert.ok(!byCli(reloaded, "cli-shutdown-plain").pendingAutoResume);
  assert.ok(!byCli(reloaded, "cli-shutdown-stale").pendingAutoResume);
});

test("the next startup tells the operator which agents were interrupted, once", function () {
  var relay = H.relay;
  relay.addProject(H.dirs.p, "p-restarted", "p-restarted", null, null, null);
  var sm = ctxOf("p-restarted").getSessionManager();
  var s = byCli(sm, "cli-shutdown-agent");

  assert.equal(s.pendingAutoResume, true, "still marked for auto-resume after startup");
  assert.equal(s.pendingAutoResumeReason, "daemon_restart");
  sm.loadSessionHistory(s);
  var notice = s.history.filter(function (h) { return h.type === "error"; }).pop();
  assert.ok(notice, "an inline notice is recorded in the session");
  assert.match(notice.text, /Clagentic: Console shut down or restarted/);
  assert.match(notice.text, /background agent "Review the diff"/);

  var diag = sessionReclaim.restartDiagnostics(sm, "p-restarted");
  assert.equal(diag.length, 1);
  assert.equal(diag[0].type, "diagnostic");
  assert.match(diag[0].message, /Review the diff/);
  assert.deepEqual(sessionReclaim.restartDiagnostics(sm, "p-restarted", function () { return false; }), []);

  // The persisted names are spent, so another restart does not repeat the notice.
  var again = byCli(managerOver(H.dirs.p), "cli-shutdown-agent");
  assert.equal(again.pendingAutoResume, true);
  assert.equal(again.pendingAutoResumeAgents, null);
});

function freshProject(slug) {
  var dir = path.join(H.home, "extra", slug);
  fs.mkdirSync(dir, { recursive: true });
  H.relay.addProject(dir, slug, slug, null, null, null);
  return { dir: dir, sm: ctxOf(slug).getSessionManager() };
}

// The announcer reports failures through console.error only (shutdown must not
// throw), so the tests need those lines to assert on.
async function capturingConsole(fn) {
  var lines = { log: [], error: [] };
  var realLog = console.log;
  var realError = console.error;
  console.log = function () { lines.log.push(Array.prototype.join.call(arguments, " ")); };
  console.error = function () { lines.error.push(Array.prototype.join.call(arguments, " ")); };
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return lines;
}

test("removing a project is not a shutdown: nothing is recorded as resumable", async function () {
  var p = freshProject("p-removed");
  var s = running(p.sm.createSessionRaw({}));
  s.cliSessionId = "cli-removed-agent";
  s.activeTaskToolIds = { toolu_9: true };
  s.taskLabels = { toolu_9: "Doomed by operator" };
  p.sm.saveSessionFile(s);

  var lines = await capturingConsole(async function () {
    assert.equal(H.relay.removeProject("p-removed"), true);
    await settle();
  });

  assert.equal(s.pendingAutoResume, undefined);
  assert.equal(s.pendingAutoResumeReason, undefined);
  assert.equal(s.pendingAutoResumeAgents, undefined);
  var reloaded = byCli(managerOver(p.dir), "cli-removed-agent");
  assert.ok(!reloaded.pendingAutoResume, "the persisted session is not marked");
  assert.ok(!reloaded.pendingAutoResumeAgents);
  assert.ok(!lines.log.concat(lines.error).some(function (l) { return /session-reclaim\] Shutdown/.test(l); }),
    "removal logs no shutdown summary");
});

test("a session file that cannot be written is logged, counted, and does not stop the shutdown", async function () {
  var p = freshProject("p-fail");
  var bad = running(p.sm.createSessionRaw({}));
  bad.cliSessionId = "cli-fail-bad";
  bad.activeTaskToolIds = { toolu_a: true };
  bad.taskLabels = { toolu_a: "Agent that loses its marker" };
  p.sm.saveSessionFile(bad);
  var good = running(p.sm.createSessionRaw({}));
  good.cliSessionId = "cli-fail-good";
  good.activeTaskToolIds = { toolu_b: true };
  good.taskLabels = { toolu_b: "Agent that is recorded" };
  p.sm.saveSessionFile(good);

  var realSave = p.sm.saveSessionFile;
  p.sm.saveSessionFile = function (s) {
    if (s === bad) throw new Error("disk full");
    return realSave(s);
  };

  var lines = await capturingConsole(function () { return H.relay.destroyAll(); });

  var failure = lines.error.filter(function (l) { return /Could not persist the resume marker/.test(l); });
  assert.equal(failure.length, 1, "one error line for the one failure");
  assert.ok(failure[0].indexOf("session " + bad.localId) !== -1, "names the session id");
  assert.ok(failure[0].indexOf("Agent that loses its marker") !== -1, "names the agent");
  assert.ok(failure[0].indexOf("disk full") !== -1, "names the error");

  var summary = lines.error.filter(function (l) { return /session-reclaim\] Shutdown/.test(l); });
  assert.equal(summary.length, 1, "one summary line per shutdown");
  assert.match(summary[0], /2 session\(s\) with background agents recorded as resumable, 1 could not be persisted/);

  var reloaded = byCli(managerOver(p.dir), "cli-fail-good");
  assert.equal(reloaded.pendingAutoResume, true, "the other session is still persisted");
  assert.deepEqual(reloaded.pendingAutoResumeAgents, ["Agent that is recorded"]);
  assert.ok(!byCli(managerOver(p.dir), "cli-fail-bad").pendingAutoResume);
});
