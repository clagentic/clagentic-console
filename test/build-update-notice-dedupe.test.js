"use strict";

// The standing build-update notice is replayed by the daemon on every connection
// and refresh. Driven through the real diagnostics module over a fake DOM: one
// notice per build pair, quiet after the operator closes it until the cooldown
// passes, a new build re-raises, clear-all clears it, and it shares the toast stack.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");

var dom = require("./fake-dom-prompt-cards");

var MODULES = path.join(__dirname, "..", "lib", "public", "modules");
var instance = 0;
var COOLDOWN = 60 * 1000;

function offer(loaded, installed) {
  return {
    type: "diagnostic", severity: "warning", source: "build-update",
    message: "Running build " + loaded + "; installed build " + installed + ".",
    buildUpdate: { loadedBuildSha: loaded, installedBuildSha: installed, reason: "sha", changes: { available: false, commits: [], truncated: false, reason: "no git history" } },
    actionable: { label: "Restart to apply update", action: "restart_for_build_update" },
    noticeCooldownMs: COOLDOWN,
  };
}

async function client(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  dom.setupGlobals();
  var container = new dom.FakeElement("div");
  global.document.body.appendChild(container);
  global.document.getElementById = function (id) { return id === "diagnostic-toast-container" ? container : null; };
  var diagnostics = await import(dom.moduleUrl("diagnostics.js") + "?case=" + (++instance));
  return {
    diagnostics: diagnostics,
    toasts: function () { return container.querySelectorAll('[data-diag-source="build-update"]'); },
    allToasts: function () { return container.querySelectorAll("[data-diag-source]"); },
    closeToast: function () {
      container.querySelectorAll("button").filter(function (b) { return b.className === "toast-diagnostic-dismiss"; })[0].click();
      t.mock.timers.tick(300);
    },
    tick: function (ms) { t.mock.timers.tick(ms); },
  };
}

test("the same build pair replayed many times leaves exactly one toast", async function (t) {
  var c = await client(t);
  for (var i = 0; i < 8; i++) {
    c.diagnostics.addDiagnostic(offer("a1", "b1"));
    c.tick(5100); // past the short duplicate window, as a reconnect would be
  }
  assert.equal(c.toasts().length, 1);
});

test("a closed notice does not return within the cooldown, and returns after it", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  c.closeToast();
  assert.equal(c.toasts().length, 0);

  c.tick(5100);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  assert.equal(c.toasts().length, 0, "replay inside the cooldown stays quiet");

  c.tick(COOLDOWN);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  assert.equal(c.toasts().length, 1, "after the cooldown it shows once");
  c.tick(5100);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  assert.equal(c.toasts().length, 1);
});

test("a newer installed build raises one notice even inside the cooldown", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  c.closeToast();
  c.tick(5100);
  c.diagnostics.addDiagnostic(offer("a1", "b2"));
  assert.equal(c.toasts().length, 1);
  assert.ok(c.toasts()[0].textContent.indexOf("b2") !== -1);
  c.tick(5100);
  c.diagnostics.addDiagnostic(offer("a1", "b2"));
  assert.equal(c.toasts().length, 1);
});

test("a new pair replaces the one still on screen instead of stacking", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  c.tick(5100);
  c.diagnostics.addDiagnostic(offer("a1", "b2"));
  c.tick(300);
  assert.equal(c.toasts().length, 1);
  assert.ok(c.toasts()[0].textContent.indexOf("b2") !== -1);
});

test("a retraction followed by the same pair stays quiet after the operator closed it", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  c.closeToast();
  c.diagnostics.retractDiagnostics("build-update");
  c.tick(5100);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  assert.equal(c.toasts().length, 0);
});

test("a quiet pair retracts a different held notice and shows nothing until the cooldown passes", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  c.closeToast();
  c.tick(5100);
  c.diagnostics.addDiagnostic(offer("a1", "b2"));
  assert.equal(c.toasts().length, 1);

  c.tick(5100);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  c.tick(300);
  assert.equal(c.toasts().length, 0, "the obsolete held notice is retracted, nothing new shows");

  c.tick(COOLDOWN);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  assert.equal(c.toasts().length, 1, "after the cooldown the pair shows once");
  assert.ok(c.toasts()[0].textContent.indexOf("b1") !== -1);
});

test("clear-all in the panel clears the notice, and it does not come back inside the cooldown", async function (t) {
  var c = await client(t);
  var panel = new dom.FakeElement("div");
  var list = new dom.FakeElement("div");
  var clearAll = new dom.FakeElement("button");
  panel.querySelector = function (sel) { return sel === ".diagnostics-panel-clear-all" ? clearAll : null; };
  var byId = { "diagnostics-panel": panel, "diagnostics-panel-list": list, "diagnostics-panel-btn": new dom.FakeElement("button") };
  var prior = global.document.getElementById;
  global.document.getElementById = function (id) { return byId[id] || prior(id); };
  c.diagnostics.initDiagnostics();

  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  assert.equal(c.toasts().length, 1);
  clearAll.click();
  c.tick(300);
  assert.equal(c.allToasts().length, 0);

  c.tick(5100);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  assert.equal(c.allToasts().length, 0);
});

test("another toast and the notice share the one stack, each present once", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic({ type: "diagnostic", severity: "warning", source: "preflight", message: "other" });
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  c.tick(5100);
  c.diagnostics.addDiagnostic(offer("a1", "b1"));
  assert.equal(c.allToasts().length, 2);
  assert.equal(c.toasts().length, 1);
});
