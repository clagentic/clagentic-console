"use strict";
// The chat width setting: the one list the server and the browser share, the
// one-time move off the bubble/channel switch, the profile and the setter, the
// load-time application and the live change, every surface that offers it, and
// the guard that no frontend source reads a layout mode any more.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var dom = require("./fake-dom-prompt-cards");
var chatWidth = require("../lib/chat-width");
var { attachPreferences } = require("../lib/users-preferences");
var { attachSettings } = require("../lib/server-settings");
var registry = require("../lib/settings-registry");

var ROOT = path.resolve(__dirname, "..");
var PUBLIC = path.join(ROOT, "lib", "public");

// ---------------------------------------------------------------------------
// One list, on the server and in the browser
// ---------------------------------------------------------------------------

test("the server and the browser list the same steps in the same order, with the same default", async function () {
  var prefs = await import(dom.moduleUrl("chat-width-prefs.js"));
  assert.deepEqual(prefs.WIDTH_OPTIONS.map(function (o) { return o.key; }), chatWidth.CHAT_WIDTHS);
  assert.equal(prefs.DEFAULT_WIDTH, chatWidth.DEFAULT_CHAT_WIDTH);
  assert.equal(chatWidth.DEFAULT_CHAT_WIDTH, "comfortable");
  ["bubble", "channel", "", "Wide", 820, null, undefined].forEach(function (v) {
    assert.equal(prefs.isChatWidth(v), false, String(v));
    assert.equal(chatWidth.isChatWidth(v), false, String(v));
  });
  [["bubble", "comfortable"], ["channel", "full"], ["wide", null], ["constructor", null], [undefined, null]].forEach(function (row) {
    assert.equal(prefs.widthFromLegacyLayout(row[0]), row[1], String(row[0]));
    assert.equal(chatWidth.widthFromLegacyLayout(row[0]), row[1], String(row[0]));
  });
});

test("base.css defines the four steps at the approved sizes, comfortable by default, and a phone is always full width", function () {
  var css = fs.readFileSync(path.join(PUBLIC, "css", "base.css"), "utf8");
  assert.match(css, /--chat-width-compact:\s*640px;/);
  assert.match(css, /--chat-width-comfortable:\s*820px;/);
  assert.match(css, /--chat-width-wide:\s*1040px;/);
  assert.match(css, /--chat-width-full:\s*100%;/);
  assert.match(css, /--content-width:\s*var\(--chat-width-comfortable\);/, "the default is today's 820 px");
  chatWidth.CHAT_WIDTHS.forEach(function (step) {
    assert.match(css, new RegExp(':root\\[data-chat-width="' + step + '"\\]\\s*\\{\\s*--content-width:\\s*var\\(--chat-width-' + step + '\\);'), step);
  });
  var phone = css.slice(css.indexOf("@media (max-width: 768px)"));
  assert.match(phone, /:root\[data-chat-width\]\s*\{[^}]*--content-width:\s*var\(--chat-width-full\)/, "the attribute selector is covered, so no step narrows a phone");
});

// ---------------------------------------------------------------------------
// Per-user preference and the one-time migration
// ---------------------------------------------------------------------------

function store(users) {
  var saves = 0;
  var data = { users: users };
  var prefs = attachPreferences({
    loadUsers: function () { return data; },
    saveUsers: function () { saves++; },
  });
  return { prefs: prefs, data: data, saves: function () { return saves; } };
}

[
  [{ id: "a", chatLayout: "bubble" }, "comfortable"],
  [{ id: "a", chatLayout: "channel" }, "full"],
  [{ id: "a", chatLayout: "bubble", chatWidth: "wide" }, "wide"],
  [{ id: "a", chatLayout: "channel", chatWidth: "compact" }, "compact"],
  [{ id: "a", chatLayout: "something-else" }, undefined],
].forEach(function (row) {
  test("migration: " + JSON.stringify(row[0]) + " becomes " + String(row[1]), function () {
    var s = store([Object.assign({}, row[0])]);
    assert.deepEqual(s.prefs.migrateAllChatLayouts(), { changed: 1 });
    assert.equal(s.data.users[0].chatWidth, row[1]);
    assert.equal("chatLayout" in s.data.users[0], false, "the old key is dropped");
    assert.equal(s.saves(), 1);
    assert.deepEqual(s.prefs.migrateAllChatLayouts(), { changed: 0 }, "it runs once");
    assert.equal(s.saves(), 1, "and saves nothing the second time");
  });
});

test("migration: a user who never chose is left alone and nothing is saved", function () {
  var s = store([{ id: "a" }, { id: "b", themeMode: "dark" }]);
  assert.deepEqual(s.prefs.migrateAllChatLayouts(), { changed: 0 });
  assert.equal(s.saves(), 0);
  assert.equal(s.prefs.getChatWidth("a"), null, "no stored value: the default applies");
});

test("preference: only a step is stored; anything else is refused and nothing changes", function () {
  var s = store([{ id: "a" }]);
  assert.deepEqual(s.prefs.setChatWidth("a", "wide"), { ok: true, chatWidth: "wide" });
  assert.equal(s.prefs.getChatWidth("a"), "wide");
  ["bubble", "channel", "huge", "", null, 640].forEach(function (v) {
    assert.deepEqual(s.prefs.setChatWidth("a", v), { error: "Invalid chat width" }, String(v));
  });
  assert.equal(s.prefs.getChatWidth("a"), "wide");
  assert.deepEqual(s.prefs.setChatWidth("nobody", "full"), { error: "User not found" });
  s.data.users[0].chatWidth = "bubble";
  assert.equal(s.prefs.getChatWidth("a"), null, "a stale stored value is not a step");
  assert.equal(typeof s.prefs.getChatLayout, "undefined", "the layout accessors are gone");
});

// ---------------------------------------------------------------------------
// The profile and the setter route
// ---------------------------------------------------------------------------

function res() {
  var r = { status: null, body: "" };
  r.writeHead = function (s) { r.status = s; };
  r.end = function (b) { r.body = b || ""; };
  return r;
}

function ctxFor(user, opts, saved) {
  return {
    users: {
      setChatWidth: function (id, width) {
        saved.push([id, width]);
        return chatWidth.isChatWidth(width) ? { ok: true, chatWidth: width } : { error: "Invalid chat width" };
      },
    },
    getMultiUserFromReq: function () { return user; },
    isRequestAuthed: function () { return !!user; },
    projects: { forEach: function () {} },
    opts: opts || {},
    CONFIG_DIR: require("os").tmpdir(),
  };
}

function put(handler, url, body) {
  var listeners = {};
  var response = res();
  var req = { method: "PUT", url: url, on: function (evt, fn) { listeners[evt] = fn; } };
  handler(req, response, url);
  listeners.data(JSON.stringify(body));
  listeners.end();
  return response;
}

test("profile: reports the user's own width, else the server default, else comfortable", function () {
  function profile(user, opts) {
    var response = res();
    attachSettings(ctxFor(user, opts, [])).handleRequest({ method: "GET", url: "/api/profile" }, response, "/api/profile");
    assert.equal(response.status, 200);
    return JSON.parse(response.body);
  }
  assert.equal(profile({ id: "u", username: "u", chatWidth: "wide" }, { onGetDaemonConfig: function () { return { chatWidth: "full" }; } }).chatWidth, "wide");
  assert.equal(profile({ id: "u", username: "u" }, { onGetDaemonConfig: function () { return { chatWidth: "full" }; } }).chatWidth, "full");
  assert.equal(profile({ id: "u", username: "u" }, {}).chatWidth, "comfortable");
  assert.equal(profile({ id: "u", username: "u", chatWidth: "bubble" }, {}).chatWidth, "comfortable", "a stale value is never reported");
  assert.equal("chatLayout" in profile({ id: "u", username: "u", chatLayout: "channel" }, {}), false, "the profile no longer carries a layout");
});

test("PUT /api/user/chat-width: a step is saved for the signed-in user; a bad one is a 400; the old route is gone", function () {
  var saved = [];
  var handler = attachSettings(ctxFor({ id: "u1", username: "u" }, {}, saved)).handleRequest;
  var ok = put(handler, "/api/user/chat-width", { chatWidth: "compact" });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, chatWidth: "compact" });
  assert.deepEqual(saved, [["u1", "compact"]]);
  var bad = put(handler, "/api/user/chat-width", { chatWidth: "bubble" });
  assert.equal(bad.status, 400);
  var gone = handler({ method: "PUT", url: "/api/user/chat-layout", on: function () {} }, res(), "/api/user/chat-layout");
  assert.equal(gone, false, "PUT /api/user/chat-layout is not handled any more");
});

// ---------------------------------------------------------------------------
// Load-time application and the live change (browser module, fake DOM)
// ---------------------------------------------------------------------------

var loads = 0;
function mockClock(t) {
  // A test may build several environments; the mock clock is enabled once per test.
  if (t.clockMocked) return;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.clockMocked = true;
}

async function freshWidthModule(t, profile, seed) {
  mockClock(t);
  dom.setupGlobals();
  document.documentElement = new dom.FakeElement("html");
  Object.keys(seed || {}).forEach(function (k) { global.localStorage.setItem(k, seed[k]); });
  var puts = [];
  global.fetch = function (url, init) {
    if (init && init.method === "PUT") {
      puts.push([url, JSON.parse(init.body)]);
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true }); } });
    }
    return Promise.resolve({ ok: profile !== null, json: function () { return Promise.resolve(profile); } });
  };
  var mod = await import(dom.moduleUrl("chat-width.js") + "?load=" + (++loads));
  return { mod: mod, puts: puts, attr: function () { return document.documentElement.dataset.chatWidth; } };
}

test("load: the saved width applies when the page loads, on another device, without opening settings", async function (t) {
  var env = await freshWidthModule(t, { chatWidth: "wide" });
  await env.mod.initChatWidth();
  assert.equal(env.attr(), "wide", "the server's choice is on the page");
  assert.equal(global.localStorage.getItem("clagentic-chat-width"), "wide", "and cached for the next first paint");
});

test("load: with no saved choice anywhere the default applies; a failed profile load keeps what this browser had", async function (t) {
  var a = await freshWidthModule(t, { chatWidth: "comfortable" });
  await a.mod.initChatWidth();
  assert.equal(a.attr(), "comfortable");
  var b = await freshWidthModule(t, null, { "clagentic-chat-width": "compact" });
  await b.mod.initChatWidth();
  assert.equal(b.attr(), "compact");
});

[
  ["bubble", "comfortable"],
  ["channel", "full"],
].forEach(function (row) {
  test("load: a stale local " + row[0] + " becomes " + row[1] + " once, with no prompt, and the old key is removed", async function (t) {
    var env = await freshWidthModule(t, null, { "clagentic-wide-view": row[0] });
    await env.mod.initChatWidth();
    assert.equal(env.attr(), row[1]);
    assert.equal(global.localStorage.getItem("clagentic-chat-width"), row[1]);
    assert.equal(global.localStorage.getItem("clagentic-wide-view"), null);
    assert.deepEqual(env.puts, [], "nothing is sent to the server by the migration");
  });
});

test("change: choosing a width applies at once with no reload, is cached and saved, and a late profile reply does not undo it", async function (t) {
  var env = await freshWidthModule(t, { chatWidth: "full" });
  var heard = [];
  env.mod.onChatWidthChange(function (w) { heard.push(w); });
  var loading = env.mod.initChatWidth();
  assert.equal(env.mod.setChatWidth("compact"), true);
  assert.equal(env.attr(), "compact", "applied before the save returns");
  assert.deepEqual(env.puts, [["/api/user/chat-width", { chatWidth: "compact" }]]);
  await loading;
  assert.equal(env.attr(), "compact", "the older profile reply (full) did not win");
  assert.equal(global.localStorage.getItem("clagentic-chat-width"), "compact");
  assert.equal(env.mod.setChatWidth("bubble"), false, "a layout is not a width");
  assert.ok(heard.indexOf("compact") !== -1);
});

test("the Appearance choice lists the four steps beside the theme, marks the current one and keeps itself current", async function (t) {
  var env = await freshWidthModule(t, null);
  var choice = await import(dom.moduleUrl("chat-width-choice.js"));
  // chat-width-choice imports the shared chat-width.js; use its instance.
  var width = await import(dom.moduleUrl("chat-width.js"));
  var container = new dom.FakeElement("div");
  container.isConnected = true;
  choice.mountChatWidthChoice(container, { showDescriptions: true });
  var cards = container.querySelectorAll("button");
  assert.deepEqual(cards.map(function (c) { return c.dataset.widthOption; }), ["compact", "comfortable", "wide", "full"]);
  assert.deepEqual(cards.map(function (c) { return c.querySelector(".layout-option-label").textContent; }), ["Compact", "Comfortable", "Wide", "Full"]);
  assert.ok(cards[1].classList.contains("selected"), "Comfortable is the default");
  cards[3].click();
  assert.equal(width.getChatWidth(), "full");
  assert.ok(container.querySelectorAll("button")[3].classList.contains("selected"), "the choice re-renders itself");
  assert.equal(container.querySelectorAll("button")[1].classList.contains("selected"), false);
  assert.deepEqual(env.puts, [["/api/user/chat-width", { chatWidth: "full" }]], "and saved on the server");
});

// ---------------------------------------------------------------------------
// Every surface that lists or sets options
// ---------------------------------------------------------------------------

function publicFiles(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var p = path.join(dir, e.name);
    if (e.isDirectory()) publicFiles(p, out);
    else if (/\.(js|css|html)$/.test(e.name)) out.push(p);
  });
  return out;
}

test("desktop Settings and the phone flow show the width option and no bubble/channel option", function () {
  var html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  var appearance = html.slice(html.indexOf('<div class="us-section" data-section="us-appearance">'), html.indexOf('<div class="us-section" data-section="us-chat">'));
  assert.match(appearance, /Chat width/);
  assert.match(appearance, /id="us-width-switcher"/);
  assert.doesNotMatch(appearance, /Bubble|Channel|Chat layout|us-layout-switcher/);
  // The phone flow (More, Settings, Appearance) opens this same section.
  assert.match(html, /<button class="us-nav-item" data-section="us-appearance">/);
});

test("the CLI settings registry offers the width default and no layout", function () {
  assert.ok(registry.settingKeys().indexOf("chatWidth") !== -1);
  assert.deepEqual(registry.settingKeys().filter(function (k) { return /layout|bubble|channel/i.test(k); }), []);
  var cli = fs.readFileSync(path.join(ROOT, "bin", "cli.js"), "utf8");
  assert.match(cli, /known keys: promptExpiryMinutes, chatWidth/);
  assert.doesNotMatch(cli, /chatLayout|chat-layout/);
});

test("no frontend source reads a layout mode", function () {
  // The only mention of the retired local key is the one-time migration, in the
  // module that applies the width and the first-paint script that mirrors it.
  var MIGRATION_ONLY = [path.join(PUBLIC, "modules", "chat-width.js"), path.join(PUBLIC, "index.html")];
  var banned = [
    [/wide-view/, "the wide-view class or key"],
    [/chatLayout|ChatLayout|\/api\/user\/chat-layout/, "a chat layout setting"],
    [/isWideView|isDmLayout/, "a layout predicate"],
    [/layout\(\)\s*===|getLayout\(/, "a layout accessor"],
  ];
  publicFiles(PUBLIC, []).forEach(function (file) {
    var src = fs.readFileSync(file, "utf8");
    banned.forEach(function (rule) {
      if (!rule[0].test(src)) return;
      var migrationOnly = MIGRATION_ONLY.indexOf(file) !== -1 && rule[1] === "the wide-view class or key";
      if (migrationOnly) {
        var uses = src.match(/.{0,40}wide-view.{0,10}/g) || [];
        uses.forEach(function (u) { assert.match(u, /clagentic-wide-view/, path.relative(ROOT, file) + " may mention only the retired storage key: " + u); });
        return;
      }
      assert.fail(path.relative(ROOT, file) + " reads " + rule[1]);
    });
  });
  assert.equal(fs.existsSync(path.join(PUBLIC, "css", "channel-layout.css")), false, "the channel stylesheet is gone");
  var style = fs.readFileSync(path.join(PUBLIC, "style.css"), "utf8");
  assert.doesNotMatch(style, /channel-layout/);
  assert.match(style, /css\/chat-layout\.css/);
});

// ---------------------------------------------------------------------------
// The assistant's identity: a named agent through the roster resolver, else the vendor
// ---------------------------------------------------------------------------

var sharedMessages = new dom.FakeElement("div");

async function assistantBlock(t, vendor, agentName) {
  mockClock(t);
  dom.setupGlobals();
  sharedMessages._children = [];
  document.getElementById = function (id) { return id === "messages" ? sharedMessages : null; };
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({ connected: true, currentVendor: vendor, currentAgentName: agentName });
  var rendering = await import(dom.moduleUrl("app-rendering.js") + "?assistant=" + (++loads));
  var el = rendering.ensureAssistantBlock();
  return { el: el, header: el.querySelector(".msg-header"), rendering: rendering };
}

test("assistant: a session cast as a named agent shows that agent's name and its roster avatar", async function (t) {
  var env = await assistantBlock(t, "claude", "Agent One");
  assert.equal(env.header.querySelector(".dm-bubble-name").textContent, "Agent One");
  var img = env.header.querySelector(".msg-header-avatar");
  assert.equal(img.dataset.agentKey, "Agent One", "drawn through the shared avatar resolver");
  var before = img.src;
  var avatars = await import(dom.moduleUrl("agent-avatar.js"));
  var styles = await import(dom.moduleUrl("avatar.js"));
  avatars.setAgentAvatars([{ key: "Agent One", avatar: { style: styles.AVATAR_STYLES[0].id, seed: "chosen" } }]);
  avatars.refreshAgentAvatars(env.el);
  assert.notEqual(img.src, before);
  assert.match(img.src, /seed=chosen/, "the operator's roster choice shows");
  avatars.setAgentAvatars([]);
});

test("assistant: a session with no agent shows the vendor as before", async function (t) {
  var registryMod = await import(dom.moduleUrl("vendor-registry.js"));
  var env = await assistantBlock(t, "codex", null);
  assert.equal(env.header.querySelector(".dm-bubble-name").textContent, registryMod.VENDOR_NAMES.codex);
  var img = env.header.querySelector(".msg-header-avatar");
  assert.equal(img.src, registryMod.VENDOR_AVATARS.codex);
  assert.equal(img.dataset.agentKey, undefined, "a vendor has no roster entry");
  var fallback = await assistantBlock(t, null, "   ");
  assert.equal(fallback.header.querySelector(".dm-bubble-name").textContent, registryMod.VENDOR_NAMES.claude, "a blank agent name is no agent");
});

test("assistant: the session switch carries the agent to the renderer and a project switch clears it", function () {
  var messages = fs.readFileSync(path.join(PUBLIC, "modules", "app-messages.js"), "utf8");
  assert.match(messages, /resetClientState\(\);[\s\S]{0,200}store\.set\(\{ currentAgentName: msg\.agentName \|\| null \}\)/);
  var projects = fs.readFileSync(path.join(PUBLIC, "modules", "app-projects.js"), "utf8");
  assert.match(projects, /currentAgentName: null/);
  assert.match(projects, /resetTranscriptParticipants\(\)/);
});

// ---------------------------------------------------------------------------
// The shared header component and its options
// ---------------------------------------------------------------------------

test("message header: one component, options not forks", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var hdr = await import(dom.moduleUrl("message-header.js"));
  var avatar = function () { var i = new dom.FakeElement("img"); return i; };
  var full = hdr.buildMessageHeader({ avatarEl: avatar(), name: "Ada", label: "trigger", time: "10:00", extras: [new dom.FakeElement("span")] });
  assert.ok(full.el.classList.contains("msg-header"));
  assert.equal(full.el.classList.contains("msg-header-own"), false);
  assert.equal(full.nameEl.textContent, "Ada");
  assert.equal(full.labelEl.textContent, "trigger");
  assert.equal(full.timeEl.textContent, "10:00");
  var own = hdr.buildMessageHeader({ side: "own", avatarEl: avatar(), name: "Me", time: "10:01" });
  assert.ok(own.el.classList.contains("msg-header-own"));
  var noAvatar = hdr.buildMessageHeader({ avatarEl: avatar(), showAvatar: false, name: "Ada", time: "10:02" });
  assert.equal(noAvatar.avatarEl, null, "avatar off is an option");
  var compact = hdr.buildMessageHeader({ avatarEl: avatar(), name: "Ada", time: "10:03", compact: true });
  assert.equal(compact.avatarEl, null);
  assert.equal(compact.nameEl, null);
  assert.equal(compact.timeEl.textContent, "10:03", "the compact header keeps the time");
  var hostile = hdr.buildMessageHeader({ name: "<img onerror=x>", label: "<b>x</b>" });
  assert.equal(hostile.nameEl.textContent, "<img onerror=x>", "text is set as text");
});

// Every shape that draws a speaker uses the component: nobody builds a header by hand.
test("message header: the transcript renderers, the permission card and mention use the shared component", function () {
  ["app-rendering.js", "mention.js", path.join("prompt-kinds", "permission.js")].forEach(function (name) {
    var src = fs.readFileSync(path.join(PUBLIC, "modules", name), "utf8");
    assert.match(src, /buildMessageHeader\(/, name);
    assert.doesNotMatch(src, /className = "dm-bubble-header"|className = "dm-bubble-name"|className = "dm-bubble-time"/, name + " builds no header by hand");
  });
});
