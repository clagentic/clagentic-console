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

// The handlers are driven directly (with the project's real session manager and
// prompt registry): the browser tools only exist when an agent CLI is installed.
function messageHandlers(extra) {
  var { attachUserMessage } = require("../lib/project-user-message");
  return attachUserMessage(Object.assign({ sm: projectCtx("pub").sm, opts: {}, clients: new Set() }, extra));
}

test("a browser tab list keyed by hostile ids does not reach the prototype", function () {
  var browserState = { _browserTabList: Object.create(null), _extensionWs: null };
  var list = browserState._browserTabList;
  var handlers = messageHandlers({ browserState: browserState });
  var ws = { readyState: 1 };
  handlers.handleUserMessage(ws, { type: "browser_tab_list", tabs: [
    { id: "__proto__", url: "https://polluted.example", title: "polluted" },
    { id: "constructor", url: "u" },
    { id: 7, url: "https://seven.example", title: "seven" },
    null, 5, "tab", { url: "no id" }, { id: NaN },
  ] });
  assert.equal(browserState._extensionWs, ws);
  assert.deepEqual(Object.keys(list), ["7"], "only a tab with a numeric id is kept");
  assert.equal(Object.getPrototypeOf(list), null);
  assert.equal(browserState._browserTabList, list, "the list is updated in place, so every holder sees it");
  assertPrototypesClean();

  handlers.handleUserMessage(ws, { type: "browser_tab_list", tabs: "not a list" });
  assert.deepEqual(Object.keys(list), [], "a new report replaces the old one");
  handlers.handleUserMessage(ws, { type: "browser_tab_list" });
});

test("only the socket an extension command was sent to can answer it", async function () {
  var { createExtensionCommands } = require("../lib/extension-commands");
  var sm = projectCtx("pub").sm;
  var sent = [];
  var commands = createExtensionCommands({
    getSessionManager: function () { return sm; },
    sendTo: function (ws, msg) { sent.push({ ws: ws, msg: msg }); },
  });
  var extension = { readyState: 1 };
  var forger = { readyState: 1 };
  var handlers = messageHandlers({ mayAnswerExtensionCommand: commands.mayAnswer });

  var settled = false;
  var call = commands.send(extension, "tab_close", { tabId: 1 }, 10000).then(function (r) { settled = true; return r; });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ws, extension, "the command went to the extension socket");
  var requestId = sent[0].msg.requestId;
  assert.equal(commands.mayAnswer(requestId, extension), true);
  assert.equal(commands.mayAnswer(requestId, forger), false);

  handlers.handleUserMessage(forger, { type: "extension_result", requestId: requestId, result: { forged: true } });
  await harness.settle(100);
  assert.equal(settled, false, "another client's extension_result does not settle the command");

  handlers.handleUserMessage(extension, { type: "extension_result", requestId: requestId, result: { ok: true } });
  assert.deepEqual(await call, { ok: true });
  assert.equal(commands.mayAnswer(requestId, extension), false, "a settled command is forgotten");
  HOSTILE.forEach(function (id) { assert.equal(commands.mayAnswer(id, extension), false); });
});

test("with no binding to the sockets commands went to, nothing may answer one", function () {
  var handlers = messageHandlers({});
  assert.doesNotThrow(function () {
    handlers.handleUserMessage({ readyState: 1 }, { type: "extension_result", requestId: "anything", result: {} });
  });
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
