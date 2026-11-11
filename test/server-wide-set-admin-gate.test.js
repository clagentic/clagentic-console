"use strict";
// Every WebSocket handler that writes a server-wide setting refuses a
// non-admin in multi-user mode, logs the refusal, stores nothing and
// broadcasts nothing. An admin's write works, and in single-user mode the
// authenticated connection (the implicit admin) keeps working.
//
// One row per server-wide set_* handler in lib/project-sessions.js. The
// project-scoped and per-user handlers are out of scope here.

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachSessions } = require("../lib/project-sessions");
var { createProjectAccess } = require("../lib/project-access");

var noop = function () {};

// optName: the daemon callback that stores the value. optReturn: what that
// callback answers. `stored` reads the in-memory copy, when the handler keeps
// one next to the daemon write.
var ROWS = [
  { type: "set_update_channel", msg: { channel: "beta" }, optName: null, ctxStore: "setUpdateChannel" },
  { type: "set_server_default_model", msg: { model: "opus" }, optName: "onSetServerDefaultModel", stored: function (sm) { return sm.currentModel; }, value: "opus" },
  { type: "set_server_default_effort", msg: { effort: "high" }, optName: "onSetServerDefaultEffort", stored: function (sm) { return sm.currentEffort; }, value: "high" },
  { type: "set_server_default_betas", msg: { betas: ["b1"] }, optName: "onSetServerDefaultBetas", stored: function (sm) { return sm.currentBetas; }, value: ["b1"] },
  { type: "set_server_default_mode", msg: { mode: "plan" }, optName: "onSetServerDefaultMode" },
  { type: "set_pin", msg: { pin: "1234" }, optName: "onSetPin", optReturn: { ok: true, pinEnabled: true } },
  { type: "set_keep_awake", msg: { value: true }, optName: "onSetKeepAwake", optReturn: { ok: true, keepAwake: true } },
  { type: "set_auto_continue", msg: { value: true }, optName: "onSetAutoContinue", optReturn: { ok: true, autoContinueOnRateLimit: true } },
  { type: "set_image_retention", msg: { days: 7 }, optName: "onSetImageRetention", optReturn: { ok: true, days: 7 } },
  { type: "set_lite_auto_enroll", msg: { value: true }, optName: "onSetLiteAutoEnroll", optReturn: { ok: true, liteAutoEnroll: true } },
  { type: "set_mem_available_threshold", msg: { value: 512 }, optName: "onSetMemAvailableThreshold", optReturn: { ok: true, memAvailableMinMB: 512 } },
  { type: "set_tokens_per_mb_headroom", msg: { value: 100 }, optName: "onSetTokensPerMbHeadroom", optReturn: { ok: true, tokensPerMbHeadroom: 100 } },
];

function build(row, multiUser) {
  var sent = [];
  var calls = [];
  var sm = {
    sessions: new Map(),
    currentModel: "sonnet",
    _savedDefaultModel: "sonnet",
    currentEffort: "medium",
    currentBetas: [],
    currentPermissionMode: "default",
    _savedDefaultMode: "default",
  };
  var opts = {};
  if (row.optName) {
    opts[row.optName] = function (value) { calls.push(value); return row.optReturn; };
  }
  var ctx = {
    cwd: "/tmp/test-server-wide-gate", slug: "test", osUsers: false, currentVersion: "0.0.0",
    sm: sm,
    sdk: { setPermissionMode: function () { return Promise.resolve(true); }, checkModeFor: function () { return { ok: true }; } },
    tm: { list: function () { return []; } },
    clients: new Set(),
    send: function (m) { sent.push(m); },
    sendTo: function (ws, m) { sent.push(m); },
    sendToAdmins: noop, sendToSession: noop, sendToSessionOthers: noop,
    opts: opts,
    usersModule: { getEffectivePermissions: function () { return {}; } },
    userPresence: { setPresence: noop },
    pushModule: null,
    getSessionForWs: function () { return null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: noop,
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (o) { return o; },
    onProcessingChanged: noop, broadcastPresence: noop,
    adapter: null,
    getProjectList: function () { return []; },
    getProjectCount: function () { return 0; },
    getScheduleCount: function () { return 0; },
    moveScheduleToProject: noop, moveAllSchedulesToProject: noop,
    getHubSchedules: function () { return []; },
    fetchVersion: noop, isNewer: function () { return false; },
    IGNORED_DIRS: new Set(),
    scheduleMessage: noop, cancelScheduledMessage: noop,
    getProjectOwnerId: function () { return null; },
    setProjectOwnerId: noop,
    getUpdateChannel: function () { return "stable"; },
    setUpdateChannel: noop,
    getLatestVersion: function () { return "0.0.0"; },
    setLatestVersion: noop,
    projectAccess: createProjectAccess({
      users: {}, onGetProjectAccess: null, isMultiUser: function () { return multiUser; },
    }),
  };
  if (row.ctxStore) {
    ctx[row.ctxStore] = function (value) { calls.push(value); };
  }
  return { ctx: ctx, sent: sent, calls: calls, sm: sm, handlers: attachSessions(ctx) };
}

function socket(user) {
  return { readyState: 1, send: noop, _clagenticUser: user, _clagenticAuthenticated: true };
}

function withWarnings(fn) {
  var warnings = [];
  var original = console.warn;
  console.warn = function (line) { warnings.push(String(line)); };
  try { fn(warnings); } finally { console.warn = original; }
}

ROWS.forEach(function (row) {
  test(row.type + ": a non-admin is refused in multi-user mode, nothing is stored or broadcast", function () {
    var t = build(row, true);
    withWarnings(function (warnings) {
      t.handlers.handleSessionsMessage(socket({ id: "u1", role: "user" }), Object.assign({ type: row.type }, row.msg));
      assert.equal(warnings.filter(function (w) { return w.indexOf("refused " + row.type) !== -1; }).length, 1, "the refusal is logged");
    });
    assert.deepEqual(t.calls, [], "the daemon write is not made");
    if (row.stored) {
      var untouched = build(row, true);
      assert.deepEqual(row.stored(t.sm), row.stored(untouched.sm), "the in-memory value is unchanged");
    }
    assert.equal(t.sent.length, 1, "only the refusal is sent");
    assert.equal(t.sent[0].type, "error");
  });

  test(row.type + ": an admin's write works in multi-user mode", function () {
    var t = build(row, true);
    t.handlers.handleSessionsMessage(socket({ id: "a1", role: "admin" }), Object.assign({ type: row.type }, row.msg));
    assert.equal(t.calls.length, 1, "the daemon write is made once");
    if (row.stored) assert.deepEqual(row.stored(t.sm), row.value);
    assert.ok(t.sent.every(function (m) { return m.type !== "error"; }), "no refusal is sent");
  });
});

test("single-user mode: the authenticated connection with no user record still writes the server defaults", function () {
  ROWS.filter(function (row) { return row.type === "set_update_channel" || /^set_server_default_/.test(row.type); }).forEach(function (row) {
    var t = build(row, false);
    t.handlers.handleSessionsMessage(socket(null), Object.assign({ type: row.type }, row.msg));
    assert.equal(t.calls.length, 1, row.type);
    assert.ok(t.sent.every(function (m) { return m.type !== "error"; }), row.type + " is not refused");
  });
});
