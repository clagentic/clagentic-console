// sidebar-sessions-rename-lifecycle-lr-16b88d.test.js
//
// Runtime LIFECYCLE regression coverage for lr-16b88d (PEACHES blocking
// review on PR #405, comment 5403402620). The source-text assertions in
// frontend-state-correlation-lr-fb49.test.js passed even when suspend()
// captured a snapshot but did NOT settle the rename, so a rebuild's
// innerHTML="" teardown still fired a synthetic blur on the detached
// <input> and committed the suspended partial edit as a real
// rename_session — the exact defect this task exists to fix. Source-text
// assertions cannot catch a runtime event-ordering defect, so this file
// drives the REAL exported renderSessionList() end-to-end: real session
// item -> real contextmenu -> real "Rename" click -> real (module-private,
// correctly unexported) startInlineRename closure -> a real detach-induced
// synthetic blur -> asserting on the real WS sends that would carry a
// partial rename_session.
//
// This required climbing sidebar-sessions.js's REAL import graph (it
// directly imports sidebar.js, app-projects.js, session-search.js,
// sidebar-mobile.js, agent-picker.js — a large slice of the frontend) far
// enough to let a genuine `node --test` process finish importing it and
// call real, unmodified production functions (initSidebar, renderSessionList,
// the context-menu click handlers). No jsdom, no new dependency: everything
// below is either (a) a minimal generic hand-built DOM stub implementing
// only the small surface these modules actually call — querySelector/
// querySelectorAll via a real child-tree walk, appendChild/remove/
// removeChild, classList, dataset, event listeners + dispatch, and, the one
// behavior this whole defect class hinges on, innerHTML="" synthesizing a
// real "blur" on any currently-focused descendant BEFORE it is torn down,
// exactly matching real browser/jsdom ordering — or (b) trivial no-op stubs
// for third-party browser-global libraries (marked, mermaid, DOMPurify,
// hljs, twemoji, lucide) that unrelated modules in the same import graph
// configure unconditionally at module top level. Class (b) stubs make NO
// claim about markdown/mermaid/icon rendering — they exist solely so the
// module graph finishes loading in Node.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");

// ---------------------------------------------------------------------------
// Minimal generic fake DOM
// ---------------------------------------------------------------------------

function FakeElement(doc, tagName, opts) {
  this._doc = doc;
  this.tagName = String(tagName || "div").toUpperCase();
  this._children = [];
  this._parent = null;
  this._listeners = {};
  this._html = "";
  this.className = "";
  this.dataset = {};
  this.type = "";
  this.value = "";
  this.title = "";
  this.selectionStart = 0;
  this.selectionEnd = 0;
  this._focused = false;
  // Permissive mode (used only for auto-vivified getElementById results —
  // real static-HTML-shell elements this file's tests never assert on):
  // an unmatched querySelector returns a fresh throwaway element instead of
  // null, so unguarded "document.getElementById(id).querySelector(...).
  // addEventListener(...)" chains in unrelated init code (resume-modal,
  // search inputs, etc.) succeed without this file needing to model their
  // real structure. The session-list element and everything rendered
  // beneath it (session items, rename inputs, context menus) stay STRICT —
  // this file's actual assertions depend on real null-vs-element semantics
  // there (e.g. "the old input is gone after rebuild").
  this._permissive = !!(opts && opts.permissive);
  var self = this;
  this.classList = {
    add: function () {},
    remove: function () {},
    toggle: function () {},
    contains: function () { return false; },
  };
  this.style = {};
}

FakeElement.prototype.setAttribute = function (name, value) { this[name] = value; };
FakeElement.prototype.getAttribute = function (name) { return this[name]; };

FakeElement.prototype.addEventListener = function (type, fn) {
  if (!this._listeners[type]) this._listeners[type] = [];
  this._listeners[type].push(fn);
};
FakeElement.prototype.removeEventListener = function (type, fn) {
  if (!this._listeners[type]) return;
  this._listeners[type] = this._listeners[type].filter(function (f) { return f !== fn; });
};
FakeElement.prototype.dispatch = function (type, evt) {
  var e = evt || { preventDefault: function () {}, stopPropagation: function () {} };
  (this._listeners[type] || []).slice().forEach(function (fn) { fn(e); });
};

FakeElement.prototype.appendChild = function (child) {
  this._children.push(child);
  child._parent = this;
  return child;
};
FakeElement.prototype.remove = function () {
  if (this._parent) {
    this._parent._children = this._parent._children.filter((c) => c !== this);
    this._parent = null;
  }
};
// For a permissive (auto-vivified) element with no real parent, lazily
// materialize a throwaway parent too, so an unguarded
// "el.parentElement.getBoundingClientRect()" chain in unrelated init code
// (sidebar.js's resize-handle sync) never hits null. Real, deliberately
// parent-less elements (the ones this file's tests actually assert
// contains()/detach behavior on) are never permissive, so this never
// masks a real "was this actually removed from its parent" check.
function parentOrLazyPermissive(el) {
  if (el._parent) return el._parent;
  if (el._permissive) {
    el._parent = new FakeElement(el._doc, "div", { permissive: true });
    el._parent._children.push(el);
  }
  return el._parent;
}
Object.defineProperty(FakeElement.prototype, "parentNode", {
  get: function () { return parentOrLazyPermissive(this); },
});
Object.defineProperty(FakeElement.prototype, "parentElement", {
  get: function () { return parentOrLazyPermissive(this); },
});
FakeElement.prototype.removeChild = function (child) {
  this._children = this._children.filter((c) => c !== child);
  child._parent = null;
  return child;
};
FakeElement.prototype.contains = function (node) {
  var stack = this._children.slice();
  while (stack.length) {
    var n = stack.pop();
    if (n === node) return true;
    stack = stack.concat(n._children || []);
  }
  return false;
};

function walk(el, pred, out, stopAtFirst) {
  for (var i = 0; i < el._children.length; i++) {
    var c = el._children[i];
    if (pred(c)) {
      out.push(c);
      if (stopAtFirst) return true;
    }
    if (walk(c, pred, out, stopAtFirst) && stopAtFirst) return true;
  }
  return false;
}

// Extremely small selector matcher: supports ".class", "[data-x=\"v\"]",
// and ".class[data-x=\"v\"]" combos — exactly what sidebar-sessions.js uses.
function matchesSelector(el, sel) {
  var parts = sel.match(/\.[\w-]+|\[[^\]]+\]/g) || [sel];
  return parts.every(function (p) {
    if (p[0] === ".") {
      var cls = p.slice(1);
      return (" " + (el.className || "") + " ").indexOf(" " + cls + " ") !== -1;
    }
    if (p[0] === "[") {
      var m = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(p);
      if (!m) return false;
      var attr = m[1];
      var val = m[2];
      var key = attr.indexOf("data-") === 0 ? attr.slice(5).replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }) : attr;
      var actual = attr.indexOf("data-") === 0 ? el.dataset[key] : el[attr];
      if (val === undefined) return actual !== undefined && actual !== null;
      return String(actual) === val;
    }
    return false;
  });
}

FakeElement.prototype.querySelector = function (sel) {
  var out = [];
  walk(this, function (el) { return matchesSelector(el, sel); }, out, true);
  if (out[0]) return out[0];
  if (this._permissive) return new FakeElement(this._doc, "div", { permissive: true });
  return null;
};
FakeElement.prototype.querySelectorAll = function (sel) {
  var out = [];
  walk(this, function (el) { return matchesSelector(el, sel); }, out, false);
  return out;
};

FakeElement.prototype.getBoundingClientRect = function () {
  return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
};

FakeElement.prototype.focus = function () {
  this._focused = true;
  this._doc.activeElement = this;
};
FakeElement.prototype.select = function () {
  this.selectionStart = 0;
  this.selectionEnd = (this.value || "").length;
};
FakeElement.prototype.setSelectionRange = function (s, e) {
  this.selectionStart = s;
  this.selectionEnd = e;
};

Object.defineProperty(FakeElement.prototype, "innerHTML", {
  get: function () { return this._html; },
  set: function (v) {
    // DETACH SEMANTICS (the mechanism this whole defect class hinges on):
    // real browsers/jsdom synthesize a "blur" event on the currently
    // focused element the instant it (or an ancestor) is removed from the
    // document via innerHTML="", and that element's blur listener is still
    // attached at the moment the synthetic event fires. Reproduce exactly
    // that ordering here, recursively over the whole subtree being cleared.
    var doc = this._doc;
    var stack = this._children.slice();
    while (stack.length) {
      var node = stack.pop();
      if (doc.activeElement === node) {
        node.dispatch("blur", {});
        doc.activeElement = null;
      }
      stack = stack.concat(node._children || []);
    }
    this._children = [];
    this._html = v;
  },
});
Object.defineProperty(FakeElement.prototype, "textContent", {
  get: function () { return this._html; },
  set: function (v) { this.innerHTML = String(v); },
});

function FakeDocument() {
  this._byId = {};
  this.activeElement = null;
  this.body = new FakeElement(this, "body");
}
FakeDocument.prototype.createElement = function (tag) {
  return new FakeElement(this, tag);
};
// Returns a fresh generic (permissive) element for ANY id not explicitly
// registered via registerById — several of sidebar-sessions.js's own DOM
// lookups at initSidebarSessions() time are unguarded (no "if (el)" check
// before .addEventListener), matching real app boot where these elements
// always exist in the real page's static HTML shell. A generic throwaway
// element here satisfies that without asserting anything about those
// unrelated UI surfaces (search input, resume modal, etc.) — none of which
// this file's tests exercise or assert on.
FakeDocument.prototype.getElementById = function (id) {
  if (!this._byId[id]) this._byId[id] = new FakeElement(this, "div", { permissive: true });
  return this._byId[id];
};
FakeDocument.prototype.registerById = function (id, el) {
  this._byId[id] = el;
};
FakeDocument.prototype.addEventListener = function () {};
FakeDocument.prototype.querySelector = function () { return null; };

// ---------------------------------------------------------------------------
// Module load — real ESM import against the stubbed globals.
// ---------------------------------------------------------------------------

var SIDEBAR_SESSIONS_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions.js")
).href;

var sidebarSessions;
var fakeDoc;
var sentMessages;

// dom-refs.js's getSessionListEl() lazily caches document.getElementById
// ("session-list") on FIRST CALL and never re-reads `document` again for
// the lifetime of the process (see dom-refs.js's own `ref()` helper) —
// dom-refs.js is a real cached ESM module singleton shared across every
// test in this file, same as sidebar-sessions.js/sidebar.js/store.js/
// ws-ref.js. So the actual <div id="session-list"> element object must be
// created ONCE (here, at file scope) and REUSED across every test's fresh
// fakeDoc/setupFakeGlobals() call — swapping `global.document` between
// tests would otherwise leave dom-refs.js's cache pointing at test 1's
// stale element while later tests render into a different one, which is a
// test-harness bug, not a module bug (this was diagnosed via a real
// failing run: renderSessionList() appeared to render nothing on test 2+).
var sharedSessionListEl = null;

function makeFakeWs() {
  return {
    readyState: 1,
    send: function (body) { sentMessages.push(JSON.parse(body)); },
  };
}

function setupFakeGlobals() {
  fakeDoc = new FakeDocument();
  if (!sharedSessionListEl) {
    sharedSessionListEl = new FakeElement(fakeDoc, "div");
  } else {
    // Reset for reuse in this test: same object identity (what dom-refs.js's
    // cache holds), fresh contents.
    sharedSessionListEl._doc = fakeDoc;
    sharedSessionListEl._children = [];
    sharedSessionListEl._html = "";
    sharedSessionListEl._listeners = {};
  }
  var sessionListEl = sharedSessionListEl;
  fakeDoc.registerById("session-list", sessionListEl);
  global.document = fakeDoc;
  // window: the rename lifecycle itself never touches window, but several
  // modules pulled in transitively by sidebar-sessions.js's own import
  // graph (e.g. tool-palette.js) register window-level listeners at MODULE
  // TOP LEVEL (import time), not inside a function — so a bare {innerWidth,
  // innerHeight} stub is not enough; window needs real (no-op) listener
  // methods too, purely to let those unrelated modules finish importing.
  global.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: function () {},
    removeEventListener: function () {},
  };
  global.lucide = { createIcons: function () {} };
  global.requestAnimationFrame = function () { return 0; }; // never fires — menu positioning is not under test
  global.cancelAnimationFrame = function () {};
  var localStorageBacking = {};
  global.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(localStorageBacking, k) ? localStorageBacking[k] : null; },
    setItem: function (k, v) { localStorageBacking[k] = String(v); },
    removeItem: function (k) { delete localStorageBacking[k]; },
  };
  // Node's own global.navigator is a getter-only accessor in modern Node —
  // must redefine, not assign.
  Object.defineProperty(global, "navigator", {
    configurable: true,
    value: { userAgent: "node-test-stub", clipboard: { writeText: function () { return Promise.resolve(); } } },
  });
  // markdown.js (pulled in transitively via the real import graph — see
  // this file's header) configures the real browser-global marked /
  // mermaid libraries UNCONDITIONALLY at module top level (marked.use(...),
  // mermaid.initialize(...)) — these are real third-party libraries loaded
  // as <script> globals in the real app, not npm imports this test can
  // substitute a real implementation for. No-op stubs here only get import
  // to complete; they are not a claim that markdown rendering is exercised.
  global.marked = { use: function () {}, parse: function (s) { return s; } };
  global.mermaid = { initialize: function () {} };
  global.DOMPurify = { sanitize: function (s) { return s; } };
  global.hljs = { highlightElement: function () {} };
  global.twemoji = { parse: function () {} };
  sentMessages = [];
  return sessionListEl;
}

var SIDEBAR_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "sidebar.js")
).href;
var WS_REF_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "ws-ref.js")
).href;
var STORE_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "store.js")
).href;

// sidebar.js's updatePageTitle() (called at the end of renderSessionList())
// reads its OWN module-private ctx.sessionListEl, separate from dom-refs.js's
// document.getElementById cache — real app boot wires this via initSidebar().
// A permissive ctx here (every ctx.$() lookup returns a fresh throwaway
// element so every "if (x) x.addEventListener(...)" guard in initSidebar /
// initSidebarSessions / initSidebarProjects / initSidebarMobile succeeds
// without throwing) is enough to satisfy initSidebar's own setup without
// asserting anything about those unrelated sub-panels' behavior.
function makeFakeCtx(sessionListEl) {
  return {
    sessionListEl: sessionListEl,
    headerTitleEl: null,
    projectName: "test-project",
    sidebar: new FakeElement(fakeDoc, "div"),
    sidebarOverlay: new FakeElement(fakeDoc, "div"),
    hamburgerBtn: new FakeElement(fakeDoc, "button"),
    sidebarToggleBtn: null,
    sidebarExpandBtn: null,
    newSessionBtn: null,
    ws: null,
    connected: false,
    $: function () { return new FakeElement(fakeDoc, "div"); },
  };
}

// Shared setup for every test below: fresh fake DOM + globals, real ESM
// import of sidebar-sessions.js/sidebar.js/ws-ref.js/store.js (module
// instances are cached by Node after the first import — reused, not
// re-created — so this also re-wires the shared module-private state
// (sidebar.js's ctx, ws-ref.js's _ws, store.js's _state) fresh for each
// test rather than leaking state across tests).
function setupModules(sessionListEl) {
  return Promise.all([
    import(SIDEBAR_SESSIONS_URL),
    import(SIDEBAR_URL),
    import(WS_REF_URL),
    import(STORE_URL),
  ]).then(function (mods) {
    sidebarSessions = mods[0];
    var sidebar = mods[1];
    var wsRef = mods[2];
    var storeMod = mods[3];
    storeMod.createStore({ connected: true, myUserId: "u1" });
    wsRef.setWs(makeFakeWs());
    sidebar.initSidebar(makeFakeCtx(sessionListEl));
    return { sidebarSessions: sidebarSessions, sidebar: sidebar, wsRef: wsRef, store: storeMod };
  });
}

test("lr-16b88d: sidebar-sessions.js loads as a real ESM module against the stubbed DOM globals, and real initSidebar() wiring succeeds", { timeout: 10000 }, function () {
  var sessionListEl = setupFakeGlobals();
  global.location = { pathname: "/p/test-project/" };
  return setupModules(sessionListEl).then(function (m) {
    assert.equal(typeof m.sidebarSessions.renderSessionList, "function");
  });
});

// Drives a session list render, opens the real context menu on a session
// item, and clicks "Rename" — reaching the module's real (unexported,
// correctly so) startInlineRename via its only real entry point.
function openRealInlineRename(sessionListEl, sessionId, title) {
  sidebarSessions.renderSessionList([{ id: sessionId, title: title, lastActivity: Date.now() }]);
  var itemEl = sessionListEl.querySelector('[data-session-id="' + sessionId + '"]');
  assert.ok(itemEl, "renderSessionList must have rendered a session-item for id " + sessionId);
  itemEl.dispatch("contextmenu", { preventDefault: function () {}, stopPropagation: function () {} });
  var renameBtn = null;
  fakeDoc.body._children.forEach(function (menu) {
    (menu._children || []).forEach(function (btn) {
      if ((btn._html || "").indexOf("Rename") !== -1) renameBtn = btn;
    });
  });
  assert.ok(renameBtn, "context menu must render a Rename item");
  renameBtn.dispatch("click", { stopPropagation: function () {} });
  var input = itemEl.querySelector(".session-rename-input");
  assert.ok(input, "startInlineRename must have installed a rename <input> in the session item");
  return input;
}

test("lr-16b88d: renderSessionList's rebuild-induced detach does NOT commit a suspended in-progress rename (defect #1)", function () {
  var sessionListEl = setupFakeGlobals();
  return setupModules(sessionListEl).then(function () {
    var input = openRealInlineRename(sessionListEl, 42, "Old Title");
    input.value = "partial title typed while streaming";
    // Do NOT blur/Enter — this is the in-progress, uncommitted edit.

    // Simulate the next session_list broadcast from an actively-streaming
    // session: same session, unchanged title (server hasn't seen a commit),
    // but lastActivity moves forward — this is exactly what makes the
    // fingerprint differ and a REAL rebuild run (per the task's own root-
    // cause note: lastActivity changes on nearly every broadcast).
    sidebarSessions.renderSessionList([{ id: 42, title: "Old Title", lastActivity: Date.now() + 1000 }]);

    var renameSends = sentMessages.filter(function (m) { return m.type === "rename_session"; });
    assert.equal(renameSends.length, 0,
      "a session_list broadcast arriving mid-edit must NOT send rename_session for the suspended partial text — " +
      "this is PEACHES defect #1 (suspend() must settle the rename so the detach-induced blur is a no-op)");
  });
});

test("lr-16b88d: the rebuild re-opens the rename with the exact suspended value + caret restored (acceptance: holds focus and in-progress text)", function () {
  var sessionListEl = setupFakeGlobals();
  return setupModules(sessionListEl).then(function () {
    var input = openRealInlineRename(sessionListEl, 7, "Old Title");
    input.value = "typing mid-turn";
    input.setSelectionRange(3, 6);

    sidebarSessions.renderSessionList([{ id: 7, title: "Old Title", lastActivity: Date.now() + 1000 }]);

    var itemEl = sessionListEl.querySelector('[data-session-id="7"]');
    var newInput = itemEl.querySelector(".session-rename-input");
    assert.ok(newInput, "a rename <input> must be re-opened after the rebuild");
    assert.notEqual(newInput, input, "the re-opened input must be a new element (the old one was torn down)");
    assert.equal(newInput.value, "typing mid-turn", "the re-opened input must restore the exact suspended value");
    assert.equal(newInput.selectionStart, 3, "the re-opened input must restore the caret start");
    assert.equal(newInput.selectionEnd, 6, "the re-opened input must restore the caret end");

    // Now a REAL commit (Enter) on the re-opened input must work normally —
    // proves the resumed rename is not itself stuck settled.
    newInput.dispatch("keydown", { key: "Enter", preventDefault: function () {} });
    var renameSends = sentMessages.filter(function (m) { return m.type === "rename_session"; });
    assert.equal(renameSends.length, 1, "a real Enter on the re-opened rename must commit exactly once");
    assert.equal(renameSends[0].title, "typing mid-turn");
  });
});

test("lr-16b88d: a rebuild whose target session has vanished (deleted) leaves no committable activeRename (defect #2)", function () {
  var sessionListEl = setupFakeGlobals();
  return setupModules(sessionListEl).then(function () {
    var input = openRealInlineRename(sessionListEl, 99, "Doomed Session");
    input.value = "still typing when it gets deleted";

    // Session 99 is gone from the next broadcast (deleted mid-edit).
    sidebarSessions.renderSessionList([{ id: 1, title: "Unrelated", lastActivity: Date.now() + 1000 }]);

    // No rename_session for the vanished/abandoned edit.
    var renameSends = sentMessages.filter(function (m) { return m.type === "rename_session"; });
    assert.equal(renameSends.length, 0, "an in-progress edit on a deleted session must never send rename_session");

    // A brand-new rename on session 1 must work cleanly — if a stale
    // activeRename from the vanished session 99 survived, opening this new
    // rename would call its stale .commit() first (PEACHES defect #2/#3),
    // which — since session 99 no longer exists in the DOM — would either
    // throw or silently misbehave. Assert it works cleanly instead.
    var newInput = openRealInlineRename(sessionListEl, 1, "Unrelated");
    newInput.value = "brand new rename";
    newInput.dispatch("keydown", { key: "Enter", preventDefault: function () {} });

    var allRenameSends = sentMessages.filter(function (m) { return m.type === "rename_session"; });
    assert.equal(allRenameSends.length, 1, "exactly one rename_session must be sent — for the NEW rename only, never for the vanished session's abandoned edit");
    assert.equal(allRenameSends[0].id, 1);
    assert.equal(allRenameSends[0].title, "brand new rename");
  });
});

test("lr-16b88d: re-opening a suspended rename does not itself send a second partial commit (defect #3)", function () {
  var sessionListEl = setupFakeGlobals();
  return setupModules(sessionListEl).then(function () {
    var input = openRealInlineRename(sessionListEl, 5, "Title A");
    input.value = "in progress";

    // Two consecutive real rebuilds in a row (two broadcasts arriving back
    // to back) — the resume path itself must never fire a commit, even
    // when it runs twice.
    sidebarSessions.renderSessionList([{ id: 5, title: "Title A", lastActivity: Date.now() + 1000 }]);
    sidebarSessions.renderSessionList([{ id: 5, title: "Title A", lastActivity: Date.now() + 2000 }]);

    var renameSends = sentMessages.filter(function (m) { return m.type === "rename_session"; });
    assert.equal(renameSends.length, 0, "re-opening a suspended rename across multiple consecutive rebuilds must never itself send rename_session");

    var itemEl = sessionListEl.querySelector('[data-session-id="5"]');
    var finalInput = itemEl.querySelector(".session-rename-input");
    assert.equal(finalInput.value, "in progress", "the value must still be the original in-progress edit after two suspend/resume cycles");
  });
});
