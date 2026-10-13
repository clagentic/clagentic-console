/**
 * The reclaim announcer runs while a session (or the whole process) is being
 * ended, so it must never throw, and it must never fail silently: every
 * failure is a journal line naming the session, the agents and the error, and
 * a lost resume marker is reported in the return value.
 */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var reclaim = require("../lib/session-reclaim");

function sessionWithAgent() {
  return { localId: 41, activeTaskToolIds: { toolu_1: true }, taskLabels: { toolu_1: "Review the diff" } };
}

function announce(overrides) {
  var errors = [];
  var realError = console.error;
  console.error = function () { errors.push(Array.prototype.join.call(arguments, " ")); };
  var result;
  try {
    result = reclaim.announceLiveAgentReclaim(Object.assign({
      session: sessionWithAgent(),
      sm: { saveSessionFile: function () {}, sendAndRecord: function () {} },
      send: function () {},
      slug: "p",
      reason: "idle_reap",
      source: "idle-reap",
      cause: "Ended.",
    }, overrides));
  } finally {
    console.error = realError;
  }
  return { result: result, errors: errors };
}

test("a session without agents is untouched and reports persisted", function () {
  var out = announce({ session: { localId: 1, activeTaskToolIds: {} } });
  assert.deepEqual(out.result, { labels: [], persisted: true });
  assert.deepEqual(out.errors, []);
});

test("success reports the agents and persisted: true", function () {
  var out = announce({});
  assert.deepEqual(out.result, { labels: ["Review the diff"], persisted: true });
  assert.deepEqual(out.errors, []);
});

test("a throwing saveSessionFile reports persisted: false, logs, and still sends the notice", function () {
  var sent = [];
  var recorded = [];
  var out = announce({
    sm: {
      saveSessionFile: function () { throw new Error("EROFS"); },
      sendAndRecord: function (s, obj) { recorded.push(obj); },
    },
    send: function (m) { sent.push(m); },
  });
  assert.equal(out.result.persisted, false);
  assert.deepEqual(out.result.labels, ["Review the diff"]);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /session 41/);
  assert.match(out.errors[0], /Review the diff/);
  assert.match(out.errors[0], /EROFS/);
  assert.equal(sent.length, 1, "the broadcast still goes out");
  assert.equal(recorded.length, 1, "the inline notice still goes out");
});

test("a deferred notice with a throwing saveSessionFile does not throw and reports persisted: false", function () {
  var out = announce({
    deferNotice: true,
    sm: { saveSessionFile: function () { throw new Error("ENOSPC"); } },
  });
  assert.equal(out.result.persisted, false);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /ENOSPC/);
});

test("broadcast and inline-notice failures are logged, not swallowed", function () {
  var out = announce({
    send: function () { throw new Error("socket closed"); },
    sm: {
      saveSessionFile: function () {},
      sendAndRecord: function () { throw new Error("history full"); },
    },
  });
  assert.equal(out.result.persisted, true);
  assert.equal(out.errors.length, 2);
  assert.match(out.errors[0], /socket closed/);
  assert.match(out.errors[1], /history full/);
});

test("the shutdown tally counts announced sessions and failures and logs one line", function () {
  var tally = reclaim.createShutdownTally();
  reclaim.countShutdownReclaim(tally, { labels: [], persisted: true });
  reclaim.countShutdownReclaim(tally, { labels: ["a"], persisted: true });
  reclaim.countShutdownReclaim(tally, { labels: ["b"], persisted: false });
  assert.deepEqual(tally, { sessions: 2, failed: 1 });

  var logged = { log: [], error: [] };
  var realLog = console.log;
  var realError = console.error;
  console.log = function (l) { logged.log.push(l); };
  console.error = function (l) { logged.error.push(l); };
  try {
    reclaim.logShutdownSummary(tally);
    reclaim.logShutdownSummary({ sessions: 1, failed: 0 });
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  assert.equal(logged.error.length, 1, "a lost marker raises an error line");
  assert.match(logged.error[0], /2 session\(s\).*1 could not be persisted/);
  assert.equal(logged.log.length, 1);
});
