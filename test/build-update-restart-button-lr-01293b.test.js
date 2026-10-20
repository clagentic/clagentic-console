"use strict";

// The "Restart to apply update" / "Restart now" buttons were dead in two ways:
// a click disabled the button before checking that the frame went anywhere, and
// nothing ever gave the button back. A click made while the socket was down (a
// phone resuming a backgrounded tab) sent nothing, logged nothing and left the
// button dimmed for good. A confirmation the daemon answered with a fresh offer
// left the spent card on screen, dimmed, beside the new one.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");

var dom = require("./fake-dom-prompt-cards");
var { createBuildUpdateRestart } = require("../lib/build-update-restart");

var MODULES = path.join(__dirname, "..", "lib", "public", "modules");
var instance = 0;

var BUILDS = {
  loadedBuildSha: "a".repeat(40), installedBuildSha: "b".repeat(40), reason: "sha",
  changes: { available: true, truncated: false, reason: null, commits: [] },
};

function standingOffer() {
  return {
    type: "diagnostic", severity: "warning", source: "build-update",
    message: "A newer build is installed.", buildUpdate: BUILDS,
    actionable: { label: "Restart to apply update", action: "restart_for_build_update" },
  };
}

function confirmOffer(token, message) {
  return {
    type: "diagnostic", severity: "warning", source: "build-update",
    message: message || "A restart now would end 1 live session.",
    buildUpdate: Object.assign({ token: token }, BUILDS),
    actionable: { label: "Restart now", action: "confirm_build_update_restart" },
  };
}

async function client(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var container = new dom.FakeElement("div");
  global.document.body.appendChild(container);
  global.document.getElementById = function (id) { return id === "diagnostic-toast-container" ? container : null; };
  var sent = [];
  var socket = { readyState: 0, send: function (body) { sent.push(JSON.parse(body)); } };
  var wsRef = await import(pathToFileURL(path.join(MODULES, "ws-ref.js")).href);
  wsRef.setWs(socket);
  var diagnostics = await import(dom.moduleUrl("diagnostics.js") + "?case=" + (++instance));
  return {
    sent: sent,
    socket: socket,
    diagnostics: diagnostics,
    container: container,
    buttons: function (label) {
      return container.querySelectorAll("button").filter(function (b) { return b.textContent === label; });
    },
    button: function (label) { return this.buttons(label)[0] || null; },
  };
}

test("a click made while the socket is down sends nothing, keeps the button usable and says why", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(confirmOffer("tok-1"));
  var btn = c.button("Restart now");
  btn.click();
  assert.deepEqual(c.sent, []);
  assert.equal(btn.disabled, false, "a click that sent nothing must not dim the button");
  assert.match(c.container.textContent, /Not connected to Clagentic: Console right now/);

  c.socket.readyState = 1; // the socket came back
  btn.click();
  assert.deepEqual(c.sent, [{ type: "restart_for_build_update", confirmToken: "tok-1", requestId: c.sent[0].requestId }]);
  assert.equal(btn.disabled, true, "a sent request waits for the daemon's answer");
  assert.doesNotMatch(c.container.textContent, /Not connected/, "the note goes once the click went through");
});

test("a daemon answer other than ok gives the button back; ok keeps it dimmed", async function (t) {
  var c = await client(t);
  c.socket.readyState = 1;
  c.diagnostics.addDiagnostic(standingOffer());
  var offerBtn = c.button("Restart to apply update");
  offerBtn.click();
  assert.equal(offerBtn.disabled, true);
  c.diagnostics.settleBuildUpdateRequest({ type: "restart_for_build_update_result", requestId: c.sent[0].requestId, ok: false, needsConfirmation: true });
  assert.equal(offerBtn.disabled, false);

  c.diagnostics.addDiagnostic(confirmOffer("tok-2"));
  var confirmBtn = c.button("Restart now");
  confirmBtn.click();
  c.diagnostics.settleBuildUpdateRequest({ type: "restart_for_build_update_result", requestId: c.sent[1].requestId, ok: true });
  assert.equal(confirmBtn.disabled, true, "a scheduled restart keeps the button dimmed");
});

test("a request nobody answers (refused by the admin gate, reply lost) frees the button after the wait", async function (t) {
  var c = await client(t);
  c.socket.readyState = 1;
  c.diagnostics.addDiagnostic(confirmOffer("tok-3"));
  var btn = c.button("Restart now");
  btn.click();
  assert.equal(btn.disabled, true);
  t.mock.timers.tick(14999);
  assert.equal(btn.disabled, true);
  t.mock.timers.tick(1);
  assert.equal(btn.disabled, false);
  assert.match(c.container.textContent, /did not answer, so the restart may not have been requested/);
});

test("a refusal from the daemon is shown to the operator, not swallowed", async function (t) {
  var c = await client(t);
  c.socket.readyState = 1;
  c.diagnostics.addDiagnostic(confirmOffer("tok-9"));
  c.button("Restart now").click();
  c.diagnostics.settleBuildUpdateRequest({ requestId: c.sent[0].requestId, ok: false, error: "No newer build is installed, so there is nothing to apply." });
  assert.match(c.container.textContent, /nothing to apply/);
  assert.equal(c.button("Restart now").disabled, false);
});

test("a result releases only the request it answers; an uncorrelated result releases nothing", async function (t) {
  var c = await client(t);
  c.socket.readyState = 1;
  c.diagnostics.addDiagnostic(standingOffer());
  var panelLike = c.button("Restart to apply update");
  c.diagnostics.addDiagnostic(confirmOffer("tok-a"));
  var confirmBtn = c.button("Restart now");
  panelLike.click();
  confirmBtn.click();
  assert.equal(c.sent.length, 2);
  assert.notEqual(c.sent[0].requestId, c.sent[1].requestId);

  c.diagnostics.settleBuildUpdateRequest({ ok: false, error: "no id" });
  c.diagnostics.settleBuildUpdateRequest({ requestId: "bu-unknown", ok: false });
  assert.equal(panelLike.disabled, true);
  assert.equal(confirmBtn.disabled, true);

  c.diagnostics.settleBuildUpdateRequest({ requestId: c.sent[1].requestId, ok: false, needsConfirmation: true });
  assert.equal(confirmBtn.disabled, false, "the answered request is released");
  assert.equal(panelLike.disabled, true, "the other request still waits for its own answer");
  t.mock.timers.tick(15000);
  assert.equal(panelLike.disabled, false, "its own timeout still frees it");
});

test("Enter or Space on a toast button activates the button and does not dismiss the card", async function (t) {
  var c = await client(t);
  c.socket.readyState = 1;
  c.diagnostics.addDiagnostic(confirmOffer("tok-k"));
  var toast = c.container.querySelectorAll('[data-diag-source="build-update"]')[0];
  var btn = c.button("Restart now");
  var fire = function (key, target) {
    toast._listeners.keydown.slice().forEach(function (fn) { fn({ key: key, target: target }); });
  };
  fire("Enter", btn);
  fire(" ", btn);
  t.mock.timers.tick(300);
  assert.equal(c.container.querySelectorAll('[data-diag-source="build-update"]').length, 1, "still on screen");
  btn.click();
  assert.equal(c.sent.length, 1, "the button still activates");

  fire("Escape", btn);
  t.mock.timers.tick(300);
  assert.equal(c.container.querySelectorAll('[data-diag-source="build-update"]').length, 0, "Escape still dismisses");
});

test("a re-issued confirmation replaces the spent one, even when its text is identical", async function (t) {
  var c = await client(t);
  c.socket.readyState = 1;
  c.diagnostics.addDiagnostic(confirmOffer("tok-old"));
  c.button("Restart now").click();
  // The daemon spent tok-old and answered with a fresh offer for the same sessions.
  c.diagnostics.addDiagnostic(confirmOffer("tok-new"));
  t.mock.timers.tick(300);
  assert.equal(c.buttons("Restart now").length, 1, "one live confirmation, not a dimmed spent card beside it");
  c.button("Restart now").click();
  var last = c.sent[c.sent.length - 1];
  assert.deepEqual(last, { type: "restart_for_build_update", confirmToken: "tok-new", requestId: last.requestId });
});

test("the daemon journals a confirmation that restarted nothing", async function () {
  var lines = [];
  var sessions = new Map();
  var controller = createBuildUpdateRestart({
    assess: function () {
      return {
        state: "stale", reason: "sha", detail: "d", loadedBuildSha: "old", installedBuildSha: "new",
        loadedContentHash: "h-old", installedContentHash: "h-new",
      };
    },
    getProjects: function () { return [{ slug: "lore", sm: { sessions: sessions } }]; },
    listChanges: async function () { return { available: false, commits: [], truncated: false, reason: null }; },
    restart: function () {},
    waitForIdleThenAct: function () {},
    announce: function () {},
    log: function (line) { lines.push(line); },
  });

  await controller.request("never-issued");
  assert.ok(lines.some(function (l) { return /Restart confirmation not applied: the offer was unknown or expired/.test(l); }), lines.join("\n"));

  var offer = (await controller.request(null)).offer;
  sessions.set("s1", { localId: "s1", title: "late", queryInstance: {}, isProcessing: false, activeTaskToolIds: {} });
  // Ruled contract change (seq 14): a changed session set proceeds and is journaled.
  assert.equal((await controller.request(offer.token)).status, "restarting");
  assert.ok(lines.some(function (l) { return /Restart confirmed after the offer changed \(now live and not offered: lore#s1\)/.test(l); }), lines.join("\n"));

  var again = await controller.request(null);
  assert.equal(again.status, "restarting");
  assert.equal(again.offer, undefined, "a pending restart is never offered again");
  assert.ok(lines.some(function (l) { return /a confirmed restart is already waiting/.test(l); }), lines.join("\n"));
});
