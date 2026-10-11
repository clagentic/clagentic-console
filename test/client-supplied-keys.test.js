// Names and ids that arrive from a client are never used as keys on a plain
// object or handed to a lookup unchecked: a hostile vendor, tab id or request
// id is refused, the server keeps running, and no prototype is touched.
// Also: only the socket an extension command was sent to may answer it.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var harness = require("./access-harness");

var HOSTILE = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "__defineGetter__", "prototype", "", 7, null, true, {}, ["claude"], { toString: 1 }];

var H = null;

function projectCtx(slug) {
  var found = null;
  H.relay.forEachProject(function (ctx, s) { if (s === slug) found = ctx; });
  return found;
}

function assertPrototypesClean() {
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "models"), false);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
}

test.before(async function () {
  H = await harness.start({
    users: [{ key: "alice", username: "alice" }, { key: "bob", username: "bob" }],
    projects: [{ slug: "pub", visibility: "public", ownerKey: "bob" }],
  });
});

test.after(async function () {
  if (H) await H.stop();
});

test("a hostile vendor in get_vendor_models gets an empty answer and changes nothing", async function () {
  var c = await H.connect("pub", "alice");
  var sm = projectCtx("pub").sm;
  for (var i = 0; i < HOSTILE.length; i++) {
    c.send({ type: "get_vendor_models", vendor: HOSTILE[i] });
    var info = await c.waitFor(function (m) { return m.type === "model_info" && Array.isArray(m.models) && m.models.length === 0 && m.__seen !== true; });
    assert.deepEqual(info.models, [], "vendor " + JSON.stringify(HOSTILE[i]));
    info.__seen = true;
  }
  assert.equal(Object.getPrototypeOf(sm.modelsByVendor || {}) === Object.prototype || Object.getPrototypeOf(sm.modelsByVendor) === null, true);
  assert.equal(Object.keys(sm.modelsByVendor || {}).filter(function (k) { return HOSTILE.indexOf(k) !== -1; }).length, 0);
  assertPrototypesClean();
  assert.ok((await H.connect("pub", "alice")).ok, "the server is still serving");
});

test("a hostile vendor is not bound to a session by new_session, set_vendor or a message", async function () {
  var c = await H.connect("pub", "alice");
  var sm = projectCtx("pub").sm;
  for (var i = 0; i < HOSTILE.length; i++) {
    if (typeof HOSTILE[i] === "string" && HOSTILE[i] !== "") {
      c.send({ type: "new_session", vendor: HOSTILE[i] });
      await harness.settle(80);
    }
  }
  sm.sessions.forEach(function (s) {
    assert.ok(s.vendor === null || s.vendor === undefined || s.vendor === "claude" || s.vendor === "codex", "session vendor " + JSON.stringify(s.vendor));
  });
  c.send({ type: "new_session" });
  await harness.settle(100);
  for (var j = 0; j < HOSTILE.length; j++) {
    c.send({ type: "set_vendor", vendor: HOSTILE[j] });
    await harness.settle(40);
  }
  sm.sessions.forEach(function (s) {
    assert.ok(s.vendor === null || s.vendor === undefined || s.vendor === "claude" || s.vendor === "codex", "session vendor " + JSON.stringify(s.vendor));
  });
  assertPrototypesClean();
  assert.ok((await H.connect("pub", "alice")).ok);
});

test("a known vendor is still accepted", async function () {
  var c = await H.connect("pub", "alice");
  c.send({ type: "new_session", vendor: "codex" });
  await harness.settle(150);
  var sm = projectCtx("pub").sm;
  var vendors = [];
  sm.sessions.forEach(function (s) { vendors.push(s.vendor); });
  assert.ok(vendors.indexOf("codex") !== -1);
});

test("a browser tab list keyed by hostile ids does not reach the prototype", async function () {
  var ext = await H.connect("pub", "alice");
  ext.send({ type: "browser_tab_list", tabs: [
    { id: "__proto__", url: "https://polluted.example", title: "polluted" },
    { id: "constructor", url: "u" },
    { id: 7, url: "https://seven.example", title: "seven" },
    null, 5, "tab", { url: "no id" },
  ] });
  await harness.settle(150);
  var handler = projectCtx("pub").getMcpBridgeHandler();
  var tools = await handler.listTools();
  var listTool = tools.filter(function (t) { return t.name === "browser_list_tabs"; })[0];
  assert.ok(listTool, "the browser tools are offered once an extension has connected");
  var result = await handler.callTool(listTool.server, "browser_list_tabs", {});
  var tabs = JSON.parse(result.content[0].text);
  assert.deepEqual(tabs.map(function (t) { return t.id; }), [7], "only a tab with a numeric id is listed");
  assertPrototypesClean();
});

test("only the socket an extension command was sent to can answer it", async function () {
  var ext = await H.connect("pub", "alice");
  ext.send({ type: "browser_tab_list", tabs: [{ id: 1, url: "https://a.example", title: "a" }] });
  await harness.settle(150);
  var forger = await H.connect("pub", "bob");

  var handler = projectCtx("pub").getMcpBridgeHandler();
  var settled = false;
  var call = handler.callTool("clay-browser", "browser_close", { tabId: 1 }).then(function (r) { settled = true; return r; });
  var command = await ext.waitFor(function (m) { return m.type === "extension_command" && m.command === "tab_close"; });

  forger.send({ type: "extension_result", requestId: command.requestId, result: { forged: true } });
  await harness.settle(250);
  assert.equal(settled, false, "another client's extension_result does not settle the command");

  ext.send({ type: "extension_result", requestId: command.requestId, result: { ok: true } });
  var result = await call;
  assert.match(result.content[0].text, /Closed tab 1/);
});

test("an extension_result for a request that was never sent is ignored", async function () {
  var ext = await H.connect("pub", "alice");
  for (var i = 0; i < HOSTILE.length; i++) {
    ext.send({ type: "extension_result", requestId: HOSTILE[i], result: {} });
  }
  await harness.settle(150);
  assertPrototypesClean();
  assert.ok((await H.connect("pub", "alice")).ok);
});
