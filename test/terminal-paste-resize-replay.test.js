"use strict";
// Console terminal: paste reaches the PTY with one line break per line, a
// reconnected page can still resize the PTY, scrollback replay neither
// duplicates output nor sends xterm's query replies into the shell, and the
// touch toolbar keeps copy and paste.
//
// The browser side runs terminal.js over a fake xterm that reproduces the
// xterm behaviours the fix relies on: paste() turns CRLF/LF into CR and wraps
// the text in bracketed-paste markers when the program asked for them, and a
// query in the written output (OSC 11) is answered through onData while the
// chunk is parsed, before the write callback runs.

var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("crypto");
var fakeDom = require("./fake-dom-prompt-cards");

function mod(name, query) { return import(fakeDom.moduleUrl(name) + (query || "")); }
function sha(text) { return crypto.createHash("sha256").update(text).digest("hex"); }

// 2 KB+ of 120+ character lines, #!/bin/sh first.
var LINE = "echo " + "x".repeat(118);
var LF_PAYLOAD = ["#!/bin/sh"].concat(new Array(20).fill(LINE)).join("\n") + "\n";
var CRLF_PAYLOAD = LF_PAYLOAD.replace(/\n/g, "\r\n");
// What xterm.paste() puts on the wire for either payload.
var WIRE_PAYLOAD = LF_PAYLOAD.replace(/\n/g, "\r");

var OSC11_QUERY = "\x1b]11;?\x07";
var OSC11_REPLY = "\x1b]11;rgb:0505/0707/0e0e\x07";

async function harness(opts) {
  opts = opts || {};
  fakeDom.setupGlobals();
  // The context menu measures itself before positioning.
  fakeDom.FakeElement.prototype.getBoundingClientRect = function () { return { width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; };
  if (opts.touch) global.window.ontouchstart = null;
  var xterms = [];
  var pendingWrites = [];
  var keyHandlerRegistrations = 0;
  global.Terminal = function () {
    var self = this;
    var dataHandler = null;
    this.cols = 80; this.rows = 24; this.options = {};
    this.text = "";
    this.resets = 0;
    this.selection = "";
    this.keyHandler = null;
    this.loadAddon = function () {};
    this.registerLinkProvider = function () {};
    this.open = function () {};
    this.focus = function () {};
    this.dispose = function () {};
    this.getSelection = function () { return self.selection; };
    this.onData = function (h) { dataHandler = h; };
    this.attachCustomKeyEventHandler = function (h) { keyHandlerRegistrations += 1; self.keyHandler = h; };
    this.emit = function (data) { if (dataHandler) dataHandler(data); };
    this.paste = function (text) { self.emit(text.replace(/\r?\n/g, "\r")); };
    this.reset = function () { self.resets += 1; self.text = ""; };
    this.write = function (data, cb) {
      self.text += data;
      // xterm answers queries while parsing, before the write callback.
      if (data.indexOf(OSC11_QUERY) !== -1) self.emit(OSC11_REPLY);
      if (cb) pendingWrites.push(cb);
    };
    xterms.push(this);
  };
  var T = await mod("terminal.js", "?harness=" + Math.random());
  var storeMod = await mod("store.js");
  storeMod.createStore({ isOsUsers: false, isMultiUserMode: true });
  var container = new fakeDom.FakeElement("div");
  var body = new fakeDom.FakeElement("div");
  container.appendChild(body);
  var toolbar = new fakeDom.FakeElement("div");
  global.document.getElementById = function (id) {
    if (id === "terminal-toolbar") return toolbar;
    return ["terminal-close", "terminal-fullscreen", "terminal-toggle-btn", "terminal-sidebar-btn", "terminal-new-tab"].indexOf(id) !== -1 ? new fakeDom.FakeElement("button") : null;
  };
  var sent = [];
  T.initTerminal({
    terminalContainerEl: container, terminalBodyEl: body, connected: true,
    ws: { send: function (b) { sent.push(JSON.parse(b)); } },
  });
  T.handleTermList({ terminals: [{ id: "t1", title: "t1", exited: false }] });
  T.handleTermCreated({ id: "t1" });
  return {
    T: T, body: body, toolbar: toolbar, sent: sent, xterm: xterms[0],
    flushWrites: function () { pendingWrites.splice(0).forEach(function (cb) { cb(); }); },
    keyHandlerRegistrations: function () { return keyHandlerRegistrations; },
    inputs: function () { return sent.filter(function (m) { return m.type === "term_input"; }); },
    wire: function () { return sent.filter(function (m) { return m.type === "term_input"; }).map(function (m) { return m.data; }).join(""); },
  };
}

async function contextMenuPaste(h, clipboardText) {
  var realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { readText: function () { return Promise.resolve(clipboardText); } } },
  });
  try {
    var bodyEl = h.body.children[0];
    bodyEl._listeners.contextmenu[0]({ preventDefault: function () {}, stopPropagation: function () {}, clientX: 5, clientY: 5 });
    var items = global.document.body.querySelectorAll(".term-ctx-item");
    // Copy Console, Paste, Clear Console when nothing is selected.
    items[1]._listeners.click[0]({ stopPropagation: function () {} });
    await new Promise(function (r) { setImmediate(r); });
  } finally {
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
    else delete globalThis.navigator;
  }
}

var PASTE_PATHS = [
  // xterm's own paste listener (keyboard paste, browser right-click paste) ends in xterm.paste().
  ["keyboard paste (xterm paste listener)", function (h, text) { h.xterm.paste(text); return Promise.resolve(); }],
  ["context-menu Paste", function (h, text) { return contextMenuPaste(h, text); }],
];

PASTE_PATHS.forEach(function (row) {
  [["LF", LF_PAYLOAD], ["CRLF", CRLF_PAYLOAD]].forEach(function (variant) {
    test("paste via " + row[0] + ", " + variant[0] + " payload: PTY bytes hash-equal the LF payload, no CRLF", async function () {
      var h = await harness();
      await row[1](h, variant[1]);
      var wire = h.wire();
      assert.ok(variant[1].length > 2048);
      assert.equal(wire[0], "#");
      assert.equal(sha(wire), sha(WIRE_PAYLOAD));
      h.inputs().forEach(function (m) { assert.ok(m.data.indexOf("\r\n") === -1, "term_input carried CRLF"); });
    });
  });
});

test("paste: the tab body registers no raw paste listener, and Cmd/Ctrl+V is left to the browser event", async function () {
  var h = await harness();
  var bodyEl = h.body.children[0];
  assert.equal((bodyEl._listeners.paste || []).length, 0);
  assert.equal(h.xterm.keyHandler({ type: "keydown", key: "v", ctrlKey: true }), false);
  assert.equal(h.xterm.keyHandler({ type: "keydown", key: "v", metaKey: true }), false);
});

test("replay: query replies emitted while replaying are not forwarded, later keystrokes are", async function () {
  var h = await harness();
  h.T.handleTermOutput({ id: "t1", data: "old output " + OSC11_QUERY, replay: true });
  assert.equal(h.inputs().length, 0, "reply sent to the PTY during replay");
  h.flushWrites();
  h.xterm.emit("l");
  assert.deepEqual(h.inputs().map(function (m) { return m.data; }), ["l"]);
});

test("live output that asks a query is still answered", async function () {
  var h = await harness();
  h.T.handleTermOutput({ id: "t1", data: OSC11_QUERY });
  assert.equal(h.wire(), OSC11_REPLY);
});

test("replay: re-attach into an xterm that holds output does not duplicate it", async function () {
  var h = await harness();
  h.T.handleTermOutput({ id: "t1", data: "line1\r\n", replay: true });
  h.flushWrites();
  h.T.handleTermOutput({ id: "t1", data: "line2\r\n" });
  h.T.handleTermOutput({ id: "t1", data: "line1\r\nline2\r\n", replay: true });
  h.flushWrites();
  assert.equal(h.xterm.text, "line1\r\nline2\r\n");
});

test("key handler: initToolbar keeps one handler, so Cmd/Ctrl+C, Cmd/Ctrl+V and the toolbar Ctrl all work", async function () {
  var h = await harness({ touch: true });
  assert.equal(h.keyHandlerRegistrations(), 1, "a second handler would replace the first");

  // Arm the toolbar's virtual Ctrl.
  var ctrlBtn = { dataset: { key: "ctrl" }, classList: { toggle: function () {}, remove: function () {} } };
  h.toolbar._listeners.click[0]({ target: { closest: function () { return ctrlBtn; } } });
  assert.equal(h.xterm.keyHandler({ type: "keydown", key: "c" }), false);
  assert.deepEqual(h.inputs().map(function (m) { return [m.id, m.data]; }), [["t1", "\x03"]]);

  // Ctrl+V still goes to the browser paste event; Ctrl+C with a selection copies.
  assert.equal(h.xterm.keyHandler({ type: "keydown", key: "v", ctrlKey: true }), false);
  assert.equal(h.xterm.keyHandler({ type: "keydown", key: "c", metaKey: true }), false);
  assert.equal(h.xterm.keyHandler({ type: "keydown", key: "a" }), true);
});

// --- Server side: lib/terminal-manager.js over a stubbed PTY ---

function withStubbedPty(fn) {
  var terminalModPath = require.resolve("../lib/terminal");
  var real = require(terminalModPath);
  var ptys = [];
  require.cache[terminalModPath].exports = Object.assign({}, real, {
    createTerminal: function () {
      var pty = {
        dataHandlers: [], resizes: [],
        onData: function (h) { pty.dataHandlers.push(h); },
        onExit: function () {},
        write: function () {},
        resize: function (c, r) { pty.resizes.push([c, r]); },
        kill: function () {},
      };
      ptys.push(pty);
      return pty;
    },
  });
  try {
    delete require.cache[require.resolve("../lib/terminal-manager")];
    return fn(require("../lib/terminal-manager"), ptys);
  } finally {
    require.cache[terminalModPath].exports = real;
  }
}

function makeWs(userId, role) {
  return { _clagenticUser: userId ? { id: userId, role: role || "user" } : null, readyState: 1, send: function () {} };
}

test("terminal manager: after a reconnect the owning user's new socket can resize the PTY; other users cannot", function () {
  withStubbedPty(function (tm, ptys) {
    var mgr = tm.createTerminalManager({ cwd: "/tmp", send: function () {}, sendTo: function () {} });
    var firstSocket = makeWs("user-A");
    var session = mgr.create(80, 24, null, firstSocket);
    var reconnected = makeWs("user-A");

    mgr.resize(session.id, 120, 40, reconnected);
    assert.deepEqual(ptys[0].resizes, [[120, 40]]);

    mgr.resize(session.id, 50, 10, makeWs("user-B"));
    mgr.resize(session.id, 51, 11, makeWs("admin-1", "admin"));
    mgr.resize(session.id, 52, 12, makeWs(null));
    assert.deepEqual(ptys[0].resizes, [[120, 40]], "observers must not resize the owner's PTY");
  });
});

test("terminal manager: attach replay is marked replay, once per new subscriber", function () {
  withStubbedPty(function (tm, ptys) {
    var sentTo = [];
    var mgr = tm.createTerminalManager({ cwd: "/tmp", send: function () {}, sendTo: function (ws, m) { sentTo.push(m); } });
    var ws = makeWs("user-A");
    var session = mgr.create(80, 24, null, ws);
    ptys[0].dataHandlers.forEach(function (h) { h("scrollback"); });

    mgr.attach(session.id, ws);
    mgr.attach(session.id, ws);
    var replays = sentTo.filter(function (m) { return m.type === "term_output"; });
    assert.equal(replays.length, 1);
    assert.equal(replays[0].replay, true);
    assert.equal(replays[0].data, "scrollback");
  });
});
