"use strict";

// The agent-messages section of the Team view: drawn through the section
// registry on desktop and on the phone sheet, from the snapshot the server sends.
// Drives the real client modules under a hand-built DOM; neutral fixtures.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var dom = require("./fake-dom-prompt-cards.js");

var ROOT = path.resolve(__dirname, "..");

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

function installPage(innerWidth) {
  dom.setupGlobals();
  global.window.innerWidth = innerWidth || 1280;
  var els = {};
  ["team-view", "team-view-body", "team-view-close", "icon-strip-team-btn"].forEach(function (id) { els[id] = new dom.FakeElement("div"); });
  els["team-view"].className = "hidden";
  global.document.getElementById = function (id) { return els[id] || null; };
  return els;
}

var sentFrames;
var instance = 0;
async function load(innerWidth) {
  var els = installPage(innerWidth);
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({ connected: true });
  var wsRef = await import(dom.moduleUrl("ws-ref.js"));
  sentFrames = [];
  wsRef.setWs({ readyState: 1, send: function (s) { sentFrames.push(JSON.parse(s)); } });
  var view = await import(dom.moduleUrl("team-view.js"));
  var panel = await import(dom.moduleUrl("team-panel.js"));
  // A fresh module per test: the section keeps its selection and last snapshot.
  var am = await import(dom.moduleUrl("agent-messages.js") + "?test=" + (++instance));
  view.initTeamView();
  panel.handleTeamGone();
  view.closeTeamView();
  var opened = [];
  am.initAgentMessages({ openSession: function (project, id) { opened.push({ project: project, id: id }); } });
  return { els: els, view: view, am: am, opened: opened };
}

function sender(over) {
  return Object.assign({ senderKind: "extracted", attribution: "extracted", fromName: "worker-a@side", senderAgent: "worker-a" }, over || {});
}

function snapshot(over) {
  var key = "s:side/cli-sender>work/cli-shared";
  return Object.assign({
    type: "team_traffic",
    ok: true,
    result: "listed",
    retentionDays: 30,
    pairs: [{
      key: key,
      sender: Object.assign(sender(), { link: { project: "side", id: 7 } }),
      target: { project: "work", agent: "reviewer", link: { project: "work", id: 100 } },
      count: 2,
      pendingCount: 1,
      lastAt: new Date(Date.now() - 60 * 1000).toISOString(),
    }],
    messages: [
      { pairKey: key, ts: new Date(Date.now() - 120 * 1000).toISOString(), kind: "open", result: "opened", reason: null, text: "start the review", truncated: false, contextNote: "pr 12" },
      { pairKey: key, ts: new Date(Date.now() - 60 * 1000).toISOString(), kind: "input", result: "delivered", reason: null, text: "second note", truncated: false, contextNote: null },
    ],
    pending: [{ pairKey: key, id: "si_1", kind: "scheduled", nextAt: Date.now() + 3600 * 1000, createdBy: "browser:someone", text: "check in later", truncated: false }],
    withheld: { count: 0, reasons: [] },
  }, over || {});
}

test("the section is registered beside the others and asks the server for its data when drawn", async function () {
  var m = await load();
  assert.ok(m.view.listTeamSections().some(function (s) { return s.id === "agent-messages" && s.title === "Agent messages"; }));
  m.view.openTeamView();
  assert.deepEqual(sentFrames.map(function (f) { return f.type; }), ["team_traffic_request"]);
  assert.ok(m.els["team-view-body"].querySelector(".am-empty"), "loading state until the answer");
});

test("the map lists each pair with its count and last seen; selecting it shows the thread in order", async function () {
  var m = await load();
  m.view.openTeamView();
  m.am.handleTeamTraffic(snapshot());
  var body = m.els["team-view-body"];

  var rows = body.querySelectorAll(".am-pair");
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /worker-a@side/);
  assert.match(rows[0].textContent, /reviewer@work/);
  assert.match(rows[0].textContent, /2/);
  assert.match(rows[0].textContent, /1m ago/);
  assert.match(rows[0].textContent, /1 pending/);
  assert.equal(body.querySelectorAll(".am-message").length, 0, "no thread until a pair is selected");

  rows[0].click();
  var messages = body.querySelectorAll(".am-message");
  assert.equal(messages.length, 3, "two sent messages and one pending");
  var text = body.textContent;
  assert.ok(text.indexOf("start the review") < text.indexOf("second note"), "oldest first");
  ["open", "opened", "input", "delivered", "pr 12"].forEach(function (needle) { assert.ok(text.indexOf(needle) >= 0, "missing " + needle); });
  assert.ok(messages[2].classList.contains("pending"), "the pending input is last and marked");
  assert.match(messages[2].textContent, /pending/);
  assert.match(messages[2].textContent, /check in later/);
  assert.equal(messages[2].querySelectorAll("button").length, 0, "a pending input has no actions here");
});

test("a message links to the sender's and the target's session; a session that is gone has no link", async function () {
  var m = await load();
  m.view.openTeamView();
  var snap = snapshot();
  m.am.handleTeamTraffic(snap);
  m.els["team-view-body"].querySelector(".am-pair").click();

  var links = m.els["team-view-body"].querySelectorAll(".am-link");
  assert.deepEqual(links.map(function (l) { return l.textContent; }), ["Sender session", "Target session", "Sender session", "Target session"]);
  links[1].click();
  assert.deepEqual(m.opened, [{ project: "work", id: 100 }]);
  assert.equal(m.view.isTeamViewOpen(), false, "the view closes so the session shows");

  var gone = snapshot();
  gone.pairs[0].target.link = null;
  m.view.openTeamView();
  m.am.handleTeamTraffic(gone);
  m.els["team-view-body"].querySelector(".am-pair").click();
  assert.deepEqual(m.els["team-view-body"].querySelectorAll(".am-link").map(function (l) { return l.textContent; }), ["Sender session", "Sender session"]);
});

test("a new snapshot redraws the open section without a reload, and the live nudge asks again", async function () {
  var m = await load();
  m.view.openTeamView();
  m.am.handleTeamTraffic(snapshot());
  m.els["team-view-body"].querySelector(".am-pair").click();
  assert.equal(m.els["team-view-body"].textContent.indexOf("third note"), -1);

  var next = snapshot();
  next.pairs[0].count = 3;
  next.messages.push({ pairKey: next.pairs[0].key, ts: new Date().toISOString(), kind: "input", result: "delivered", reason: null, text: "third note", truncated: false, contextNote: null });
  m.am.handleTeamTraffic(next);
  assert.ok(m.els["team-view-body"].textContent.indexOf("third note") >= 0, "the thread shows the new message in place");

  var before = sentFrames.length;
  m.am.handleTeamTrafficChanged();
  assert.equal(sentFrames.length, before + 1);
  assert.equal(sentFrames[sentFrames.length - 1].type, "team_traffic_request");
});

test("the empty state says why: nothing recorded, withheld from this user, ledger off, or unreadable", async function () {
  var m = await load();
  m.view.openTeamView();
  var cases = [
    [snapshot({ pairs: [], messages: [], pending: [] }), /No agent messages recorded yet/],
    [snapshot({ pairs: [], messages: [], pending: [], withheld: { count: 2, reasons: ["the caller cannot read the target session"] } }), /2 messages are withheld from you: the caller cannot read the target session/],
    [snapshot({ pairs: [], messages: [], pending: [], note: "the outbound ledger is turned off (outboundRetentionDays is 0)" }), /turned off/],
    [{ type: "team_traffic", ok: false, result: "error", reason: "the outbound ledger cannot be read" }, /could not be read: the outbound ledger cannot be read/],
  ];
  cases.forEach(function (c) {
    m.am.handleTeamTraffic(c[0]);
    var empty = m.els["team-view-body"].querySelector(".am-empty");
    assert.ok(empty, "an empty state is drawn");
    assert.match(empty.textContent, c[1]);
  });
});

test("withheld entries beside visible ones are reported under the map", async function () {
  var m = await load();
  m.view.openTeamView();
  m.am.handleTeamTraffic(snapshot({ withheld: { count: 1, reasons: ["the target session runs as another OS user"] } }));
  assert.match(m.els["team-view-body"].querySelector(".am-footnote").textContent, /1 message is withheld from you: the target session runs as another OS user/);
});

test("the phone sheet draws the section through the same registry, one pane at a time", async function () {
  var m = await load(390);
  var sheet = new dom.FakeElement("div");
  m.view.renderTeamSections(sheet);
  m.am.handleTeamTraffic(snapshot());
  assert.ok(sheet.querySelector(".am-layout.phone"), "phone layout");
  assert.equal(sheet.querySelectorAll(".am-pair").length, 1);
  assert.equal(sheet.querySelectorAll(".am-thread").length, 0, "the map alone until a pair is chosen");

  sheet.querySelector(".am-pair").click();
  assert.equal(sheet.querySelectorAll(".am-pair").length, 0, "the thread replaces the map");
  assert.equal(sheet.querySelectorAll(".am-message").length, 3);
  sheet.querySelector(".am-back").click();
  assert.equal(sheet.querySelectorAll(".am-pair").length, 1, "Back returns to the map");

  var mobileSrc = read("lib/public/modules/sidebar-mobile.js");
  assert.match(mobileSrc, /function renderSheetTeam\(listEl\) \{\s*renderTeamSections\(listEl\);\s*\}/);
});

test("it reads only: no module of the section sends anything but a request for the data", function () {
  var src = read("lib/public/modules/agent-messages.js");
  var types = src.match(/type:\s*"[a-z_]+"/g) || [];
  assert.deepEqual(types, ['type: "team_traffic_request"']);
  assert.doesNotMatch(src, /schedule_message|cancel_scheduled|send_scheduled|send_input|open_session/);
});

test("the server messages are wired to the section and listed in the schema", function () {
  var wiring = read("lib/public/modules/app-messages.js");
  assert.match(wiring, /team_traffic: handleTeamTraffic/);
  assert.match(wiring, /team_traffic_changed: handleTeamTrafficChanged/);
  var schema = read("lib/ws-schema.js");
  ["team_traffic_request", "team_traffic", "team_traffic_changed"].forEach(function (t) {
    assert.ok(schema.indexOf('"' + t + '"') >= 0, t);
  });
  var handler = read("lib/project-user-message.js");
  assert.match(handler, /teamTraffic\.handle\(ws, msg\)/);
});
