"use strict";
// One assistant reply is a run of consecutive "delta" history records. History
// pages (initial replay and scroll-up) must never start inside such a run, and
// an initial replay that ends while the session is still processing must leave
// the open assistant block open so live deltas append to it.
//
// Server side drives the real lib/sessions.js; client side drives the real
// lib/public ESM graph under Node with the shared fake browser globals.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { pathToFileURL } = require("url");
var { installBrowserGlobals } = require("./helpers/fake-browser-globals.js");

var MODULES = path.join(__dirname, "..", "lib", "public", "modules");
function modUrl(name) { return pathToFileURL(path.join(MODULES, name)).href; }
var APP_JS_URL = pathToFileURL(path.join(__dirname, "..", "lib", "public", "app.js")).href;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Text of a reply split into `count` pieces: a code fence opened in piece 40
// and closed in piece 120, an angle-bracket placeholder inside it, and a word
// split across pieces 99/100 (1-based).
function replyPieces(count) {
  var pieces = [];
  for (var i = 1; i <= count; i++) {
    var t = "p" + i + " ";
    if (i === 40) t = "```js\nconst x = <placeholder>;\n";
    if (i === 99) t = "inter";
    if (i === 100) t = "face ";
    if (i === 120) t = "\n```\n";
    pieces.push(t);
  }
  return pieces;
}

function deltas(pieces) { return pieces.map(function (t) { return { type: "delta", text: t }; }); }
function user(text) { return { type: "user_message", text: text }; }
function bash(i) { return { type: "tool_start", id: "b" + i, name: "Bash" }; }

function filler(n, make) { var out = []; for (var i = 0; i < n; i++) out.push(make(i)); return out; }

var PAGE_ROWS = [
  {
    name: "150 deltas after one user_message",
    history: [user("q")].concat(deltas(replyPieces(150))),
    starts: [1, 0],
  },
  {
    name: "run longer than the page size, followed by another turn",
    history: [user("q")].concat(deltas(replyPieces(250)), [user("next")], deltas(replyPieces(10))),
    starts: [251, 1, 0],
  },
  {
    name: "run starting exactly at the page edge keeps its boundary",
    history: [user("q")].concat(filler(50, bash), deltas(replyPieces(100))),
    starts: [51, 0],
  },
  {
    name: "short turns keep their user_message boundaries",
    history: filler(65, function (i) { return [user("q" + i), { type: "delta", text: "a" }]; }).reduce(function (a, b) { return a.concat(b); }, []),
    starts: [128, 28, 0],
  },
];

// ---------------------------------------------------------------------------
// Server: page boundaries
// ---------------------------------------------------------------------------

function makeSessionManager(tmpHome, captured, extraOpts) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessions;
  try {
    sessions = require("../lib/sessions");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  return sessions.createSessionManager(Object.assign({
    cwd: tmpHome,
    send: function (obj) { captured.push(obj); },
    sendTo: function (ws, obj) { captured.push(obj); },
    sendEach: function () {},
  }, extraOpts || {}));
}

function sessionWithHistory(sm, history) {
  var sess = sm.createSessionRaw({});
  sess.cliSessionId = "sess-delta-run";
  sm.saveSessionFile(sess);
  history.forEach(function (e) { sm.sendAndRecord(sess, Object.assign({}, e)); });
  return sess;
}

// What the load_more_history handler (lib/project-sessions.js) computes for a
// page ending at `before` (absolute index): from the heap when the window
// lies inside it, from the full on-disk history when it reaches below the
// trimmed head.
function olderPage(sm, sess, before) {
  var base = sess._historyBaseIndex || 0;
  var target = Math.max(0, before - sm.HISTORY_PAGE_SIZE);
  if (target >= base) {
    var heapFrom = sm.extendWindowForVisibility(sess.history, sm.findTurnBoundary(sess.history, target - base), before - base);
    return { from: base + heapFrom, items: sess.history.slice(heapFrom, before - base) };
  }
  var disk = sm.readSessionHistoryFromDisk(sess);
  var diskFrom = sm.extendWindowForVisibility(disk, sm.findTurnBoundary(disk, target), before);
  return { from: diskFrom, items: disk.slice(diskFrom, before) };
}

function olderPageFrom(sm, sess, before) { return olderPage(sm, sess, before).from; }

function pageStarts(sm, sess, captured) {
  captured.length = 0;
  sm.replayHistory(sess, undefined, {});
  var starts = [captured.filter(function (m) { return m.type === "history_meta"; })[0].from];
  while (starts[starts.length - 1] > 0) starts.push(olderPageFrom(sm, sess, starts[starts.length - 1]));
  return starts;
}

PAGE_ROWS.forEach(function (row) {
  test("history pages: " + row.name, function () {
    var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-deltarun-"));
    try {
      var captured = [];
      var sm = makeSessionManager(tmpHome, captured);
      var sess = sessionWithHistory(sm, row.history);
      var starts = pageStarts(sm, sess, captured);
      starts.forEach(function (s) {
        var midRun = s > 0 && sess.history[s].type === "delta" && sess.history[s - 1].type === "delta";
        assert.equal(midRun, false, "page starting at " + s + " cuts inside a delta run");
      });
      assert.deepEqual(starts, row.starts);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Client: one message, one header
// ---------------------------------------------------------------------------

var sockets = [];
var parsed = [];
var created = [];
var mods;

test.before(async function () {
  installBrowserGlobals({
    sockets: sockets,
    onParse: function (s) { parsed.push(s); },
    // Never fires: the draw loop is paused, finalize/flush render the text.
    requestAnimationFrame: function () { return 1; },
  });
  var realCreate = global.document.createElement;
  global.document.createElement = function (tag) {
    var el = realCreate(tag);
    created.push(el);
    return el;
  };
  await import(APP_JS_URL);
  mods = {
    handlers: await import(modUrl("app-messages.js")),
    header: await import(modUrl("app-header.js")),
    projects: await import(modUrl("app-projects.js")),
    rendering: await import(modUrl("app-rendering.js")),
    store: await import(modUrl("store.js")),
  };
});

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }

function assistantEls() {
  return created.filter(function (el) { return el.className === "msg-assistant"; });
}

function resetClient(processing) {
  mods.projects.resetClientState();
  mods.store.store.set({ sessionIsProcessing: !!processing });
  created.length = 0;
  parsed.length = 0;
}

// Replays the server's initial page, then prepends every older page.
function replayAndPrepend(sm, sess, captured) {
  var h = mods.handlers;
  captured.length = 0;
  sm.replayHistory(sess, undefined, {});
  var initial = captured.slice();
  initial.forEach(function (m) { h.processMessage(m); });
  var from = initial[0].from;
  while (from > 0) {
    var page = olderPage(sm, sess, from);
    mods.header.prependOlderHistory(page.items, { from: page.from, to: from, hasMore: page.from > 0 });
    from = page.from;
  }
}

test("a 150-delta reply replayed then prepended renders one message with the fence paired", async function () {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-deltarun-"));
  try {
    var captured = [];
    var sm = makeSessionManager(tmpHome, captured);
    var pieces = replyPieces(150);
    var sess = sessionWithHistory(sm, [user("q")].concat(deltas(pieces)));
    resetClient(false);
    replayAndPrepend(sm, sess, captured);
    await tick(20);
    assert.equal(assistantEls().length, 1, "one assistant message element, one header");
    var rendered = parsed[parsed.length - 1];
    assert.equal(rendered, pieces.join(""));
    assert.equal(rendered.split("```").length - 1, 2, "fence opened and closed in one render");
    assert.ok(rendered.indexOf("<placeholder>") !== -1, "angle-bracket placeholder preserved");
    assert.ok(rendered.indexOf("interface ") !== -1, "word split across pieces rejoined");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// The in-heap history is trimmed to a tail (historyInMemMax), both while a
// session records and when it is loaded from disk. A trim point inside a delta
// run leaves the reply's head on disk only, which the older-page path renders
// as a second message with its own header.
var TRIM_ROWS = [
  { name: "live trim inside a 400-delta reply", history: [user("q")].concat(deltas(replyPieces(400))), reload: false, replies: 1 },
  { name: "tail load from disk inside a 400-delta reply", history: [user("q")].concat(deltas(replyPieces(400))), reload: true, replies: 1 },
  { name: "live trim inside the second of two replies", history: [user("q")].concat(deltas(replyPieces(30)), [user("next")], deltas(replyPieces(300))), reload: false, replies: 2 },
  { name: "tail load from disk inside the second of two replies", history: [user("q")].concat(deltas(replyPieces(30)), [user("next")], deltas(replyPieces(300))), reload: true, replies: 2 },
];

TRIM_ROWS.forEach(function (row) {
  test("heap trim: " + row.name, async function () {
    var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-deltarun-"));
    try {
      var captured = [];
      var sm = makeSessionManager(tmpHome, captured, { historyInMemMax: 150 });
      var sess = sessionWithHistory(sm, row.history);
      if (row.reload) {
        sess._historyLoaded = false;
        sm.loadSessionHistory(sess);
      }
      assert.ok(sess._historyBaseIndex > 0, "the heap was trimmed");
      resetClient(false);
      replayAndPrepend(sm, sess, captured);
      await tick(20);
      assert.equal(assistantEls().length, row.replies, "one assistant message element per reply");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// Initial replay of an unfinished reply, then live deltas of the same reply.
var RECONNECT_ROWS = [
  { name: "session still processing: live deltas append to the same message", processing: true, assistants: 1, open: true },
  { name: "idle session: the block is finalized at replay end", processing: false, assistants: 2, open: false },
];

RECONNECT_ROWS.forEach(function (row) {
  test("initial replay end: " + row.name, async function () {
    var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-deltarun-"));
    try {
      var captured = [];
      var sm = makeSessionManager(tmpHome, captured);
      var sess = sessionWithHistory(sm, [user("q")].concat(deltas(["first half, "])));
      resetClient(row.processing);
      replayAndPrepend(sm, sess, captured);
      assert.equal(!!mods.store.store.get("currentMsgEl"), row.open);
      mods.handlers.processMessage({ type: "delta", text: "second half" });
      mods.rendering.finalizeAssistantBlock();
      await tick(20);
      assert.equal(assistantEls().length, row.assistants);
      if (row.open) assert.equal(parsed[parsed.length - 1], "first half, second half");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
