"use strict";
/**
 * Regression tests for lr-db0437: per-session model choice silently became
 * the de-facto project default for all future sessions, and changing a
 * project/server default silently retargeted whatever session happened to
 * be focused ("reverse bleed").
 *
 * Root causes covered here (see lib/sdk-bridge.js setModel and
 * lib/project-sessions.js new_session / set_project_default_model /
 * set_server_default_model for the full fix + comments):
 *
 *   (a)+(b) new_session used to seed a brand-new session's model from
 *       sm.currentModel — a field also mutated by any OTHER session's
 *       setModel call — so session A picking model X leaked into session B
 *       on creation. Fixed: new_session now seeds from
 *       sm._savedDefaultModel, the actual saved project/global default,
 *       which setModel (session-scoped) never touches.
 *
 *   (c) set_project_default_model / set_server_default_model used to call
 *       sdk.setModel(session, msg.model) on the currently-focused session,
 *       silently changing its live model as a side effect of changing the
 *       default. Fixed: these handlers now only update sm.currentModel /
 *       sm._savedDefaultModel (the default), never session.model.
 *
 * These tests drive attachSessions().handleSessionsMessage directly against
 * a minimal stub ctx/sm/sdk, following the harness pattern established by
 * test/project-sessions-remove-project-lr-fc2818.test.js.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var { attachSessions } = require("../lib/project-sessions");
var { createProjectAccess } = require("../lib/project-access");

function makeSessionManager(overrides) {
  var sessions = new Map();
  return Object.assign({
    sessions: sessions,
    currentModel: null,
    _savedDefaultModel: null,
    currentPermissionMode: "default",
    _savedDefaultMode: "default",
    createSession: function (sessionOpts, targetWs) {
      var localId = sessions.size + 1;
      var session = { localId: localId, model: null, permissionMode: null };
      sessions.set(localId, session);
      return session;
    },
    saveSessionFile: function () {},
  }, overrides);
}

function makeCtx(overrides) {
  var sent = [];
  var sentTo = [];
  var noop = function () {};

  var ctx = Object.assign({
    cwd: "/tmp/test-db0437",
    slug: "test-db0437",
    osUsers: false,
    currentVersion: "0.0.0",
    sm: makeSessionManager(),
    sdk: { setModel: function () { return Promise.resolve(); } },
    tm: { list: function () { return []; } },
    clients: new Set(),
    send: function (msg) { sent.push(msg); },
    sendTo: function (ws, msg) { sent.push(msg); sentTo.push([ws, msg]); },
    sendToAdmins: noop,
    sendToSession: noop,
    sendToSessionOthers: noop,
    opts: {},
    usersModule: { getEffectivePermissions: function () { return {}; } },
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
    // Single-user: an authenticated connection is the implicit admin, which
    // the server-wide default setters ask for.
    projectAccess: createProjectAccess({ users: {}, onGetProjectAccess: null, isMultiUser: function () { return false; } }),
  }, overrides);

  ctx._sent = sent;
  ctx._sentTo = sentTo;
  return ctx;
}

function makeWs() {
  return { readyState: 1, send: function () {}, _clagenticAuthenticated: true };
}

test("lr-db0437: a new session does not inherit another session's live model choice", function () {
  var ctx = makeCtx();
  var sessions = attachSessions(ctx);

  // sm._savedDefaultModel is the real saved default (untouched); sm.currentModel
  // simulates another session having picked "opus" without that becoming the
  // default (this is exactly what setModel now does — see sdk-bridge.js).
  ctx.sm._savedDefaultModel = "sonnet";
  ctx.sm.currentModel = "opus";

  var ws = makeWs();
  sessions.handleSessionsMessage(ws, { type: "new_session" });

  var newSession = ctx.sm.sessions.get(1);
  assert.ok(newSession, "expected a new session to be created");
  assert.strictEqual(newSession.model, "sonnet",
    "new session must seed from the saved project/global default, not from another session's live model choice");
});

test("lr-db0437: set_project_default_model does not mutate the focused session's live model", function () {
  var focusedSession = { localId: 1, model: "sonnet" };
  var ctx = makeCtx({
    getSessionForWs: function () { return focusedSession; },
  });
  var setModelCalls = [];
  ctx.sdk.setModel = function (session, model) {
    setModelCalls.push([session, model]);
    return Promise.resolve();
  };
  ctx.opts.onSetProjectDefaultModel = function (slug, model) {
    ctx.opts._lastProjectDefault = model;
  };

  var sessions = attachSessions(ctx);
  var ws = makeWs();
  sessions.handleSessionsMessage(ws, { type: "set_project_default_model", model: "opus" });

  assert.strictEqual(focusedSession.model, "sonnet",
    "changing the project default must not change the focused session's own model");
  assert.strictEqual(ctx.sm.currentModel, "opus", "the default cache must reflect the new default");
  assert.strictEqual(ctx.sm._savedDefaultModel, "opus", "the saved default must reflect the new default");
  assert.deepStrictEqual(setModelCalls, [], "sdk.setModel must never be called from a default-model handler");

  assert.ok(!ctx._sent.some(function (m) { return m.type === "config_state"; }),
    "a default change sends saved_defaults and never a config_state (which would move other sessions' chips)");
});

test("lr-db0437: set_server_default_model does not mutate the focused session's live model", function () {
  var focusedSession = { localId: 1, model: "haiku" };
  var ctx = makeCtx({
    getSessionForWs: function () { return focusedSession; },
  });
  var setModelCalls = [];
  ctx.sdk.setModel = function (session, model) {
    setModelCalls.push([session, model]);
    return Promise.resolve();
  };

  var sessions = attachSessions(ctx);
  var ws = makeWs();
  sessions.handleSessionsMessage(ws, { type: "set_server_default_model", model: "opus" });

  assert.strictEqual(focusedSession.model, "haiku",
    "changing the server default must not change the focused session's own model");
  assert.strictEqual(ctx.sm.currentModel, "opus");
  assert.strictEqual(ctx.sm._savedDefaultModel, "opus");
  assert.deepStrictEqual(setModelCalls, [], "sdk.setModel must never be called from a default-model handler");
});

// Effort, betas and thinking follow the model's pattern. One row per default
// setter: the default is saved and persisted, no running session moves, and the
// client viewing the session is told the session's own values.
var OWN = { effort: "low", betas: ["own-beta"], thinking: "disabled", thinkingBudget: 2048 };
var DEFAULT_SETTER_ROWS = [
  { type: "set_project_default_effort", msg: { effort: "high" }, optName: "onSetProjectDefaultEffort", saved: { _savedDefaultEffort: "high" } },
  { type: "set_server_default_effort", msg: { effort: "high" }, optName: "onSetServerDefaultEffort", saved: { _savedDefaultEffort: "high" } },
  { type: "set_project_default_betas", msg: { betas: ["b-default"] }, optName: "onSetProjectDefaultBetas", saved: { _savedDefaultBetas: ["b-default"] } },
  { type: "set_server_default_betas", msg: { betas: ["b-default"] }, optName: "onSetServerDefaultBetas", saved: { _savedDefaultBetas: ["b-default"] } },
  { type: "set_project_default_thinking", msg: { thinking: "budget", budgetTokens: 4096 }, optName: "onSetProjectDefaultThinking", saved: { _savedDefaultThinking: "budget", _savedDefaultThinkingBudget: 4096 } },
  { type: "set_server_default_thinking", msg: { thinking: "budget", budgetTokens: 4096 }, optName: "onSetServerDefaultThinking", saved: { _savedDefaultThinking: "budget", _savedDefaultThinkingBudget: 4096 } },
  // The Codex defaults are saved for new sessions and tell the viewing client
  // nothing about its session (codex: no config_state, no codex_config).
  { type: "set_project_default_codex_approval", msg: { approval: "never" }, optName: "onSetProjectDefaultCodex", saved: { _savedDefaultCodexApproval: "never" }, codex: true },
  { type: "set_project_default_codex_sandbox", msg: { sandbox: "danger-full-access" }, optName: "onSetProjectDefaultCodex", saved: { _savedDefaultCodexSandbox: "danger-full-access" }, codex: true },
  { type: "set_project_default_codex_websearch", msg: { webSearch: "disabled" }, optName: "onSetProjectDefaultCodex", saved: { _savedDefaultCodexWebSearch: "disabled" }, codex: true },
  { type: "set_server_default_codex_approval", msg: { approval: "never" }, optName: "onSetServerDefaultCodex", saved: { _savedDefaultCodexApproval: "never" }, codex: true },
  { type: "set_server_default_codex_sandbox", msg: { sandbox: "danger-full-access" }, optName: "onSetServerDefaultCodex", saved: { _savedDefaultCodexSandbox: "danger-full-access" }, codex: true },
  { type: "set_server_default_codex_websearch", msg: { webSearch: "disabled" }, optName: "onSetServerDefaultCodex", saved: { _savedDefaultCodexWebSearch: "disabled" }, codex: true },
  // A value outside the allowed ones (or not a string) is answered with an error
  // to the requester alone and is neither saved nor persisted (refused: true).
  { type: "set_project_default_codex_approval", msg: { approval: "yolo" }, optName: "onSetProjectDefaultCodex", saved: { _savedDefaultCodexApproval: undefined }, codex: true, refused: true },
  { type: "set_server_default_codex_sandbox", msg: { sandbox: "everything" }, optName: "onSetServerDefaultCodex", saved: { _savedDefaultCodexSandbox: undefined }, codex: true, refused: true },
  { type: "set_project_default_codex_websearch", msg: { webSearch: 7 }, optName: "onSetProjectDefaultCodex", saved: { _savedDefaultCodexWebSearch: undefined }, codex: true, refused: true },
  { type: "set_server_default_codex_approval", msg: { approval: "on-failure" }, optName: "onSetServerDefaultCodex", saved: { _savedDefaultCodexApproval: undefined }, codex: true, refused: true },
];

var OWN_CODEX = { codexApproval: "on-request", codexSandbox: "read-only", codexWebSearch: "live" };

DEFAULT_SETTER_ROWS.forEach(function (row) {
  test(row.type + " saves the default and moves no running session", function () {
    var focused = Object.assign({ localId: 1 }, OWN, OWN_CODEX, { betas: OWN.betas.slice() });
    var viewer = makeWs();
    var ctx = makeCtx({ getSessionForWs: function () { return focused; }, clients: new Set([viewer]) });
    var stored = [];
    ctx.opts[row.optName] = function () { stored.push(Array.prototype.slice.call(arguments)); };

    var requester = makeWs();
    var warn = console.warn;
    console.warn = function () {};
    try {
      attachSessions(ctx).handleSessionsMessage(requester, Object.assign({ type: row.type }, row.msg));
    } finally {
      console.warn = warn;
    }

    if (row.refused) {
      assert.strictEqual(stored.length, 0, "a refused value is not persisted");
      assert.strictEqual(ctx._sent.length, 1, "and only the requester is answered");
      assert.strictEqual(ctx._sentTo[0][0], requester);
      assert.strictEqual(ctx._sentTo[0][1].type, "error");
    }
    assert.deepStrictEqual({ effort: focused.effort, betas: focused.betas, thinking: focused.thinking, thinkingBudget: focused.thinkingBudget }, OWN,
      "the running session keeps its own values");
    Object.keys(row.saved).forEach(function (field) {
      assert.deepStrictEqual(ctx.sm[field], row.saved[field], field + " holds the new default");
    });
    var kept = { codexApproval: focused.codexApproval, codexSandbox: focused.codexSandbox, codexWebSearch: focused.codexWebSearch };
    assert.deepStrictEqual(kept, OWN_CODEX, "the running session keeps its own Codex values");
    if (row.refused) return;
    assert.strictEqual(stored.length, 1, "the default is persisted through the store callback");
    if (row.codex) {
      var everything = ctx._sent.map(function (m) { return m.type; });
      assert.ok(everything.indexOf("saved_defaults") !== -1, "the Settings pickers are told through saved_defaults");
      assert.deepStrictEqual(everything.filter(function (t) { return t === "config_state" || t === "codex_config"; }), [], "no session's config is pushed");
      return;
    }
    var told = ctx._sentTo.map(function (pair) { return pair[1]; }).filter(function (m) { return m.type === "config_state"; });
    assert.strictEqual(told.length, 1, "the viewing client is told once");
    assert.strictEqual(told[0].effort, OWN.effort, "with the session's own effort, not the default");
    assert.deepStrictEqual(told[0].betas, OWN.betas);
    assert.strictEqual(told[0].thinking, OWN.thinking);
    assert.strictEqual(told[0].thinkingBudget, OWN.thinkingBudget);
  });
});

// A session's pick (set_*) writes that session only and replies to that
// session's clients; no shared field exists to carry it.
[
  // told: how many config_state sends to a session's clients the handler makes
  // itself (set_effort announces through the bridge, not here).
  { type: "set_effort", msg: { effort: "high" }, field: "effort", expect: "high", told: 0 },
  { type: "set_betas", msg: { betas: ["context-beta"] }, field: "betas", expect: ["context-beta"], told: 1 },
  { type: "set_thinking", msg: { thinking: "budget", budgetTokens: 8192 }, field: "thinking", expect: "budget", told: 1, budget: 8192 },
  // The Codex picks are saved with the session (codex: the one send is a
  // codex_config carrying the pick) and written to no other session.
  { type: "set_codex_approval", msg: { approval: "never" }, field: "codexApproval", expect: "never", told: 1, codex: { approval: "never", sandbox: "workspace-write", webSearch: "live" } },
  { type: "set_codex_sandbox", msg: { sandbox: "danger-full-access" }, field: "codexSandbox", expect: "danger-full-access", told: 1, codex: { approval: "on-request", sandbox: "danger-full-access", webSearch: "live" } },
  { type: "set_codex_websearch", msg: { webSearch: "disabled" }, field: "codexWebSearch", expect: "disabled", told: 1, codex: { approval: "on-request", sandbox: "workspace-write", webSearch: "disabled" } },
  // noSession: with no session viewed a pick has nothing to set; the requester
  // alone is sent the saved-default config (the sandbox default is
  // "danger-full-access" here) and nothing is saved.
  { type: "set_codex_approval", msg: { approval: "never" }, noSession: { approval: "on-request", sandbox: "danger-full-access", webSearch: "live" } },
  { type: "set_codex_sandbox", msg: { sandbox: "read-only" }, noSession: { approval: "on-request", sandbox: "danger-full-access", webSearch: "live" } },
  { type: "set_codex_websearch", msg: { webSearch: "cached" }, noSession: { approval: "on-request", sandbox: "danger-full-access", webSearch: "live" } },
  // refused: a value outside the allowed ones is answered with an error and the
  // session's own config, to the requester alone, and is not saved.
  { type: "set_codex_approval", msg: { approval: "yolo" }, field: "codexApproval", expect: undefined, refused: { approval: "on-request", sandbox: "workspace-write", webSearch: "live" } },
  { type: "set_codex_sandbox", msg: { sandbox: "everything" }, field: "codexSandbox", expect: undefined, refused: { approval: "on-request", sandbox: "workspace-write", webSearch: "live" } },
  { type: "set_codex_websearch", msg: { webSearch: ["live"] }, field: "codexWebSearch", expect: undefined, refused: { approval: "on-request", sandbox: "workspace-write", webSearch: "live" } },
].forEach(function (row) {
  test(row.type + " " + (row.noSession ? "with no session viewed answers the requester with the saved defaults" : row.refused ? "refuses " + JSON.stringify(row.msg) : "writes the viewed session only"), function () {
    var viewed = row.noSession ? null : { localId: 1 };
    var other = { localId: 2, effort: "low", betas: [], thinking: "adaptive", codexApproval: "untrusted", codexSandbox: "read-only", codexWebSearch: "cached" };
    var told = [];
    var savedSessions = [];
    var ctx = makeCtx({
      getSessionForWs: function () { return viewed; },
      sdk: { setEffort: function (session, effort) { session.effort = effort; return Promise.resolve({ ok: true }); } },
      sendToSession: function (id, msg) { told.push([id, msg]); },
    });
    ctx.sm.saveSessionFile = function (s) { savedSessions.push(s.localId); };
    if (viewed) ctx.sm.sessions.set(1, viewed);
    ctx.sm.sessions.set(2, other);
    if (row.noSession) ctx.sm._savedDefaultCodexSandbox = "danger-full-access";
    var requester = makeWs();
    var warn = console.warn;
    console.warn = function () {};
    try {
      attachSessions(ctx).handleSessionsMessage(requester, Object.assign({ type: row.type }, row.msg));
    } finally {
      console.warn = warn;
    }

    if (row.noSession) {
      var answered = ctx._sentTo.map(function (pair) { return pair[1]; });
      assert.deepStrictEqual(answered, [Object.assign({ type: "codex_config" }, row.noSession)]);
      assert.deepStrictEqual(savedSessions, [], "nothing is saved");
      assert.strictEqual(ctx._sent.length, 1, "and no other client is told");
      return Promise.resolve();
    }
    if (row.refused) {
      assert.deepStrictEqual(ctx._sentTo.map(function (pair) { return pair[0]; }), [requester, requester], "the requester alone is answered");
      assert.strictEqual(ctx._sentTo[0][1].type, "error");
      assert.deepStrictEqual(ctx._sentTo[1][1], Object.assign({ type: "codex_config" }, row.refused), "with the config its session still runs");
      assert.deepStrictEqual(savedSessions, [], "nothing is saved");
      assert.deepStrictEqual(told, [], "no session's clients are told");
      assert.strictEqual(viewed[row.field], undefined, "the viewed session is unchanged");
      return Promise.resolve();
    }

    return Promise.resolve().then(function () {
      assert.deepStrictEqual({ a: other.codexApproval, s: other.codexSandbox, w: other.codexWebSearch }, { a: "untrusted", s: "read-only", w: "cached" }, "another session's Codex values are untouched");
      ["_savedDefaultCodexApproval", "_savedDefaultCodexSandbox", "_savedDefaultCodexWebSearch"].forEach(function (name) {
        assert.strictEqual(ctx.sm[name], undefined, name + " (the saved default) is not written by a session pick");
      });
      if (row.codex) {
        assert.deepStrictEqual(savedSessions, [1], "the pick is saved with the session (its meta line)");
        var pushed = told[0][1];
        assert.strictEqual(pushed.type, "codex_config");
        assert.deepStrictEqual({ approval: pushed.approval, sandbox: pushed.sandbox, webSearch: pushed.webSearch }, row.codex);
        assert.strictEqual(ctx._sent.filter(function (m) { return m.type === "codex_config"; }).length, 0, "no broadcast to every client");
      }
      assert.deepStrictEqual(viewed[row.field], row.expect, "the viewed session holds the pick");
      assert.strictEqual(viewed.thinkingBudget, row.budget, "the viewed session holds the pick's token budget");
      assert.strictEqual(other.thinkingBudget, undefined, "another session's budget is untouched");
      assert.deepStrictEqual({ effort: other.effort, betas: other.betas, thinking: other.thinking }, { effort: "low", betas: [], thinking: "adaptive" },
        "another session is untouched");
      ["_savedDefaultEffort", "_savedDefaultBetas", "_savedDefaultThinking"].forEach(function (name) {
        assert.strictEqual(ctx.sm[name], undefined, name + " (the saved default) is not written by a session pick");
      });
      assert.strictEqual(told.length, row.told, "the expected number of sends to the session's clients");
      told.forEach(function (pair) { assert.strictEqual(pair[0], 1, "only the viewed session's clients are told"); });
    });
  });
});

// A client that switches to a session is sent that session's Codex values (its
// own, else the saved defaults), never another session's.
[
  { name: "a session with its own values", id: 2, expect: { approval: "never", sandbox: "read-only", webSearch: "cached" } },
  { name: "a session with none takes the saved defaults", id: 3, expect: { approval: "on-request", sandbox: "danger-full-access", webSearch: "live" } },
].forEach(function (row) {
  test("switch_session sends codex_config: " + row.name, function () {
    var ctx = makeCtx();
    ctx.sm._savedDefaultCodexSandbox = "danger-full-access";
    ctx.sm.switchSession = function () {};
    ctx.sm.sessions.set(1, { localId: 1, codexApproval: "untrusted", codexSandbox: "workspace-write", codexWebSearch: "disabled" });
    ctx.sm.sessions.set(2, { localId: 2, codexApproval: "never", codexSandbox: "read-only", codexWebSearch: "cached" });
    ctx.sm.sessions.set(3, { localId: 3 });
    attachSessions(ctx).handleSessionsMessage(makeWs(), { type: "switch_session", id: row.id });
    var pushed = ctx._sentTo.map(function (pair) { return pair[1]; }).filter(function (m) { return m.type === "codex_config"; });
    assert.strictEqual(pushed.length, 1);
    assert.deepStrictEqual({ approval: pushed[0].approval, sandbox: pushed[0].sandbox, webSearch: pushed[0].webSearch }, row.expect);
  });
});

// The session prompt-expiry setter has the same admin gate as the global one.
[
  { name: "an admin sets it", multiUser: false, user: null, msg: { promptExpiryMinutes: 5 }, expect: 5, refused: false },
  { name: "null clears it", multiUser: false, user: null, msg: { promptExpiryMinutes: null }, expect: undefined, refused: false, preset: 7 },
  { name: "a malformed value is refused", multiUser: false, user: null, msg: { promptExpiryMinutes: -1 }, expect: undefined, refused: true },
  { name: "a non-admin is refused", multiUser: true, user: { id: "u1", role: "user" }, msg: { promptExpiryMinutes: 5 }, expect: undefined, refused: true },
].forEach(function (row) {
  test("set_session_prompt_expiry: " + row.name, function () {
    var session = { localId: 1 };
    if (row.preset !== undefined) session.promptExpiryMinutes = row.preset;
    var saved = 0;
    var ctx = makeCtx({
      getSessionForWs: function () { return session; },
      projectAccess: createProjectAccess({ users: {}, onGetProjectAccess: null, isMultiUser: function () { return row.multiUser; } }),
    });
    ctx.sm.saveSessionFile = function () { saved++; };
    var ws = makeWs();
    ws._clagenticUser = row.user;
    var warn = console.warn;
    console.warn = function () {};
    try {
      attachSessions(ctx).handleSessionsMessage(ws, Object.assign({ type: "set_session_prompt_expiry" }, row.msg));
    } finally {
      console.warn = warn;
    }
    assert.strictEqual(session.promptExpiryMinutes, row.expect);
    assert.strictEqual(saved, row.refused ? 0 : 1, "saved with the session only when accepted");
    assert.strictEqual(ctx._sent.some(function (m) { return m.type === "error"; }), row.refused);
  });
});

// What a project reads at its next start is what the default setters stored:
// the project's own default, else the server's. The stores here keep the value
// the way the daemon's callbacks do (one slot per level).
test("the Thinking, effort and betas defaults set in Settings are what project start reads back", function () {
  var { readSavedDefaults } = require("../lib/session-settings");
  var server = {};
  var project = {};
  var ctx = makeCtx();
  Object.assign(ctx.opts, {
    onSetServerDefaultThinking: function (thinking, budget) { server.thinking = { thinking: thinking, thinkingBudget: budget }; },
    onGetServerDefaultThinking: function () { return server.thinking || { thinking: null, thinkingBudget: null }; },
    onSetProjectDefaultThinking: function (slug, thinking, budget) { project.thinking = { thinking: thinking, thinkingBudget: budget }; },
    onGetProjectDefaultThinking: function () { return project.thinking || { thinking: null, thinkingBudget: null }; },
    onSetServerDefaultBetas: function (betas) { server.betas = { betas: betas }; },
    onGetServerDefaultBetas: function () { return server.betas || { betas: [] }; },
    onSetProjectDefaultBetas: function (slug, betas) { project.betas = { betas: betas }; },
    onGetProjectDefaultBetas: function () { return project.betas || { betas: [] }; },
    onSetServerDefaultEffort: function (effort) { server.effort = { effort: effort }; },
    onGetServerDefaultEffort: function () { return server.effort || { effort: null }; },
  });
  var handlers = attachSessions(ctx);
  var ws = makeWs();

  assert.deepStrictEqual(readSavedDefaults(ctx.opts, "test-db0437"), { effort: "medium", betas: [], thinking: null, thinkingBudget: null },
    "nothing saved: the fallbacks");

  handlers.handleSessionsMessage(ws, { type: "set_server_default_thinking", thinking: "budget", budgetTokens: 4096 });
  handlers.handleSessionsMessage(ws, { type: "set_server_default_betas", betas: ["server-beta"] });
  handlers.handleSessionsMessage(ws, { type: "set_server_default_effort", effort: "high" });
  assert.deepStrictEqual(readSavedDefaults(ctx.opts, "test-db0437"), { effort: "high", betas: ["server-beta"], thinking: "budget", thinkingBudget: 4096 },
    "a restart shows the Thinking default set before, like the betas and effort defaults");

  handlers.handleSessionsMessage(ws, { type: "set_project_default_thinking", thinking: "disabled" });
  handlers.handleSessionsMessage(ws, { type: "set_project_default_betas", betas: [] });
  var read = readSavedDefaults(ctx.opts, "test-db0437");
  assert.strictEqual(read.thinking, "disabled", "the project's default outranks the server's");
  assert.strictEqual(read.thinkingBudget, null, "the budget comes from the same level as the mode");
  assert.deepStrictEqual(read.betas, ["server-beta"], "an empty project list is not a default and does not mask the server's");
  assert.strictEqual(ctx.sm._savedDefaultThinking, "disabled", "and the running project holds the same");
});

// The Settings pickers show the saved defaults, so the server sends them: a
// default change tells every client the saved server and project defaults, each
// from its own store, and never a session's values.
function defaultsStores(opts) {
  var server = {};
  var project = {};
  opts.onGetServerDefaultEffort = function () { return { effort: server.effort || null }; };
  opts.onSetServerDefaultEffort = function (v) { server.effort = v; };
  opts.onGetProjectDefaultEffort = function () { return { effort: project.effort || null }; };
  opts.onSetProjectDefaultEffort = function (slug, v) { project.effort = v; };
  opts.onGetServerDefaultBetas = function () { return { betas: server.betas || [] }; };
  opts.onSetServerDefaultBetas = function (v) { server.betas = v; };
  opts.onGetProjectDefaultBetas = function () { return { betas: project.betas || [] }; };
  opts.onSetProjectDefaultBetas = function (slug, v) { project.betas = v; };
  opts.onGetServerDefaultThinking = function () { return { thinking: server.thinking || null, thinkingBudget: server.thinkingBudget || null }; };
  opts.onSetServerDefaultThinking = function (v, b) { server.thinking = v; server.thinkingBudget = b; };
  opts.onGetProjectDefaultThinking = function () { return { thinking: project.thinking || null, thinkingBudget: project.thinkingBudget || null }; };
  opts.onSetProjectDefaultThinking = function (slug, v, b) { project.thinking = v; project.thinkingBudget = b; };
  // The Codex defaults of a project are kept per slug, as its mode default is.
  var projectCodex = {};
  var serverCodex = {};
  opts.onGetServerDefaultCodex = function () { return Object.assign({ approval: null, sandbox: null, webSearch: null }, serverCodex); };
  opts.onSetServerDefaultCodex = function (field, v) { if (v) serverCodex[field] = v; else delete serverCodex[field]; };
  opts.onGetProjectDefaultCodex = function (slug) { return Object.assign({ approval: null, sandbox: null, webSearch: null }, projectCodex[slug]); };
  opts.onSetProjectDefaultCodex = function (slug, field, v) {
    projectCodex[slug] = projectCodex[slug] || {};
    if (v) projectCodex[slug][field] = v; else delete projectCodex[slug][field];
  };
  opts.onGetServerDefaultModel = function () { return { model: server.model || null }; };
  opts.onSetServerDefaultModel = function (v) { server.model = v; };
  opts.onGetProjectDefaultModel = function () { return { model: project.model || null }; };
  opts.onSetProjectDefaultModel = function (slug, v) { project.model = v; };
  // The mode default of a project is kept per slug, so one project can hold its
  // own while another does not.
  var projectModes = {};
  opts.onGetServerDefaultMode = function () { return { mode: server.mode || null }; };
  opts.onSetServerDefaultMode = function (v) { server.mode = v; };
  opts.onGetProjectDefaultMode = function (slug) { return { mode: projectModes[slug] || null }; };
  opts.onSetProjectDefaultMode = function (slug, v) { projectModes[slug] = v; };
}

var SAVED_DEFAULT_ROWS = [
  { type: "set_server_default_model", msg: { model: "opus" }, level: "server", expect: { model: "opus" } },
  { type: "set_project_default_model", msg: { model: "opus" }, level: "project", expect: { model: "opus" } },
  { type: "set_server_default_effort", msg: { effort: "high" }, level: "server", expect: { effort: "high" } },
  { type: "set_project_default_effort", msg: { effort: "high" }, level: "project", expect: { effort: "high" } },
  { type: "set_server_default_betas", msg: { betas: ["b-default"] }, level: "server", expect: { betas: ["b-default"] } },
  { type: "set_project_default_betas", msg: { betas: ["b-default"] }, level: "project", expect: { betas: ["b-default"] } },
  { type: "set_server_default_thinking", msg: { thinking: "budget", budgetTokens: 4096 }, level: "server", expect: { thinking: "budget", thinkingBudget: 4096 } },
  { type: "set_project_default_thinking", msg: { thinking: "budget", budgetTokens: 4096 }, level: "project", expect: { thinking: "budget", thinkingBudget: 4096 } },
  { type: "set_server_default_codex_approval", msg: { approval: "never" }, level: "server", expect: { codexApproval: "never" } },
  { type: "set_project_default_codex_approval", msg: { approval: "never" }, level: "project", expect: { codexApproval: "never" } },
  { type: "set_server_default_codex_sandbox", msg: { sandbox: "read-only" }, level: "server", expect: { codexSandbox: "read-only" } },
  { type: "set_project_default_codex_sandbox", msg: { sandbox: "read-only" }, level: "project", expect: { codexSandbox: "read-only" } },
  { type: "set_server_default_codex_websearch", msg: { webSearch: "cached" }, level: "server", expect: { codexWebSearch: "cached" } },
  { type: "set_project_default_codex_websearch", msg: { webSearch: "cached" }, level: "project", expect: { codexWebSearch: "cached" } },
];

SAVED_DEFAULT_ROWS.forEach(function (row) {
  test(row.type + " tells every client the saved " + row.level + " defaults, not the session's", function () {
    var focused = Object.assign({ localId: 1, model: "haiku" }, OWN, { betas: OWN.betas.slice() });
    var ctx = makeCtx({ getSessionForWs: function () { return focused; } });
    defaultsStores(ctx.opts);

    attachSessions(ctx).handleSessionsMessage(makeWs(), Object.assign({ type: row.type }, row.msg));

    var told = ctx._sent.filter(function (m) { return m.type === "saved_defaults"; });
    assert.strictEqual(told.length, 1, "one saved_defaults broadcast");
    var other = row.level === "server" ? "project" : "server";
    Object.keys(row.expect).forEach(function (field) {
      assert.deepStrictEqual(told[0][row.level][field], row.expect[field], field + " is the value just saved");
    });
    assert.deepStrictEqual(told[0][other], { codexApproval: null, codexSandbox: null, codexWebSearch: null, model: null, mode: null, effort: null, betas: [], thinking: null, thinkingBudget: null },
      "the other level is as stored: nothing");
    assert.notStrictEqual(told[0][row.level].effort, OWN.effort, "never the viewed session's effort");
  });
});

// A server default is server-wide, so a change made in one project reaches the
// others: a session made in another project afterwards starts from the new
// value, and that project's clients are told it. Two projects share one set of
// stores, as the daemon's callbacks do; the second holds a real session manager.
function freshSessionManager(slug) {
  var fs = require("fs");
  var os = require("os");
  var path = require("path");
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-defaults-"));
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) { delete require.cache[require.resolve(m)]; });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = home;
  try {
    return require("../lib/sessions").createSessionManager({ cwd: home, slug: slug, send: function () {}, sendTo: function () {}, sendEach: function () {} });
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
}

function twoProjects() {
  var shared = {};
  defaultsStores(shared);
  var handlers = new Map();
  shared.onServerDefaultsChanged = function (exceptSlug) {
    handlers.forEach(function (h, slug) {
      if (slug !== exceptSlug && typeof h.refreshServerDefaults === "function") h.refreshServerDefaults();
    });
  };
  var { readSavedDefaults } = require("../lib/session-settings");
  var smB = freshSessionManager("b");
  var viewerB = makeWs();
  var ctxA = makeCtx({ slug: "a", opts: shared });
  var ctxB = makeCtx({ slug: "b", sm: smB, opts: shared, clients: new Set([viewerB]) });
  // What each project loaded at startup.
  [[ctxA.sm, "a"], [smB, "b"]].forEach(function (pair) {
    var d = readSavedDefaults(shared, pair[1]);
    pair[0]._savedDefaultEffort = d.effort;
    pair[0]._savedDefaultBetas = d.betas;
    pair[0]._savedDefaultThinking = d.thinking;
    pair[0]._savedDefaultThinkingBudget = d.thinkingBudget;
    pair[0]._savedDefaultMode = "default";
    pair[0].currentPermissionMode = "default";
  });
  handlers.set("a", attachSessions(ctxA));
  handlers.set("b", attachSessions(ctxB));
  return { a: ctxA, b: ctxB, smB: smB, handlersA: handlers.get("a"), handlersB: handlers.get("b"), viewerB: viewerB };
}

[
  { type: "set_server_default_effort", msg: { effort: "high" }, seeded: { effort: "high" } },
  { type: "set_server_default_betas", msg: { betas: ["b-default"] }, seeded: { betas: ["b-default"] } },
  { type: "set_server_default_thinking", msg: { thinking: "budget", budgetTokens: 4096 }, seeded: { thinking: "budget", thinkingBudget: 4096 } },
  { type: "set_server_default_model", msg: { model: "opus" }, seeded: { model: "opus" } },
  { type: "set_server_default_codex_approval", msg: { approval: "never" }, seeded: { codexApproval: "never" }, running: true },
  { type: "set_server_default_codex_sandbox", msg: { sandbox: "danger-full-access" }, seeded: { codexSandbox: "danger-full-access" }, running: true },
  { type: "set_server_default_codex_websearch", msg: { webSearch: "disabled" }, seeded: { codexWebSearch: "disabled" }, running: true },
].forEach(function (row) {
  test(row.type + " in one project: a new session in another starts from it and its clients are told", function () {
    var w = twoProjects();
    // A running session in the other project (and one in the changing project)
    // keeps its own Codex values (rows with `running`).
    var runningB = row.running ? w.smB.createSession({}) : null;
    var runningA = row.running ? w.a.sm.createSession({}) : null;
    var ownCodex = { codexApproval: "on-request", codexSandbox: "read-only", codexWebSearch: "live" };
    if (runningB) { Object.assign(runningB, ownCodex); Object.assign(runningA, ownCodex); }
    w.handlersA.handleSessionsMessage(makeWs(), Object.assign({ type: row.type }, row.msg));
    if (runningB) {
      [runningA, runningB].forEach(function (s) {
        assert.deepStrictEqual({ codexApproval: s.codexApproval, codexSandbox: s.codexSandbox, codexWebSearch: s.codexWebSearch }, ownCodex,
          "no running session's Codex values change");
      });
    }

    w.handlersB.handleSessionsMessage(w.viewerB, { type: "new_session" });
    var created = Array.from(w.smB.sessions.values()).pop();
    Object.keys(row.seeded).forEach(function (field) {
      assert.deepStrictEqual(created[field], row.seeded[field], "the new session in the other project holds the new " + field);
    });
    var told = w.b._sent.concat(w.b._sentTo.map(function (pair) { return pair[1]; })).filter(function (m) { return m.type === "saved_defaults"; });
    assert.strictEqual(told.length, 1, "the other project's clients are told once");
    Object.keys(row.seeded).forEach(function (field) {
      assert.deepStrictEqual(told[0].server[field], row.seeded[field], field + " in the saved server defaults");
    });
  });
});

// A server default changed in the project that has its own default for the same
// setting does not replace it: a new session there still gets the project's.
// Each row runs its steps in project "a", then a new session is made there.
[
  {
    name: "set_server_default_model in a project with its own model default: a new session gets the project's",
    steps: [
      { type: "set_project_default_model", model: "sonnet" },
      { type: "set_server_default_model", model: "opus" },
    ],
    field: "model", expect: "sonnet", currentModel: "sonnet",
  },
  {
    name: "set_server_default_model in a project with no model default of its own: a new session gets the server's",
    steps: [{ type: "set_server_default_model", model: "opus" }],
    field: "model", expect: "opus",
  },
  {
    name: "a cleared project Thinking default: a new session takes the server's",
    steps: [
      { type: "set_server_default_thinking", thinking: "budget", budgetTokens: 4096 },
      { type: "set_project_default_thinking", thinking: "disabled" },
      { type: "set_project_default_thinking", thinking: null },
    ],
    field: "thinking", expect: "budget", project: "b",
  },
  {
    name: "set_server_default_codex_sandbox in a project with its own Codex default: a new session gets the project's",
    steps: [
      { type: "set_project_default_codex_sandbox", sandbox: "read-only" },
      { type: "set_server_default_codex_sandbox", sandbox: "danger-full-access" },
    ],
    field: "codexSandbox", expect: "read-only", project: "b",
  },
  {
    name: "a cleared project Codex default: a new session takes the server's",
    steps: [
      { type: "set_server_default_codex_approval", approval: "never" },
      { type: "set_project_default_codex_approval", approval: "untrusted" },
      { type: "set_project_default_codex_approval", approval: "" },
    ],
    field: "codexApproval", expect: "never", project: "b",
  },
  {
    name: "a cleared server Codex default: a new session takes the built-in one (none seeded)",
    steps: [
      { type: "set_server_default_codex_sandbox", sandbox: "read-only" },
      { type: "set_server_default_codex_sandbox", sandbox: "" },
    ],
    field: "codexSandbox", expect: undefined, project: "b",
  },
  {
    name: "a refused server Codex value is not saved: a new session takes the previous default",
    steps: [
      { type: "set_server_default_codex_websearch", webSearch: "cached" },
      { type: "set_server_default_codex_websearch", webSearch: "bing" },
    ],
    field: "codexWebSearch", expect: "cached", project: "b",
  },
  {
    name: "a refused project Codex value is not saved: a new session takes the previous default",
    steps: [
      { type: "set_project_default_codex_approval", approval: "never" },
      { type: "set_project_default_codex_approval", approval: "yolo" },
    ],
    field: "codexApproval", expect: "never", project: "b",
  },
  {
    name: "a Codex default read back from the store that is not an allowed value is not seeded",
    steps: [{ storedCodex: { key: "sandbox", value: "everything" } }],
    field: "codexSandbox", expect: undefined, project: "b",
  },
].forEach(function (row) {
  test(row.name, function () {
    var w = twoProjects();
    // Project "b" holds a real session manager, which seeds a new session's
    // effort, betas and thinking from its saved defaults; "a" is a stub.
    var handlers = row.project === "b" ? w.handlersB : w.handlersA;
    var sm = row.project === "b" ? w.smB : w.a.sm;
    var warn = console.warn;
    console.warn = function () {};
    try {
      row.steps.forEach(function (step) {
        if (step.storedCodex) {
          // A raw value in the server store, as a hand edit of daemon.json leaves it.
          w.a.opts.onSetServerDefaultCodex(step.storedCodex.key, step.storedCodex.value);
          w.handlersB.refreshServerDefaults();
        } else {
          handlers.handleSessionsMessage(makeWs(), step);
        }
      });
    } finally {
      console.warn = warn;
    }
    handlers.handleSessionsMessage(makeWs(), { type: "new_session" });
    var created = Array.from(sm.sessions.values()).pop();
    assert.strictEqual(created[row.field], row.expect);
    if (row.currentModel) assert.strictEqual(sm.currentModel, row.currentModel, "the fallback the bridge reads is still the project's default");
  });
});

// The permission mode default is server-wide too: a change made in "a" reaches
// "b", unless "b" has its own, and "a" keeps its own over the server's. Each row
// runs its steps, then makes a new session in "b" and reads what "a" would start
// new sessions in (its stub session manager does not seed a mode itself).
// Step shapes: { on: "a"|"b", msg } sends a message to that project; { stored }
// writes a raw value into the server store (as a hand edit would) and reloads
// "b". Optional row fields: running (a session "b" holds, with its own mode, that
// must keep it), told (what "b"'s clients must be sent), warn (a start warning
// that must be logged for "b").
[
  { name: "a project with no mode default of its own starts new sessions in the new server mode, and its clients are told",
    steps: [{ on: "a", msg: { type: "set_server_default_mode", mode: "plan" } }],
    expectB: "plan", expectA: "plan", told: { server: "plan", project: null } },
  { name: "a running session in another project keeps its mode (no applyToRunning)",
    running: "acceptEdits",
    steps: [{ on: "a", msg: { type: "set_server_default_mode", mode: "plan" } }],
    expectB: "plan", expectA: "plan", expectRunning: "acceptEdits" },
  { name: "a running session in another project keeps its mode (applyToRunning in the changing project)",
    running: "acceptEdits",
    steps: [{ on: "a", msg: { type: "set_server_default_mode", mode: "plan", applyToRunning: true } }],
    expectB: "plan", expectA: "plan", expectRunning: "acceptEdits" },
  { name: "a saved server mode that fails the check loads as default, with the start warning",
    steps: [{ stored: "bypassPermissions" }],
    expectB: "default", expectA: "default", warn: /saved default permission mode .*refused in b/ },
  { name: "a project with its own mode default keeps it when another project changes the server mode",
    steps: [{ on: "b", msg: { type: "set_project_default_mode", mode: "acceptEdits" } },
      { on: "a", msg: { type: "set_server_default_mode", mode: "plan" } }],
    expectB: "acceptEdits", expectA: "plan" },
  { name: "the project that changes the server mode keeps its own mode default",
    steps: [{ on: "a", msg: { type: "set_project_default_mode", mode: "acceptEdits" } },
      { on: "a", msg: { type: "set_server_default_mode", mode: "plan" } }],
    expectB: "plan", expectA: "acceptEdits" },
  { name: "a project default mode change stays in its project",
    steps: [{ on: "a", msg: { type: "set_project_default_mode", mode: "plan" } }],
    expectB: "default", expectA: "plan" },
].forEach(function (row) {
  test("mode default: " + row.name, function () {
    var w = twoProjects();
    var running = row.running ? w.smB.createSession({ permissionMode: row.running }) : null;
    var warned = [];
    var origWarn = console.warn;
    console.warn = function (line) { warned.push(String(line)); };
    try {
      row.steps.forEach(function (step) {
        if ("stored" in step) {
          w.a.opts.onSetServerDefaultMode(step.stored);
          w.handlersB.refreshServerDefaults();
        } else {
          (step.on === "a" ? w.handlersA : w.handlersB).handleSessionsMessage(makeWs(), step.msg);
        }
      });
    } finally {
      console.warn = origWarn;
    }
    w.handlersB.handleSessionsMessage(w.viewerB, { type: "new_session" });
    var created = Array.from(w.smB.sessions.values()).pop();
    assert.strictEqual(created.permissionMode, row.expectB, "a new session in b");
    assert.strictEqual(w.smB._savedDefaultMode, row.expectB, "b's saved default mode");
    assert.strictEqual(w.smB.currentPermissionMode, row.expectB, "b's fallback mode follows it");
    assert.strictEqual(w.a.sm._savedDefaultMode, row.expectA, "a's saved default mode");
    assert.strictEqual(w.a.sm.currentPermissionMode, row.expectA, "a's fallback mode follows it");
    if (running) assert.strictEqual(running.permissionMode, row.expectRunning, "the running session keeps its mode");
    if (row.warn) assert.ok(warned.some(function (l) { return row.warn.test(l); }), "the refusal is logged as at project start");
    if (row.told) {
      var all = w.b._sent.concat(w.b._sentTo.map(function (pair) { return pair[1]; }));
      var told = all.filter(function (m) { return m.type === "saved_defaults"; });
      assert.strictEqual(told.length, 1, "b's clients are told once");
      assert.strictEqual(told[0].server.mode, row.told.server);
      assert.strictEqual(told[0].project.mode, row.told.project, "the project level is as stored");
      assert.deepStrictEqual(all.filter(function (m) { return m.type === "config_state"; }), [], "no session's config moves");
    }
  });
});

// A default change is not a session's change: no client's model chip moves.
[
  { type: "set_server_default_model", level: "server" },
  { type: "set_project_default_model", level: "project" },
].forEach(function (row) {
  test(row.type + " sends no config_state that moves a session's model", function () {
    var w = twoProjects();
    var viewed = { localId: 1, model: "haiku" };
    w.a.getSessionForWs = function () { return viewed; };
    w.handlersA = attachSessions(w.a);
    w.handlersA.handleSessionsMessage(makeWs(), { type: row.type, model: "opus" });

    var all = w.a._sent.concat(w.a._sentTo.map(function (pair) { return pair[1]; }), w.b._sent, w.b._sentTo.map(function (pair) { return pair[1]; }));
    var moved = all.filter(function (m) { return m.type === "config_state" && "model" in m; });
    assert.deepStrictEqual(moved, [], "no config_state carries a model");
    assert.strictEqual(viewed.model, "haiku", "the viewed session keeps its model");
    assert.ok(all.some(function (m) { return m.type === "saved_defaults" && m[row.level].model === "opus"; }), "the default change is sent as saved_defaults");
  });
});
