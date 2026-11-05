"use strict";

// Browser-global stubs for loading lib/public/app.js's real ESM graph under
// Node. Unlike the boot test's inline copy, the WebSocket stub never opens by
// itself and records every constructed socket in opts.sockets, so a test
// decides when a connection attempt resolves. Options: sockets (required
// array), fetch, requestAnimationFrame, onParse.

function makeFakeElement() {
  var el = {
    style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    dataset: {},
    children: [],
    attributes: {},
    addEventListener: function () {},
    removeEventListener: function () {},
    appendChild: function (c) { el.children.push(c); return c; },
    removeChild: function () {},
    replaceChild: function () {},
    insertBefore: function (c) { return c; },
    setAttribute: function () {},
    getAttribute: function () { return null; },
    removeAttribute: function () {},
    hasAttribute: function () { return false; },
    querySelector: function () { return makeFakeElement(); },
    querySelectorAll: function () { return []; },
    closest: function () { return makeFakeElement(); },
    focus: function () {},
    blur: function () {},
    click: function () {},
    scrollTo: function () {},
    scrollIntoView: function () {},
    remove: function () {},
    getBoundingClientRect: function () {
      return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
    },
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
    set: function (v) { el._text = v; },
  });
  Object.defineProperty(el, "innerHTML", {
    get: function () { return el._html; },
    set: function (v) { el._html = v; },
  });
  Object.defineProperty(el, "parentElement", { get: function () { return el; } });
  return el;
}

// Records every WebSocket construction so the test can assert connect()
// (app.js:1041) actually ran as part of the module graph's top-level init
// sequence — the concrete symptom this incident fixes (onopen never
// firing because connect() was never reached).
function installBrowserGlobals(opts) {
  opts = opts || {};
  var fakeDocument = {
    getElementById: function () { return makeFakeElement(); },
    querySelector: function () { return makeFakeElement(); },
    querySelectorAll: function () { return []; },
    createElement: function () { return makeFakeElement(); },
    addEventListener: function () {},
    removeEventListener: function () {},
    body: makeFakeElement(),
    documentElement: makeFakeElement(),
    head: makeFakeElement(),
    visibilityState: "visible",
    cookie: "",
    title: "",
  };

  global.document = fakeDocument;
  global.window = global;
  global.addEventListener = function () {};
  global.removeEventListener = function () {};
  global.dispatchEvent = function () {};
  global.location = { pathname: "/", hash: "", href: "http://localhost/", search: "" };
  Object.defineProperty(global, "navigator", {
    value: {
      userAgent: "node-esm-graph-probe",
      platform: "node-esm-graph-probe",
      serviceWorker: undefined,
      clipboard: { writeText: function () { return Promise.resolve(); } },
      vibrate: function () {},
    },
    configurable: true,
  });
  global.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  global.sessionStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  // lr-795882: a real browser WebSocket always eventually calls onopen,
  // onclose, or onerror. This stub previously never called any of them, so
  // app-connection.js's connect()->openSocket() 3s "not connected yet" watchdog
  // (connectTimeoutId, app-connection.js:297) never got cleared by a real
  // onopen — it fired, tore the socket down, and called connect() again,
  // which built a NEW real 3s Node timer, forever. Under `node --test`
  // (no --test-force-exit) that unbounded setTimeout chain kept the process
  // event loop alive indefinitely, and under --test-force-exit it silently
  // truncated later test files in the same run instead of ever completing.
  // Firing onopen asynchronously mirrors a real successful handshake, which
  // reaches connect()'s real terminal state and clears its own timer via the
  // production onopen handler — no test-side timer bookkeeping needed.
  global.WebSocket = function (url, protocols) {
    var sock = {
      url: url,
      send: function () {},
      close: function () { sock.closed = true; },
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      closed: false,
    };
    opts.sockets.push(sock);
    return sock;
  };
  global.lucide = { createIcons: function () {} };
  global.DOMPurify = { sanitize: function (s) { return s; } };
  global.marked = { parse: function (s) { if (opts.onParse) opts.onParse(s); return s; }, setOptions: function () {}, use: function () {} };
  global.mermaid = { initialize: function () {}, run: function () {} };
  global.requestAnimationFrame = opts.requestAnimationFrame || function (fn) { return setTimeout(fn, 0); };
  global.cancelAnimationFrame = function () {};
  global.matchMedia = function () { return { matches: false, addListener: function () {}, addEventListener: function () {} }; };
  global.ResizeObserver = function () { return { observe: function () {}, disconnect: function () {} }; };
  global.IntersectionObserver = function () { return { observe: function () {}, disconnect: function () {} }; };
  global.fetch = opts.fetch || function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); }, text: function () { return Promise.resolve(""); } }); };
  global.history = { pushState: function () {}, replaceState: function () {}, state: null };
  global.CustomEvent = function (type, opts) { this.type = type; Object.assign(this, opts || {}); };
  global.Image = function () { this.onload = null; this.onerror = null; };
  Object.defineProperty(global.Image.prototype, "src", { set: function () {} });
}


module.exports = { installBrowserGlobals: installBrowserGlobals };
