"use strict";
// Client-side coverage for permission cards: a click only moves the card to a
// pending state, the final label comes from the server's permission_resolved,
// a dead socket never produces an "Allowed" card, and a reconnect replay of a
// still-pending request yields a clickable card.
//
// Drives the real tools.js exports against a small hand-built DOM (no jsdom
// dependency in this repo; same approach as the sidebar rename lifecycle test).

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");

function FakeClassList(el) { this._el = el; }
FakeClassList.prototype._set = function () {
  var s = (this._el.className || "").split(/\s+/).filter(Boolean);
  return s;
};
FakeClassList.prototype.add = function () {
  var s = this._set();
  for (var i = 0; i < arguments.length; i++) if (s.indexOf(arguments[i]) === -1) s.push(arguments[i]);
  this._el.className = s.join(" ");
};
FakeClassList.prototype.remove = function () {
  var rm = Array.prototype.slice.call(arguments);
  this._el.className = this._set().filter(function (c) { return rm.indexOf(c) === -1; }).join(" ");
};
FakeClassList.prototype.contains = function (c) { return this._set().indexOf(c) !== -1; };

function FakeElement(tag) {
  this.tagName = String(tag || "div").toUpperCase();
  this.className = "";
  this.dataset = {};
  this.style = {};
  this.disabled = false;
  this.value = "";
  this._children = [];
  this._parent = null;
  this._listeners = {};
  this._text = "";
  this.classList = new FakeClassList(this);
}
FakeElement.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); };
FakeElement.prototype.click = function () {
  if (this.disabled) return;
  (this._listeners.click || []).slice().forEach(function (fn) { fn({}); });
};
FakeElement.prototype.focus = function () {};
FakeElement.prototype.appendChild =function (c) { c._parent = this; this._children.push(c); return c; };
FakeElement.prototype.remove = function () {
  if (!this._parent) return;
  var p = this._parent;
  p._children = p._children.filter(function (c) { return c !== this; }, this);
  this._parent = null;
};
Object.defineProperty(FakeElement.prototype, "parentNode", { get: function () { return this._parent; } });
Object.defineProperty(FakeElement.prototype, "innerHTML", {
  get: function () { return this._text; },
  set: function (v) { this._children = []; this._text = String(v); },
});
Object.defineProperty(FakeElement.prototype, "textContent", {
  get: function () {
    return this._text + this._children.map(function (c) { return c.textContent; }).join("");
  },
  set: function (v) { this._children = []; this._text = String(v); },
});

function matches(el, sel) {
  return sel.split(",").some(function (part) {
    part = part.trim();
    var parts = part.match(/\.[\w-]+|\[[^\]]+\]|^[a-z]+/g) || [];
    return parts.length > 0 && parts.every(function (p) {
      if (p[0] === ".") return el.classList.contains(p.slice(1));
      if (p[0] === "[") {
        var m = /\[([\w-]+)="([^"]*)"\]/.exec(p);
        var key = m[1].slice(5).replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
        return el.dataset[key] === m[2];
      }
      return el.tagName === p.toUpperCase();
    });
  });
}
FakeElement.prototype.querySelectorAll = function (sel) {
  var out = [];
  (function walk(n) {
    n._children.forEach(function (c) { if (matches(c, sel)) out.push(c); walk(c); });
  })(this);
  return out;
};
FakeElement.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };

var doc;
function setupGlobals() {
  doc = {
    createElement: function (t) { return new FakeElement(t); },
    getElementById: function () { return null; },
    addEventListener: function () {},
    querySelector: function () { return null; },
    body: new FakeElement("body"),
  };
  global.document = doc;
  global.window = { innerWidth: 1280, innerHeight: 800, addEventListener: function () {}, removeEventListener: function () {} };
  global.lucide = { createIcons: function () {} };
  global.requestAnimationFrame = function () { return 0; };
  global.cancelAnimationFrame = function () {};
  var backing = {};
  global.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null; },
    setItem: function (k, v) { backing[k] = String(v); },
    removeItem: function (k) { delete backing[k]; },
  };
  Object.defineProperty(global, "navigator", { configurable: true, value: { userAgent: "node-test-stub", clipboard: {} } });
  global.marked = { use: function () {}, parse: function (s) { return s; } };
  global.mermaid = { initialize: function () {} };
  global.DOMPurify = { sanitize: function (s) { return s; } };
  global.hljs = { highlightElement: function () {} };
  global.twemoji = { parse: function () {} };
  global.location = { pathname: "/p/test/" };
}

var MODULES = path.join(__dirname, "..", "lib", "public", "modules");
function url(name) { return pathToFileURL(path.join(MODULES, name)).href; }

// Timers are mocked for every test so unconfirmed-card ack timeouts never
// hold the test process open; they are restored automatically per test.
async function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  setupGlobals();
  var tools = await import(url("tools.js"));
  var storeMod = await import(url("store.js"));
  storeMod.createStore({ connected: true });
  var messagesEl = new FakeElement("div");
  var sent = [];
  var ctx = {
    ws: { send: function (body) { sent.push(JSON.parse(body)); } },
    connected: true,
    messagesEl: messagesEl,
    finalizeAssistantBlock: function () {},
    addToMessages: function (el) { messagesEl.appendChild(el); },
    scrollToBottom: function () {},
    stopUrgentBlink: function () {},
  };
  tools.initTools(ctx);
  tools.resetToolState();
  return { tools: tools, ctx: ctx, messagesEl: messagesEl, sent: sent };
}

function card(env, id) { return env.messagesEl.querySelector('[data-request-id="' + id + '"]'); }
// The fake DOM does not parse innerHTML, so the decision label is read back
// from the raw markup the module wrote into the actions container.
function label(c) {
  var m = /permission-decision-label">([^<]*)</.exec(c.textContent);
  return m ? m[1] : "";
}
// The formal (bubble) and conversational (channel) layouts use different classes.
function allowSessionBtn(c) { return c.querySelector(".permission-allow-session, .perm-always"); }

test("a click while the socket is down leaves the card undecided and clickable", async function (t) {
  var env = await setup(t);
  env.ctx.connected = false;
  env.tools.renderPermissionRequest("r1", "Write", { file_path: "/tmp/x" }, "");
  var c = card(env, "r1");

  allowSessionBtn(c).click();

  assert.equal(env.sent.length, 0);
  assert.ok(!c.classList.contains("resolved"));
  assert.ok(!c.classList.contains("resolved-allowed"));
  assert.equal(label(c), "");
  assert.equal(allowSessionBtn(c).disabled, false);
  assert.match(c.textContent, /Not connected/);
});

test("a click while connected shows a pending state, not a decision, until the server confirms", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r2", "Write", { file_path: "/tmp/x" }, "");
  var c = card(env, "r2");

  allowSessionBtn(c).click();

  assert.deepEqual(env.sent, [{ type: "permission_response", requestId: "r2", decision: "allow_always" }]);
  assert.ok(c.classList.contains("sending"));
  assert.ok(!c.classList.contains("resolved"));
  assert.doesNotMatch(c.textContent, /Allowed/);
  assert.match(c.textContent, /Sending/);
  assert.equal(allowSessionBtn(c).disabled, true);

  env.tools.markPermissionResolved("r2", "allow_always");

  assert.ok(c.classList.contains("resolved-allowed"));
  assert.equal(label(c), "Allowed for session");
  assert.ok(!c.classList.contains("sending"));
  assert.doesNotMatch(c.textContent, /Sending/);
});

test("a decision the server never confirms is offered again after the ack timeout", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r3", "Write", { file_path: "/tmp/x" }, "");
  var c = card(env, "r3");
  allowSessionBtn(c).click();
  assert.ok(c.classList.contains("sending"));

  t.mock.timers.tick(10000);

  assert.ok(!c.classList.contains("sending"));
  assert.ok(!c.classList.contains("resolved"));
  assert.equal(allowSessionBtn(c).disabled, false);
  assert.match(c.textContent, /No confirmation/);
});

test("a socket drop restores every card awaiting confirmation", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r4", "Write", { file_path: "/tmp/x" }, "");
  var c = card(env, "r4");
  allowSessionBtn(c).click();

  env.tools.restoreUnconfirmedPermissions("Connection lost");

  assert.ok(!c.classList.contains("sending"));
  assert.equal(allowSessionBtn(c).disabled, false);
  assert.match(c.textContent, /Connection lost/);
});

test("reconnect replay of a still-pending request turns an unconfirmed card back into a clickable one", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r5", "Write", { file_path: "/tmp/x" }, "");
  var first = card(env, "r5");
  allowSessionBtn(first).click();
  assert.ok(first.classList.contains("sending"));

  env.tools.renderPermissionRequest("r5", "Write", { file_path: "/tmp/x" }, "", undefined, undefined, true);

  var replayed = card(env, "r5");
  assert.ok(replayed, "a card must exist for the pending request");
  assert.ok(!replayed.classList.contains("sending"));
  assert.ok(!replayed.classList.contains("resolved"));
  assert.equal(allowSessionBtn(replayed).disabled, false);
  assert.equal(env.messagesEl.querySelectorAll('[data-request-id="r5"]').length, 1);
});

test("history replay of a request without the server-pending flag does not duplicate or reset a card", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r6", "Write", { file_path: "/tmp/x" }, "");
  var first = card(env, "r6");
  allowSessionBtn(first).click();

  env.tools.renderPermissionRequest("r6", "Write", { file_path: "/tmp/x" }, "");

  assert.equal(card(env, "r6"), first);
  assert.ok(first.classList.contains("sending"));
});

test("a stale reply renders as no longer active instead of leaving an actionable card", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r7", "Write", { file_path: "/tmp/x" }, "");
  var c = card(env, "r7");
  allowSessionBtn(c).click();

  env.tools.markPermissionCancelled("r7", "stale");

  assert.ok(c.classList.contains("resolved"));
  assert.ok(!c.classList.contains("resolved-allowed"));
  assert.match(label(c), /No longer active/);
});

test("plan approval also stays pending until confirmed and is restorable", async function (t) {
  var env = await setup(t);
  env.tools.renderPermissionRequest("r8", "ExitPlanMode", {}, "");
  var c = card(env, "r8");
  var approve = c.querySelector(".permission-allow");

  approve.click();

  assert.equal(env.sent[0].decision, "allow_accept_edits");
  assert.ok(c.classList.contains("sending"));
  assert.doesNotMatch(c.textContent, /Approved/);

  env.tools.restoreUnconfirmedPermissions("Connection lost");

  assert.equal(c.querySelector(".permission-allow").disabled, false);
  assert.equal(c.querySelector(".plan-feedback-send").disabled, true, "feedback send stays disabled while the input is empty");
});
