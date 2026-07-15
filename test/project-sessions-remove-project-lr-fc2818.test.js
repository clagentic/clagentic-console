"use strict";
/**
 * Regression tests for lr-fc2818: "Remove Worktree" silently no-op'd — the
 * worktree stayed on disk while the UI reported success.
 *
 * Root cause: the "remove_project" WS handler in project-sessions.js sent
 * { type: "remove_project_result", ok: true } to the client BEFORE calling
 * opts.onRemoveProject(), and never looked at what onRemoveProject actually
 * returned. Any real failure from onRemoveProject (e.g. daemon.js's
 * removeWorktree() rejecting a dirty/locked worktree, or the parent project
 * no longer being resolvable) was silently discarded — the client was always
 * told "removed" even when nothing was removed from disk.
 *
 * Fix: call opts.onRemoveProject() first (it is synchronous) and forward its
 * actual { ok, error } to the client.
 *
 * These tests drive attachSessions().handleSessionsMessage directly against
 * a minimal stub ctx, asserting the WS response reflects the real result of
 * onRemoveProject in both the success and failure cases, and that
 * onRemoveProject is invoked before the response is sent.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachSessions } = require("../lib/project-sessions");

function makeCtx(overrides) {
  var sent = [];
  var sentTo = [];
  var noop = function () {};

  var ctx = Object.assign({
    cwd: "/tmp/test-fc2818",
    slug: "test-fc2818",
    osUsers: false,
    currentVersion: "0.0.0",
    sm: { sessions: new Map() },
    sdk: null,
    tm: { list: function () { return []; } },
    clients: new Set(),
    send: function (msg) { sent.push(msg); },
    sendTo: function (ws, msg) { sent.push(msg); sentTo.push([ws, msg]); },
    sendToAdmins: noop,
    sendToSession: noop,
    sendToSessionOthers: noop,
    opts: {},
    usersModule: { getEffectivePermissions: function () { return { deleteProject: true }; } },
    userPresence: { setPresence: noop },
    pushModule: null,
    getSessionForWs: function () { return null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: noop,
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (o) { return o; },
    onProcessingChanged: noop,
    broadcastPresence: noop,
    adapter: null,
    getProjectList: function () { return []; },
    getProjectCount: function () { return 0; },
    getScheduleCount: function () { return 0; },
    moveScheduleToProject: noop,
    moveAllSchedulesToProject: noop,
    getHubSchedules: function () { return []; },
    fetchVersion: noop,
    isNewer: function () { return false; },
    onCreateWorktree: null,
    IGNORED_DIRS: new Set(),
    scheduleMessage: noop,
    cancelScheduledMessage: noop,
    getProjectOwnerId: function () { return null; },
    setProjectOwnerId: noop,
    getUpdateChannel: function () { return "stable"; },
    setUpdateChannel: noop,
    getLatestVersion: function () { return "0.0.0"; },
    setLatestVersion: noop,
  }, overrides);

  ctx._sent = sent;
  ctx._sentTo = sentTo;
  return ctx;
}

function makeWs() {
  return { readyState: 1, send: function () {} };
}

test("lr-fc2818: remove_project forwards onRemoveProject's real failure instead of a hardcoded ok:true", function () {
  var onRemoveProjectCalls = [];
  var ctx = makeCtx({
    opts: {
      onRemoveProject: function (slug, userId) {
        onRemoveProjectCalls.push(slug);
        // Simulates daemon.js's onRemoveProject when removeWorktree() fails
        // (e.g. dirty/locked worktree) or the parent project can't be resolved.
        return { ok: false, error: "Worktree has uncommitted changes. Commit or discard them first." };
      },
    },
  });
  var sessions = attachSessions(ctx);
  var ws = makeWs();

  var handled = sessions.handleSessionsMessage(ws, { type: "remove_project", slug: "myproject--feature-x" });
  assert.strictEqual(handled, true);

  assert.deepStrictEqual(onRemoveProjectCalls, ["myproject--feature-x"], "onRemoveProject must be called");

  var result = ctx._sent.find(function (m) { return m.type === "remove_project_result"; });
  assert.ok(result, "expected a remove_project_result message");
  assert.strictEqual(result.ok, false, "a real onRemoveProject failure must be forwarded, not overwritten with ok:true");
  assert.match(result.error, /uncommitted changes/i);
});

test("lr-fc2818: remove_project reports ok:true when onRemoveProject actually succeeds", function () {
  var ctx = makeCtx({
    opts: {
      onRemoveProject: function () { return { ok: true }; },
    },
  });
  var sessions = attachSessions(ctx);
  var ws = makeWs();

  sessions.handleSessionsMessage(ws, { type: "remove_project", slug: "myproject--feature-x" });

  var result = ctx._sent.find(function (m) { return m.type === "remove_project_result"; });
  assert.ok(result);
  assert.strictEqual(result.ok, true);
});

test("lr-fc2818: remove_project calls onRemoveProject before sending the result (not after, with a hardcoded ok:true)", function () {
  var callOrder = [];
  var ctx = makeCtx({
    sendTo: function (ws, msg) {
      if (msg.type === "remove_project_result") callOrder.push("sendResult");
    },
    opts: {
      onRemoveProject: function () {
        callOrder.push("onRemoveProject");
        return { ok: true };
      },
    },
  });
  var sessions = attachSessions(ctx);
  sessions.handleSessionsMessage(makeWs(), { type: "remove_project", slug: "myproject--feature-x" });

  assert.deepStrictEqual(callOrder, ["onRemoveProject", "sendResult"], "onRemoveProject's return value must be known before the WS response is sent");
});
