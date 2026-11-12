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

test("a named agent's avatar is 20 px, round, and named by the agent for assistive tech and on hover", async function () {
  var env = await freshModule(null);
  var img = env.mod.createSessionAgentAvatar("agent-a");
  assert.equal(img.tagName, "IMG");
  assert.ok(img.classList.contains("session-list-avatar"));
  assert.equal(img.width, 20);
  assert.equal(img.height, 20);
  assert.equal(img.alt, "agent-a");
  assert.equal(img.title, "agent-a");
  assert.equal(img.dataset.agentKey, "agent-a", "bound to the shared resolver");
  var css = read("lib/public/css/agent-picker.css");
  var rule = css.slice(css.indexOf(".session-list-avatar {"));
  assert.match(rule, /width: 20px;/);
  assert.match(rule, /height: 20px;/);
  assert.match(rule, /border-radius: 50%;/);
});

test("avatar source rows: a picked image, the resolver default with no pick, and an agent outside the roster", async function () {
  var env = await freshModule(null);
  var a = env.avatar;
  var robot = a.robotAvatarUrl("agent-a", 20);
  var rows = [
    // [roster, agent shown, expected src]
    [[{ key: "agent-a", avatar: { style: "pixel-art", seed: "seed-1" } }], "agent-a", /\/pixel-art\/svg\?seed=seed-1&size=20$/],
    [[{ key: "agent-a", avatar: { custom: "team-icon" } }], "agent-a", /^\/api\/custom-emoji\/team-icon$/],
    [[], "agent-a", robot],
    [[{ key: "agent-b", avatar: { style: "pixel-art", seed: "seed-1" } }], "agent-a", robot],
  ];
  rows.forEach(function (row, i) {
    a.setAgentAvatars(row[0]);
    var img = env.mod.createSessionAgentAvatar(row[1]);
    if (typeof row[2] === "string") assert.equal(img.src, row[2], "row " + i);
    else assert.match(img.src, row[2], "row " + i);
    assert.equal(img.title, row[1], "row " + i + ": only the name");
  });
});

test("a roster change repaints every session avatar already drawn, without a reload", async function () {
  var env = await freshModule(null);
  var root = new dom.FakeElement("div");
  var rowA = env.mod.createSessionAgentAvatar("agent-a");
  var rowA2 = env.mod.createSessionAgentAvatar("agent-a");
  var rowB = env.mod.createSessionAgentAvatar("agent-b");
  [rowA, rowA2, rowB].forEach(function (img) { root.appendChild(img); });
  var before = rowB.src;
  env.avatar.setAgentAvatars([{ key: "agent-a", avatar: { style: "pixel-art", seed: "s2" } }]);
  env.avatar.refreshAgentAvatars(root);
  assert.match(rowA.src, /\/pixel-art\/svg\?seed=s2&size=20$/, "every row of that agent updates");
  assert.equal(rowA2.src, rowA.src);
  assert.equal(rowB.src, before, "another agent's rows are unchanged");
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
  ["lib/public/modules/sidebar-mobile.js", /if \(s\.agentName && sessionListAvatarsEnabled\(\)\) \{[\s\S]{0,200}createSessionAgentAvatar\(s\.agentName\)/, /else if \(s\.agentName\) \{[\s\S]{0,200}session-agent-badge/, /createSessionAgentAvatar\(s\.agentName\)/],
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

test("the sidebar rows repaint with the setting, and Recent Sessions redraws on it", function () {
  var sessions = read("lib/public/modules/sidebar-sessions.js");
  assert.match(sessions, /"\|av:" \+ \(sessionListAvatarsEnabled\(\) \? "1" : "0"\)/, "the list fingerprint carries the setting");
  assert.match(sessions, /onSessionListAvatarsChange\(function \(\) \{ renderSessionList\(\); \}\)/);
  var hub = read("lib/public/modules/app-home-hub.js");
  assert.match(hub, /onSessionListAvatarsChange\(function \(\) \{\s*if \(lastRecentSessionsMsg\) handleHubRecentSessions\(lastRecentSessionsMsg\);/);
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
  assert.deepEqual(registry.findSetting("sessionListAvatars").pick(false), { ok: true, value: false });
  assert.match(read("bin/cli.js"), /known keys: promptExpiryMinutes, chatWidth, sessionListAvatars\)/);
  var daemon = read("lib/daemon.js");
  assert.match(daemon, /sessionListAvatars: \{\s*set: serverHooks\.onSetSessionListAvatarsDefault,\s*announce: serverHooks\.onGetSessionListAvatarsDefault,/);
  assert.match(daemon, /sessionListAvatars: sessionListAvatarsSetting\.read\(config\)/);
});

test("the app starts the preference at load", function () {
  assert.match(read("lib/public/app.js"), /initSessionListAvatars\(\);/);
  assert.ok(fs.existsSync(path.join(PUBLIC, "modules", "serialized-save.js")));
});
