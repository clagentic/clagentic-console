// Regression tests for the client connection lifecycle: connect() is
// single-flight (a superseded attempt never opens a socket, and a socket that
// is no longer tracked never feeds messages), and resetClientState() drops
// undrawn stream text so it is not drawn in front of the replayed history.
// Drives the real lib/public ESM graph under Node with a fake WebSocket.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");
var { installBrowserGlobals } = require("./helpers/fake-browser-globals.js");

var MODULES = path.join(__dirname, "..", "lib", "public", "modules");
function modUrl(name) { return pathToFileURL(path.join(MODULES, name)).href; }
var APP_JS_URL = pathToFileURL(path.join(__dirname, "..", "lib", "public", "app.js")).href;

var sockets = [];
var ticketResolvers = [];
var parsed = [];
var rafCallbacks = [];

function ticketResponse() {
  return { status: 200, ok: true, json: function () { return Promise.resolve({ ticket: "t" }); } };
}

function fakeFetch(url) {
  if (String(url).indexOf("/api/ws-ticket") !== -1) {
    return new Promise(function (resolve) {
      ticketResolvers.push(function () { resolve(ticketResponse()); });
    });
  }
  return Promise.resolve({ status: 200, ok: true, json: function () { return Promise.resolve({}); }, text: function () { return Promise.resolve(""); } });
}

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }

async function resolveAllTickets() {
  while (ticketResolvers.length) ticketResolvers.shift()();
  await tick(10);
}

var mods;

test.before(async function () {
  installBrowserGlobals({
    sockets: sockets,
    fetch: fakeFetch,
    onParse: function (s) { parsed.push(s); },
    // Never fires: a hidden tab pauses the draw loop.
    requestAnimationFrame: function (fn) { rafCallbacks.push(fn); return rafCallbacks.length; },
  });
  await import(APP_JS_URL);
  mods = {
    conn: await import(modUrl("app-connection.js")),
    projects: await import(modUrl("app-projects.js")),
    rendering: await import(modUrl("app-rendering.js")),
    sidebar: await import(modUrl("sidebar-sessions.js")),
    store: await import(modUrl("store.js")),
    wsRef: await import(modUrl("ws-ref.js")),
  };
});

function liveSockets() {
  return sockets.filter(function (s) { return typeof s.onmessage === "function"; });
}

test("overlapping connect() calls leave exactly one live socket", async function () {
  // app.js boot already started one connect(); start another before any ticket resolves.
  mods.conn.connect();
  await resolveAllTickets();
  assert.equal(liveSockets().length, 1, "only the latest attempt may own a live socket");
  assert.equal(sockets.length, 1, "a superseded attempt must not construct a socket");
  assert.equal(mods.wsRef.getWs(), liveSockets()[0]);
});

test("a reconnect timer firing during switchProject does not leave an orphan socket", async function () {
  sockets.length = 0;
  mods.conn.scheduleReconnect();
  mods.projects.switchProject("other-project");
  await tick(250); // past the reconnect delay: an uncancelled timer would call connect() here
  await resolveAllTickets();
  assert.equal(liveSockets().length, 1, "exactly one socket stays live");
  assert.equal(mods.wsRef.getWs(), liveSockets()[0]);
});

test("a session_list on a superseded socket leaves the sidebar unchanged", async function () {
  sockets.length = 0;
  mods.conn.connect();
  mods.conn.connect();
  await resolveAllTickets();
  var before = JSON.stringify(mods.sidebar.getCachedSessions());
  var current = mods.wsRef.getWs();
  sockets.filter(function (s) { return s !== current; }).forEach(function (stale) {
    if (typeof stale.onmessage === "function") {
      stale.onmessage({ data: JSON.stringify({ type: "session_list", sessions: [{ id: 1, title: "other project" }] }) });
    }
  });
  assert.equal(JSON.stringify(mods.sidebar.getCachedSessions()), before);
});

test("resetClientState drops undrawn stream text so replay renders each chunk once", function () {
  parsed.length = 0;
  rafCallbacks.length = 0;
  var r = mods.rendering;
  r.appendDelta("The new record shows X and");
  mods.projects.resetClientState();
  r.appendDelta("The new record shows X and more");
  r.finalizeAssistantBlock();
  var rendered = parsed[parsed.length - 1];
  assert.equal(rendered, "The new record shows X and more");
});
