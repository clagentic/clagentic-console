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
var harness = require("./access-harness");

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
