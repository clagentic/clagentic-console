// browser-stub.js
//
// Shared browser stand-in for tests that load the real lib/public/app.js module
// graph under Node's ESM loader: a minimal DOM element, and the window/document
// globals the graph's top-level code touches. Not a test file (the suite globs
// test/*.test.js).

"use strict";

function makeElement(id) {
  var attrs = {};
  var classes = new Set();
  var listeners = {};
  var el = {
    id: id,
    style: {},
    dataset: {},
    children: [],
    classes: classes,
    listeners: listeners,
    classList: {
      add: function () { for (var i = 0; i < arguments.length; i++) classes.add(arguments[i]); },
      remove: function () { for (var i = 0; i < arguments.length; i++) classes.delete(arguments[i]); },
      toggle: function (c, force) {
        var on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: function (c) { return classes.has(c); },
    },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    setAttribute: function (k, v) { attrs[k] = String(v); },
    removeAttribute: function (k) { delete attrs[k]; },
    hasAttribute: function (k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
    addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: function () {},
    appendChild: function (c) { el.children.push(c); return c; },
    removeChild: function () {},
    insertBefore: function (c) { return c; },
    querySelector: function () { return makeElement(); },
    querySelectorAll: function () { return [makeElement()]; },
    closest: function () { return makeElement(); },
    focus: function () {}, blur: function () {}, click: function () {},
    scrollTo: function () {}, scrollIntoView: function () {}, remove: function () {},
    getBoundingClientRect: function () { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    getContext: function () {
      return {
        clearRect: function () {}, drawImage: function () {}, fillRect: function () {},
        beginPath: function () {}, arc: function () {}, fill: function () {}, stroke: function () {},
        save: function () {}, restore: function () {}, translate: function () {},
        fillText: function () {}, measureText: function () { return { width: 0 }; },
      };
    },
    _text: "",
    _html: "",
  };
  Object.defineProperty(el, "textContent", {
    get: function () { return el._text; },
    set: function (v) { el._text = String(v); },
  });
  Object.defineProperty(el, "innerHTML", {
    get: function () { return el._html; },
    set: function (v) { el._html = v; },
  });
  Object.defineProperty(el, "parentElement", { get: function () { return el; } });
  return el;
}

function fire(target, type, event) {
  (target.listeners[type] || []).forEach(function (fn) { fn(event || {}); });
}

// Installs the browser globals on `global`. Options:
//   els:       map filled with the elements getElementById hands out by id
//   label:     navigator userAgent/platform string
//   onSocket:  called with (url, protocols) for every WebSocket construction
// The stub WebSocket opens asynchronously, like a real handshake, so connect()'s
// own timers settle instead of rescheduling forever under `node --test`.
function installBrowserGlobals(opts) {
  opts = opts || {};
  var els = opts.els || {};
  function byId(id) { return els[id] || (els[id] = makeElement(id)); }
  global.document = {
    getElementById: byId,
    querySelector: function () { return makeElement(); },
    querySelectorAll: function () { return [makeElement()]; },
    createElement: function () { return makeElement(); },
    addEventListener: function () {},
    removeEventListener: function () {},
    body: makeElement(),
    documentElement: makeElement(),
    head: makeElement(),
    visibilityState: "visible",
    cookie: "",
    title: "",
  };
  global.window = global;
  global.addEventListener = function () {};
  global.removeEventListener = function () {};
  global.dispatchEvent = function () {};
  global.location = { pathname: "/", hash: "", href: "http://localhost/", search: "", reload: function () {} };
  Object.defineProperty(global, "navigator", {
    value: {
      userAgent: opts.label || "browser-stub",
      platform: opts.label || "browser-stub",
      serviceWorker: undefined,
      clipboard: { writeText: function () { return Promise.resolve(); } },
      vibrate: function () {},
    },
    configurable: true,
  });
  global.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  global.sessionStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  global.WebSocket = function (url, protocols) {
    var sock = { send: function () {}, close: function () {}, onopen: null, onclose: null, onerror: null, onmessage: null };
    if (opts.onSocket) opts.onSocket(url, protocols);
    setTimeout(function () { if (typeof sock.onopen === "function") sock.onopen(); }, 0);
    return sock;
  };
  global.lucide = { createIcons: function () {} };
  global.marked = { parse: function (s) { return s; }, setOptions: function () {}, use: function () {} };
  global.mermaid = { initialize: function () {}, run: function () {} };
  global.requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };
  global.cancelAnimationFrame = function () {};
  global.matchMedia = function () { return { matches: false, addListener: function () {}, addEventListener: function () {} }; };
  global.ResizeObserver = function () { return { observe: function () {}, disconnect: function () {} }; };
  global.IntersectionObserver = function () { return { observe: function () {}, disconnect: function () {} }; };
  global.fetch = function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); }, text: function () { return Promise.resolve(""); } }); };
  global.history = { pushState: function () {}, replaceState: function () {}, state: null };
  global.CustomEvent = function (type, opts2) { this.type = type; Object.assign(this, opts2 || {}); };
  global.Image = function () { this.onload = null; this.onerror = null; };
  Object.defineProperty(global.Image.prototype, "src", { set: function () {} });
}

module.exports = { makeElement: makeElement, fire: fire, installBrowserGlobals: installBrowserGlobals };
