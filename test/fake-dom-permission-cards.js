"use strict";
// Hand-built DOM (no jsdom in this repo) sufficient to drive the real tools.js
// permission-card exports. Shared helper, not a test file: the runner only
// collects test/*.test.js.

var path = require("path");
var { pathToFileURL } = require("url");

function FakeClassList(el) { this._el = el; }
FakeClassList.prototype._set = function () {
  return (this._el.className || "").split(/\s+/).filter(Boolean);
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
FakeElement.prototype.appendChild = function (c) { c._parent = this; this._children.push(c); return c; };
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

function setupGlobals() {
  global.document = {
    createElement: function (t) { return new FakeElement(t); },
    getElementById: function () { return null; },
    addEventListener: function () {},
    querySelector: function () { return null; },
    body: new FakeElement("body"),
  };
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
function moduleUrl(name) { return pathToFileURL(path.join(MODULES, name)).href; }

async function setupToolsEnv(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  setupGlobals();
  var tools = await import(moduleUrl("tools.js"));
  var storeMod = await import(moduleUrl("store.js"));
  storeMod.createStore({ connected: true });
  var messagesEl = new FakeElement("div");
  var ctx = {
    ws: { send: function () {} },
    connected: true,
    messagesEl: messagesEl,
    finalizeAssistantBlock: function () {},
    addToMessages: function (el) { messagesEl.appendChild(el); },
    scrollToBottom: function () {},
    stopUrgentBlink: function () {},
  };
  tools.initTools(ctx);
  tools.resetToolState();
  tools.clearSettledPermissions();
  return { tools: tools, messagesEl: messagesEl };
}

function cardFor(env, id) { return env.messagesEl.querySelector('[data-request-id="' + id + '"]'); }

function enabledButtons(card) {
  return card.querySelectorAll("button").filter(function (b) { return !b.disabled; });
}

module.exports = { setupToolsEnv: setupToolsEnv, cardFor: cardFor, enabledButtons: enabledButtons };
