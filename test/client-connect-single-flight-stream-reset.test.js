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

// Opens socket A through the real ticket path and returns it with its handlers
// captured before anything supersedes it.
async function openSocketA() {
  sockets.length = 0;
  mods.conn.connect();
  await resolveAllTickets();
  var a = mods.wsRef.getWs();
  assert.equal(sockets.length >= 1, true, "ticket resolution must construct a socket");
  assert.equal(a, sockets[sockets.length - 1]);
  assert.equal(typeof a.onmessage, "function");
  a.onopen();
  return { sock: a, onmessage: a.onmessage, onclose: a.onclose };
}

function frame(obj) { return { data: JSON.stringify(obj) }; }

// Delivers a session_list and a delta through the captured handler of a
// superseded socket and asserts neither reached the sidebar or the pane.
function assertStaleFramesIgnored(captured) {
  var sidebarBefore = JSON.stringify(mods.sidebar.getCachedSessions());
  parsed.length = 0;
  rafCallbacks.length = 0;
  captured.onmessage(frame({ type: "session_list", sessions: [{ id: 1, title: "other project" }] }));
  captured.onmessage(frame({ type: "delta", text: "STALE-SOCKET-TEXT" }));
  captured.onclose({});
  assert.equal(JSON.stringify(mods.sidebar.getCachedSessions()), sidebarBefore, "sidebar unchanged");
  mods.rendering.appendDelta("current text");
  mods.rendering.finalizeAssistantBlock();
  assert.equal(parsed[parsed.length - 1], "current text", "pane holds only the current socket's text");
}

test("two connect() calls before the ticket resolves construct a single socket", async function () {
  sockets.length = 0;
  mods.conn.connect();
  mods.conn.connect();
  await resolveAllTickets();
  assert.equal(sockets.length, 1, "a superseded attempt must not construct a socket");
  assert.equal(liveSockets().length, 1);
  assert.equal(mods.wsRef.getWs(), liveSockets()[0]);
});

test("a reconnect timer firing during switchProject does not leave an orphan socket", async function () {
  var a = await openSocketA();
  mods.conn.scheduleReconnect();
  mods.projects.switchProject("other-project");
  await tick(250); // past the reconnect delay: an uncancelled timer would call connect() here
  await resolveAllTickets();
  var b = mods.wsRef.getWs();
  assert.notEqual(b, a.sock);
  assert.equal(sockets.length, 2, "A plus exactly one replacement");
  assert.equal(liveSockets().length, 1, "exactly one socket stays live");
  assert.equal(liveSockets()[0], b);
  assert.equal(a.sock.closed, true);
});

test("frames from a socket superseded by connect() are ignored", async function () {
  var a = await openSocketA();
  mods.conn.connect();
  await resolveAllTickets();
  var b = mods.wsRef.getWs();
  assert.notEqual(b, a.sock, "socket B is now current");
  assert.equal(a.sock.closed, true, "A was closed");
  assert.equal(a.sock.onmessage, null, "A's handlers were detached");
  assert.equal(liveSockets().length, 1);
  assertStaleFramesIgnored(a);
});

test("frames from a socket superseded by switchProject during a pending reconnect are ignored", async function () {
  var a = await openSocketA();
  mods.conn.scheduleReconnect();
  mods.projects.switchProject("another-project");
  await resolveAllTickets();
  var b = mods.wsRef.getWs();
  assert.notEqual(b, a.sock, "socket B is now current");
  assert.equal(a.sock.closed, true, "A was closed");
  assert.equal(a.sock.onmessage, null, "A's handlers were detached");
  assert.equal(liveSockets().length, 1);
  assertStaleFramesIgnored(a);
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
