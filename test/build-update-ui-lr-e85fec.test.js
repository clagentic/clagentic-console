"use strict";

// The client half of the offer, driven through the real diagnostics module over
// a fake DOM: the first click only asks, only the confirmation carries the
// token the daemon issued, declining sends nothing, and a retraction removes
// the action.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");

var dom = require("./fake-dom-prompt-cards");

var MODULES = path.join(__dirname, "..", "lib", "public", "modules");
var instance = 0;

var BUILDS = {
  loadedBuildSha: "a".repeat(40), installedBuildSha: "b".repeat(40), reason: "sha",
  changes: { available: true, truncated: false, reason: null, commits: [{ sha: "1234567890ab", subject: "fix a thing" }] },
};

function standingOffer() {
  return {
    type: "diagnostic", severity: "warning", source: "build-update",
    message: "A newer build is installed.",
    buildUpdate: BUILDS,
    actionable: { label: "Restart to apply update", action: "restart_for_build_update" },
  };
}

function confirmOffer(token) {
  return {
    type: "diagnostic", severity: "warning", source: "build-update",
    message: "A restart now would end 2 live sessions and 1 background agent: [lore] HOLDEN lane (running a turn)",
    buildUpdate: Object.assign({ token: token }, BUILDS),
    actionable: { label: "Restart now", action: "confirm_build_update_restart" },
  };
}

// One browser: a fresh diagnostics module instance over a fake DOM, with the
// websocket frames it sends recorded.
async function client(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var container = new dom.FakeElement("div");
  global.document.body.appendChild(container);
  global.document.getElementById = function (id) { return id === "diagnostic-toast-container" ? container : null; };
  var sent = [];
  var wsRef = await import(pathToFileURL(path.join(MODULES, "ws-ref.js")).href);
  wsRef.setWs({ readyState: 1, send: function (body) { sent.push(JSON.parse(body)); } });
  var diagnostics = await import(dom.moduleUrl("diagnostics.js") + "?case=" + (++instance));
  return {
    sent: sent,
    diagnostics: diagnostics,
    container: container,
    button: function (label) {
      return container.querySelectorAll("button").filter(function (b) { return b.textContent === label; })[0] || null;
    },
    toastsOf: function (source) { return container.querySelectorAll('[data-diag-source="' + source + '"]'); },
    settle: function () { t.mock.timers.tick(300); },
  };
}

test("the first click only asks for the offer: no token, no restart; the interruptions then show", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(standingOffer());
  c.button("Restart to apply update").click();
  assert.deepEqual(c.sent, [{ type: "restart_for_build_update", requestId: c.sent[0].requestId }]);
  assert.equal(typeof c.sent[0].requestId, "string");

  // The daemon's answer to that click arrives as another diagnostic.
  c.diagnostics.addDiagnostic(confirmOffer("tok-1"));
  var shown = c.container.textContent;
  assert.ok(shown.indexOf("would end 2 live sessions and 1 background agent") !== -1, shown);
  assert.ok(shown.indexOf("[lore] HOLDEN lane") !== -1, shown);
  assert.equal(c.sent.length, 1, "showing the list sent nothing further");
  assert.ok(c.sent.every(function (m) { return m.confirmToken === undefined; }), "no frame carries a token yet");
});

test("confirming sends exactly one restart carrying the daemon's token", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(confirmOffer("tok-2"));
  var confirm = c.button("Restart now");
  confirm.click();
  confirm.click(); // a second click on the same button
  assert.deepEqual(c.sent, [{ type: "restart_for_build_update", confirmToken: "tok-2", requestId: c.sent[0].requestId }]);
});

test("an offer with no token sends nothing when confirmed", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(confirmOffer(undefined));
  c.button("Restart now").click();
  assert.deepEqual(c.sent, []);
});

test("declining sends nothing and removes the offer", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(confirmOffer("tok-3"));
  c.button("Not now").click();
  c.settle();
  assert.deepEqual(c.sent, []);
  assert.equal(c.toastsOf("build-update").length, 0);
});

test("a diagnostic cannot name an action the client does not know", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic({
    type: "diagnostic", severity: "warning", source: "x", message: "m",
    actionable: { label: "Do it", action: "shutdown_server" },
  });
  assert.equal(c.button("Do it"), null, "no button is rendered for an unlisted action");
  assert.deepEqual(c.sent, []);
});

test("a retraction removes the build-update offer and its action, and leaves other diagnostics", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(standingOffer());
  c.diagnostics.addDiagnostic(confirmOffer("tok-4"));
  c.diagnostics.addDiagnostic({ type: "diagnostic", severity: "warning", source: "preflight", message: "unrelated" });
  assert.equal(c.toastsOf("build-update").length, 2);

  c.diagnostics.retractDiagnostics("build-update");
  c.settle();
  assert.equal(c.toastsOf("build-update").length, 0);
  assert.equal(c.toastsOf("preflight").length, 1, "an unrelated diagnostic stays");
  assert.equal(c.button("Restart now"), null);
  assert.equal(c.button("Restart to apply update"), null);
  assert.deepEqual(c.sent, []);
});

test("a refreshed offer replaces the entry in place: one action button, and the confirmation survives", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(standingOffer());
  c.diagnostics.addDiagnostic(confirmOffer("tok-5"));
  var refreshed = Object.assign(standingOffer(), { refresh: true, message: "A newer build is installed (changes read)." });
  c.diagnostics.refreshDiagnostic(refreshed);
  c.settle();
  assert.equal(c.toastsOf("build-update").length, 2, "still one standing offer and one confirmation");
  assert.equal(c.container.querySelectorAll("button").filter(function (b) { return b.textContent === "Restart to apply update"; }).length, 1);
  assert.ok(c.container.textContent.indexOf("changes read") !== -1, "the new text is the one shown");
  assert.ok(c.button("Restart now"), "the confirmation the operator is reading was not replaced");
  assert.deepEqual(c.sent, []);
});

test("a refresh does not bring back an offer the operator declined", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(confirmOffer("tok-6"));
  c.button("Not now").click();
  c.settle();
  c.diagnostics.refreshDiagnostic(Object.assign(confirmOffer("tok-6"), { refresh: true }));
  c.settle();
  assert.equal(c.toastsOf("build-update").length, 0);
  assert.equal(c.button("Restart now"), null);
});

test("a refresh arriving before any offer is held is ignored; a plain diagnostic still shows", async function (t) {
  var c = await client(t);
  c.diagnostics.refreshDiagnostic(Object.assign(standingOffer(), { refresh: true }));
  assert.equal(c.button("Restart to apply update"), null);
  c.diagnostics.addDiagnostic(standingOffer());
  assert.ok(c.button("Restart to apply update"));
});

test("the same offer shown again after a retraction is not swallowed as a duplicate", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(standingOffer());
  c.diagnostics.retractDiagnostics("build-update");
  c.settle();
  c.diagnostics.addDiagnostic(standingOffer());
  assert.ok(c.button("Restart to apply update"));
});

// A DOM small enough to read back what build-update-detail.js builds.
function fakeDocument() {
  function el(tag) {
    return {
      tag: tag, className: "", children: [], _text: "",
      set textContent(v) { this._text = String(v); },
      get textContent() { return this._text + this.children.map(function (c) { return c.textContent; }).join(""); },
      appendChild: function (c) { this.children.push(c); return c; },
    };
  }
  return { createElement: el };
}

test("build-update-detail renders both builds and the commits, as text", async function () {
  global.document = fakeDocument();
  try {
    var mod = await import(pathToFileURL(path.join(MODULES, "build-update-detail.js")).href);
    var root = mod.buildUpdateDetailEl({
      loadedBuildSha: "a".repeat(40), installedBuildSha: "b".repeat(40), reason: "sha",
      changes: { available: true, truncated: true, reason: null, commits: [{ sha: "1234567890abcdef", subject: "<img src=x onerror=alert(1)> fix" }] },
    });
    var text = root.textContent;
    assert.ok(text.indexOf("Running: " + "a".repeat(12)) !== -1, text);
    assert.ok(text.indexOf("Installed: " + "b".repeat(12)) !== -1, text);
    assert.ok(text.indexOf("12345678 <img src=x onerror=alert(1)> fix") !== -1, "the subject is shown literally");
    assert.ok(text.indexOf("More commits not shown") !== -1);
    assert.equal(mod.buildUpdateDetailEl(null), null);
  } finally {
    delete global.document;
  }
});

test("build-update-detail says why the change list is missing instead of showing an empty one", async function () {
  global.document = fakeDocument();
  try {
    var mod = await import(pathToFileURL(path.join(MODULES, "build-update-detail.js")).href);
    var root = mod.buildUpdateDetailEl({
      loadedBuildSha: "a", installedBuildSha: "b", reason: "sha",
      changes: { available: false, commits: [], truncated: false, reason: "no git history is available for this install" },
    });
    assert.ok(root.textContent.indexOf("Change list unavailable: no git history is available for this install.") !== -1);
  } finally {
    delete global.document;
  }
});
