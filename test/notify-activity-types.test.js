"use strict";

// The activity notifications (finished turn, loop end, direct message, mention)
// go through the notification core: each carries a full target, reaches its
// audience alone, collapses per session, and is categorised by the registry.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var execFileSync = require("child_process").execFileSync;
var world = require("./prompt-harness-world");

// The banner store persists under the console config directory: keep it off
// the host's own.
var ownHome = fs.mkdtempSync(path.join(os.tmpdir(), "notify-activity-"));
process.env.CLAGENTIC_CONSOLE_HOME = ownHome;

var notifyApi = require("../lib/notify");
var payloads = require("../lib/notify/payload");
var prefs = require("../lib/notification-prefs");
var NotifyTarget = require("../lib/public/notify-target.js");
var sw = require("../lib/public/notify-sw-logic.js");
var { attachUserMention } = require("../lib/project-user-mention");
var { attachDm } = require("../lib/server-dm");

function spyPush() {
  var calls = [];
  return {
    calls: calls,
    sendPush: function (p) { calls.push({ to: "everyone", payload: p }); },
    sendPushToUser: function (u, p) { calls.push({ to: u, payload: p }); },
  };
}

function spyBanner() {
  var shown = [];
  return {
    shown: shown,
    show: function (event, data, meta) { shown.push({ event: event, data: data, meta: meta }); },
    dismissKeys: function () {},
  };
}

var MULTI = function () { return true; };

// AC6, AC8: one registration per type, with the category the prefs filter reads.
var ACTIVITY = {
  response_done: { category: "turn_done", target: { slug: "p", sessionId: 3 }, tag: "n:response_done:p:3" },
  loop_complete: { category: "loop", target: { slug: "p", sessionId: 3 }, tag: "n:loop_complete:p:3" },
  loop_error: { category: "loop", target: { slug: "p", sessionId: 3 }, tag: "n:loop_error:p:3" },
  mate_dm: { category: "messages", target: { peerId: "u9" }, tag: "n:mate_dm:dm:u9" },
  user_mention: { category: "messages", target: { slug: "p", sessionId: 3 }, tag: "n:user_mention:p:3" },
};

Object.keys(ACTIVITY).forEach(function (type) {
  var row = ACTIVITY[type];

  test(type + ": registered, tagged from its target, categorised by the registry (AC3, AC6)", function () {
    var push = spyPush();
    var banner = spyBanner();
    var sent = notifyApi.notifyFor(push, banner).notify(type, row.target, {
      push: { title: "T", body: "B" },
      banner: { title: "T", preview: "B" },
    }, { ownerId: "alice" });
    assert.equal(sent.tag, row.tag);
    assert.equal(sent.type, type);
    assert.equal(sent.collapse, "session");
    assert.equal(sent.core, 1);
    assert.equal(push.calls.length, 1);
    assert.equal(push.calls[0].to, "alice");
    assert.equal(push.calls[0].payload.tag, row.tag);
    assert.equal(banner.shown.length, 1);
    assert.equal(banner.shown[0].meta.key, row.tag);
    assert.equal(prefs.categoryOfPush({ type: type }), row.category);
    assert.equal(prefs.categoryOfNotification(type), row.category);
  });

  test(type + ": content naming a target user or owner does not change the audience (AC8)", function () {
    var push = spyPush();
    var banner = spyBanner();
    notifyApi.notifyFor(push, banner).notify(type, row.target, {
      push: { title: "T", body: "B", targetUserId: "mallory", ownerId: "mallory" },
      banner: { title: "T", targetUserId: "mallory", targetUserIds: ["mallory"], ownerId: "mallory" },
    }, { ownerId: "alice" });
    assert.deepEqual(push.calls.map(function (c) { return c.to; }), ["alice"]);
    assert.equal(banner.shown[0].data.targetUserId, "alice");
    assert.equal(banner.shown[0].data.targetUserIds, null);
    assert.equal(banner.shown[0].data.ownerId, "alice");
  });

  test(type + ": an ownerless session goes to the admins in multi-user mode, to everyone in single-user", function () {
    var multi = spyPush();
    notifyApi.notifyFor(multi, null).notify(type, row.target, { push: { title: "T", body: "B" } }, {
      ownerId: null, isMultiUser: MULTI, listAdmins: function () { return ["admin-1"]; },
    });
    assert.deepEqual(multi.calls.map(function (c) { return c.to; }), ["admin-1"]);
    var single = spyPush();
    notifyApi.notifyFor(single, null).notify(type, row.target, { push: { title: "T", body: "B" } }, {
      ownerId: null, isMultiUser: function () { return false; },
    });
    assert.deepEqual(single.calls.map(function (c) { return c.to; }), ["everyone"]);
  });

  test(type + ": no activity type is closed when a prompt resolves", function () {
    var push = spyPush();
    var core = notifyApi.notifyFor(push, null);
    core.notify(type, row.target, { push: { title: "T", body: "B" } }, { ownerId: "alice" });
    push.calls.length = 0;
    core.resolve({ slug: "p", sessionId: 3 }, { ownerId: "alice" });
    assert.deepEqual(push.calls.filter(function (c) { return c.payload.closes === type; }), []);
  });
});

// AC1, AC2: the finished turn, on the real message processor.
async function finishTurns(opts, steps) {
  var push = spyPush();
  var banner = spyBanner();
  var server = await world.createServer({ pushModule: push, multiUser: opts.multiUser, users: opts.users });
  server.notifications.show = banner.show;
  try {
    await server.startQuery();
    if (opts.ownerId) server.session.ownerId = opts.ownerId;
    server.session.responsePreview = "all done";
    server.session.title = "Fix the build";
    steps(server);
    await new Promise(function (r) { setImmediate(r); });
    return { push: push.calls, banner: banner.shown, server: server };
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
}

function finish(server) {
  server.sdk({ yokeType: "result", cost: 0.01, duration: 10, sessionId: "cli" });
}

test("a finished turn pushes and shows a banner carrying the project and session, to the owner alone (AC1)", async function () {
  var r = await finishTurns({ multiUser: true, ownerId: "alice" }, finish);
  var done = r.push.filter(function (c) { return c.payload.type === "response_done"; });
  assert.equal(done.length, 1);
  assert.equal(done[0].to, "alice");
  var sid = String(r.server.session.localId);
  assert.deepEqual(done[0].payload.target, { slug: "harness", sessionId: sid, requestId: null });
  assert.equal(done[0].payload.url, "/p/harness/?session=" + sid);
  assert.equal(done[0].payload.title, "Fix the build");
  assert.equal(done[0].payload.body, "all done");
  assert.equal(r.banner.length, 1);
  assert.equal(r.banner[0].event, "response_done");
  assert.equal(r.banner[0].data.slug, "harness");
  assert.equal(String(r.banner[0].data.sessionId), sid);
  assert.equal(r.banner[0].data.targetUserId, "alice");
  assert.equal(r.banner[0].meta.key, "n:response_done:harness:" + sid);
});

test("two turns in one session collapse to one tag; another session gets its own (AC2)", async function () {
  var r = await finishTurns({ multiUser: false }, function (server) {
    finish(server);
    server.session.responsePreview = "second";
    finish(server);
    var other = server.sm.createSessionRaw({});
    other.cliSessionId = "other-" + other.localId;
    other.responsePreview = "elsewhere";
    server.bridge.processSDKMessage(other, { yokeType: "result", cost: 0.01, duration: 10, sessionId: "cli2" });
  });
  var tags = r.push.filter(function (c) { return c.payload.type === "response_done"; }).map(function (c) { return c.payload.tag; });
  var first = "n:response_done:harness:" + r.server.session.localId;
  assert.equal(tags.length, 3);
  assert.equal(tags[0], first);
  assert.equal(tags[1], first);
  assert.notEqual(tags[2], first);
  assert.deepEqual(r.banner.map(function (b) { return b.meta.key; }), tags);
});

test("a turn of a loop's own session pushes but raises no banner", async function () {
  var r = await finishTurns({ multiUser: false }, function (server) {
    server.session.loop = { active: true };
    finish(server);
  });
  assert.equal(r.push.filter(function (c) { return c.payload.type === "response_done"; }).length, 1);
  assert.deepEqual(r.banner, []);
});

// AC3: the loop's end, on the real loop engine.
function loopHarness(push, banner) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-loop-notify-"));
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-loop-notify-cwd-"));
  var env = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  });
  execFileSync("git", ["init", "-q"], { cwd: cwd, env: env });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: cwd, env: env });
  var sessions = new Map();
  var nextId = 1;
  var noop = function () {};
  var ctx = {
    cwd: cwd,
    slug: "loop-project",
    sm: {
      sessions: sessions,
      setResolveLoopInfo: noop,
      createSession: function () {
        var s = { localId: nextId++, history: [], loop: {}, isProcessing: false, ownerId: "alice" };
        sessions.set(s.localId, s);
        return s;
      },
      switchSession: noop, saveSessionFile: noop, appendToSessionFile: noop, broadcastSessionList: noop,
      recordHistoryEntry: function (sess, obj) { sess.history.push(obj); },
    },
    sdk: { startQuery: noop },
    send: noop, sendTo: noop, sendToSession: noop,
    pushModule: push,
    notificationsModule: banner,
    getHubSchedules: function () { return []; },
    getAllProjectSessions: function () { return []; },
    getStatus: noop,
    getLinuxUserForSession: function () { return null; },
    onProcessingChanged: noop,
    hydrateImageRefs: noop,
  };
  ["../lib/config", "../lib/utils", "../lib/store", "../lib/scheduler", "../lib/project-loop", "../lib/loop-handoff"]
    .forEach(function (m) { delete require.cache[require.resolve(m)]; });
  var orig = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = home;
  var engine;
  try {
    engine = require("../lib/project-loop").attachLoop(ctx);
  } finally {
    if (orig === undefined) delete process.env.CLAGENTIC_HOME; else process.env.CLAGENTIC_HOME = orig;
  }
  engine.stopTimer();
  var dir = path.join(cwd, ".claude", "loops", "loop_notify");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "PROMPT.md"), "Do the task.");
  fs.writeFileSync(path.join(dir, "JUDGE.md"), "Judge it.");
  fs.writeFileSync(path.join(dir, "LOOP.json"), JSON.stringify({ maxIterations: 3 }));
  engine.loopState.loopId = "loop_notify";
  engine.loopState.loopFilesId = "loop_notify";
  engine.loopState.wizardData = { loopMode: "judge" };
  return {
    engine: engine,
    ctx: ctx,
    cleanup: function () {
      engine.stopClaudeDirWatch();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test("a loop that stops carries its project, its last session and its owner; a tap lands on the project (AC3)", function () {
  var origSetTimeout = global.setTimeout;
  var armed = [];
  global.setTimeout = function (f, d) { var t = origSetTimeout(f, d); armed.push(t); return t; };
  var push = spyPush();
  var banner = spyBanner();
  var h;
  try {
    h = loopHarness(push, banner);
    h.engine.startLoop({ maxIterations: 3, name: "nightly" });
    var sid = h.engine.loopState.currentSessionId;
    h.engine.stopLoop();
    h.ctx.sm.sessions.get(sid).onQueryComplete(h.ctx.sm.sessions.get(sid));
  } finally {
    global.setTimeout = origSetTimeout;
    armed.forEach(function (t) { clearTimeout(t); });
    if (h) h.cleanup();
  }
  assert.equal(push.calls.length, 1);
  assert.equal(push.calls[0].to, "alice");
  var p = push.calls[0].payload;
  assert.equal(p.type, "loop_complete");
  assert.equal(p.tag, "n:loop_complete:loop-project:1");
  assert.deepEqual(p.target, { slug: "loop-project", sessionId: "1", requestId: null });
  assert.equal(p.url, "/p/loop-project/?session=1");
  assert.equal(p.body, "Stopped by user");
  assert.equal(banner.shown.length, 1);
  assert.equal(banner.shown[0].event, "loop_complete");
  assert.equal(banner.shown[0].data.slug, "loop-project");
  assert.equal(banner.shown[0].data.targetUserId, "alice");
  assert.equal(banner.shown[0].data.reason, "stopped");
});

// AC4: a direct message.
function dmWorld(opts) {
  var push = spyPush();
  var banner = spyBanner();
  var sent = [];
  var ctx = {
    users: {},
    dm: { sendMessage: function () { return { text: "hi" }; } },
    projects: new Map([["p", {
      getNotificationsModule: function () { return opts && opts.noBanner ? null : banner; },
      forEachClient: function () {},
    }]]),
    pushModule: push,
  };
  var ws = { _clagenticUser: { id: "u1", displayName: "Una" }, send: function (m) { sent.push(JSON.parse(m)); } };
  return { push: push, banner: banner, ws: ws, dm: attachDm(ctx) };
}

test("a direct message pushes and shows a banner to the recipient alone, with a target that opens the conversation (AC4)", function () {
  var w = dmWorld();
  w.dm.handleMessage(w.ws, { type: "dm_send", dmKey: "u1:u2", text: "lunch?" });
  assert.equal(w.push.calls.length, 1);
  assert.equal(w.push.calls[0].to, "u2");
  var p = w.push.calls[0].payload;
  assert.equal(p.tag, "n:mate_dm:dm:u1");
  assert.deepEqual(p.target, { slug: null, sessionId: null, requestId: null, peerId: "u1" });
  assert.equal(p.url, "/?dm=u1");
  assert.equal(p.title, "Una");
  assert.equal(p.body, "lunch?");
  assert.equal(w.banner.shown.length, 1);
  assert.equal(w.banner.shown[0].event, "mate_dm");
  assert.equal(w.banner.shown[0].data.targetUserId, "u2");
  assert.equal(w.banner.shown[0].data.peerId, "u1");
  assert.equal(w.banner.shown[0].data.senderName, "Una");
  assert.equal(NotifyTarget.parsePeerLink("?dm=u1"), "u1");
  assert.equal(NotifyTarget.parsePeerLink("?dm=../x"), null);
});

test("a second message from the same person replaces the first; another sender does not", function () {
  var w = dmWorld();
  w.dm.handleMessage(w.ws, { type: "dm_send", dmKey: "u1:u2", text: "one" });
  w.dm.handleMessage(w.ws, { type: "dm_send", dmKey: "u1:u2", text: "two" });
  var other = { _clagenticUser: { id: "u3", username: "tom" }, send: function () {} };
  w.dm.handleMessage(other, { type: "dm_send", dmKey: "u3:u2", text: "three" });
  assert.deepEqual(w.push.calls.map(function (c) { return c.payload.tag; }), ["n:mate_dm:dm:u1", "n:mate_dm:dm:u1", "n:mate_dm:dm:u3"]);
});

test("a tap on a message notification hands the page the conversation to open (AC4)", async function () {
  var posted = [];
  var win = { url: "https://h.example/", visibilityState: "visible", focus: function () { return Promise.resolve(); }, postMessage: function (m) { posted.push(m); } };
  var p = payloads.buildPayload(notifyApi.getType("mate_dm"), NotifyTarget.makeTarget({ peerId: "u1" }), { title: "Una", body: "hi" });
  await sw.handleClick({
    scope: "https://h.example/",
    clients: { matchAll: function () { return Promise.resolve([win]); }, openWindow: function () { throw new Error("a window exists"); } },
  }, { data: p });
  assert.deepEqual(posted, [{ type: "notify_route", target: { slug: null, sessionId: null, requestId: null, peerId: "u1" } }]);
});

// AC5: a mention.
function mentionWorld(online) {
  var push = spyPush();
  var banner = spyBanner();
  var sessionOwner = "owner-1";
  var attached = attachUserMention({
    slug: "proj",
    sm: { recordHistoryEntry: function () {}, appendToSessionFile: function () {} },
    send: function () {}, sendTo: function () {}, sendToSession: function () {},
    sendToSessionOthers: function () {},
    getSessionForWs: function () { return { localId: 7, ownerId: sessionOwner }; },
    getLinuxUserForSession: function () { return null; },
    saveImageFile: function () { return null; },
    usersModule: { findUserById: function (id) { return { id: id, username: "bea", displayName: "Bea" }; } },
    pushModule: push,
    isUserOnline: function () { return online; },
    getNotificationsModule: function () { return banner; },
  });
  var ws = { _clagenticUser: { id: "u1", username: "una" } };
  return { push: push, banner: banner, run: function () { attached.handleUserMention(ws, { targetUserId: "u2", text: "look at this" }); } };
}

test("a mention pushes to the mentioned user with a target that opens the project's session (AC5)", function () {
  var w = mentionWorld(false);
  w.run();
  assert.equal(w.push.calls.length, 1);
  assert.equal(w.push.calls[0].to, "u2");
  var p = w.push.calls[0].payload;
  assert.deepEqual(p.target, { slug: "proj", sessionId: "7", requestId: null });
  assert.equal(p.url, "/p/proj/?session=7");
  assert.equal(p.title, "@una mentioned you");
  assert.equal(w.banner.shown[0].data.slug, "proj");
  assert.equal(String(w.banner.shown[0].data.sessionId), "7");
  assert.equal(w.banner.shown[0].data.targetUserId, "u2");
  assert.equal(w.banner.shown[0].data.fromUserId, "u1");
});

test("a mention of a user who is online is a banner only: the push waits for them to be away", function () {
  var w = mentionWorld(true);
  w.run();
  assert.deepEqual(w.push.calls, []);
  assert.equal(w.banner.shown.length, 1);
  assert.equal(w.banner.shown[0].data.targetUserId, "u2");
});

test("a presence reader that fails counts as offline", function () {
  var push = spyPush();
  notifyApi.notifyFor(push, null).notify("user_mention", { slug: "p", sessionId: 1 }, { push: { title: "T", body: "B" } }, {
    ownerId: "u2", isOnline: function () { throw new Error("no presence"); },
  });
  assert.equal(push.calls.length, 1);
});

// The page's own done notification and the push for the same turn share a tag.
test("the page and the core derive the same tag for a finished turn", function () {
  var target = { slug: "p", sessionId: 3 };
  var core = payloads.buildPayload(notifyApi.getType("response_done"), NotifyTarget.makeTarget(target), { title: "T", body: "B" });
  assert.equal(NotifyTarget.tagFor("response_done", "session", target), core.tag);
});

// AC6: the legacy tags and the legacy payload branch are gone from the tree.
test("no emitter or reader in lib/ keeps a legacy tag or the legacy payload branch (AC6)", function () {
  var lib = path.join(__dirname, "..", "lib");
  var hits = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!/\.js$/.test(e.name)) return;
      var text = fs.readFileSync(p, "utf8");
      ["claude-done", "claude-ask", "ralph-loop-done", "showLegacy", "clay-user-mention"].forEach(function (needle) {
        if (text.indexOf(needle) !== -1) hits.push(path.relative(lib, p) + ": " + needle);
      });
    });
  })(lib);
  assert.deepEqual(hits, []);
});

test("every sender goes through the core: no sendPush call outside it", function () {
  var lib = path.join(__dirname, "..", "lib");
  var senders = [];
  fs.readdirSync(lib).forEach(function (name) {
    if (!/\.js$/.test(name) || name === "push.js" || name === "push-audience.js") return;
    var text = fs.readFileSync(path.join(lib, name), "utf8");
    if (/\bsendPush(ToUser)?\s*\(/.test(text) || /\bpushForSession\s*\(/.test(text)) senders.push(name);
  });
  assert.deepEqual(senders, []);
});

// AC7: no banner for a sessionless prompt, and nothing for a close to retire.
test("a sessionless prompt raises no banner and its close retires nothing (AC7)", function () {
  var push = spyPush();
  var banner = spyBanner();
  var dismissed = [];
  banner.dismissKeys = function (k) { dismissed.push(k); };
  banner.dismissRequest = function (slug, id) { dismissed.push([slug, id]); };
  var { createPromptRegistry } = require("../lib/prompt-registry");
  var reg = createPromptRegistry({
    index: {},
    saveSessionFile: function () {},
    getSession: function () { return null; },
    getProjectSlug: function () { return "p"; },
    getPushModule: function () { return push; },
    getNotificationsModule: function () { return banner; },
    sendAndRecord: function () {},
    onProcessingChanged: function () {},
  });
  var opened = reg.open(null, "extension", { command: "tab_list", args: {} }, { notification: { title: "t", body: "b" }, timeoutMs: 0 });
  assert.equal(opened.pending, true);
  assert.deepEqual(banner.shown, []);
  assert.deepEqual(push.calls, []);
  assert.deepEqual(dismissed, []);
});

// A banner aimed at a user is handed, on connect, to that user alone, whatever
// its type (it used to hold for prompts only).
test("a targeted activity banner is withheld from other viewers on connect and on the live send", function () {
  fs.rmSync(path.join(require("../lib/config").CONFIG_DIR, "notifications.json"), { force: true });
  var live = [];
  var nm = require("../lib/project-notifications").attachNotifications({
    broadcastAll: function (m) { live.push({ to: "everyone", msg: m }); },
    sendToUser: function (u, m) { live.push({ to: u, msg: m }); },
    pushModule: null,
  });
  notifyApi.notifyFor(null, nm).notify("mate_dm", { peerId: "u1" }, { banner: { senderName: "Una", preview: "hi" } }, { ownerId: "u2" });
  function listFor(userId) {
    var list = null;
    nm.sendConnectionState({ _clagenticUser: { id: userId } }, function (ws, m) {
      if (m.type === "notifications_state") list = m.notifications;
    });
    return list.map(function (n) { return n.type; });
  }
  assert.deepEqual(listFor("u2"), ["mate_dm"]);
  assert.deepEqual(listFor("u3"), []);
  assert.deepEqual(live.map(function (l) { return l.to; }), ["u2"]);
  nm.dismissKeys(["n:mate_dm:dm:u1"]);
});
