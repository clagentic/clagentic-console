"use strict";

// The build-update notice as the daemon really sends it. The messages are built
// by the server's own code (createStandingOffer + composeNotice) and delivered
// by the real project-connection replay, then fed through the real client
// diagnostics module, so the shape is never hand-typed.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var EventEmitter = require("events");

var dom = require("./fake-dom-prompt-cards");
var { attachConnection } = require("../lib/project-connection");
var { createStandingOffer } = require("../lib/build-update-standing");
var { composeNotice, noticeCooldownFrom, DEFAULT_NOTICE_COOLDOWN_MS } = require("../lib/build-update-offer");

var COOLDOWN = 60 * 1000;
var instance = 0;
var timersOn = new WeakSet();

function assessment(loaded, installed) {
  return { loadedBuildSha: loaded.repeat(40), installedBuildSha: installed.repeat(40), installedContentHash: "h" + installed, reason: "sha" };
}

// The daemon's standing offer, wired as lib/daemon.js wires it, with the wire
// (JSON) form of every broadcast recorded.
function serverSide(cooldownMs) {
  var desired = null;
  var broadcasts = [];
  var standing = createStandingOffer({
    listChanges: function () { return Promise.resolve({ available: true, commits: [{ sha: "1234567890ab", subject: "fix a thing" }], truncated: false, reason: null }); },
    desired: function () { return desired; },
    broadcast: function (m) { broadcasts.push(JSON.parse(JSON.stringify(m))); },
    compose: function (a, changes) { return composeNotice(a, changes, cooldownMs); },
  });
  return {
    standing: standing,
    broadcasts: broadcasts,
    setDesired: function (a) { desired = a; standing.reconcile(a); },
    settle: function () { return new Promise(function (r) { setImmediate(r); }); },
  };
}

function makeFakeWs() {
  var ws = new EventEmitter();
  ws.readyState = 1;
  ws._sent = [];
  ws.send = function (d) { ws._sent.push(d); };
  ws.terminate = function () {};
  ws.close = function () {};
  return ws;
}

function makeCtx(opts) {
  var sessions = new Map();
  return {
    cwd: "/tmp/test-notice", slug: "test-notice", isMate: false, osUsers: false, debug: false,
    dangerouslySkipPermissions: false, currentVersion: "0.0.0", lanHost: null,
    sm: {
      sessions: sessions, activeSessionId: null, defaultVendor: "claude", availableModels: [], modelsByVendor: {},
      currentModel: null, slashCommands: null, capabilitiesByVendor: {},
      createSession: function () { var s = { localId: 1, history: [], pendingPermissions: {}, lastActivity: Date.now() }; sessions.set(1, s); return s; },
      saveSessionFile: function () {}, loadSessionHistory: function () {}, replayHistory: function () {},
      mapSessionForClient: function (s) { return s; },
      effectiveSessionModel: function () { return ""; },
    },
    tm: { list: function () { return []; } }, nm: { list: function () { return []; } },
    clients: new Set(), send: function () {},
    sendTo: function (ws, msg) { ws._sent.push(JSON.parse(JSON.stringify(msg))); },
    opts: opts,
    _loop: { loopState: {}, loopRegistry: {}, resumeLoop: function () {}, sendConnectionState: function () {} },
    _mcp: null, _notifications: null,
    hydrateImageRefs: function (o) { return o; }, broadcastClientCount: function () {}, broadcastPresence: function () {},
    getProjectList: function () { return []; }, getHubSchedules: function () { return []; }, loadContextSources: function () { return []; },
    stopFileWatch: function () {}, stopAllDirWatches: function () {}, getProjectOwnerId: function () { return null; },
    setProjectOwnerId: function () {}, getLatestVersion: function () { return "0.0.0"; },
    getTitle: function () { return "Test"; }, getProject: function () { return "test-notice"; }, warmup: null,
  };
}

// What one connect or reconnect delivers of the notice.
function connectAndCollect(server) {
  var conn = attachConnection(makeCtx({ onGetBuildUpdateDiagnostic: function () { return server.standing.forNewClient(); } }));
  var ws = makeFakeWs();
  conn.handleConnection(ws, { id: "u" }, function () {}, function () {});
  return ws._sent.filter(function (m) { return m && (m.type === "diagnostic" || m.type === "diagnostic_retract"); });
}

async function browser(t) {
  if (!timersOn.has(t)) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    timersOn.add(t);
  }
  dom.setupGlobals();
  var container = new dom.FakeElement("div");
  global.document.body.appendChild(container);
  global.document.getElementById = function (id) { return id === "diagnostic-toast-container" ? container : null; };
  var diagnostics = await import(dom.moduleUrl("diagnostics.js") + "?replay=" + (++instance));
  return {
    diagnostics: diagnostics,
    container: container,
    // The dispatch app-messages.js applies to a diagnostic frame.
    receive: function (msg) {
      if (msg.type === "diagnostic_retract") diagnostics.retractDiagnostics(msg.source);
      else if (msg.refresh === true) diagnostics.refreshDiagnostic(msg);
      else diagnostics.addDiagnostic(msg);
    },
    toasts: function (source) { return container.querySelectorAll('[data-diag-source="' + source + '"]'); },
    tick: function (ms) { t.mock.timers.tick(ms); },
  };
}

test("the replay the server sends on many connects and reconnects leaves one notice", async function (t) {
  var server = serverSide(COOLDOWN);
  server.setDesired(assessment("a", "b"));
  await server.settle();
  var c = await browser(t);

  // The first poll's broadcast, a refresh once the change list was read, then
  // several connections (one per project per tab) and reconnects.
  server.broadcasts.forEach(c.receive);
  for (var i = 0; i < 6; i++) {
    var replay = connectAndCollect(server);
    assert.ok(replay.length >= 1, "the connect replays the held notice");
    replay.forEach(c.receive);
    c.tick(5100);
  }
  assert.equal(c.toasts("build-update").length, 1);
  assert.equal(c.toasts("build-update")[0].textContent.indexOf("Restart to apply update") !== -1, true);
});

test("a closed notice stays closed across replays, and a newer installed build raises one", async function (t) {
  var server = serverSide(COOLDOWN);
  server.setDesired(assessment("a", "b"));
  await server.settle();
  var c = await browser(t);
  connectAndCollect(server).forEach(c.receive);
  c.container.querySelectorAll("button").filter(function (b) { return b.className === "toast-diagnostic-dismiss"; })[0].click();
  c.tick(300);

  c.tick(5100);
  connectAndCollect(server).forEach(c.receive);
  assert.equal(c.toasts("build-update").length, 0);

  server.setDesired(assessment("a", "c"));
  await server.settle();
  server.broadcasts.slice(-3).forEach(c.receive);
  connectAndCollect(server).forEach(c.receive);
  c.tick(300);
  assert.equal(c.toasts("build-update").length, 1);
  assert.ok(c.toasts("build-update")[0].textContent.indexOf("c".repeat(12)) !== -1);
});

test("two tabs each keep their own single notice", async function (t) {
  var server = serverSide(COOLDOWN);
  server.setDesired(assessment("a", "b"));
  await server.settle();
  // Tabs run one after the other because the fake DOM is a process global; each
  // is a fresh module instance, so none shares state with another.
  for (var n = 0; n < 2; n++) {
    var tab = await browser(t);
    connectAndCollect(server).forEach(tab.receive);
    connectAndCollect(server).forEach(tab.receive);
    assert.equal(tab.toasts("build-update").length, 1, "tab " + n);
  }
});

test("the notice and another toast share the one stack and neither is duplicated", async function (t) {
  var server = serverSide(COOLDOWN);
  server.setDesired(assessment("a", "b"));
  await server.settle();
  var c = await browser(t);
  c.receive({ type: "diagnostic", severity: "warning", source: "preflight", message: "other" });
  connectAndCollect(server).forEach(c.receive);
  connectAndCollect(server).forEach(c.receive);
  var all = c.container.querySelectorAll("[data-diag-source]");
  assert.equal(all.length, 2);
  all.forEach(function (el) { assert.equal(el.parentNode, c.container, "both toasts are children of the one stack"); });

  // Stacking is by normal flow in a column container, with no per-toast fixed position.
  var css = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "diagnostics.css"), "utf8");
  var stack = /#diagnostic-toast-container \{([^}]*)\}/.exec(css)[1];
  assert.match(stack, /display:\s*flex/);
  assert.match(stack, /flex-direction:\s*column/);
  var toast = /\n\.toast-diagnostic \{([^}]*?)\n\}/.exec(css)[1];
  assert.match(toast, /position:\s*relative/);
});

test("the cooldown is delivered by the server: set, default and invalid values", function () {
  assert.equal(noticeCooldownFrom(undefined), DEFAULT_NOTICE_COOLDOWN_MS);
  assert.equal(noticeCooldownFrom(""), DEFAULT_NOTICE_COOLDOWN_MS);
  assert.equal(noticeCooldownFrom("abc"), DEFAULT_NOTICE_COOLDOWN_MS);
  assert.equal(noticeCooldownFrom("-5"), DEFAULT_NOTICE_COOLDOWN_MS);
  assert.equal(noticeCooldownFrom("0"), 0);
  assert.equal(noticeCooldownFrom("120000"), 120000);
  assert.equal(DEFAULT_NOTICE_COOLDOWN_MS, 3600000);
  var msg = composeNotice(assessment("a", "b"), null, noticeCooldownFrom("120000"));
  assert.equal(msg.noticeCooldownMs, 120000);
});

test("the client applies the cooldown the server sent", async function (t) {
  var server = serverSide(5000);
  server.setDesired(assessment("a", "b"));
  await server.settle();
  var c = await browser(t);
  connectAndCollect(server).forEach(c.receive);
  c.container.querySelectorAll("button").filter(function (b) { return b.className === "toast-diagnostic-dismiss"; })[0].click();
  c.tick(300);
  c.tick(5100);
  connectAndCollect(server).forEach(c.receive);
  assert.equal(c.toasts("build-update").length, 1, "back after the server's 5 s cooldown, not the 1 h default");
});
