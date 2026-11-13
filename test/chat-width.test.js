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

var MIGRATION_ROWS = [
  [{ id: "a", chatLayout: "bubble" }, "comfortable"],
  [{ id: "a", chatLayout: "channel" }, "full"],
  [{ id: "a", chatLayout: "bubble", chatWidth: "wide" }, "wide"],
  [{ id: "a", chatLayout: "channel", chatWidth: "compact" }, "compact"],
  [{ id: "a", chatLayout: "something-else" }, undefined],
];

test("migration: each stored layout becomes its width once, the old key is dropped and nothing is saved twice", function () {
  MIGRATION_ROWS.forEach(function (row) {
    var label = JSON.stringify(row[0]) + " becomes " + String(row[1]);
    var s = store([Object.assign({}, row[0])]);
    assert.deepEqual(s.prefs.migrateAllChatLayouts(), { changed: 1 }, label);
    assert.equal(s.data.users[0].chatWidth, row[1], label);
    assert.equal("chatLayout" in s.data.users[0], false, label + ": the old key is dropped");
    assert.equal(s.saves(), 1, label);
    assert.deepEqual(s.prefs.migrateAllChatLayouts(), { changed: 0 }, label + ": it runs once");
    assert.equal(s.saves(), 1, label + ": and saves nothing the second time");
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

// holdPuts: each save stays unanswered until release() answers the oldest one.
async function freshWidthModule(t, profile, seed, holdPuts) {
  mockClock(t);
  dom.setupGlobals();
  document.documentElement = new dom.FakeElement("html");
  Object.keys(seed || {}).forEach(function (k) { global.localStorage.setItem(k, seed[k]); });
  var puts = [];
  var held = [];
  global.fetch = function (url, init) {
    if (init && init.method === "PUT") {
      puts.push([url, JSON.parse(init.body)]);
      var answer = { ok: true, json: function () { return Promise.resolve({ ok: true }); } };
      if (!holdPuts) return Promise.resolve(answer);
      return new Promise(function (resolve) { held.push(function () { resolve(answer); }); });
    }
    return Promise.resolve({ ok: profile !== null, json: function () { return Promise.resolve(profile); } });
  };
  var mod = await import(dom.moduleUrl("chat-width.js") + "?load=" + (++loads));
  return {
    mod: mod,
    puts: puts,
    release: function () { held.shift()(); return new Promise(function (resolve) { setImmediate(resolve); }); },
    attr: function () { return document.documentElement.dataset.chatWidth; },
  };
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

test("load: a stale local bubble or channel becomes comfortable or full once, with no prompt, and the old key is removed", async function (t) {
  var rows = [["bubble", "comfortable"], ["channel", "full"]];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var env = await freshWidthModule(t, null, { "clagentic-wide-view": row[0] });
    await env.mod.initChatWidth();
    assert.equal(env.attr(), row[1], row[0]);
    assert.equal(global.localStorage.getItem("clagentic-chat-width"), row[1], row[0]);
    assert.equal(global.localStorage.getItem("clagentic-wide-view"), null, row[0]);
    assert.deepEqual(env.puts, [], row[0] + ": nothing is sent to the server by the migration");
  }
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

// The theme module under the same fake page. Its profile is `profile`; the theme
// list is empty (the two built-in themes are always there). holdPuts works as in
// freshWidthModule.
async function freshThemeModule(t, profile, seed, holdPuts) {
  var env = await freshWidthModule(t, profile, seed, holdPuts);
  document.documentElement.style = { setProperty: function () {} };
  var plain = global.fetch;
  global.fetch = function (url, init) {
    if (url === "/api/themes") {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ bundled: {}, custom: {} }); } });
    }
    return plain(url, init);
  };
  env.theme = await import(dom.moduleUrl("theme.js") + "?load=" + (++loads));
  return env;
}

function settle() {
  return new Promise(function (resolve) { setImmediate(function () { setImmediate(resolve); }); });
}

// Runs fn with console.error replaced and returns what was reported.
async function reportedErrors(fn) {
  var real = console.error;
  var logged = [];
  console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
  try { await fn(); } finally { console.error = real; }
  return logged;
}

// Cases that need a module of their own: saves kept in flight, and listeners
// that unsubscribe or throw while a change is announced.
var CHANGE_CASES = [
  ["theme: the saved choice applies at load without opening Settings, and is cached", async function (env, t) {
    var theme = await freshThemeModule(t, { themeMode: "light", themeId: null });
    theme.theme.initTheme();
    await settle();
    assert.equal(theme.theme.getThemeId(), "clagentic-light");
    assert.equal(global.localStorage.getItem("clagentic-mode"), "light");
    assert.equal(global.localStorage.getItem("clagentic-theme"), "clagentic-light");
    assert.deepEqual(theme.puts, [], "loading sends nothing to the server");
  }],
  ["theme: with no saved choice the device's own choice stands; a choice made on this page beats a late reply", async function (env, t) {
    var none = await freshThemeModule(t, { themeMode: null, themeId: null }, { "clagentic-mode": "light" });
    none.theme.initTheme();
    await settle();
    assert.equal(none.theme.getThemeId(), "clagentic-light");
    assert.equal(global.localStorage.getItem("clagentic-mode"), "light");
    var late = await freshThemeModule(t, { themeMode: "light", themeId: null });
    late.theme.initTheme();
    late.theme.setThemeMode("dark");
    await settle();
    assert.equal(late.theme.getThemeId(), "clagentic-dark", "the older profile reply (light) did not win");
  }],
  ["theme: quick choices are saved one at a time and the server ends on the last", async function (env, t) {
    var theme = await freshThemeModule(t, null, null, true);
    theme.theme.setThemeMode("light");
    theme.theme.setThemeMode("dark");
    theme.theme.setThemeMode(null);
    assert.deepEqual(theme.puts, [["/api/user/theme-mode", { themeMode: "light" }]], "one save in flight");
    await theme.release();
    assert.deepEqual(theme.puts.slice(1), [["/api/user/theme-mode", { themeMode: null }]], "the last choice follows, the middle one is dropped");
    await theme.release();
    assert.equal(theme.puts.length, 2);
  }],
  ["theme: a listener that unsubscribes and one that throws do not make another miss the change; the error is reported", async function (env, t) {
    var theme = await freshThemeModule(t, null);
    var heard = [];
    var off = theme.theme.onThemeChange(function () { heard.push("first"); off(); });
    theme.theme.onThemeChange(function () { throw new Error("boom"); });
    theme.theme.onThemeChange(function (id) { heard.push(id); });
    var logged = await reportedErrors(function () { theme.theme.applyTheme("clagentic-light"); });
    assert.deepEqual(heard, ["first", "clagentic-light"]);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /theme listener failed.*boom/);
  }],
  ["a failed profile load or preference save is reported by name for the theme, the width and the avatars", async function (env, t) {
    var theme = await freshThemeModule(t, null);
    var avatars = await import(dom.moduleUrl("session-list-avatars.js") + "?load=" + (++loads));
    var logged = await reportedErrors(async function () {
      theme.theme.initTheme();
      await theme.mod.initChatWidth();
      await avatars.initSessionListAvatars();
      await settle();
    });
    ["theme", "chat width", "session list avatars"].forEach(function (name) {
      assert.ok(logged.some(function (line) { return line.indexOf("Loading the " + name + " preference failed") === 0; }), name + " load is reported");
    });
    var base = global.fetch;
    global.fetch = function (url, init) {
      if (init && init.method === "PUT") return Promise.resolve({ ok: false, status: 503 });
      return base(url, init);
    };
    var saveLogged = await reportedErrors(async function () {
      theme.theme.setThemeMode("dark");
      await settle();
    });
    assert.equal(saveLogged.length, 1);
    assert.match(saveLogged[0], /Saving themeMode failed: HTTP 503/);
  }],
  ["quick choices are saved one at a time and only the latest is kept", async function (env) {
    env.mod.setChatWidth("wide");
    env.mod.setChatWidth("compact");
    env.mod.setChatWidth("full");
    assert.deepEqual(env.puts, [["/api/user/chat-width", { chatWidth: "wide" }]], "one save in flight");
    await env.release();
    assert.deepEqual(env.puts.slice(1), [["/api/user/chat-width", { chatWidth: "full" }]], "the last choice follows, the middle one is dropped");
    await env.release();
    assert.equal(env.puts.length, 2);
    env.mod.setChatWidth("wide");
    assert.equal(env.puts.length, 3, "idle again: the next choice is sent at once");
    assert.equal(env.attr(), "wide");
  }],
  ["a listener that unsubscribes itself does not make the next one miss the change", async function (env) {
    var heard = [];
    var off = env.mod.onChatWidthChange(function () { heard.push("first"); off(); });
    env.mod.onChatWidthChange(function () { heard.push("second"); });
    env.mod.applyChatWidth("wide");
    assert.deepEqual(heard, ["first", "second"]);
  }],
  ["a listener that throws is reported and the next one still runs", async function (env, t) {
    var reported = t.mock.method(console, "error", function () {});
    var heard = [];
    env.mod.onChatWidthChange(function () { throw new Error("boom"); });
    env.mod.onChatWidthChange(function (w) { heard.push(w); });
    env.mod.applyChatWidth("wide");
    assert.deepEqual(heard, ["wide"]);
    assert.equal(reported.mock.callCount(), 1);
    assert.match(String(reported.mock.calls[0].arguments[1]), /boom/);
  }],
];

test("change cases: saves are serialized and listeners are isolated", async function (t) {
  for (var i = 0; i < CHANGE_CASES.length; i++) {
    var env = await freshWidthModule(t, null, null, true);
    await CHANGE_CASES[i][1](env, t);
  }
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

async function assistantBlock(t, vendor, agentName, extraState) {
  mockClock(t);
  dom.setupGlobals();
  sharedMessages._children = [];
  document.getElementById = function (id) { return id === "messages" ? sharedMessages : null; };
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore(Object.assign({ connected: true, currentVendor: vendor, currentAgentName: agentName }, extraState || {}));
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
  var blank = await assistantBlock(t, "codex", "   ");
  assert.equal(blank.header.querySelector(".dm-bubble-name").textContent, registryMod.VENDOR_NAMES.codex, "a blank agent name is no agent");
});

// A header never names a vendor the session did not run on. With no vendor on
// the page the session list's vendor is used, and with none known the header
// is a neutral assistant with no vendor picture.
[
  { name: "a Codex session whose page vendor was wiped, from the session list", vendor: null, state: { activeSessionId: 7, sessionVendors: { 7: "codex" } }, vendorKey: "codex" },
  { name: "the page vendor wins over a list entry", vendor: "claude", state: { activeSessionId: 7, sessionVendors: { 7: "codex" } }, vendorKey: "claude" },
  { name: "no vendor anywhere: neutral, never Claude Code", vendor: null, state: { activeSessionId: 7, sessionVendors: {} }, vendorKey: null },
].forEach(function (row) {
  test("assistant: " + row.name, async function (t) {
    var registryMod = await import(dom.moduleUrl("vendor-registry.js"));
    var env = await assistantBlock(t, row.vendor, null, row.state);
    var name = env.header.querySelector(".dm-bubble-name").textContent;
    var avatar = env.header.querySelector(".msg-header-avatar");
    if (row.vendorKey) {
      assert.equal(name, registryMod.VENDOR_NAMES[row.vendorKey]);
      assert.equal(avatar.src, registryMod.VENDOR_AVATARS[row.vendorKey]);
    } else {
      assert.equal(name, "Assistant");
      assert.notEqual(name, registryMod.VENDOR_NAMES.claude);
      assert.ok(!avatar.src, "no vendor avatar");
    }
  });
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
