// Authentication is a separate, earlier input than the principal: "no user" is
// the implicit single-user owner only for a request or connection that proved
// it passed the login gate. This drives a real server with the login gate
// stood in for (its answer is a variable the test sets, and it never names a
// user), once per daemon mode.
//
// Swept: every route and socket that resolves a principal (palette, /api/file
// through the /p/<slug> gate, /p/<slug>, root redirect, /info, WebSocket
// upgrade) plus the local MCP bridge, which carries no login by design.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var harness = require("./access-harness");

var H = null;
var gate = { authed: false, multiUser: false };

function projectCtx(slug) {
  var found = null;
  H.relay.forEachProject(function (ctx, s) { if (s === slug) found = ctx; });
  return found;
}

test.before(async function () {
  H = await harness.start({
    multiUser: false,
    users: [],
    projects: [
      { slug: "mine", files: { "a.png": "png" } },
      { slug: "other" },
    ],
    serverOpts: { isMultiUser: function () { return gate.multiUser; } },
    beforeServer: function () {
      var serverAuth = require("../lib/server-auth");
      var attach = serverAuth.attachAuth;
      serverAuth.attachAuth = function (deps) {
        return Object.assign({}, attach(deps), {
          getMultiUserFromReq: function () { return null; },
          isRequestAuthed: function () { return gate.authed; },
        });
      };
    },
  });
  var s = projectCtx("other").sm.createSessionRaw({ ownerId: "a-former-user", sessionVisibility: "private" });
  s.title = "zebrafish-vault-notes";
});

test.after(async function () {
  if (H) await H.stop();
});

function withGate(state, fn) {
  return async function () {
    var before = Object.assign({}, gate);
    Object.assign(gate, state);
    try {
      await fn();
    } finally {
      Object.assign(gate, before);
    }
  };
}

[false, true].forEach(function (multiUser) {
  var label = multiUser ? "multi-user" : "single-user";

  test(label + ": an unauthenticated palette request is refused and reveals no session", withGate({ authed: false, multiUser: multiUser }, async function () {
    var search = await H.request("GET", "/api/palette/search?q=zebrafish", null);
    assert.equal(search.status, 401);
    assert.doesNotMatch(search.body, /zebrafish/);
    var recent = await H.request("GET", "/api/palette/search", null);
    assert.equal(recent.status, 401);
    assert.doesNotMatch(recent.body, /zebrafish/);
  }));

  test(label + ": unauthenticated project routes, root and info serve nothing of the owner's", withGate({ authed: false, multiUser: multiUser }, async function () {
    var file = await H.request("GET", "/p/mine/api/file?path=a.png", null);
    assert.equal(file.status, 401, "/api/file");
    var page = await H.request("GET", "/p/mine/", null);
    assert.equal(page.status, 200);
    assert.equal(page.headers["set-cookie"], undefined, "no project is selected for a stranger");
    assert.equal(page.headers.location, undefined);
    var root = await H.request("GET", "/", null);
    assert.equal(root.status, 200, "the root shows the login page, never a project redirect");
    assert.equal(root.headers.location, undefined);
    var info = await H.request("GET", "/info", null);
    assert.equal(info.status, 401);
    assert.doesNotMatch(info.body, /"slug"/);
  }));

  test(label + ": an unauthenticated WebSocket upgrade is refused", withGate({ authed: false, multiUser: multiUser }, async function () {
    assert.equal((await H.connect("mine", null)).status, 401);
    assert.equal((await H.connect("other", null)).status, 401);
  }));

  test(label + ": the local MCP bridge needs no login", withGate({ authed: false, multiUser: multiUser }, async function () {
    var bridge = await H.request("POST", "/p/mine/api/mcp-bridge", null, { action: "no-such-action" });
    assert.equal(bridge.status, 400, "the request reached the bridge handler");
  }));
});

test("single-user: an authenticated owner is served the palette, the project routes and the socket", withGate({ authed: true, multiUser: false }, async function () {
  var search = await H.request("GET", "/api/palette/search?q=zebrafish", null);
  assert.equal(search.status, 200);
  assert.deepEqual(JSON.parse(search.body).results.map(function (r) { return r.sessionTitle; }), ["zebrafish-vault-notes"], search.body);
  assert.equal((await H.request("GET", "/api/palette/search", null)).status, 200);
  assert.equal((await H.request("GET", "/p/mine/api/file?path=a.png", null)).status, 200);
  var root = await H.request("GET", "/", null);
  assert.equal(root.status, 302);
  assert.equal((await H.request("GET", "/info", null)).status, 200);
  var c = await H.connect("mine", null);
  assert.ok(c.ok, "WebSocket upgrade");
}));

test("multi-user: a login that names no user is nobody, however the gate answered", withGate({ authed: true, multiUser: true }, async function () {
  assert.equal((await H.request("GET", "/api/palette/search", null)).status, 401);
  assert.equal((await H.request("GET", "/p/mine/api/file?path=a.png", null)).status, 302);
  assert.equal((await H.connect("mine", null)).status, 401);
}));
