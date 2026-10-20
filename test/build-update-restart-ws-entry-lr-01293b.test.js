"use strict";

// The confirmed "Restart now" driven end to end through the real WS entry point.
//
// The frames are not written by hand: the real client module
// (lib/public/modules/diagnostics.js) produces them from button clicks, its
// socket hands each one to the real restart_for_build_update handler in
// lib/project-sessions.js, which calls the real createBuildUpdateRestart and
// the real waitForIdleThenAct. The handler's answers (the result frame and the
// confirmation diagnostic) are fed back into the client's own entry points, so
// the loop a phone or a desktop tab runs is closed. Only the build assessment,
// the change list and the final restart() are stand-ins.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");

var dom = require("./fake-dom-prompt-cards");
var { attachSessions } = require("../lib/project-sessions");
var { createBuildUpdateRestart } = require("../lib/build-update-restart");
var { waitForIdleThenAct } = require("../lib/build-update-check");

var MODULES = path.join(__dirname, "..", "lib", "public", "modules");
var WAIT_MS = 3000;
var instance = 0;

var BUILDS = {
  loadedBuildSha: "a".repeat(40), installedBuildSha: "b".repeat(40), reason: "sha",
  changes: { available: true, truncated: false, reason: null, commits: [] },
};

// The standing notice every client holds (lib/build-update-offer.js composeNotice).
function standingNotice() {
  return {
    type: "diagnostic", severity: "warning", source: "build-update",
    message: "A newer build is installed.", buildUpdate: BUILDS,
    actionable: { label: "Restart to apply update", action: "restart_for_build_update" },
  };
}

function flush() { return new Promise(function (r) { setImmediate(r); }); }

function liveSession(id, processing) {
  return { localId: id, title: "session " + id, queryInstance: {}, isProcessing: !!processing, activeTaskToolIds: {} };
}

function makeCtx(opts, sessions) {
  var noop = function () {};
  return {
    cwd: "/tmp/test-restart-ws-entry", slug: "lore", osUsers: false, currentVersion: "0.0.0",
    sm: { sessions: sessions, currentModel: null, saveSessionFile: noop },
    sdk: {}, tm: { list: function () { return []; } }, clients: new Set(),
    send: function (msg) { ctxBroadcast.push(msg); },
    sendTo: function (ws, msg) { ws._deliver(msg); },
    sendToAdmins: noop, sendToSession: noop, sendToSessionOthers: noop,
    opts: opts,
    usersModule: { getEffectivePermissions: function () { return {}; } },
    userPresence: { setPresence: noop }, pushModule: null,
    getSessionForWs: function () { return null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: noop,
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (o) { return o; },
    onProcessingChanged: noop, broadcastPresence: noop, adapter: null,
    getProjectList: function () { return []; }, getProjectCount: function () { return 0; },
    getScheduleCount: function () { return 0; },
    moveScheduleToProject: noop, moveAllSchedulesToProject: noop,
    getHubSchedules: function () { return []; }, fetchVersion: noop,
    isNewer: function () { return false; }, onCreateWorktree: null,
    IGNORED_DIRS: new Set(), scheduleMessage: noop, cancelScheduledMessage: noop,
    getProjectOwnerId: function () { return null; }, setProjectOwnerId: noop,
    getUpdateChannel: function () { return "stable"; }, setUpdateChannel: noop,
    getLatestVersion: function () { return "0.0.0"; }, setLatestVersion: noop,
  };
}

var ctxBroadcast = [];

async function rig(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  ctxBroadcast = [];
  dom.setupGlobals();
  var container = new dom.FakeElement("div");
  global.document.body.appendChild(container);
  global.document.getElementById = function (id) { return id === "diagnostic-toast-container" ? container : null; };
  var wsRef = await import(pathToFileURL(path.join(MODULES, "ws-ref.js")).href);
  var diagnostics = await import(dom.moduleUrl("diagnostics.js") + "?entry=" + (++instance));

  var sessions = new Map();
  var restarts = 0;
  var lines = [];
  var controller = createBuildUpdateRestart({
    assess: function () {
      return {
        state: "stale", reason: "sha", detail: "d",
        loadedBuildSha: BUILDS.loadedBuildSha, installedBuildSha: BUILDS.installedBuildSha,
        loadedContentHash: "h-old", installedContentHash: "h-new",
      };
    },
    getProjects: function () { return [{ slug: "lore", sm: { sessions: sessions } }]; },
    listChanges: async function () { return { available: true, commits: [], truncated: false, reason: null }; },
    restart: function () { restarts += 1; },
    waitForIdleThenAct: waitForIdleThenAct,
    waitMs: WAIT_MS,
    log: function (line) { lines.push(line); },
  });
  var handler = attachSessions(makeCtx({ onRestartForBuildUpdate: function (token) { return controller.request(token); } }, sessions));

  // One browser tab: a client module and a socket that delivers to the daemon.
  var results = [];
  var tabWs = {
    readyState: 1,
    _clagenticUser: { role: "admin" },
    _deliver: function (msg) {
      if (msg.type === "restart_for_build_update_result") {
        results.push(msg);
        diagnostics.settleBuildUpdateRequest(msg);
      } else if (msg.type === "diagnostic") {
        diagnostics.addDiagnostic(msg);
      } else if (msg.type === "diagnostic_retract") {
        diagnostics.retractDiagnostics(msg.source);
      }
    },
  };
  var frames = [];
  var socket = {
    readyState: 1,
    send: function (body) {
      var frame = JSON.parse(body);
      frames.push(frame);
      handler.handleSessionsMessage(tabWs, frame);
    },
  };
  wsRef.setWs(socket);

  return {
    sessions: sessions, frames: frames, results: results, lines: lines, container: container,
    restarts: function () { return restarts; },
    button: function (label) {
      return container.querySelectorAll("button").filter(function (b) { return b.textContent === label; })[0] || null;
    },
    // A socket that is not the one the offer went to: another tab, or the same
    // tab after a reconnect. It replays a frame the real client produced.
    otherSocket: function () {
      var got = [];
      var other = {
        readyState: 1, _clagenticUser: { role: "admin" },
        _deliver: function (msg) { got.push(msg); },
      };
      return { got: got, send: function (frame) { handler.handleSessionsMessage(other, frame); } };
    },
    diagnostics: diagnostics,
    standing: function () { diagnostics.addDiagnostic(standingNotice()); },
  };
}

test("a session that starts a turn between offer and confirm: the confirm schedules the restart and the result echoes requestId", async function (t) {
  var r = await rig(t);
  r.sessions.set(1, liveSession(1, false));
  r.standing();

  r.button("Restart to apply update").click();
  await flush();
  assert.equal(r.frames.length, 1);
  assert.deepEqual(Object.keys(r.frames[0]).sort(), ["requestId", "type"], "the offer request carries no confirmToken");
  assert.equal(r.frames[0].type, "restart_for_build_update");
  assert.equal(r.results[0].requestId, r.frames[0].requestId);
  assert.equal(r.results[0].ok, false);
  assert.equal(r.results[0].needsConfirmation, true);
  assert.equal(r.restarts(), 0, "asking for the offer restarts nothing");

  // The offered session starts a turn after the operator was shown the card.
  r.sessions.get(1).isProcessing = true;
  r.sessions.set(2, liveSession(2, true));

  r.button("Restart now").click();
  await flush();
  assert.equal(r.frames.length, 2);
  var confirm = r.frames[1];
  assert.deepEqual(Object.keys(confirm).sort(), ["confirmToken", "requestId", "type"]);
  assert.match(confirm.confirmToken, /^[0-9a-f]{32}$/);
  assert.notEqual(confirm.requestId, r.frames[0].requestId);

  var result = r.results[1];
  assert.equal(result.type, "restart_for_build_update_result");
  assert.equal(result.requestId, confirm.requestId, "the result echoes the confirm's requestId");
  assert.equal(result.ok, true);
  assert.equal(r.button("Restart now").disabled, true, "a scheduled restart keeps the button dimmed");
  assert.ok(r.lines.some(function (l) { return /Restart confirmed after the offer changed/.test(l); }), r.lines.join("\n"));
  assert.equal(r.restarts(), 0, "running turns get their bounded wait first");

  t.mock.timers.tick(WAIT_MS);
  assert.equal(r.restarts(), 1, "the restart fires once the wait is over, whatever the session set did");
});

test("an unknown token is refused with its reason, restarts nothing and leaves the card usable", async function (t) {
  var r = await rig(t);
  // A card carrying a token the daemon never issued: what a client holding an
  // offer from before a daemon restart would have on screen.
  r.diagnostics.addDiagnostic({
    type: "diagnostic", severity: "warning", source: "build-update",
    message: "A restart now would end 1 live session.",
    buildUpdate: Object.assign({ token: "f".repeat(32) }, BUILDS),
    actionable: { label: "Restart now", action: "confirm_build_update_restart" },
  });
  r.button("Restart now").click();
  await flush();

  assert.deepEqual(Object.keys(r.frames[0]).sort(), ["confirmToken", "requestId", "type"]);
  assert.equal(r.results[0].requestId, r.frames[0].requestId);
  assert.equal(r.results[0].ok, false);
  assert.equal(r.results[0].needsConfirmation, true);
  assert.match(r.container.textContent, /That offer expired\. Review the current one\./, "the reason reaches the operator");
  assert.ok(r.lines.some(function (l) { return /the offer was unknown or expired/.test(l); }), r.lines.join("\n"));
  t.mock.timers.tick(WAIT_MS * 2);
  assert.equal(r.restarts(), 0);
});

test("a second confirm while one waits restarts once and is journaled as already waiting", async function (t) {
  var r = await rig(t);
  r.sessions.set(1, liveSession(1, true));
  r.standing();
  r.button("Restart to apply update").click();
  await flush();
  r.button("Restart now").click();
  await flush();
  assert.equal(r.results[1].ok, true);
  var firstConfirm = r.frames[1];

  // Another tab (or this one after a reconnect) asks again while the first
  // restart is still waiting on the running turn.
  var other = r.otherSocket();
  other.send({ type: "restart_for_build_update", requestId: "bu-other-1" });
  await flush();
  assert.ok(!other.got.some(function (m) { return m.type === "diagnostic" && m.buildUpdate; }), "no offer is issued while a restart waits");
  other.send({ type: "restart_for_build_update", confirmToken: "f".repeat(32), requestId: "bu-other-2" });
  await flush();

  assert.ok(r.lines.some(function (l) { return /a confirmed restart is already waiting/.test(l); }), r.lines.join("\n"));
  var second = other.got.find(function (m) { return m.type === "restart_for_build_update_result" && m.requestId === "bu-other-2"; });
  assert.ok(second, "the second confirm is answered, with its own requestId");
  assert.equal(second.ok, true, "a repeat reports the pending restart, not a refusal");

  t.mock.timers.tick(WAIT_MS);
  assert.equal(r.restarts(), 1, "two confirms schedule one restart");

  // The first confirm's token is spent: replaying its frame (a reconnect that
  // resends) does not restart again.
  other.send(firstConfirm);
  await flush();
  t.mock.timers.tick(WAIT_MS);
  assert.equal(r.restarts(), 1, "a spent token never restarts a second time");
});

test("a confirmed restart leaves one restarting card that does not close on a timer and no prompt to click again", async function (t) {
  var r = await rig(t);
  r.sessions.set(1, liveSession(1, true));
  r.standing();
  r.button("Restart to apply update").click();
  await flush();
  r.button("Restart now").click();
  await flush();
  t.mock.timers.tick(400); // the withdrawn cards finish leaving

  assert.equal(r.results[1].ok, true);
  assert.equal(r.results[1].waitSeconds, WAIT_MS / 1000);
  assert.equal(r.button("Restart to apply update"), null, "the first prompt is withdrawn");
  assert.equal(r.button("Restart now"), null, "the confirm prompt is withdrawn");
  var pending = /Restarting Clagentic: Console to apply the installed update\./g;
  assert.equal((r.container.textContent.match(pending) || []).length, 1);

  // A repeat from the same tab restates the state; it does not stack a card or ask again.
  var tab = r.otherSocket();
  tab.send({ type: "restart_for_build_update", requestId: "bu-repeat" });
  await flush();
  assert.equal(r.frames.length, 2, "no prompt was left to click");
  t.mock.timers.tick(400);
  assert.equal((r.container.textContent.match(pending) || []).length, 1);

  // Well past the toast's old 6 s life and past the wait itself, still readable.
  t.mock.timers.tick(WAIT_MS * 3);
  assert.equal(r.restarts(), 1);
  assert.equal((r.container.textContent.match(pending) || []).length, 1, "the state stays until the page is replaced");
  assert.equal(r.button("Restart now"), null);
});

test("a non-admin socket sending the confirm frame is refused and restarts nothing", async function (t) {
  var r = await rig(t);
  var got = [];
  var handlerWs = { readyState: 1, _clagenticUser: { role: "user" }, _deliver: function (m) { got.push(m); } };
  var called = 0;
  var h = attachSessions(makeCtx({ onRestartForBuildUpdate: function () { called += 1; return Promise.resolve({ status: "restarting" }); } }, new Map()));
  h.handleSessionsMessage(handlerWs, { type: "restart_for_build_update", confirmToken: "x".repeat(32), requestId: "bu-9" });
  await flush();
  assert.equal(called, 0);
  assert.deepEqual(got, [{ type: "error", text: "Admin access required" }]);
  assert.equal(r.restarts(), 0);
});
