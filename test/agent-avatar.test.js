"use strict";

// The shared agent-avatar resolver and the roster section built on it: one
// resolver answers for the Team roster, the Agent messages section, an injected
// message's sender and a sub-agent's label in the transcript; a choice reaches all
// of them; a deleted custom icon falls back to the seeded robot. Neutral fixtures.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var dom = require("./fake-dom-prompt-cards.js");

var ROOT = path.resolve(__dirname, "..");

function mod(name, query) {
  return import(dom.moduleUrl(name) + (query || ""));
}

var instance = 0;

async function loadAvatar() {
  dom.setupGlobals();
  var avatar = await mod("agent-avatar.js");
  avatar.setAgentAvatars([]);
  return avatar;
}

function fireError(img) {
  (img._listeners.error || []).slice().forEach(function (fn) { fn({}); });
}

test("with no choice an agent shows the seeded robot, or the caller's default", async function () {
  var a = await loadAvatar();
  var robot = a.robotAvatarUrl("agent-a", 40);
  assert.match(robot, /\/bottts\/svg\?seed=agent-a&size=40$/);
  assert.deepEqual(a.resolveAgentAvatar("agent-a", 40), { url: robot, fallbackUrl: robot, custom: null });
  var withDefault = a.resolveAgentAvatar("agent-a", 40, "https://example.test/mate.svg");
  assert.equal(withDefault.url, "https://example.test/mate.svg");
  assert.equal(withDefault.fallbackUrl, "https://example.test/mate.svg");
});

test("a built-in style choice resolves through avatar.js with its seed", async function () {
  var a = await loadAvatar();
  a.setAgentAvatars([{ key: "agent-a", avatar: { style: "pixel-art", seed: "seed-1" } }]);
  var r = a.resolveAgentAvatar("agent-a", 40);
  assert.match(r.url, /\/pixel-art\/svg\?seed=seed-1&size=40$/);
  assert.equal(r.custom, null);
  assert.equal(r.fallbackUrl, a.robotAvatarUrl("agent-a", 40));
});

test("a custom-icon choice resolves to the global store, with the seeded robot as fallback", async function () {
  var a = await loadAvatar();
  a.setAgentAvatars([{ key: "agent-a", avatar: { custom: "team-icon" } }]);
  var r = a.resolveAgentAvatar("agent-a", 40);
  assert.equal(r.url, "/api/custom-emoji/team-icon");
  assert.equal(r.custom, "team-icon");
  assert.equal(r.fallbackUrl, a.robotAvatarUrl("agent-a", 40));
});

test("a choice that cannot be drawn is ignored, never an error or a broken URL", async function () {
  var a = await loadAvatar();
  a.setAgentAvatars([
    { key: "agent-a", avatar: { style: "no-such-style", seed: "s" } },
    { key: "agent-b", avatar: { custom: "Bad Slug!" } },
    { key: "agent-c", avatar: "robot" },
    { key: "agent-d" },
    null,
  ]);
  ["agent-a", "agent-b", "agent-c", "agent-d"].forEach(function (k) {
    assert.equal(a.resolveAgentAvatar(k, 40).url, a.robotAvatarUrl(k, 40), k);
  });
});

test("a custom icon that is gone from the store falls back to the seeded robot, once", async function () {
  var a = await loadAvatar();
  a.setAgentAvatars([{ key: "agent-a", avatar: { custom: "deleted-icon" } }]);
  var img = a.createAgentAvatar("agent-a", 24, "x");
  assert.equal(img.src, "/api/custom-emoji/deleted-icon");
  fireError(img);
  assert.equal(img.src, a.robotAvatarUrl("agent-a", 24));
  fireError(img);
  assert.equal(img.src, a.robotAvatarUrl("agent-a", 24), "a failing fallback does not loop");
});

test("a fallback that fails too is left alone, with no thrown error", async function () {
  var a = await loadAvatar();
  var img = a.createAgentAvatar("agent-a", 24, "x");
  assert.doesNotThrow(function () { fireError(img); });
});

test("a custom icon deleted after it was chosen: the roster's next message repaints the avatar to the robot", async function () {
  var a = await loadAvatar();
  var root = new dom.FakeElement("div");
  a.setAgentAvatars([{ key: "agent-a", avatar: { custom: "team-icon" } }]);
  var img = a.createAgentAvatar("agent-a", 24, "x");
  root.appendChild(img);
  assert.equal(img.src, "/api/custom-emoji/team-icon");
  fireError(img);
  a.setAgentAvatars([{ key: "agent-a", avatar: null }]);
  a.refreshAgentAvatars(root);
  assert.equal(img.src, a.robotAvatarUrl("agent-a", 24));
  assert.equal(img._agentFellBack, false, "repainting re-arms the fallback");
});

test("refreshAgentAvatars repaints every bound avatar under the root, and listeners hear of the change", async function () {
  var a = await loadAvatar();
  var root = new dom.FakeElement("div");
  var one = a.createAgentAvatar("agent-a", 24, "x");
  var two = a.createAgentAvatar("agent-a", 40, "y");
  var other = a.createAgentAvatar("agent-b", 24, "z");
  [one, two, other].forEach(function (i) { root.appendChild(i); });
  var heard = 0;
  var stop = a.onAgentAvatarsChanged(function () { heard++; });

  a.setAgentAvatars([{ key: "agent-a", avatar: { style: "micah", seed: "s" } }]);
  a.refreshAgentAvatars(root);
  assert.match(one.src, /\/micah\/svg\?seed=s&size=24$/);
  assert.match(two.src, /\/micah\/svg\?seed=s&size=40$/, "each keeps its own size");
  assert.equal(other.src, a.robotAvatarUrl("agent-b", 24), "another agent is untouched");
  assert.equal(heard, 1);
  stop();
  a.setAgentAvatars([]);
  assert.equal(heard, 1);
});

// --- Consumers ---

test("an injected sender's avatar follows the roster: declared and extracted senders are keyed, others are not", async function () {
  var a = await loadAvatar();
  var identity = await mod("injected-identity.js");
  a.setAgentAvatars([
    { key: "sender-z", avatar: { custom: "team-icon" } },
    { key: "worker-a", avatar: { style: "icons", seed: "s" } },
  ]);

  var declared = identity.resolveInjectedIdentity({ senderKind: "declared", fromName: "sender-z" }, "injected:trigger", [], 36);
  assert.equal(declared.agentKey, "sender-z");
  assert.equal(declared.avatarUrl, "/api/custom-emoji/team-icon");
  assert.match(declared.defaultAvatarUrl, /\/bottts\/svg\?seed=sender-z&size=36$/);

  var extracted = identity.resolveInjectedIdentity({ senderKind: "extracted", fromName: "worker-a@side", senderAgent: "worker-a" }, undefined, [], 36);
  assert.equal(extracted.agentKey, "worker-a");
  assert.match(extracted.avatarUrl, /\/icons\/svg\?seed=s&size=36$/);

  var undeclared = identity.resolveInjectedIdentity({ senderKind: "undeclared" }, undefined, [], 36);
  assert.equal(undeclared.agentKey, null);
  assert.equal(undeclared.avatarUrl, undeclared.defaultAvatarUrl);
  var automation = identity.resolveInjectedIdentity({ senderKind: "automation", fromName: "sender-z" }, undefined, [], 36);
  assert.equal(automation.agentKey, null, "the console's own automations are not agents");
  assert.equal(automation.avatarUrl, automation.defaultAvatarUrl);
});

test("an injected sender's avatar already on the page changes when the roster does", async function () {
  var a = await loadAvatar();
  var identity = await mod("injected-identity.js");
  var img = new dom.FakeElement("img");
  var root = new dom.FakeElement("div");
  root.appendChild(img);
  var id = identity.resolveInjectedIdentity({ senderKind: "declared", fromName: "sender-z" }, "injected:trigger", [], 36);
  a.applyIdentityAvatar(img, id, 36);
  assert.equal(img.src, id.defaultAvatarUrl);

  a.setAgentAvatars([{ key: "sender-z", avatar: { style: "thumbs", seed: "other" } }]);
  a.refreshAgentAvatars(root);
  assert.match(img.src, /\/thumbs\/svg\?seed=other&size=36$/);
  a.setAgentAvatars([]);
  a.refreshAgentAvatars(root);
  assert.equal(img.src, id.defaultAvatarUrl, "clearing the choice returns the default the sender always had");
});

test("a sender with no agent key keeps the plain avatar and is not bound", async function () {
  var a = await loadAvatar();
  var img = new dom.FakeElement("img");
  a.applyIdentityAvatar(img, { avatarUrl: "https://example.test/x.svg", agentKey: null }, 36);
  assert.equal(img.src, "https://example.test/x.svg");
  assert.equal(img.dataset.agentKey, undefined);
});

async function loadTeam(innerWidth) {
  dom.setupGlobals();
  global.window.innerWidth = innerWidth || 1280;
  var els = {};
  ["team-view", "team-view-body", "team-view-close", "icon-strip-team-btn"].forEach(function (id) { els[id] = new dom.FakeElement("div"); });
  els["team-view"].className = "hidden";
  global.document.getElementById = function (id) { return els[id] || null; };
  // On the page, as in a browser: the avatar refresh finds what the view drew.
  global.document.body.appendChild(els["team-view-body"]);
  var storeMod = await mod("store.js");
  storeMod.createStore({ connected: true });
  var wsRef = await mod("ws-ref.js");
  var frames = [];
  wsRef.setWs({ readyState: 1, send: function (s) { frames.push(JSON.parse(s)); } });
  var view = await mod("team-view.js");
  var panel = await mod("team-panel.js");
  var avatar = await mod("agent-avatar.js");
  avatar.setAgentAvatars([]);
  var n = ++instance;
  var roster = await mod("agent-roster.js", "?test=" + n);
  var messages = await mod("agent-messages.js", "?test=" + n);
  view.initTeamView();
  panel.handleTeamGone();
  view.closeTeamView();
  messages.initAgentMessages({});
  return { els: els, view: view, roster: roster, messages: messages, avatar: avatar, frames: frames };
}

function agent(key, over) {
  return Object.assign({ key: key, firstSeen: Date.now() - 3600 * 1000, lastSeen: Date.now() - 60 * 1000, places: [{ source: "session", project: "proj-1", lastSeen: Date.now() - 60 * 1000 }], avatar: null }, over || {});
}

test("the roster is a Team view section that asks for the roster when drawn", async function () {
  var m = await loadTeam();
  var section = m.view.listTeamSections().filter(function (s) { return s.id === "agent-roster"; })[0];
  assert.ok(section, "registered");
  assert.equal(section.title, "Agents");
  m.view.openTeamView();
  var body = m.els["team-view-body"];
  var tab = body.querySelectorAll(".team-view-tab").filter(function (t) { return t.dataset.sectionId === "agent-roster"; })[0];
  tab.click();
  assert.ok(m.frames.some(function (f) { return f.type === "agent_roster_request"; }));
  assert.ok(body.querySelector(".ar-empty"), "loading state until the roster arrives");
});

test("each roster entry shows its avatar, last seen and where it was seen, and no first seen; the list updates live", async function () {
  var m = await loadTeam();
  m.view.openTeamView();
  var body = m.els["team-view-body"];
  body.querySelectorAll(".team-view-tab").filter(function (t) { return t.dataset.sectionId === "agent-roster"; })[0].click();

  m.roster.handleAgentRoster({ type: "agent_roster", agents: [] });
  assert.match(body.querySelector(".ar-empty").textContent, /No agents seen yet/);

  m.roster.handleAgentRoster({ type: "agent_roster", agents: [
    agent("agent-a"),
    agent("helper-x", { places: [{ source: "subagent", project: "proj-2", lastSeen: Date.now() }, { source: "sender", project: null, lastSeen: Date.now() }] }),
  ] });
  var rows = body.querySelectorAll(".ar-row");
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /agent-a/);
  assert.doesNotMatch(rows[0].textContent, /First seen/);
  assert.match(rows[0].textContent, /Last seen 1m ago/);
  assert.match(rows[0].textContent, /session agent in proj-1/);
  assert.doesNotMatch(rows[0].textContent, /session \d/);
  assert.match(rows[1].textContent, /sub-agent in proj-2/);
  assert.match(rows[1].textContent, /sender/);
  var avatarImg = rows[0].querySelector(".ar-avatar");
  assert.equal(avatarImg.dataset.agentKey, "agent-a");
  assert.equal(avatarImg.src, m.avatar.robotAvatarUrl("agent-a", 40));

  m.roster.handleAgentRoster({ type: "agent_roster", agents: [agent("agent-a"), agent("helper-x"), agent("late-comer")] });
  assert.equal(body.querySelectorAll(".ar-row").length, 3, "a newly seen agent appears without a reload");
});

test("choosing a built-in style, a custom icon or the default sends the choice for that agent", async function () {
  var m = await loadTeam();
  m.view.openTeamView();
  var body = m.els["team-view-body"];
  body.querySelectorAll(".team-view-tab").filter(function (t) { return t.dataset.sectionId === "agent-roster"; })[0].click();
  m.roster.handleAgentRoster({ type: "agent_roster", agents: [agent("agent-a")] });
  m.frames.length = 0;

  body.querySelector(".ar-change").click();
  var picker = body.querySelector(".ar-picker");
  assert.ok(picker, "the picker opens under the entry");
  var styleButtons = picker.querySelectorAll(".ar-choice").filter(function (b) { return b.dataset.style; });
  assert.ok(styleButtons.length >= 2, "every built-in style is offered");
  styleButtons.filter(function (b) { return b.dataset.style === "pixel-art"; })[0].click();
  assert.deepEqual(m.frames[0], { type: "agent_avatar_set", key: "agent-a", avatar: { style: "pixel-art", seed: "agent-a" } });

  picker.querySelector(".ar-reset").click();
  assert.deepEqual(m.frames[1], { type: "agent_avatar_set", key: "agent-a", avatar: null });
});

test("the picker lists the global custom-icon store, uploads into it, and chooses the upload", async function () {
  dom.setupGlobals();
  var pickerMod = await mod("agent-avatar-picker.js");
  var chosen = [];
  var uploads = [];
  var picker = pickerMod.buildAvatarPicker("agent-a", function (ref) { chosen.push(ref); }, {
    fetchList: function () { return Promise.resolve([{ slug: "team-icon", url: "/api/custom-emoji/team-icon" }, { slug: "logo", url: "/api/custom-emoji/logo" }]); },
    upload: function (slug, file) { uploads.push({ slug: slug, file: file }); return Promise.resolve({ ok: true, slug: slug }); },
  });
  await new Promise(function (r) { setImmediate(r); });

  var icons = picker.querySelectorAll(".ar-choice").filter(function (b) { return b.dataset.custom; });
  assert.deepEqual(icons.map(function (b) { return b.dataset.custom; }), ["team-icon", "logo"]);
  icons[0].click();
  assert.deepEqual(chosen[0], { custom: "team-icon" });

  var file = picker.querySelector(".ar-file");
  file.files = [{ name: "Logo.PNG" }];
  (file._listeners.change || []).forEach(function (fn) { fn({}); });
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].slug, "logo-2", "an upload never replaces an icon something else uses");
  assert.deepEqual(chosen[1], { custom: "logo-2" });
});

test("a failed upload is reported in the picker and chooses nothing", async function () {
  dom.setupGlobals();
  var pickerMod = await mod("agent-avatar-picker.js");
  var chosen = [];
  var picker = pickerMod.buildAvatarPicker("agent-a", function (ref) { chosen.push(ref); }, {
    fetchList: function () { return Promise.resolve([]); },
    upload: function () { return Promise.resolve({ ok: false, error: "File too large" }); },
  });
  await new Promise(function (r) { setImmediate(r); });
  assert.match(picker.textContent, /No custom icons uploaded yet/);
  var file = picker.querySelector(".ar-file");
  file.files = [{ name: "big.png" }];
  (file._listeners.change || []).forEach(function (fn) { fn({}); });
  await new Promise(function (r) { setImmediate(r); });
  assert.match(picker.textContent, /Upload failed: File too large/);
  assert.equal(chosen.length, 0);
});

test("a custom-icon list that cannot be loaded shows an error, not an empty store", async function () {
  dom.setupGlobals();
  var pickerMod = await mod("agent-avatar-picker.js");
  var picker = pickerMod.buildAvatarPicker("agent-a", function () {}, {
    fetchList: function () { return Promise.reject(new Error("offline")); },
    upload: function () { return Promise.resolve({ ok: true }); },
  });
  await new Promise(function (r) { setImmediate(r); });
  assert.match(picker.textContent, /Custom icons could not be loaded/);
  assert.doesNotMatch(picker.textContent, /No custom icons uploaded yet/);
});

test("the picker's own upload is create-only; the shared upload helper replaces unless asked", async function () {
  dom.setupGlobals();
  var icons = await mod("custom-icons.js");
  var realFetch = global.fetch;
  var realReader = global.FileReader;
  var urls = [];
  global.fetch = function (url) {
    urls.push(url);
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true }); } });
  };
  global.FileReader = function () {
    var self = this;
    this.readAsArrayBuffer = function () { setImmediate(function () { self.onload({ target: { result: new ArrayBuffer(1) } }); }); };
  };
  try {
    await icons.uploadCustomIcon("a-icon", {});
    await icons.uploadCustomIcon("a-icon", {}, { createOnly: true });
    assert.deepEqual(urls, ["/api/custom-emoji/a-icon", "/api/custom-emoji/a-icon?create=1"]);

    urls.length = 0;
    var pickerMod = await mod("agent-avatar-picker.js");
    var picker = pickerMod.buildAvatarPicker("agent-a", function () {}, { fetchList: function () { return Promise.resolve([]); } });
    await new Promise(function (r) { setImmediate(r); });
    var file = picker.querySelector(".ar-file");
    file.files = [{ name: "Logo.PNG" }];
    (file._listeners.change || []).forEach(function (fn) { fn({}); });
    await new Promise(function (r) { setTimeout(r, 20); });
    assert.deepEqual(urls, ["/api/custom-emoji/logo?create=1"]);
  } finally {
    global.fetch = realFetch;
    global.FileReader = realReader;
  }
});

test("uniqueSlug stays inside the store's slug limit", async function () {
  dom.setupGlobals();
  var pickerMod = await mod("agent-avatar-picker.js");
  assert.equal(pickerMod.uniqueSlug("a", []), "a");
  assert.equal(pickerMod.uniqueSlug("a", ["a", "a-2"]), "a-3");
  var long = "x".repeat(64);
  var next = pickerMod.uniqueSlug(long, [long]);
  assert.equal(next.length, 64);
  assert.match(next, /-2$/);
});

test("a refused avatar change is reported under the open entry", async function () {
  var m = await loadTeam();
  m.view.openTeamView();
  var body = m.els["team-view-body"];
  body.querySelectorAll(".team-view-tab").filter(function (t) { return t.dataset.sectionId === "agent-roster"; })[0].click();
  m.roster.handleAgentRoster({ type: "agent_roster", agents: [agent("agent-a")] });
  body.querySelector(".ar-change").click();
  m.roster.handleAgentAvatarSetResult({ type: "agent_avatar_set_result", key: "agent-a", ok: false, error: "that agent has not been seen" });
  assert.match(body.querySelector(".ar-failure").textContent, /could not be saved: that agent has not been seen/);
});

test("a roster that changes only sighting times does not redraw an open picker", async function () {
  var m = await loadTeam();
  m.view.openTeamView();
  var body = m.els["team-view-body"];
  body.querySelectorAll(".team-view-tab").filter(function (t) { return t.dataset.sectionId === "agent-roster"; })[0].click();
  m.roster.handleAgentRoster({ type: "agent_roster", agents: [agent("agent-a")] });
  body.querySelector(".ar-change").click();
  var picker = body.querySelector(".ar-picker");
  m.roster.handleAgentRoster({ type: "agent_roster", agents: [agent("agent-a", { lastSeen: Date.now() })] });
  assert.equal(body.querySelector(".ar-picker"), picker, "the same picker element is still on screen");
  m.roster.handleAgentRoster({ type: "agent_roster", agents: [agent("agent-a", { avatar: { style: "micah", seed: "s" } })] });
  assert.notEqual(body.querySelector(".ar-picker"), picker, "a changed choice redraws it");
});

test("a choice reaches every consumer at once: Agent messages, an injected sender and the resolver", async function () {
  var m = await loadTeam();
  var identity = await mod("injected-identity.js");
  var body = m.els["team-view-body"];

  // Agent messages: a thread whose sender is the extracted agent "worker-a".
  m.view.openTeamView();
  body.querySelectorAll(".team-view-tab").filter(function (t) { return t.dataset.sectionId === "agent-messages"; })[0].click();
  var key = "s:side/cli-sender>work/cli-shared";
  m.messages.handleTeamTraffic({
    type: "team_traffic", ok: true, result: "listed", retentionDays: 30,
    pairs: [{ key: key, sender: { senderKind: "extracted", attribution: "extracted", fromName: "worker-a@side", senderAgent: "worker-a" }, target: { project: "work", agent: "reviewer-x" }, count: 1, pendingCount: 0, lastAt: new Date().toISOString() }],
    messages: [], pending: [], withheld: { count: 0, reasons: [] },
  });
  var amAvatars = body.querySelectorAll(".am-avatar");
  var senderImg = amAvatars.filter(function (i) { return i.dataset.agentKey === "worker-a"; })[0];
  assert.ok(senderImg, "the sender avatar is bound to its agent key");
  assert.equal(senderImg.src, m.avatar.robotAvatarUrl("worker-a", 24));

  // An injected message already on the page.
  var injectedImg = new dom.FakeElement("img");
  global.document.body.appendChild(injectedImg);
  m.avatar.applyIdentityAvatar(injectedImg, identity.resolveInjectedIdentity({ senderKind: "extracted", fromName: "worker-a@side", senderAgent: "worker-a" }, undefined, [], 36), 36);

  // The roster section, then the roster message that carries the choice.
  var rosterMsg = { type: "agent_roster", agents: [agent("worker-a", { avatar: { custom: "team-icon" } })] };
  m.roster.handleAgentRoster(rosterMsg);

  assert.equal(senderImg.src, "/api/custom-emoji/team-icon", "Agent messages section");
  assert.equal(injectedImg.src, "/api/custom-emoji/team-icon", "injected-sender identity");
  assert.equal(m.avatar.resolveAgentAvatar("worker-a", 40).url, "/api/custom-emoji/team-icon", "the resolver every consumer asks");
});

test("a Task or Agent call is labelled in the transcript with its sub-agent's avatar, which follows the roster", async function () {
  dom.setupGlobals();
  var storeMod = await mod("store.js");
  storeMod.createStore({ connected: true });
  var a = await mod("agent-avatar.js");
  a.setAgentAvatars([{ key: "helper-x", avatar: { custom: "team-icon" } }]);
  var client = await dom.createClient("avatar-label");
  var tools = client.tools;

  function toolItem(id) {
    var item = new dom.FakeElement("div");
    var header = new dom.FakeElement("div");
    header.className = "tool-header";
    var desc = new dom.FakeElement("span");
    desc.className = "tool-desc";
    header.appendChild(desc);
    item.appendChild(header);
    tools.getTools()[id] = { el: item, name: "Agent", input: null, done: false };
    return item;
  }

  var dispatch = toolItem("t1");
  tools.updateToolExecuting("t1", "Agent", { description: "look around", subagent_type: "helper-x" });
  var label = dispatch.querySelector(".tool-agent");
  assert.ok(label, "the dispatch has an agent label");
  assert.equal(label.querySelector(".tool-agent-name").textContent, "helper-x");
  var img = label.querySelector(".tool-agent-avatar");
  assert.equal(img.src, "/api/custom-emoji/team-icon");
  assert.equal(dispatch.querySelector(".tool-desc").textContent, "look around", "the description is unchanged");

  tools.updateToolExecuting("t1", "Agent", { description: "look around", subagent_type: "helper-x" });
  assert.equal(dispatch.querySelectorAll(".tool-agent").length, 1, "a repeated update does not add a second label");

  a.setAgentAvatars([{ key: "helper-x", avatar: null }]);
  a.refreshAgentAvatars(dispatch);
  assert.equal(img.src, a.robotAvatarUrl("helper-x", 16), "clearing the choice returns the robot");

  var plain = toolItem("t2");
  tools.updateToolExecuting("t2", "Agent", { description: "no type" });
  assert.equal(plain.querySelector(".tool-agent"), null, "no subagent_type, no label");
  var read = toolItem("t3");
  tools.updateToolExecuting("t3", "Bash", { command: "ls", subagent_type: "helper-x" });
  assert.equal(read.querySelector(".tool-agent"), null, "only a dispatch carries the label");
});

// --- Shipped tree ---

test("the roster and avatar modules hold no absolute host path", function () {
  var files = [
    "lib/agent-roster.js", "lib/agent-roster-ws.js",
    "lib/public/modules/agent-avatar.js", "lib/public/modules/agent-avatar-picker.js", "lib/public/modules/agent-roster.js",
    "lib/public/css/agent-roster.css",
  ];
  files.forEach(function (rel) {
    var src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(!/\/(root|home|var|etc|workspace)\//.test(src), rel + " has an absolute host path");
  });
});
