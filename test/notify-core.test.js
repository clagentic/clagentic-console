"use strict";

// The notification core (lib/notify/): target model, tags, payloads, close on
// resolve, and the prompt registry's resolve wiring.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

process.env.CLAGENTIC_CONSOLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "notify-core-"));

var notify = require("../lib/notify");
var target = require("../lib/notify/target");
var payloads = require("../lib/notify/payload");
var { createTypeRegistry } = require("../lib/notify/type-registry");
var { registerBuiltins, PROMPT_TYPES } = require("../lib/notify/types");
var { categoryOfPush } = require("../lib/notification-prefs");
var { createPromptRegistry } = require("../lib/prompt-registry");

function fakePush() {
  var sent = [];
  return {
    sent: sent,
    sendPush: function (p) { sent.push({ to: "*", payload: p }); },
    sendPushToUser: function (u, p) { sent.push({ to: u, payload: p }); },
  };
}

function core(push) {
  var registry = registerBuiltins(createTypeRegistry());
  return notify.createNotifyCore({ registry: registry, push: push });
}

var SINGLE = { isMultiUser: function () { return false; } };
function aud(extra) { return Object.assign({}, SINGLE, extra || {}); }

test("targetKey is slug:sessionId[:requestId] and refuses a slug that is not a slug", function () {
  assert.equal(target.targetKey({ slug: "p", sessionId: 3 }), "p:3");
  assert.equal(target.targetKey({ slug: "p", sessionId: 3, requestId: "r1" }), "p:3:r1");
  assert.equal(target.makeTarget({ slug: "../x", sessionId: 1 }), null);
  assert.equal(target.makeTarget({ slug: "A b" }), null);
  assert.equal(target.targetKey(null), "");
});

test("the same session number in two projects is two targets", function () {
  assert.notEqual(target.targetKey({ slug: "p", sessionId: 7 }), target.targetKey({ slug: "q", sessionId: 7 }));
});

test("urlForTarget builds /p/<slug>/?session=<id>[&request=<id>] and parseDeepLink reads it back", function () {
  assert.equal(target.urlForTarget({ slug: "p", sessionId: 3, requestId: "r 1" }), "/p/p/?session=3&request=r%201");
  assert.equal(target.urlForTarget({ slug: "p", sessionId: 3 }, "https://h/app"), "https://h/app/p/p/?session=3");
  assert.equal(target.urlForTarget({ slug: "p" }), "/p/p/");
  assert.equal(target.urlForTarget({ slug: null }), "/");
  assert.deepEqual(target.parseDeepLink("?session=3&request=r%201"), { sessionId: "3", requestId: "r 1" });
  assert.deepEqual(target.parseDeepLink("?session=12"), { sessionId: "12", requestId: null });
  assert.equal(target.parseDeepLink("?session=abc"), null);
  assert.equal(target.parseDeepLink("?playbook=x"), null);
  assert.equal(target.parseDeepLink(""), null);
});

test("each prompt type carries slug, sessionId and requestId in a core payload", function () {
  var push = fakePush();
  var c = core(push);
  ["permission_request", "ask_user", "elicitation", "permission_reminder"].forEach(function (type) {
    var p = c.notify(type, { slug: "p", sessionId: 3, requestId: "r1" }, { title: "T", body: "B" }, aud());
    assert.equal(p.core, 1);
    assert.equal(p.type, type);
    assert.deepEqual(p.target, { slug: "p", sessionId: "3", requestId: "r1" });
    assert.equal(p.title, "T");
    assert.equal(p.body, "B");
    assert.equal(p.url, "/p/p/?session=3&request=r1");
    assert.equal(p.requireInteraction, true);
  });
  assert.equal(push.sent.length, 4);
});

test("payload tags: a repeat for one target collapses, different targets do not", function () {
  var c = core(fakePush());
  var a = c.notify("permission_reminder", { slug: "p", sessionId: 3, requestId: "r1" }, { title: "t", body: "b" }, aud());
  var b = c.notify("permission_reminder", { slug: "p", sessionId: 3, requestId: "r2" }, { title: "t", body: "b" }, aud());
  assert.equal(a.tag, b.tag, "two reminders for one session share a tag");
  assert.equal(a.renotify, true);
  var other = c.notify("permission_reminder", { slug: "q", sessionId: 3, requestId: "r1" }, { title: "t", body: "b" }, aud());
  assert.notEqual(a.tag, other.tag, "same session number, other project");
  var p1 = c.notify("permission_request", { slug: "p", sessionId: 3, requestId: "r1" }, { title: "t", body: "b" }, aud());
  var p2 = c.notify("permission_request", { slug: "p", sessionId: 3, requestId: "r1" }, { title: "t", body: "b" }, aud());
  assert.equal(p1.tag, p2.tag, "two pushes for one prompt share a tag");
});

test("ask_user prompts in two sessions get different tags", function () {
  var c = core(fakePush());
  var a = c.notify("ask_user", { slug: "p", sessionId: 1, requestId: "toolu_a" }, { title: "t", body: "b" }, aud());
  var b = c.notify("ask_user", { slug: "p", sessionId: 2, requestId: "toolu_b" }, { title: "t", body: "b" }, aud());
  assert.notEqual(a.tag, b.tag);
});

test("a request-level type without a requestId, an unknown type and a bad target are refused", function () {
  var c = core(fakePush());
  assert.throws(function () { c.notify("ask_user", { slug: "p", sessionId: 1 }, { title: "t", body: "b" }, aud()); }, /requestId/);
  assert.throws(function () { c.notify("nope", { slug: "p", sessionId: 1 }, {}, aud()); }, /unregistered/);
  assert.throws(function () { c.notify("ask_user", { slug: "../", sessionId: 1, requestId: "r" }, {}, aud()); }, /invalid/);
});

test("resolve(target) sends a close push with the tag derived from the target, to the audience", function () {
  var push = fakePush();
  var c = core(push);
  var p = c.notify("permission_request", { slug: "p", sessionId: 3, requestId: "r1" }, { title: "t", body: "b" }, aud({ ownerId: "u1" }));
  push.sent.length = 0;
  assert.equal(c.resolve({ slug: "p", sessionId: 3, requestId: "r1" }, aud({ ownerId: "u1" })), 1);
  assert.equal(push.sent.length, 1);
  assert.equal(push.sent[0].to, "u1");
  assert.equal(push.sent[0].payload.type, "notify_close");
  assert.equal(push.sent[0].payload.closes, "permission_request");
  assert.ok(push.sent[0].payload.tags.indexOf(p.tag) !== -1);
});

test("a close needs no live memory: a fresh core closes what an earlier one showed, for every request-level type", function () {
  var push = fakePush();
  var shown = core(push);
  var t = { slug: "p", sessionId: 3, requestId: "r1" };
  var tags = ["permission_request", "ask_user", "elicitation"].map(function (type) {
    return shown.notify(type, t, { title: "t", body: "b" }, aud({ ownerId: "u1" })).tag;
  });
  push.sent.length = 0;
  var afterRestart = core(push);
  assert.equal(afterRestart.resolve(t, aud({ ownerId: "u1" })), 1, "one push per category");
  assert.deepEqual(push.sent[0].payload.tags.slice().sort(), tags.slice().sort());
  assert.equal(push.sent[0].to, "u1");
});

test("a close for another project's target names other tags", function () {
  var push = fakePush();
  var c = core(push);
  var mine = c.notify("permission_request", { slug: "p", sessionId: 3, requestId: "r1" }, { title: "t", body: "b" }, aud());
  push.sent.length = 0;
  c.resolve({ slug: "q", sessionId: 3, requestId: "r1" }, aud());
  assert.equal(push.sent[0].payload.tags.indexOf(mine.tag), -1);
  assert.equal(c.resolve({ requestId: "r1" }, aud()), 0, "a request id alone names no target");
});

test("resolve for a session closes its reminder and not its prompts' pushes", function () {
  var push = fakePush();
  var c = core(push);
  var reminder = c.notify("permission_reminder", { slug: "p", sessionId: 3, requestId: "r1" }, { title: "t", body: "b" }, aud());
  push.sent.length = 0;
  assert.equal(c.resolve({ slug: "p", sessionId: 3 }, aud()), 1);
  assert.equal(push.sent[0].payload.closes, "permission_reminder");
  assert.deepEqual(push.sent[0].payload.tags, [reminder.tag]);
});

test("registered categories match the push filter's categories, and a close follows its type's category", function () {
  Object.keys(PROMPT_TYPES).forEach(function (name) {
    assert.equal(categoryOfPush({ type: name }), PROMPT_TYPES[name].category, name);
  });
  assert.equal(categoryOfPush({ type: "notify_close", closes: "ask_user" }), "approval");
  assert.equal(categoryOfPush({ type: "notify_close", closes: "permission_reminder" }), "approval_reminder");
});

test("a new type is one register() call", function () {
  var registry = registerBuiltins(createTypeRegistry());
  registry.register("build_ready", {
    category: "system", collapse: "session", persistent: false,
    format: function (c) { return { title: "Build " + c.name, body: "ready" }; },
  });
  var push = fakePush();
  var c = notify.createNotifyCore({ registry: registry, push: push });
  var p = c.notify("build_ready", { slug: "p", sessionId: 1 }, { name: "x" }, aud());
  assert.equal(p.title, "Build x");
  assert.equal(p.tag, "n:build_ready:p:1");
  assert.equal(p.requireInteraction, false);
  assert.throws(function () { registry.register("build_ready", { collapse: "session" }); }, /already registered/);
  assert.throws(function () { registry.register("bad", { collapse: "x" }); }, /collapse/);
});

test("the migrated emitters hold no tag literal, route or dedupe logic", function () {
  var root = path.join(__dirname, "..", "lib");
  var files = ["sdk-bridge.js", "sdk-message-processor.js", "prompt-reminders.js"];
  files.forEach(function (f) {
    var src = fs.readFileSync(path.join(root, f), "utf8");
    assert.doesNotMatch(src, /claude-ask|claude-elicitation|"perm-"|prompt-reminder-/, f + " has a tag literal");
  });
  var bridge = fs.readFileSync(path.join(root, "sdk-bridge.js"), "utf8");
  assert.doesNotMatch(bridge, /pushForSession/, "sdk-bridge sends through the core");
});

test("prompt registry closes the push when a prompt settles, however it ends", function () {
  var push = fakePush();
  var sessions = new Map();
  var session = { localId: 4, title: "S", ownerId: "u1" };
  sessions.set(4, session);
  var registry = createPromptRegistry({
    index: Object.create(null),
    getSession: function (id) { return sessions.get(id); },
    sendAndRecord: function () {},
    saveSessionFile: function () {},
    getProjectSlug: function () { return "p"; },
    getPushModule: function () { return push; },
  });
  var core = notify.notifyFor(push);

  var one = registry.open(session, "permission", { toolName: "Bash", toolInput: { command: "ls" } }, { toolUseId: "t1" });
  core.notify("permission_request", { slug: "p", sessionId: 4, requestId: one.requestId }, { title: "t", body: "b" }, aud({ ownerId: "u1" }));
  push.sent.length = 0;
  registry.respond(one.requestId, { behavior: "allow" }, { session: session });
  var closes = push.sent.filter(function (s) { return s.payload.type === "notify_close"; });
  assert.equal(closes.length, 1, "answered");
  assert.equal(closes[0].to, "u1");

  var two = registry.open(session, "permission", { toolName: "Bash", toolInput: { command: "ls" } }, { toolUseId: "t2" });
  core.notify("permission_request", { slug: "p", sessionId: 4, requestId: two.requestId }, { title: "t", body: "b" }, aud({ ownerId: "u1" }));
  push.sent.length = 0;
  registry.cancelSession(session, "session_ended");
  assert.equal(push.sent.filter(function (s) { return s.payload.type === "notify_close"; }).length, 1, "ended with the session");
});

test("a daemon shutdown settles every pending prompt and closes its push, with no live memory", function () {
  var push = fakePush();
  var sessions = new Map();
  var session = { localId: 5, title: "S", ownerId: "u1" };
  sessions.set(5, session);
  var index = Object.create(null);
  var registry = createPromptRegistry({
    index: index,
    getSession: function (id) { return sessions.get(id); },
    sendAndRecord: function () {},
    saveSessionFile: function () {},
    getProjectSlug: function () { return "p"; },
    getPushModule: function () { return push; },
  });
  var ask = registry.open(session, "permission", { toolName: "Bash", toolInput: { command: "ls" } }, { toolUseId: "t9" });
  var expected = notify.notifyFor(fakePush()).notify("permission_request", { slug: "p", sessionId: 5, requestId: ask.requestId }, { title: "t", body: "b" }, aud({ ownerId: "u1" })).tag;
  push.sent.length = 0;
  registry.shutdown();
  var closes = push.sent.filter(function (s) { return s.payload.type === "notify_close"; });
  assert.ok(closes.length >= 1);
  assert.equal(closes[0].to, "u1");
  assert.ok(closes[0].payload.tags.indexOf(expected) !== -1);
});

test("the live-prompt snapshot lists the viewer's pending prompts by session, with ids only", function () {
  var { snapshotLivePrompts } = require("../lib/notify/live-prompts");
  var sessions = [{ localId: 1, ownerId: "u1" }, { localId: 2, ownerId: "u2" }];
  var prompts = { pendingInfo: function (s) { return [{ requestId: "r" + s.localId, toolUseId: "t" + s.localId, content: "secret" }]; } };
  var multi = function () { return true; };
  var snap = snapshotLivePrompts({ slug: "p", sessions: sessions, prompts: prompts, viewerId: "u1", isMultiUser: multi });
  assert.equal(snap.slug, "p");
  assert.deepEqual(snap.items, [{ sessionId: "1", requestId: "r1", toolUseId: "t1" }]);
  assert.equal(typeof snap.at, "number");
});
