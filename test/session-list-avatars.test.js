"use strict";
// "Avatars in session list": a session run by a named agent leads its row with
// that agent's avatar in the desktop sidebar, the phone chat list and Recent
// Sessions; a per-user Appearance setting (on by default) turns it off, which
// shows the generic agent badge as before. Neutral fixtures throughout.
//
// The three list renderers pull in most of the frontend, so their wiring is
// pinned by source rows (the convention of the other list tests here); the
// avatar element, the preference, the server and every option surface are
// driven for real.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var dom = require("./fake-dom-prompt-cards");
var { attachPreferences } = require("../lib/users-preferences");
var { attachSettings } = require("../lib/server-settings");
var registry = require("../lib/settings-registry");

var ROOT = path.resolve(__dirname, "..");
var PUBLIC = path.join(ROOT, "lib", "public");
var KEY = "clagentic-session-list-avatars";

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

// ---------------------------------------------------------------------------
// The avatar element (AC1, AC5, AC6) and the roster repaint (AC2)
// ---------------------------------------------------------------------------

var loads = 0;
async function freshModule(profile, seed, holdPuts) {
  dom.setupGlobals();
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
  var avatar = await import(dom.moduleUrl("agent-avatar.js"));
  avatar.setAgentAvatars([]);
  var mod = await import(dom.moduleUrl("session-list-avatars.js") + "?load=" + (++loads));
  return {
    mod: mod,
    avatar: avatar,
    puts: puts,
    release: function () { held.shift()(); return new Promise(function (resolve) { setImmediate(resolve); }); },
  };
}

function pickedImage(el) { return el.querySelector("img"); }
function tintOf(el) {
  var found = el.className.split(/\s+/).filter(function (c) { return /^agent-avatar-tint-[0-3]$/.test(c); });
  return found.length === 1 ? found[0] : null;
}

test("a named agent's avatar is 20 px, round, and named by the agent for assistive tech and on hover", async function () {
  var env = await freshModule(null);
  var el = env.mod.createSessionAgentAvatar("agent-a");
  assert.ok(el.classList.contains("session-list-avatar"));
  assert.equal(el.getAttribute("role"), "img");
  assert.equal(el.getAttribute("aria-label"), "agent-a");
  assert.equal(el.title, "agent-a");
  assert.equal(el.dataset.agentKey, "agent-a", "bound to the shared resolver");
  assert.equal(env.mod.SESSION_AVATAR_SIZE, 20);
  var css = read("lib/public/css/agent-picker.css");
  var rule = css.slice(css.indexOf(".session-list-avatar {"));
  assert.match(rule, /width: 20px;/);
  assert.match(rule, /height: 20px;/);
  assert.match(rule, /border-radius: 50%;/);
  assert.match(rule, /margin-right: 8px;/, "8 px gap");
  var initial = css.slice(css.indexOf(".agent-avatar-initial {"));
  assert.match(initial, /font-size: 12px;/);
  assert.match(initial, /font-weight: 700;/);
  assert.match(initial, /color: var\(--on-av\);/);
  for (var t = 0; t < 4; t++) assert.match(css, new RegExp("\\.agent-avatar-tint-" + t + " \\{ background: var\\(--av" + t + "\\); \\}"));
});

test("avatar source rows: a picked image, the initial on a tint with no pick, and an agent outside the roster", async function () {
  var env = await freshModule(null);
  var a = env.avatar;
  var rows = [
    // [roster, agent shown, picked image src (null: initial on a tint)]
    [[{ key: "agent-a", avatar: { style: "pixel-art", seed: "seed-1" } }], "agent-a", /\/pixel-art\/svg\?seed=seed-1&size=20$/],
    [[{ key: "agent-a", avatar: { custom: "team-icon" } }], "agent-a", /^\/api\/custom-emoji\/team-icon$/],
    [[], "agent-a", null],
    [[{ key: "agent-b", avatar: { style: "pixel-art", seed: "seed-1" } }], "agent-a", null],
    [[{ key: "agent-a", avatar: { style: "no-such-style", seed: "x" } }], "agent-a", null],
  ];
  rows.forEach(function (row, i) {
    a.setAgentAvatars(row[0]);
    var el = env.mod.createSessionAgentAvatar(row[1]);
    var img = pickedImage(el);
    assert.equal(el.title, row[1], "row " + i + ": only the name");
    if (row[2]) {
      assert.ok(img, "row " + i + ": the picked image");
      assert.match(img.src, row[2], "row " + i);
      assert.equal(tintOf(el), null, "row " + i + ": no tint behind an image");
    } else {
      assert.equal(img, null, "row " + i + ": no robot, no image");
      assert.equal(el.textContent, "A", "row " + i + ": the initial");
      assert.ok(el.classList.contains("agent-avatar-initial"), "row " + i);
      assert.ok(tintOf(el), "row " + i + ": one of the four tints");
    }
  });
});

test("the tint is deterministic per agent, spans the four tints, and the chat-message avatar keeps the robot", async function () {
  var env = await freshModule(null);
  var a = env.avatar;
  var seen = {};
  ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f", "agent-g", "agent-h", "agent-i", "agent-j"].forEach(function (key) {
    var first = tintOf(env.mod.createSessionAgentAvatar(key));
    assert.equal(tintOf(env.mod.createSessionAgentAvatar(key)), first, key + ": same tint every time");
    assert.equal(first, "agent-avatar-tint-" + a.agentTintIndex(key));
    seen[first] = true;
  });
  assert.ok(Object.keys(seen).length >= 2, "keys spread over the tints");
  assert.equal(a.agentInitial("  zed"), "Z");
  assert.equal(a.agentInitial(""), "?");
  var chat = a.createAgentAvatar("agent-a", 20, "chat-avatar");
  assert.equal(chat.tagName, "IMG", "without the option the resolver default stays");
  assert.equal(chat.src, a.robotAvatarUrl("agent-a", 20));
});

test("a roster change repaints every session avatar already drawn, without a reload", async function () {
  var env = await freshModule(null);
  var root = new dom.FakeElement("div");
  var rowA = env.mod.createSessionAgentAvatar("agent-a");
  var rowA2 = env.mod.createSessionAgentAvatar("agent-a");
  var rowB = env.mod.createSessionAgentAvatar("beta-agent");
  [rowA, rowA2, rowB].forEach(function (el) { root.appendChild(el); });
  assert.equal(pickedImage(rowA), null);
  env.avatar.setAgentAvatars([{ key: "agent-a", avatar: { style: "pixel-art", seed: "s2" } }]);
  env.avatar.refreshAgentAvatars(root);
  assert.match(pickedImage(rowA).src, /\/pixel-art\/svg\?seed=s2&size=20$/, "every row of that agent updates");
  assert.match(pickedImage(rowA2).src, /seed=s2/);
  assert.equal(pickedImage(rowB), null, "another agent's rows are unchanged");
  assert.equal(rowB.textContent, "B");
  env.avatar.setAgentAvatars([]);
  env.avatar.refreshAgentAvatars(root);
  assert.equal(pickedImage(rowA), null, "an avatar removed in the Team view returns the initial");
  assert.equal(rowA.textContent, "A");
  assert.ok(tintOf(rowA));
});

// ---------------------------------------------------------------------------
// The preference in the browser (AC3): default on, load, live change, serialized
// ---------------------------------------------------------------------------

var LOAD_ROWS = [
  // [label, profile, cached, expected enabled, expected cache after load]
  ["no choice anywhere: on", { sessionListAvatars: true }, null, true, "1"],
  ["a failed profile load with nothing cached: on", null, null, true, null],
  ["a failed profile load keeps what this browser had", null, "0", false, "0"],
  ["another device turned it off: applies at load", { sessionListAvatars: false }, "1", false, "0"],
  ["another device turned it on", { sessionListAvatars: true }, "0", true, "1"],
  ["a profile with no value changes nothing", {}, "0", false, "0"],
];

test("load: the saved choice applies when the page loads, and is cached for the next paint", async function () {
  for (var i = 0; i < LOAD_ROWS.length; i++) {
    var row = LOAD_ROWS[i];
    var env = await freshModule(row[1], row[2] === null ? null : (function () { var s = {}; s[KEY] = row[2]; return s; })());
    await env.mod.initSessionListAvatars();
    assert.equal(env.mod.sessionListAvatarsEnabled(), row[3], row[0]);
    assert.equal(global.localStorage.getItem(KEY), row[4], row[0]);
    assert.deepEqual(env.puts, [], row[0] + ": loading sends nothing to the server");
  }
});

test("change: switching applies at once, is cached and saved, tells listeners, and a late profile reply does not undo it", async function () {
  var env = await freshModule({ sessionListAvatars: true });
  var heard = [];
  env.mod.onSessionListAvatarsChange(function (on) { heard.push(on); });
  var loading = env.mod.initSessionListAvatars();
  assert.equal(env.mod.setSessionListAvatars(false), true);
  assert.equal(env.mod.sessionListAvatarsEnabled(), false, "applied before the save returns");
  assert.deepEqual(env.puts, [["/api/user/session-list-avatars", { sessionListAvatars: false }]]);
  await loading;
  assert.equal(env.mod.sessionListAvatarsEnabled(), false, "the older profile reply (on) did not win");
  assert.equal(global.localStorage.getItem(KEY), "0");
  assert.deepEqual(heard, [false]);
  ["yes", 1, null, undefined].forEach(function (v) {
    assert.equal(env.mod.setSessionListAvatars(v), false, String(v) + " is not a boolean");
  });
});

test("saves reuse the shared serialized primitive: one in flight, only the latest kept", async function () {
  var env = await freshModule(null, null, true);
  env.mod.setSessionListAvatars(false);
  env.mod.setSessionListAvatars(true);
  env.mod.setSessionListAvatars(false);
  assert.deepEqual(env.puts, [["/api/user/session-list-avatars", { sessionListAvatars: false }]], "one save in flight");
  await env.release();
  assert.deepEqual(env.puts.slice(1), [["/api/user/session-list-avatars", { sessionListAvatars: false }]], "the last choice follows");
  await env.release();
  assert.equal(env.puts.length, 2);
  ["lib/public/modules/session-list-avatars.js", "lib/public/modules/chat-width.js"].forEach(function (file) {
    var src = read(file);
    assert.match(src, /createSerializedSaver\(/, file);
    assert.doesNotMatch(src, /method:\s*"PUT"/, file + " keeps no second copy of the write");
  });
});

// ---------------------------------------------------------------------------
// The server (AC3, AC7): stored per user, reported by the profile, daemon default
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
      setSessionListAvatars: function (id, value) {
        saved.push([id, value]);
        return typeof value === "boolean" ? { ok: true, sessionListAvatars: value } : { error: "Invalid session list avatars value" };
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
  handler({ method: "PUT", url: url, on: function (evt, fn) { listeners[evt] = fn; } }, response, url);
  if (listeners.data) { listeners.data(JSON.stringify(body)); listeners.end(); }
  return response;
}

var PROFILE_ROWS = [
  // [stored on the user, daemon default, reported]
  [{ sessionListAvatars: false }, { sessionListAvatars: true }, false],
  [{ sessionListAvatars: true }, { sessionListAvatars: false }, true],
  [{}, { sessionListAvatars: false }, false],
  [{}, {}, true],
  [{ sessionListAvatars: "no" }, {}, true],
];

test("profile: reports the user's own choice, else the daemon default, else on", function () {
  PROFILE_ROWS.forEach(function (row, i) {
    var response = res();
    var user = Object.assign({ id: "u", username: "u" }, row[0]);
    var opts = { onGetDaemonConfig: function () { return row[1]; } };
    attachSettings(ctxFor(user, opts, [])).handleRequest({ method: "GET", url: "/api/profile" }, response, "/api/profile");
    assert.equal(JSON.parse(response.body).sessionListAvatars, row[2], "row " + i);
  });
});

test("PUT /api/user/session-list-avatars: saved for the signed-in user; a non-boolean is a 400; signed out is a 401", function () {
  var saved = [];
  var handler = attachSettings(ctxFor({ id: "u1", username: "u" }, {}, saved)).handleRequest;
  var ok = put(handler, "/api/user/session-list-avatars", { sessionListAvatars: false });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, sessionListAvatars: false });
  assert.deepEqual(saved, [["u1", false]]);
  assert.equal(put(handler, "/api/user/session-list-avatars", { sessionListAvatars: "false" }).status, 400);
  var out = attachSettings(ctxFor(null, {}, [])).handleRequest;
  assert.equal(put(out, "/api/user/session-list-avatars", { sessionListAvatars: false }).status, 401);
});

var PERSIST_FAILURE_ROWS = [
  // [url, request body, the users setter that fails to persist]
  ["/api/user/session-list-avatars", { sessionListAvatars: false }, "setSessionListAvatars"],
  ["/api/user/chat-width", { chatWidth: "wide" }, "setChatWidth"],
];

test("PUT preference routes: bad JSON is a 400, a failure while persisting is logged and a 500", function () {
  var realError = console.error;
  PERSIST_FAILURE_ROWS.forEach(function (row) {
    var ctx = ctxFor({ id: "u1", username: "u" }, {}, []);
    ctx.users[row[2]] = function () { throw new Error("disk full"); };
    var handler = attachSettings(ctx).handleRequest;
    var logged = [];
    console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
    var failed;
    try {
      failed = put(handler, row[0], row[1]);
    } finally {
      console.error = realError;
    }
    assert.equal(failed.status, 500, row[0] + ": persistence failure");
    assert.equal(logged.length, 1, row[0] + ": logged once");
    assert.match(logged[0], /disk full/, row[0]);

    var listeners = {};
    var bad = res();
    handler({ method: "PUT", url: row[0], on: function (evt, fn) { listeners[evt] = fn; } }, bad, row[0]);
    listeners.data("{not json");
    listeners.end();
    assert.equal(bad.status, 400, row[0] + ": unparseable body");
  });
});

test("preference store: only a boolean is kept per user; a stale value reads as no choice", function () {
  var data = { users: [{ id: "a" }, { id: "b" }] };
  var prefs = attachPreferences({ loadUsers: function () { return data; }, saveUsers: function () {} });
  assert.equal(prefs.getSessionListAvatars("a"), null, "no stored value: the default applies");
  assert.deepEqual(prefs.setSessionListAvatars("a", false), { ok: true, sessionListAvatars: false });
  assert.equal(prefs.getSessionListAvatars("a"), false);
  assert.equal(prefs.getSessionListAvatars("b"), null, "per user");
  ["yes", 0, null, undefined].forEach(function (v) {
    assert.deepEqual(prefs.setSessionListAvatars("a", v), { error: "Invalid session list avatars value" }, String(v));
  });
  assert.equal(prefs.getSessionListAvatars("a"), false);
  assert.deepEqual(prefs.setSessionListAvatars("nobody", true), { error: "User not found" });
  data.users[0].sessionListAvatars = "no";
  assert.equal(prefs.getSessionListAvatars("a"), null);
});

// ---------------------------------------------------------------------------
// The three lists (AC1, AC3, AC4, AC5)
// ---------------------------------------------------------------------------

var LIST_ROWS = [
  // [file, on: avatar when the setting is on and a name is present, off: badge kept]
  ["lib/public/modules/sidebar-sessions.js", /var avatarOn = !!s\.agentName && sessionListAvatarsEnabled\(\);/, /s\.agentName && !avatarOn[\s\S]{0,160}session-agent-badge/, /createSessionAgentAvatar\(s\.agentName\)/],
  ["lib/public/modules/sidebar-mobile.js", /if \(s\.agentName && sessionListAvatarsEnabled\(\)\) \{[\s\S]{0,200}createSessionAgentAvatar\(s\.agentName\)/, /if \(s\.agentName && !sessionListAvatarsEnabled\(\)\) \{[\s\S]{0,200}session-agent-badge/, /createSessionAgentAvatar\(s\.agentName\)/],
  ["lib/public/modules/app-home-hub.js", /if \(sess\.agentName && sessionListAvatarsEnabled\(\)\) \{[\s\S]{0,200}createSessionAgentAvatar\(sess\.agentName\)/, /hub-recent-agent">' \+ escapeHtml\(sess\.agentName\)/, /insertBefore\([\s\S]{0,100}\.hub-recent-title/],
];

test("each list draws the avatar only for a named agent with the setting on, and keeps today's markup otherwise", function () {
  LIST_ROWS.forEach(function (row) {
    var src = read(row[0]);
    assert.match(src, row[1], row[0] + ": on, named agent");
    assert.match(src, row[2], row[0] + ": off keeps the badge or the name pill");
    assert.match(src, row[3], row[0]);
    assert.match(src, /from '\.\/session-list-avatars\.js'/, row[0] + " uses the one shared helper");
    assert.equal((src.match(/createSessionAgentAvatar\(/g) || []).length, 1, row[0] + ": no session without an agent name reaches the avatar");
  });
  assert.equal((read("lib/public/modules/session-list-avatars.js").match(/createAgentAvatar\(/g) || []).length, 1, "one avatar path");
});

var LEAD_ROWS = [
  // [file, the avatar comes before this in the row's source]
  ["lib/public/modules/sidebar-sessions.js", /textSpan\.appendChild\(createSessionAgentAvatar\(s\.agentName\)\);\s*textSpan\.insertAdjacentHTML\("beforeend", textHtml \+ tailHtml\);/],
  ["lib/public/modules/sidebar-mobile.js", /createSessionAgentAvatar\(s\.agentName\)\);\s*\}\s*\/\/ Processing dot/],
  ["lib/public/modules/app-home-hub.js", /insertBefore\(createSessionAgentAvatar\(sess\.agentName\), item\.querySelector\("\.hub-recent-title"\)\)/],
];

test("with the setting on the avatar leads the row, ahead of the title, in place of a trailing badge", function () {
  LEAD_ROWS.forEach(function (row) {
    assert.match(read(row[0]), row[1], row[0]);
  });
  var css = read("lib/public/css/agent-picker.css");
  assert.doesNotMatch(css.slice(css.indexOf(".session-list-avatar {"), css.indexOf(".session-list-avatar img")), /margin-left|order:/);
});

test("the sidebar rows repaint with the setting, and Recent Sessions redraws on it", function () {
  var sessions = read("lib/public/modules/sidebar-sessions.js");
  assert.match(sessions, /"\|av:" \+ \(sessionListAvatarsEnabled\(\) \? "1" : "0"\)/, "the list fingerprint carries the setting");
  assert.match(sessions, /onSessionListAvatarsChange\(function \(\) \{ renderSessionList\(\); \}\)/);
  var hub = read("lib/public/modules/app-home-hub.js");
  assert.match(hub, /onSessionListAvatarsChange\(function \(\) \{\s*if \(lastRecentSessionsMsg\) handleHubRecentSessions\(lastRecentSessionsMsg\);/);
  assert.match(read("lib/public/modules/sidebar-mobile.js"), /onSessionListAvatarsChange\(function \(\) \{ refreshMobileChatSheet\(\); \}\)/, "the phone chat list repaints on the setting");
});

test("a save that fails is reported with the setting name, and later choices still go out", async function () {
  dom.setupGlobals();
  var answers = [{ ok: false, status: 500 }, new Error("offline"), { ok: true, status: 200 }];
  var sent = [];
  global.fetch = function (url, init) {
    sent.push(JSON.parse(init.body));
    var next = answers.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  var saver = (await import(dom.moduleUrl("serialized-save.js"))).createSerializedSaver("/api/user/example", "exampleKey");
  var realError = console.error;
  var logged = [];
  console.error = function () { logged.push(Array.prototype.join.call(arguments, " ")); };
  try {
    for (var i = 0; i < 3; i++) {
      saver(i);
      await new Promise(function (resolve) { setImmediate(resolve); });
    }
  } finally {
    console.error = realError;
  }
  assert.equal(sent.length, 3, "a failure does not stop later saves");
  assert.equal(logged.length, 2, "the two failures are reported, the success is not");
  assert.match(logged[0], /exampleKey.*500/);
  assert.match(logged[1], /exampleKey.*offline/);
});

// ---------------------------------------------------------------------------
// Every option surface (AC7)
// ---------------------------------------------------------------------------

test("desktop Settings, the phone Appearance flow and the CLI registry each show the setting", function () {
  var html = read("lib/public/index.html");
  var appearance = html.slice(html.indexOf('<div class="us-section" data-section="us-appearance">'), html.indexOf('<div class="us-section" data-section="us-chat">'));
  assert.match(appearance, /Avatars in session list/);
  assert.match(appearance, /id="us-session-list-avatars"/);
  // The phone flow (More, Settings, Appearance) opens this same section.
  assert.match(html, /<button class="us-nav-item" data-section="us-appearance">/);
  var settings = read("lib/public/modules/user-settings.js");
  assert.match(settings, /getElementById\('us-session-list-avatars'\)/);
  assert.match(settings, /applyServerSessionListAvatars\(\{ sessionListAvatars: data\.sessionListAvatars \}\)/);

  assert.ok(registry.settingKeys().indexOf("sessionListAvatars") !== -1);
  assert.match(read("bin/cli.js"), /known keys: promptExpiryMinutes, chatWidth, sessionListAvatars\)/);
  var daemon = read("lib/daemon.js");
  assert.match(daemon, /sessionListAvatars: \{\s*set: serverHooks\.onSetSessionListAvatarsDefault,\s*announce: serverHooks\.onGetSessionListAvatarsDefault,/);
  assert.match(daemon, /sessionListAvatars: sessionListAvatarsSetting\.read\(config\)/);
});

test("the app starts the preference at load", function () {
  assert.match(read("lib/public/app.js"), /initSessionListAvatars\(\);/);
  assert.ok(fs.existsSync(path.join(PUBLIC, "modules", "serialized-save.js")));
});
