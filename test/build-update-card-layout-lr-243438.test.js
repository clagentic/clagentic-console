"use strict";

// The restart cards must keep their actions reachable at any session count.
// No browser: the real diagnostics module runs over the hand-built DOM, and the
// real stylesheet is read as text to check the bound on the expanded list at a
// phone and a desktop width.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { pathToFileURL } = require("url");

var dom = require("./fake-dom-prompt-cards");
var cssRules = require("./fixtures/css-rules");
var offerLib = require("../lib/build-update-offer");
var changes = require("../lib/build-changes");

var MODULES = path.join(__dirname, "..", "lib", "public", "modules");
var CSS = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "diagnostics.css"), "utf8");
var SESSION_COUNT = 30;
var PHONE = 390;
var DESKTOP = 1280;
var instance = 0;

// Thirty live sessions cycling through the three states the card words.
var ACTIVITIES = ["running", "waiting", "idle"];
function thirtySessions() {
  var sessions = [];
  for (var i = 0; i < SESSION_COUNT; i++) {
    var activity = ACTIVITIES[i % 3];
    sessions.push({
      key: "p#" + i, slug: "p", localId: i, title: "Session number " + i,
      processing: activity === "running", activity: activity, agents: [],
    });
  }
  return { sessions: sessions, sessionCount: SESSION_COUNT, agentCount: 0 };
}

function confirmCard() {
  var interruptions = thirtySessions();
  var offer = offerLib.buildOffer({
    assessment: { loadedBuildSha: "a".repeat(40), installedBuildSha: "b".repeat(40), reason: "sha" },
    interruptions: interruptions,
    token: "tok-layout",
  });
  return {
    type: "diagnostic", severity: "warning", source: "build-update",
    message: offer.interruptionText,
    buildUpdate: offer,
    actionable: { label: "Restart now", action: "confirm_build_update_restart" },
  };
}

function standingCard() {
  return Object.assign(offerLib.composeNotice(
    { loadedBuildSha: "a".repeat(40), installedBuildSha: "b".repeat(40), reason: "sha" },
    { available: false, commits: [], truncated: false, reason: "x" }, 0), { type: "diagnostic" });
}

async function client(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var container = new dom.FakeElement("div");
  global.document.body.appendChild(container);
  global.document.getElementById = function (id) { return id === "diagnostic-toast-container" ? container : null; };
  var wsRef = await import(pathToFileURL(path.join(MODULES, "ws-ref.js")).href);
  wsRef.setWs({ readyState: 1, send: function () {} });
  var diagnostics = await import(dom.moduleUrl("diagnostics.js") + "?layout=" + (++instance));
  return {
    diagnostics: diagnostics,
    container: container,
    button: function (label) {
      return container.querySelectorAll("button").filter(function (b) { return b.textContent === label; })[0] || null;
    },
  };
}

function textOf(els) { return els.map(function (e) { return e.textContent; }); }

test("confirm card, 30 sessions: collapsed to a count line by default, actions outside the list region", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(confirmCard());

  var region = c.container.querySelectorAll(".build-update-sessions");
  assert.equal(region.length, 1, "one session region on the card");
  assert.equal(region[0].classList.contains("is-collapsed"), true, "collapsed by default");
  assert.equal(textOf(region[0].querySelectorAll(".build-update-sessions-count"))[0], "Ends 30 live sessions");
  var toggle = region[0].querySelectorAll("button")[0];
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  var card = c.container.querySelectorAll(".toast-diagnostic")[0];
  var message = card.querySelectorAll(".toast-diagnostic-msg")[0].textContent;
  assert.ok(message.indexOf("Session number 0") === -1, "the message no longer carries a line per session");
  assert.ok(message.split("\n").length <= 3, "the message is the statement, not the list: " + message);
  assert.ok(message.indexOf("ends 30 live sessions") !== -1, message);

  ["Restart now", "Not now"].forEach(function (label) {
    var btn = c.button(label);
    assert.ok(btn, label + " is on the card");
    assert.equal(region[0].contains(btn), false, label + " sits outside the session region");
    assert.equal(card.contains(btn), true);
  });
});

test("confirm card, 30 sessions: the control expands and collapses the list; every state label survives", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(confirmCard());
  var region = c.container.querySelectorAll(".build-update-sessions")[0];
  var toggle = region.querySelectorAll("button")[0];

  toggle.click();
  assert.equal(region.classList.contains("is-collapsed"), false, "expanded");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  var items = region.querySelectorAll("li");
  assert.equal(items.length, SESSION_COUNT);
  var shown = textOf(items);
  assert.ok(shown.some(function (l) { return l === "[p] Session number 0 (running a turn)"; }), shown[0]);
  assert.ok(shown.some(function (l) { return l === "[p] Session number 1 (waiting on a prompt)"; }));
  assert.ok(shown.some(function (l) { return l === "[p] Session number 2 (idle)"; }));
  assert.equal(region.contains(c.button("Restart now")), false, "the action stays outside the list when expanded");
  assert.equal(region.contains(c.button("Not now")), false);

  toggle.click();
  assert.equal(region.classList.contains("is-collapsed"), true, "collapsed again");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("offer card: the standing offer names no session, so it has no session region, and its action is on the card", async function (t) {
  var c = await client(t);
  c.diagnostics.addDiagnostic(standingCard());
  assert.equal(c.container.querySelectorAll(".build-update-sessions").length, 0);
  assert.ok(c.button("Restart to apply update"));
});

test("the diagnostics panel entry collapses the list the same way", async function (t) {
  var c = await client(t);
  var panel = new dom.FakeElement("div");
  panel.classList.add("hidden");
  var list = new dom.FakeElement("div");
  var byId = {
    "diagnostics-panel": panel, "diagnostics-panel-list": list,
    "diagnostics-panel-btn": new dom.FakeElement("button"),
    "diagnostic-toast-container": c.container,
    "diagnostics-panel-badge": new dom.FakeElement("span"),
  };
  global.document.getElementById = function (id) { return byId[id] || null; };
  c.diagnostics.initDiagnostics();
  c.diagnostics.addDiagnostic(confirmCard(), { toast: false });

  var region = list.querySelectorAll(".build-update-sessions");
  assert.equal(region.length, 1);
  assert.equal(region[0].classList.contains("is-collapsed"), true);
  var action = list.querySelectorAll("button").filter(function (b) { return b.textContent === "Restart now"; })[0];
  assert.ok(action);
  assert.equal(region[0].contains(action), false);
});

test("css: the list region is hidden while collapsed and bounded in height at phone and desktop widths", function () {
  var hidden = cssRules.valueAt(CSS, ".build-update-sessions.is-collapsed .build-update-session-list", "display", DESKTOP);
  assert.equal(hidden, "none", "a collapsed list takes no height");

  [PHONE, DESKTOP].forEach(function (width) {
    var max = cssRules.valueAt(CSS, ".build-update-session-list", "max-height", width);
    assert.match(max || "", /^\d+(\.\d+)?(px|vh)$/, "a bounded max-height holds at " + width + "px, got " + max);
    assert.equal(cssRules.valueAt(CSS, ".build-update-session-list", "overflow-y", width), "auto",
      "the list scrolls inside its bound at " + width + "px");
  });

  var phone = cssRules.rules(CSS).filter(function (r) {
    return r.selector === ".build-update-session-list" && r.media !== null;
  });
  assert.ok(phone.length > 0, "the phone bound is a rule in the stylesheet's mobile @media block");
  assert.ok(phone.every(function (r) { return cssRules.mediaApplies(r.media, PHONE) && !cssRules.mediaApplies(r.media, DESKTOP); }),
    "the phone rule applies at 390px and not at desktop width");
});

test("css: the region uses existing theme variables, not new colours", function () {
  var block = cssRules.rules(CSS).filter(function (r) { return /^\.build-update-sessions/.test(r.selector); })
    .map(function (r) { return r.body; }).join("\n");
  assert.ok(block.length > 0);
  assert.equal(/#[0-9a-f]{3,8}\b|rgb\(/i.test(block), false, "no literal colours in the session region rules");
});

test("change list: an install with no checkout says why, and names the setting that fixes it", async function () {
  var out = await changes.listBuildChanges({ repo: null, fromSha: "a".repeat(40), toSha: "b".repeat(40) });
  assert.equal(out.available, false);
  assert.match(out.reason, /installed from a package, not a checkout/);
  assert.match(out.reason, /buildSourceRepo/);
});

test("change list: the package directory of a packed install has no .git, so only buildSourceRepo resolves a repo", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-root-"));
  try {
    assert.equal(changes.resolveHistoryRepo(undefined, root), null, "a packed install has no history of its own");
    assert.equal(changes.resolveHistoryRepo("relative/path", root), null, "a relative buildSourceRepo is not used");
    var configured = path.join(root, "checkout");
    assert.equal(changes.resolveHistoryRepo(configured, root), configured);
    fs.mkdirSync(path.join(root, ".git"));
    assert.equal(changes.resolveHistoryRepo(undefined, root), root, "a checkout resolves itself");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("offer: the session lines are the same wording the message carries", function () {
  var interruptions = thirtySessions();
  var offer = offerLib.buildOffer({
    assessment: { loadedBuildSha: "a".repeat(40), installedBuildSha: "b".repeat(40), reason: "sha" },
    interruptions: interruptions,
  });
  assert.equal(offer.interruptions.lines.length, SESSION_COUNT);
  offer.interruptions.lines.forEach(function (l) {
    assert.ok(offer.interruptionText.split("\n").indexOf("- " + l) !== -1, l);
  });
});
