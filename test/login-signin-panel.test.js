"use strict";
// The sign-in panel for a vendor login run in the console terminal: the
// parser over redacted login output, the panel DOM, the wiring that feeds only
// the login tab, and the rule that the URL query and the code are never
// logged or persisted.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var fakeDom = require("./fake-dom-prompt-cards");
var yoke = require("../lib/yoke");

var FakeElement = fakeDom.FakeElement;
var COLS = 40;

function mod(name, query) { return import(fakeDom.moduleUrl(name) + (query || "")); }

// --- A fake xterm buffer fed like a terminal: lines hard-wrap at COLS. ---
function bufferOf(text) {
  var rows = [];
  text.split("\n").forEach(function (line) {
    if (line.length === 0) { rows.push(""); return; }
    for (var i = 0; i < line.length; i += COLS) rows.push(line.slice(i, i + COLS));
  });
  return rows;
}

function fakeXterm(text) {
  var rows = bufferOf(text);
  var lines = rows.map(function (t) {
    return {
      isWrapped: false,
      translateToString: function (trim) {
        return trim ? t.replace(/\s+$/, "") : t + " ".repeat(Math.max(0, COLS - t.length));
      },
    };
  });
  return {
    cols: COLS,
    buffer: { active: { length: lines.length, getLine: function (y) { return lines[y]; } } },
  };
}

// --- Redacted captures, shaped like each CLI's real login screen. ---
var CLAUDE_URL = "https://example.test/oauth/authorize?code=true&client_id=REDACTED&response_type=code&redirect_uri=REDACTED&scope=REDACTED&code_challenge=REDACTED&state=REDACTED";
var CLAUDE_OUT = [
  "Opening browser to sign in...",
  "If it did not open, visit: " + CLAUDE_URL,
  "",
  "Paste code here if prompted > ",
].join("\n");
var CLAUDE_URL_ONLY = CLAUDE_OUT.split("\n").slice(0, 2).join("\n");

var CODEX_OUT = [
  "Welcome to Codex",
  "",
  "Follow these steps to sign in using device code authorization:",
  "",
  "1. Open this link in your browser and sign in",
  "   https://auth.example.test/codex/device",
  "",
  "2. Enter this one-time code (expires in 15 minutes)",
  "   ABCD-EFGH12",
  "",
  "Device codes are a common phishing target. Never share this code.",
].join("\n");

var NO_URL_OUT = "Checking login status...\nAlready signed in as a user.\nDone.";
var NOISE_OUT = "total 4\ndrwxr-xr-x 2 user user 4096 .\nsee ftp://example.test/readme for details\nPaste is not a word here";

async function patternsFor(vendor) {
  var msg = yoke.registry.describeForClient({ installed: [], available: [] });
  var entry = msg.filter(function (v) { return v.id === vendor; })[0];
  return entry.loginPatterns;
}

async function parse(vendor, out) {
  var P = await mod("login-parser.js");
  var L = await mod("terminal-links.js");
  var compiled = P.compileLoginPatterns(await patternsFor(vendor));
  var x = fakeXterm(out);
  return P.parseLoginLines(L.bufferLogicalLines(x.buffer.active, x.cols, 200), compiled);
}

test("parser: Claude hard-wrapped URL is joined and the code prompt is detected", async function () {
  var got = await parse("claude", CLAUDE_OUT);
  assert.equal(got.url, CLAUDE_URL);
  assert.equal(got.codePrompt, true);
  assert.equal(got.userCode, "");
});

test("parser: Claude before the code prompt prints has a URL and no code prompt", async function () {
  var got = await parse("claude", CLAUDE_URL_ONLY);
  assert.equal(got.url, CLAUDE_URL);
  assert.equal(got.codePrompt, false);
});

test("parser: Codex device auth gives the short URL and the displayed code, no code prompt", async function () {
  var got = await parse("codex", CODEX_OUT);
  assert.equal(got.url, "https://auth.example.test/codex/device");
  assert.equal(got.userCode, "ABCD-EFGH12");
  assert.equal(got.codePrompt, false);
});

test("parser: output with no URL, and non-web noise, parse to nothing", async function () {
  assert.equal(await parse("claude", NO_URL_OUT), null);
  assert.equal(await parse("codex", NO_URL_OUT), null);
  assert.equal(await parse("claude", NOISE_OUT), null);
});

test("parser: the newest URL wins when a login is retried", async function () {
  var P = await mod("login-parser.js");
  var compiled = P.compileLoginPatterns(await patternsFor("codex"));
  var got = P.parseLoginLines(["https://a.example.test/one", "retry", "https://a.example.test/two"], compiled);
  assert.equal(got.url, "https://a.example.test/two");
});

test("parser: a missing or broken pattern declares no panel instead of throwing", async function () {
  var P = await mod("login-parser.js");
  assert.equal(P.compileLoginPatterns(null), null);
  assert.equal(P.compileLoginPatterns({ url: "(" }), null);
  assert.equal(P.parseLoginLines(["https://a.example.test/x"], null), null);
  var c = P.compileLoginPatterns({ url: "https:\\/\\/\\S+", userCode: "(" });
  assert.equal(P.parseLoginLines(["https://a.example.test/x"], c).userCode, "");
});

test("registry: login patterns are declared beside loginCommand and validated", function () {
  var base = {
    id: "pat", displayName: "Pat", priority: 98, binaryNames: ["pat"], probeInstalled: function () { return false; },
    checkAuth: function () { return true; }, installHint: "x", loginCommand: "pat login", osUsersSupported: false,
    needsRuntimeEnv: false, ownedEnvNames: [], nativeInstructionFiles: [], interruptMessage: "x",
    capabilities: {}, createAdapter: function () {},
  };
  assert.throws(function () { yoke.registry.register(Object.assign({}, base, { loginPatterns: { url: "(" } })); }, /valid regular expression/);
  assert.throws(function () { yoke.registry.register(Object.assign({}, base, { loginPatterns: { codePrompt: "x" } })); }, /'url'/);
  assert.throws(function () { yoke.registry.register(Object.assign({}, base, { loginPatterns: { url: "x", bogus: "y" } })); }, /unknown key/);
  var shipped = yoke.registry.describeForClient({ installed: [], available: [] });
  var byId = {};
  shipped.forEach(function (v) { byId[v.id] = v; });
  assert.ok(byId.claude.loginPatterns.codePrompt);
  assert.ok(byId.codex.loginPatterns.userCode);
});

// --- Panel DOM ---
function buttons(panel) { return panel.element.querySelectorAll("button").map(function (b) { return b.textContent; }); }

async function makePanel(over) {
  fakeDom.setupGlobals();
  var PanelMod = await mod("login-panel.js");
  var calls = { sent: [], copied: [], opened: [], dismissed: 0 };
  var host = new FakeElement("div");
  var panel = PanelMod.createLoginPanel(Object.assign({
    vendorName: "Claude Code",
    identity: "shared",
    sendCode: function (t) { calls.sent.push(t); },
    copy: function (t) { calls.copied.push(t); },
    openLink: function (u) { calls.opened.push(u); },
    onDismiss: function () { calls.dismissed++; },
  }, over || {}));
  host.appendChild(panel.element);
  return { panel: panel, calls: calls, host: host, PanelMod: PanelMod };
}

test("panel: Open link, Copy link and a code field, submitting sends code plus newline", async function () {
  var t = await makePanel();
  t.panel.update({ url: CLAUDE_URL, codePrompt: true, userCode: "" });
  assert.deepEqual(buttons(t.panel), ["Dismiss", "Open link", "Copy link", "Copy code", "Submit code"]);
  assert.equal(t.panel.element.querySelector(".login-panel-code-entry").style.display, "");
  assert.equal(t.panel.element.querySelector(".login-panel-shown-code").style.display, "none");

  t.panel.element.querySelector(".login-panel-open").click();
  t.panel.element.querySelector(".login-panel-copy-link").click();
  assert.deepEqual(t.calls.opened, [CLAUDE_URL]);
  assert.deepEqual(t.calls.copied, [CLAUDE_URL]);

  var input = t.panel.element.querySelector(".login-panel-code-input");
  fakeDom.typeInto(input, "  pasted-code-123  ");
  t.panel.element.querySelector(".login-panel-submit").click();
  assert.deepEqual(t.calls.sent, ["pasted-code-123\n"]);
  assert.equal(input.value, "", "the field is cleared after submit");
  t.panel.element.querySelector(".login-panel-submit").click();
  assert.equal(t.calls.sent.length, 1, "an empty field sends nothing");
});

test("panel: the host is shown, never the query string", async function () {
  var t = await makePanel();
  t.panel.update({ url: CLAUDE_URL, codePrompt: true, userCode: "" });
  var text = t.panel.element.textContent;
  assert.ok(text.indexOf("example.test") !== -1);
  assert.ok(text.indexOf("client_id") === -1 && text.indexOf("state=") === -1);
});

test("panel: Codex shows the displayed code with a Copy button and no entry field", async function () {
  var t = await makePanel();
  t.panel.update({ url: "https://auth.example.test/codex/device", codePrompt: false, userCode: "ABCD-EFGH12" });
  assert.equal(t.panel.element.querySelector(".login-panel-code-value").textContent, "ABCD-EFGH12");
  assert.equal(t.panel.element.querySelector(".login-panel-shown-code").style.display, "");
  assert.equal(t.panel.element.querySelector(".login-panel-code-entry").style.display, "none");
  t.panel.element.querySelector(".login-panel-copy-code").click();
  assert.deepEqual(t.calls.copied, ["ABCD-EFGH12"]);
});

test("panel: dismiss removes the panel and clears what it held", async function () {
  var t = await makePanel();
  t.panel.update({ url: CLAUDE_URL, codePrompt: true, userCode: "ABCD-EFGH12" });
  t.panel.element.querySelector(".login-panel-dismiss").click();
  assert.equal(t.calls.dismissed, 1);
  assert.equal(t.panel.isOpen(), false);
  assert.equal(t.host.children.length, 0);
  t.panel.element.querySelector(".login-panel-open").click();
  t.panel.element.querySelector(".login-panel-copy-code").click();
  assert.deepEqual(t.calls.opened, []);
  assert.deepEqual(t.calls.copied, []);
});

test("panel: the identity note matches the mode", async function () {
  var own = await makePanel({ identity: "os-users" });
  assert.ok(own.panel.element.textContent.indexOf("your own account") !== -1);
  var shared = await makePanel({ identity: "shared" });
  assert.ok(shared.panel.element.textContent.indexOf("every user of this host") !== -1);
  var none = await makePanel({ identity: "" });
  assert.equal(none.panel.element.querySelector(".login-panel-identity"), null);
});

test("panel: every string is brand-correct (no bare 'clagentic')", async function () {
  var src = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "login-panel.js"), "utf8");
  assert.ok(!/["'][^"']*\bclagentic\b(?!-console)[^"']*["']/i.test(src.replace(/Clagentic: Console/g, "")));
  var t = await makePanel();
  t.panel.update({ url: CLAUDE_URL, codePrompt: true, userCode: "ABCD-EFGH12" });
  assert.ok(!/clagentic/i.test(t.panel.element.textContent));
});

test("panel CSS: wraps and shrinks at narrow and phone widths", function () {
  var css = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "login-panel.css"), "utf8");
  assert.ok(/\.login-panel\s*\{[^}]*max-width:\s*100%/.test(css));
  assert.ok(/\.login-panel\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css));
  assert.ok(/\.login-panel-row\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
  assert.ok(/\.login-panel-code-input\s*\{[^}]*min-width:\s*0/.test(css));
  assert.ok(/@media \(max-width:\s*480px\)/.test(css));
  assert.ok(!/white-space:\s*nowrap/.test(css), "nothing may force a single line");
  assert.ok(!/(^|[^-])width:\s*\d{3,}px/.test(css), "no fixed wide width");
  var style = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "style.css"), "utf8");
  assert.ok(style.indexOf('css/login-panel.css') !== -1);
});

// --- The login tab and the terminal wiring ---
async function loginTabHarness(vendor, identity) {
  fakeDom.setupGlobals();
  var T = await mod("login-tab.js");
  var calls = { sent: [] };
  var mount = new FakeElement("div");
  var tab = T.createLoginTab({
    patterns: await patternsFor(vendor),
    vendorName: vendor,
    identity: identity || "",
    sendCode: function (t) { calls.sent.push(t); },
    copy: function () {},
    openLink: function () {},
    mount: function (el) { mount.appendChild(el); },
  });
  return { tab: tab, mount: mount, calls: calls };
}

test("login tab: a panel appears once a URL is on screen and not before", async function () {
  var h = await loginTabHarness("claude");
  h.tab.feed(fakeXterm(NO_URL_OUT));
  assert.equal(h.mount.children.length, 0);
  h.tab.feed(fakeXterm(CLAUDE_URL_ONLY));
  assert.equal(h.mount.children.length, 1);
  assert.equal(h.mount.querySelector(".login-panel-code-entry").style.display, "none");
  h.tab.feed(fakeXterm(CLAUDE_OUT));
  assert.equal(h.mount.children.length, 1, "one panel, updated in place");
  assert.equal(h.mount.querySelector(".login-panel-code-entry").style.display, "");
});

test("login tab: close (exit) removes the panel and a later feed shows none", async function () {
  var h = await loginTabHarness("claude");
  h.tab.feed(fakeXterm(CLAUDE_OUT));
  h.tab.close();
  assert.equal(h.mount.children.length, 0);
  h.tab.feed(fakeXterm(CLAUDE_OUT));
  assert.equal(h.mount.children.length, 0);
});

test("login tab: a dismissed panel stays dismissed while the login keeps printing", async function () {
  var h = await loginTabHarness("claude");
  h.tab.feed(fakeXterm(CLAUDE_OUT));
  h.mount.querySelector(".login-panel-dismiss").click();
  h.tab.feed(fakeXterm(CLAUDE_OUT));
  assert.equal(h.mount.children.length, 0);
});

test("login tab: the panel is hidden while another terminal tab is active", async function () {
  var h = await loginTabHarness("claude");
  h.tab.feed(fakeXterm(CLAUDE_OUT));
  var panel = h.mount.children[0];
  h.tab.setActive(false);
  assert.equal(panel.style.display, "none");
  h.tab.setActive(true);
  assert.equal(panel.style.display, "");
});

// terminal.js over a fake xterm: output of the marked tab feeds the panel, a
// plain terminal's output never does, and the code goes to that terminal id.
async function terminalHarness() {
  fakeDom.setupGlobals();
  var created = [];
  global.Terminal = function () {
    var self = this;
    this.cols = COLS; this.rows = 24; this.options = {};
    this.text = "";
    this.loadAddon = function () {};
    this.registerLinkProvider = function () {};
    this.open = function () {};
    this.onData = function () {};
    this.attachCustomKeyEventHandler = function () {};
    this.focus = function () {};
    this.dispose = function () {};
    this.write = function (data, cb) {
      self.text += data.replace(/\r/g, "");
      var x = fakeXterm(self.text);
      self.buffer = x.buffer;
      if (cb) cb();
    };
    this.buffer = fakeXterm("").buffer;
    created.push(this);
  };
  var sent = [];
  var T = await mod("terminal.js", "?harness=" + Math.random());
  var storeMod = await mod("store.js");
  var VR = await mod("vendor-registry.js");
  storeMod.createStore({ isOsUsers: false, isMultiUserMode: true });
  var msg = require("../lib/vendor-registry-message").buildVendorRegistryMessage({ installedVendors: ["claude", "codex"], availableVendors: ["claude", "codex"], capabilitiesByVendor: {} });
  VR.applyVendorRegistry(JSON.parse(JSON.stringify(msg)));
  var container = new FakeElement("div");
  var body = new FakeElement("div");
  container.appendChild(body);
  // initTerminal binds header buttons by id; hand it stand-ins.
  global.document.getElementById = function (id) {
    return ["terminal-close", "terminal-fullscreen", "terminal-toggle-btn", "terminal-sidebar-btn", "terminal-new-tab"].indexOf(id) !== -1 ? new FakeElement("button") : null;
  };
  T.initTerminal({
    terminalContainerEl: container, terminalBodyEl: body, connected: true,
    ws: { send: function (b) { sent.push(JSON.parse(b)); } },
  });
  function list(ids) {
    T.handleTermList({ terminals: ids.map(function (id) { return { id: id, title: id, exited: false }; }) });
  }
  return { T: T, storeMod: storeMod, container: container, sent: sent, list: list, created: created };
}

test("terminal wiring: only the marked login tab feeds the panel; the code goes to that terminal", async function () {
  var h = await terminalHarness();
  h.list(["t1", "t2"]);
  h.T.handleTermCreated({ id: "t1" });
  h.T.markLoginTerminal("t1", "claude");
  h.T.handleTermOutput({ id: "t1", data: CLAUDE_OUT.replace(/\n/g, "\r\n") });
  assert.equal(h.container.querySelectorAll(".login-panel").length, 1);

  // A different terminal printing the same URL gets no panel.
  h.T.handleTermCreated({ id: "t2" });
  h.T.handleTermOutput({ id: "t2", data: CLAUDE_OUT.replace(/\n/g, "\r\n") });
  assert.equal(h.container.querySelectorAll(".login-panel").length, 1);
  assert.equal(h.container.querySelector(".login-panel").style.display, "none", "hidden while t2 is active");

  h.T.handleTermCreated({ id: "t1" });
  var input = h.container.querySelector(".login-panel-code-input");
  fakeDom.typeInto(input, "the-code");
  h.sent.length = 0;
  h.container.querySelector(".login-panel-submit").click();
  var inputs = h.sent.filter(function (m) { return m.type === "term_input"; });
  assert.deepEqual(inputs.map(function (m) { return [m.id, m.data]; }), [["t1", "the-code\n"]]);
});

test("terminal wiring: the identity note follows os-users versus shared mode", async function () {
  var h = await terminalHarness();
  h.list(["t1"]);
  h.T.handleTermCreated({ id: "t1" });
  h.storeMod.store.set({ isOsUsers: true });
  h.T.markLoginTerminal("t1", "claude");
  h.T.handleTermOutput({ id: "t1", data: CLAUDE_OUT.replace(/\n/g, "\r\n") });
  assert.ok(h.container.querySelector(".login-panel-identity").textContent.indexOf("your own account") !== -1);

  var h2 = await terminalHarness();
  h2.list(["t1"]);
  h2.T.handleTermCreated({ id: "t1" });
  h2.T.markLoginTerminal("t1", "claude");
  h2.T.handleTermOutput({ id: "t1", data: CLAUDE_OUT.replace(/\n/g, "\r\n") });
  assert.ok(h2.container.querySelector(".login-panel-identity").textContent.indexOf("every user of this host") !== -1);
});

test("terminal wiring: exit and close remove the panel", async function () {
  var h = await terminalHarness();
  h.list(["t1"]);
  h.T.handleTermCreated({ id: "t1" });
  h.T.markLoginTerminal("t1", "claude");
  h.T.handleTermOutput({ id: "t1", data: CLAUDE_OUT.replace(/\n/g, "\r\n") });
  assert.equal(h.container.querySelectorAll(".login-panel").length, 1);
  h.T.handleTermExited({ id: "t1" });
  assert.equal(h.container.querySelectorAll(".login-panel").length, 0);

  var h2 = await terminalHarness();
  h2.list(["t1"]);
  h2.T.handleTermCreated({ id: "t1" });
  h2.T.markLoginTerminal("t1", "codex");
  h2.T.handleTermOutput({ id: "t1", data: CODEX_OUT.replace(/\n/g, "\r\n") });
  assert.equal(h2.container.querySelectorAll(".login-panel").length, 1);
  h2.T.handleTermClosed({ id: "t1" });
  assert.equal(h2.container.querySelectorAll(".login-panel").length, 0);
});

test("terminal wiring: a login that prints no URL shows no panel", async function () {
  var h = await terminalHarness();
  h.list(["t1"]);
  h.T.handleTermCreated({ id: "t1" });
  h.T.markLoginTerminal("t1", "claude");
  h.T.handleTermOutput({ id: "t1", data: NO_URL_OUT.replace(/\n/g, "\r\n") });
  assert.equal(h.container.querySelectorAll(".login-panel").length, 0);
});

// --- No log, no persistence ---
test("no-log: the URL query and the code reach no console method and no storage", async function () {
  var secrets = ["client_id=REDACTED", "code_challenge=REDACTED", "state=REDACTED", "the-code-777", "ABCD-EFGH12"];
  var seen = [];
  var methods = ["log", "info", "warn", "error", "debug", "trace"];
  var saved = {};
  methods.forEach(function (m) {
    saved[m] = console[m];
    console[m] = function () { seen.push(Array.prototype.join.call(arguments, " ")); };
  });
  var h;
  try {
    h = await terminalHarness();
    var stored = [];
    var origSet = global.localStorage.setItem;
    global.localStorage.setItem = function (k, v) { stored.push(k + "=" + v); origSet(k, v); };
    global.sessionStorage = { setItem: function (k, v) { stored.push(k + "=" + v); }, getItem: function () { return null; } };
    h.list(["t1"]);
    h.T.handleTermCreated({ id: "t1" });
    h.T.markLoginTerminal("t1", "claude");
    h.T.handleTermOutput({ id: "t1", data: CLAUDE_OUT.replace(/\n/g, "\r\n") });
    fakeDom.typeInto(h.container.querySelector(".login-panel-code-input"), "the-code-777");
    h.container.querySelector(".login-panel-submit").click();
    h.T.markLoginTerminal("t1", "codex");
    h.T.handleTermOutput({ id: "t1", data: CODEX_OUT.replace(/\n/g, "\r\n") });
    h.T.handleTermExited({ id: "t1" });
    var held = JSON.stringify(h.storeMod.store.snap());
    secrets.forEach(function (s) {
      assert.ok(held.indexOf(s) === -1, "store holds " + s);
      assert.ok(!stored.some(function (e) { return e.indexOf(s) !== -1; }), "storage holds " + s);
    });
  } finally {
    methods.forEach(function (m) { console[m] = saved[m]; });
  }
  secrets.forEach(function (s) {
    assert.ok(!seen.some(function (e) { return e.indexOf(s) !== -1; }), "console shows " + s);
  });
});

test("no-log: the sign-in modules contain no console call and no storage write", function () {
  ["login-parser.js", "login-panel.js", "login-tab.js"].forEach(function (f) {
    var src = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", f), "utf8");
    assert.ok(!/\bconsole\./.test(src), f + " calls console");
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), f + " persists");
  });
});
