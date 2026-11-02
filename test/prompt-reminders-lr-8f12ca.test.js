"use strict";

// Reminders for unanswered operator prompts (lib/prompt-reminders.js) over the
// real prompt registry and the real notifications module.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var home = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-reminders-"));
process.env.CLAGENTIC_CONSOLE_HOME = home;

var { createPromptRegistry } = require("../lib/prompt-registry");
var { attachNotifications } = require("../lib/project-notifications");
var reminders = require("../lib/prompt-reminders");
var sessionReclaim = require("../lib/session-reclaim");

var MIN = 60000;

function world(opts) {
  opts = opts || {};
  var clock = { t: 1000000 };
  var sessions = new Map();
  var sent = [];
  var pushes = [];
  var registry;
  var nm = attachNotifications({
    broadcastAll: function (m) { sent.push(m); },
    sendToUser: function (u, m) { sent.push(Object.assign({ toUser: u }, m)); },
    pushModule: null,
  });
  registry = createPromptRegistry({
    index: Object.create(null),
    getSession: function (id) { return sessions.get(id); },
    sendAndRecord: function () {},
    saveSessionFile: function () {},
    getNotificationsModule: function () { return nm; },
    getProjectName: function () { return "proj"; },
  });
  var realNow = Date.now;
  Date.now = function () { return clock.t; };
  var rem = reminders.createPromptReminders({
    notifications: nm,
    push: { sendPush: function (p) { pushes.push(p); }, sendPushToUser: function (u, p) { pushes.push(Object.assign({ toUser: u }, p)); } },
    getConfig: function () { return opts.config || null; },
    now: function () { return clock.t; },
    listSessions: function () {
      var out = [];
      sessions.forEach(function (s) { out.push({ slug: "p", project: "Proj", session: s, prompts: registry }); });
      return out;
    },
  });
  rem.start();
  return {
    clock: clock, sessions: sessions, sent: sent, pushes: pushes, registry: registry, nm: nm, rem: rem,
    addSession: function (id, extra) {
      var s = Object.assign({ localId: id, title: "Session " + id }, extra || {});
      sessions.set(id, s);
      return s;
    },
    open: function (session, tool, toolUseId) {
      return registry.open(session, "permission", { toolName: tool || "Bash", toolInput: { command: "ls" } },
        { toolUseId: toolUseId, notification: { title: "t", slug: "p", sessionId: session.localId } });
    },
    live: function () { return world.liveOf(sent); },
    done: function () { rem.stop(); Date.now = realNow; },
  };
}

// The reminders a client would be showing: created and not dismissed.
world.liveOf = function (messages) {
  var live = [];
  messages.forEach(function (m) {
    if (m.type === "notification_created" && m.notification.type === "permission_reminder") live.push(m.notification);
    if (m.type === "notification_dismissed") live = live.filter(function (n) { return m.ids.indexOf(n.id) === -1; });
  });
  return live;
};

test("schedule: 5, 15 and 30 minutes, then hourly", function () {
  var s = reminders.resolveSchedule(null);
  assert.equal(reminders.dueCount(4 * MIN, s), 0);
  assert.equal(reminders.dueCount(5 * MIN, s), 1);
  assert.equal(reminders.dueCount(15 * MIN, s), 2);
  assert.equal(reminders.dueCount(30 * MIN, s), 3);
  assert.equal(reminders.dueCount(89 * MIN, s), 3);
  assert.equal(reminders.dueCount(90 * MIN, s), 4);
  assert.equal(reminders.dueCount(150 * MIN, s), 5);
});

test("configuration: custom steps, off, and malformed values fall back to the defaults", function () {
  var c = reminders.resolveSchedule({ scheduleMinutes: [0.5, 1], repeatMinutes: 2, tickSeconds: 1 });
  assert.deepEqual(c.offsetsMs, [30000, 60000]);
  assert.equal(c.repeatMs, 120000);
  assert.equal(c.tickMs, 1000);
  assert.equal(reminders.resolveSchedule({ enabled: false }).enabled, false);
  assert.deepEqual(reminders.resolveSchedule({ scheduleMinutes: ["x", -1] }).offsetsMs, [5 * MIN, 15 * MIN, 30 * MIN]);
  assert.deepEqual(reminders.resolveSchedule({ scheduleMinutes: [] }).offsetsMs, [5 * MIN, 15 * MIN, 30 * MIN]);
});

test("a background agent's prompt left unanswered gets reminders at the schedule, one replacing the last", function () {
  var w = world();
  try {
    var session = w.addSession(1);
    session.activeTaskToolIds = { task1: true };
    sessionReclaim.noteTaskLabel(session, "task1", { description: "Reviewer" });
    w.registry.noteSubagentTool(session, "tool1", "task1");
    w.open(session, "Edit", "tool1");

    w.clock.t += 4 * MIN; w.rem.sweep(true);
    assert.equal(w.live().length, 0, "nothing before the first step");
    assert.equal(w.pushes.length, 0);

    w.clock.t += 1 * MIN; w.rem.sweep(true);
    var first = w.live();
    assert.equal(first.length, 1);
    assert.match(first[0].title, /^1 prompt waiting, oldest 5 min$/);
    assert.match(first[0].body, /Agent: Reviewer/);
    assert.match(first[0].body, /Tool: Edit/);
    assert.equal(first[0].category, "approval_reminder");
    assert.equal(w.pushes.length, 1);
    assert.equal(w.pushes[0].type, "permission_reminder");
    assert.equal(w.pushes[0].tag, "prompt-reminder-p:1");

    w.clock.t += 20 * MIN; w.rem.sweep(true);
    var second = w.live();
    assert.equal(second.length, 1, "replaced, never stacked");
    assert.notEqual(second[0].id, first[0].id);
    assert.match(second[0].title, /oldest 25 min/);
    assert.equal(w.pushes.length, 2);
    assert.equal(w.pushes[1].tag, w.pushes[0].tag, "the device replaces by tag");

    w.rem.sweep(true);
    w.rem.sweep(true);
    assert.equal(w.pushes.length, 2, "sweeping again before the next step sends nothing");
    assert.equal(w.live()[0].id, second[0].id, "and leaves the live reminder alone");
  } finally { w.done(); }
});

test("the reminder carries a count and the oldest age, and names every waiting agent and tool", function () {
  var w = world();
  try {
    var session = w.addSession(1);
    session.activeTaskToolIds = { t1: true, t2: true };
    sessionReclaim.noteTaskLabel(session, "t1", { description: "Alpha" });
    sessionReclaim.noteTaskLabel(session, "t2", { description: "Beta" });
    w.registry.noteSubagentTool(session, "u1", "t1");
    w.registry.noteSubagentTool(session, "u2", "t2");
    w.open(session, "Bash", "u1");
    w.clock.t += 10 * MIN;
    w.open(session, "Write", "u2");
    w.open(session, "Bash");
    w.clock.t += 37 * MIN; w.rem.sweep(true);
    var n = w.live();
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "3 prompts waiting, oldest 47 min");
    assert.match(n[0].body, /Agent: Alpha, Beta/);
    assert.match(n[0].body, /Tool: Bash, Write/);
    assert.equal(n[0].meta.count, 3);
  } finally { w.done(); }
});

test("answering clears the reminder at once, and a remaining prompt recounts it", function () {
  var w = world();
  try {
    var session = w.addSession(1);
    var a = w.open(session, "Bash");
    var b = w.open(session, "Edit");
    w.clock.t += 6 * MIN; w.rem.sweep(true);
    assert.match(w.live()[0].title, /^2 prompts waiting/);
    w.registry.respond(a.requestId, { decision: "allow" });
    assert.equal(w.live().length, 1);
    assert.match(w.live()[0].title, /^1 prompt waiting/, "recounted without waiting for the clock");
    assert.equal(w.pushes.length, 1, "a recount is not a new push");
    w.registry.respond(b.requestId, { decision: "deny" });
    assert.equal(w.live().length, 0, "gone as the last prompt is answered");
  } finally { w.done(); }
});

test("cancelling (turn end, session end) clears it too", function () {
  var w = world();
  try {
    var session = w.addSession(1);
    w.open(session, "Bash");
    w.clock.t += 6 * MIN; w.rem.sweep(true);
    assert.equal(w.live().length, 1);
    w.registry.cancelSession(session, "context_clear");
    assert.equal(w.live().length, 0);
  } finally { w.done(); }
});

test("a session with reminders switched off gets none, and switching off clears a live one", function () {
  var w = world();
  try {
    var off = w.addSession(1, { promptRemindersOff: true });
    var on = w.addSession(2);
    w.open(off, "Bash");
    w.open(on, "Bash");
    w.clock.t += 6 * MIN; w.rem.sweep(true);
    var live = w.live();
    assert.equal(live.length, 1);
    assert.equal(live[0].sessionId, 2);
    on.promptRemindersOff = true;
    w.nm.reconcileReminders();
    assert.equal(w.live().length, 0);
  } finally { w.done(); }
});

test("reminders disabled in configuration send none", function () {
  var w = world({ config: { enabled: false } });
  try {
    w.open(w.addSession(1), "Bash");
    w.clock.t += 60 * MIN; w.rem.sweep(true);
    assert.equal(w.live().length, 0);
    assert.equal(w.pushes.length, 0);
  } finally { w.done(); }
});

test("each session has its own one reminder", function () {
  var w = world();
  try {
    w.open(w.addSession(1), "Bash");
    w.open(w.addSession(2), "Bash");
    w.clock.t += 6 * MIN; w.rem.sweep(true);
    assert.deepEqual(w.live().map(function (n) { return n.sessionId; }).sort(), [1, 2]);
    w.clock.t += 10 * MIN; w.rem.sweep(true);
    assert.equal(w.live().length, 2);
  } finally { w.done(); }
});

test("a reminder targets the session owner, and a push goes to the owner only", function () {
  var w = world();
  try {
    w.open(w.addSession(1, { ownerId: "alice" }), "Bash");
    w.clock.t += 6 * MIN; w.rem.sweep(true);
    var created = w.sent.filter(function (m) { return m.type === "notification_created"; });
    assert.ok(created.some(function (m) { return m.toUser === "alice" && m.notification.type === "permission_reminder"; }));
    assert.equal(w.pushes[0].toUser, "alice");
  } finally { w.done(); }
});

test("a restart: a new sweep over a prompt that is pending again starts from that prompt's own opening", function () {
  var w = world();
  try {
    var session = w.addSession(1);
    w.open(session, "Bash");
    w.clock.t += 6 * MIN; w.rem.sweep(true);
    assert.equal(w.live().length, 1);
    // The process restarts: the reminder module is new, the prompt is asked again.
    w.rem.stop();
    var again = w.open(w.addSession(2), "Bash");
    assert.ok(again.pending);
    var fresh = reminders.createPromptReminders({
      notifications: w.nm, push: null, now: function () { return w.clock.t; },
      listSessions: function () { return [{ slug: "p", project: "Proj", session: w.sessions.get(2), prompts: w.registry }]; },
    });
    fresh.sweep(true);
    assert.equal(w.live().filter(function (n) { return n.sessionId === 2; }).length, 0, "not yet due");
    w.clock.t += 5 * MIN; fresh.sweep(true);
    assert.equal(w.live().filter(function (n) { return n.sessionId === 2; }).length, 1, "resumes at its schedule point");
  } finally { w.done(); }
});

test("a reminder is never kept across a restart and never touches the prompt", function () {
  var w = world();
  try {
    var session = w.addSession(1);
    var p = w.open(session, "Bash");
    w.clock.t += 6 * MIN; w.rem.sweep(true);
    assert.equal(w.registry.pendingCount(session), 1);
    var saved = JSON.parse(fs.readFileSync(path.join(home, "console", "notifications.json"), "utf8"));
    assert.ok(saved.some(function (n) { return n.type === "permission_reminder"; }), "written like any notification");
    var reloaded = attachNotifications({ broadcastAll: function () {}, pushModule: null });
    var seen = [];
    reloaded.sendConnectionState({}, function (ws, m) { seen.push(m); });
    var state = seen.find(function (m) { return m.type === "notifications_state"; });
    assert.equal(state.notifications.filter(function (n) { return n.type === "permission_reminder"; }).length, 0);
    assert.ok(p.pending);
  } finally { w.done(); }
});
