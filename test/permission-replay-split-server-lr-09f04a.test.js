"use strict";
// Replay pages history, so a permission_request can be sent without the
// resolution that closed it. The server marks such requests settled so the
// client never draws them as live cards.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { attachSessions } = require("../lib/project-sessions");

function makeHarness() {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-perm-replay-"));
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessionsModule;
  try { sessionsModule = require("../lib/sessions"); }
  finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  var sent = [];
  function sendTo(ws, msg) { sent.push(msg); }
  var sm = sessionsModule.createSessionManager({ cwd: tmpHome, send: function () {}, sendTo: sendTo, sendEach: function () {} });
  var handlers = attachSessions({
    cwd: tmpHome, slug: "test-perm-replay", osUsers: false, currentVersion: "0.0.0",
    sm: sm, sdk: null, tm: null, clients: [], opts: {},
    getNotificationsModule: function () { return null; },
    send: function () {}, sendTo: sendTo, sendToAdmins: function () {},
    sendToSession: function () {}, sendToSessionOthers: function () {},
    usersModule: { isMultiUser: function () { return false; } },
    userPresence: null, pushModule: null,
    getSessionForWs: function (ws) { return ws._session || null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return true; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (o) { return o; },
    onProcessingChanged: function () {}, broadcastPresence: function () {},
    adapter: null, getProjectList: function () { return []; },
    getProjectCount: function () { return 0; }, getScheduleCount: function () { return 0; },
  });
  return { tmpHome: tmpHome, sm: sm, handlers: handlers, sent: sent };
}

function cleanup(h) {
  try { fs.rmSync(h.tmpHome, { recursive: true, force: true }); } catch (_) {}
}

// 100+ filler entries, then request, user message, resolution, activity: the
// last-turn start lands on the user message, splitting request from resolution.
function splitHistory(resolution) {
  var history = [];
  for (var i = 0; i < 120; i++) history.push({ type: "delta", text: "x" + i });
  history.push({ type: "permission_request", requestId: "req-1", toolName: "Write", toolInput: { file_path: "/tmp/x" } });
  history.push({ type: "user_message", text: "typed while the card was open" });
  if (resolution) history.push(resolution);
  history.push({ type: "delta", text: "after" });
  return history;
}

function loadSession(h, history, pending) {
  var session = h.sm.createSessionRaw({});
  session.history = history;
  session._historyLoaded = true;
  session._historyBaseIndex = 0;
  session.pendingPermissions = pending || {};
  h.sm.sessions.set(session.localId, session);
  return session;
}

function requestsIn(sent) {
  var out = [];
  sent.forEach(function (m) {
    if (m.type === "permission_request") out.push(m);
    if (m.type === "history_prepend") m.items.forEach(function (it) { if (it.type === "permission_request") out.push(it); });
  });
  return out;
}

test("replay split: the older page carries the request as settled with its decision", function () {
  var h = makeHarness();
  try {
    var history = splitHistory({ type: "permission_resolved", requestId: "req-1", decision: "allow" });
    var session = loadSession(h, history);

    h.sm.replayHistory(session, undefined, {});
    var meta = h.sent.filter(function (m) { return m.type === "history_meta"; })[0];
    assert.equal(requestsIn(h.sent).length, 0, "the request is outside the first page");

    h.handlers.handleSessionsMessage({ _session: session }, { type: "load_more_history", before: meta.from });
    var found = requestsIn(h.sent);
    assert.equal(found.length, 1);
    assert.equal(found[0].requestId, "req-1");
    assert.equal(found[0].settled, true);
    assert.equal(found[0].decision, "allow");
    assert.equal(history[120].settled, undefined, "stored history is not mutated");
  } finally { cleanup(h); }
});

test("replay: a cancelled request is settled without a decision", function () {
  var h = makeHarness();
  try {
    var session = loadSession(h, splitHistory({ type: "permission_cancel", requestId: "req-1" }));
    h.sm.replayHistory(session, undefined, {});
    var meta = h.sent.filter(function (m) { return m.type === "history_meta"; })[0];
    h.handlers.handleSessionsMessage({ _session: session }, { type: "load_more_history", before: meta.from });
    var found = requestsIn(h.sent);
    assert.equal(found[0].settled, true);
    assert.equal(found[0].decision, undefined);
  } finally { cleanup(h); }
});

test("guard: a request still pending on the server is replayed unannotated", function () {
  var h = makeHarness();
  try {
    var session = loadSession(h, splitHistory(null), { "req-1": { resolve: function () {} } });
    h.sm.replayHistory(session, undefined, {});
    var meta = h.sent.filter(function (m) { return m.type === "history_meta"; })[0];
    h.handlers.handleSessionsMessage({ _session: session }, { type: "load_more_history", before: meta.from });
    var found = requestsIn(h.sent);
    assert.equal(found.length, 1);
    assert.equal(found[0].settled, undefined);
  } finally { cleanup(h); }
});
