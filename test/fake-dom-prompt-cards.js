"use strict";
// Hand-built DOM (no jsdom in this repo) sufficient to drive the real tools.js
// prompt-card exports for every prompt kind. Shared helper, not a test file:
// the runner only collects test/*.test.js.

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

// One compound selector (tag, classes, data attributes; no combinators).
function matchesCompound(el, compound) {
  var parts = compound.match(/\.[\w-]+|\[[^\]]+\]|^[a-z]+/g) || [];
  return parts.length > 0 && parts.every(function (p) {
    if (p[0] === ".") return el.classList.contains(p.slice(1));
    if (p[0] === "[") {
      var m = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(p);
      var key = m[1].slice(5).replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
      return m[2] === undefined ? el.dataset[key] !== undefined : el.dataset[key] === m[2];
    }
    return el.tagName === p.toUpperCase();
  });
}

// A selector list whose selectors may use the descendant combinator, as in
// ".ask-user-other input".
function matches(el, sel) {
  return sel.split(",").some(function (group) {
    var chain = group.trim().split(/\s+/);
    if (!matchesCompound(el, chain[chain.length - 1])) return false;
    var i = chain.length - 2;
    for (var node = el._parent; i >= 0 && node; node = node._parent) {
      if (matchesCompound(node, chain[i])) i--;
    }
    return i < 0;
  });
}

/** What typing text into a field does: set its value, then fire "input". */
function typeInto(el, text) {
  el.value = text;
  (el._listeners.input || []).slice().forEach(function (fn) { fn({}); });
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

/**
 * One browser's prompt UI: a private tools.js instance (module state such as
 * its prompt controller is per instance) over its own messages container and
 * main input.
 *
 * @param {string} [instanceKey] - distinct keys give independent clients.
 * @param {function(string): boolean} [transmit] - receives each serialized
 *   outbound frame; returning false models an unusable socket.
 */
async function createClient(instanceKey, transmit) {
  var tools = await import(moduleUrl("tools.js") + (instanceKey ? "?client=" + encodeURIComponent(instanceKey) : ""));
  var messagesEl = new FakeElement("div");
  var sent = [];
  var ctx = {
    ws: {
      send: function (body) {
        sent.push(JSON.parse(body));
        if (transmit) transmit(body);
      },
    },
    connected: true,
    messagesEl: messagesEl,
    inputEl: new FakeElement("textarea"),
    finalizeAssistantBlock: function () {},
    addToMessages: function (el) { messagesEl.appendChild(el); },
    scrollToBottom: function () {},
    stopUrgentBlink: function () {},
  };
  tools.initTools(ctx);
  tools.resetToolState();
  tools.clearPromptStates();
  return { tools: tools, ctx: ctx, messagesEl: messagesEl, sent: sent };
}

// Timers are mocked so unconfirmed-card ack timeouts never hold the test
// process open; node:test restores them per test.
async function setupToolsEnv(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  setupGlobals();
  var storeMod = await import(moduleUrl("store.js"));
  storeMod.createStore({ connected: true });
  return createClient();
}

function cardFor(env, id) { return env.messagesEl.querySelector('[data-request-id="' + id + '"]'); }

function enabledButtons(card) {
  return card.querySelectorAll("button").filter(function (b) { return !b.disabled; });
}

// The fake DOM does not parse innerHTML, so the decision label is read back
// from the raw markup the module wrote into the actions container, or from
// the status element a card without an actions row adds.
function decisionLabel(card) {
  var m = /permission-decision-label">([^<]*)</.exec(card.textContent);
  if (m) return m[1];
  var status = card.querySelector(".ask-user-status");
  return status ? status.textContent : "";
}

/** Controls of a card an operator could still use. */
function liveControls(card) {
  return card.querySelectorAll("button, input, select, textarea").filter(function (el) { return !el.disabled; });
}

module.exports = {
  FakeElement: FakeElement,
  setupGlobals: setupGlobals,
  moduleUrl: moduleUrl,
  createClient: createClient,
  setupToolsEnv: setupToolsEnv,
  cardFor: cardFor,
  enabledButtons: enabledButtons,
  liveControls: liveControls,
  decisionLabel: decisionLabel,
  typeInto: typeInto,
};
