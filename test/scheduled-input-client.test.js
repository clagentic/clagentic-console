"use strict";
// The browser side of scheduled input: the time arithmetic and wording, the
// schedule panel, and the scheduled-message bubbles, run as the production
// modules over the repo's hand-built DOM.

var test = require("node:test");
var assert = require("node:assert/strict");

var dom = require("./fake-dom-prompt-cards");
var serverTime = require("../lib/cli/schedule-input-subcommands");

function local(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

var NOW = local(2026, 3, 1, 19, 0);

async function timeModule() {
  return import(dom.moduleUrl("schedule-time.js"));
}

// --- the time arithmetic ---

test("the browser and the CLI resolve a clock time the same way", async function () {
  var t = await timeModule();
  ["20:01", "18:30", "19:00", "00:00", "23:59", "7:05", "24:00", "12:60", "noon", ""].forEach(function (raw) {
    var browser = t.resolveClockTime(raw, NOW);
    var cli = serverTime.resolveClockTime(raw, NOW);
    assert.equal(browser.error !== undefined, cli.error !== undefined, "same verdict for " + JSON.stringify(raw));
    if (!cli.error) {
      assert.equal(browser.ms, cli.ms, "same time for " + raw);
      assert.equal(browser.tomorrow, cli.tomorrow, "same day for " + raw);
    }
  });
});

test("a past clock time is shown as tomorrow before anything is armed", async function () {
  var t = await timeModule();
  var built = t.buildSchedule({ mode: "once", onceBy: "at", at: "18:00" }, NOW);
  assert.equal(built.spec.kind, "once");
  assert.equal(built.spec.atMs, local(2026, 3, 2, 18, 0));
  assert.match(built.summary, /tomorrow at 18:00/);
  var today = t.buildSchedule({ mode: "once", onceBy: "at", at: "20:01" }, NOW);
  assert.match(today.summary, /today at 20:01/);
});

test("once in N minutes states the clock time it will go", async function () {
  var t = await timeModule();
  var built = t.buildSchedule({ mode: "once", onceBy: "in", inMinutes: "10" }, NOW);
  assert.deepEqual(built.spec, { kind: "once", delayMs: 600000 });
  assert.match(built.summary, /Sends in 10 min, at 19:10/);
  assert.match(t.buildSchedule({ mode: "once", onceBy: "in", inMinutes: "0" }, NOW).error, /minutes from 1 to 1440/);
  assert.match(t.buildSchedule({ mode: "once", onceBy: "in", inMinutes: "1441" }, NOW).error, /minutes from 1 to 1440/);
  assert.match(t.buildSchedule({ mode: "once", onceBy: "in", inMinutes: "" }, NOW).error, /minutes/);
});

test("a repeat needs an interval from 1 minute to 24 hours and an end", async function () {
  var t = await timeModule();
  var form = { mode: "repeat", everyMinutes: "30", endBy: "count", count: "3" };
  var byCount = t.buildSchedule(form, NOW);
  assert.deepEqual(byCount.spec, { kind: "recurring", everyMs: 1800000, count: 3 });
  assert.match(byCount.summary, /every 30 min, 3 times/);
  var byUntil = t.buildSchedule({ mode: "repeat", everyMinutes: "30", endBy: "until", until: "21:00" }, NOW);
  assert.deepEqual(byUntil.spec, { kind: "recurring", everyMs: 1800000, untilMs: local(2026, 3, 1, 21, 0) });
  assert.match(byUntil.summary, /until today at 21:00/);
  assert.match(t.buildSchedule({ mode: "repeat", everyMinutes: "1441", endBy: "count", count: "2" }, NOW).error, /1 to 1440/);
  assert.match(t.buildSchedule({ mode: "repeat", everyMinutes: "0", endBy: "count", count: "2" }, NOW).error, /1 to 1440/);
  assert.match(t.buildSchedule({ mode: "repeat", everyMinutes: "30", endBy: "count", count: "" }, NOW).error, /how many times/);
  assert.match(t.buildSchedule({ mode: "repeat", everyMinutes: "30", endBy: "until", until: "19:10" }, NOW).error, /before the first send/);
});

test("an until time already past today means tomorrow, shown", async function () {
  var t = await timeModule();
  var built = t.buildSchedule({ mode: "repeat", everyMinutes: "60", endBy: "until", until: "07:00" }, NOW);
  assert.equal(built.spec.untilMs, local(2026, 3, 2, 7, 0));
  assert.match(built.summary, /until tomorrow at 07:00/);
});

test("the websocket message carries the armed shape, with the original once fields kept", async function () {
  var t = await timeModule();
  assert.deepEqual(t.scheduleMessageFor({ kind: "once", delayMs: 600000 }, "hi", NOW), { type: "schedule_message", text: "hi", resetsAt: NOW + 600000 });
  assert.deepEqual(t.scheduleMessageFor({ kind: "once", atMs: 12345 }, "hi", NOW), { type: "schedule_message", text: "hi", resetsAt: 12345 });
  assert.deepEqual(t.scheduleMessageFor({ kind: "recurring", everyMs: 60000, untilMs: 999 }, "hi", NOW),
    { type: "schedule_message", text: "hi", kind: "recurring", every: 60000, until: 999 });
  assert.deepEqual(t.scheduleMessageFor({ kind: "recurring", everyMs: 60000, count: 4 }, "hi", NOW),
    { type: "schedule_message", text: "hi", kind: "recurring", every: 60000, count: 4 });
});

test("labels are plain, and the automatic resume is named only for the auto-continue", async function () {
  var t = await timeModule();
  assert.equal(t.inputLabel({ kind: "once", createdBy: "browser" }), "Scheduled message");
  assert.equal(t.inputLabel({ kind: "recurring", createdBy: "cli" }), "Scheduled repeat");
  assert.equal(t.inputLabel({ kind: "once", createdBy: "rate-limit" }), "Automatic resume after rate limit");
  var line = t.inputSummary({ kind: "recurring", createdBy: "cli", every: 1800000, nextAt: local(2026, 3, 1, 19, 30), until: local(2026, 3, 1, 21, 0), firedCount: 0, count: null }, NOW);
  assert.equal(line, "Scheduled repeat · every 30 min · next 19:30 · until 21:00");
  var lines = t.countdownText({ kind: "recurring", createdBy: "cli", every: 1800000, nextAt: NOW + 90000, count: 3, firedCount: 1, until: null }, NOW);
  assert.match(lines, /^Scheduled repeat · Next at .* \(1m 30s\) · every 30 min · 2 of 3 left$/);
  assert.match(t.countdownText({ kind: "once", createdBy: "browser", nextAt: NOW + 5000 }, NOW), /^Sends at .* \(5s\)$/);
  assert.equal(t.countdownText({ kind: "once", createdBy: "browser", nextAt: NOW - 1 }, NOW), "Sending...");
});

// --- the panel and the bubbles, over the fake DOM ---

async function boot() {
  dom.setupGlobals();
  document.removeEventListener = function () {};
  var messages = new dom.FakeElement("div");
  document.getElementById = function (id) { return id === "messages" ? messages : null; };
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({ connected: true, activeSessionId: "A", currentVendor: "claude", replayingHistory: false, myUserId: "me", cachedAllUsers: [] });
  return { messages: messages, store: storeMod.store };
}

function click(el) { el.click(); }

test("the panel arms a once input by minutes and by clock time, and a repeat by count or until", async function () {
  await boot();
  var { createSchedulePanel } = await import(dom.moduleUrl("schedule-panel.js"));
  var armed = [];
  var panel = createSchedulePanel({
    anchorEl: new dom.FakeElement("button"),
    getInputs: function () { return []; },
    canArm: function () { return true; },
    onArm: function (spec) { armed.push(spec); },
    onSendNow: function () {},
    onCancel: function () {},
    now: function () { return NOW; },
  });
  panel.toggle();
  var el = document.body.querySelector(".schedule-panel");
  assert.equal(panel.isOpen(), true);
  assert.equal(el.classList.contains("hidden"), false);
  var arm = el.querySelector(".schedule-arm");
  assert.equal(arm.disabled, true, "nothing chosen yet");
  assert.equal(el.querySelector(".schedule-preview").textContent, "Choose when to send.");

  var minutes = el.querySelectorAll(".schedule-inline-input");
  var times = el.querySelectorAll(".schedule-time-input");
  var radios = el.querySelectorAll(".schedule-radio");

  dom.typeInto(minutes[0], "10");
  assert.match(el.querySelector(".schedule-preview").textContent, /Sends in 10 min, at 19:10/);
  click(arm);
  assert.deepEqual(armed[0], { kind: "once", delayMs: 600000 });
  assert.equal(panel.isOpen(), false, "arming closes the panel");

  panel.toggle();
  click(radios[1]);
  dom.typeInto(times[0], "18:00");
  assert.match(el.querySelector(".schedule-preview").textContent, /tomorrow at 18:00/, "the day is shown before arming");
  click(arm);
  assert.deepEqual(armed[1], { kind: "once", atMs: local(2026, 3, 2, 18, 0) });

  panel.toggle();
  click(el.querySelectorAll(".schedule-tab")[1]);
  assert.equal(arm.disabled, true, "a repeat without an interval and an end cannot be armed");
  dom.typeInto(minutes[1], "30");
  assert.equal(arm.disabled, true, "an interval without an end cannot be armed");
  click(radios[3]);
  dom.typeInto(minutes[2], "3");
  click(arm);
  assert.deepEqual(armed[2], { kind: "recurring", everyMs: 1800000, count: 3 });

  panel.toggle();
  click(radios[2]);
  dom.typeInto(times[1], "21:00");
  click(arm);
  assert.deepEqual(armed[3], { kind: "recurring", everyMs: 1800000, untilMs: local(2026, 3, 1, 21, 0) });
});

test("the panel lists the session's armed inputs with send now and cancel for each, and refuses to arm at the cap", async function () {
  await boot();
  var { createSchedulePanel } = await import(dom.moduleUrl("schedule-panel.js"));
  var inputs = [
    { id: "si_a", kind: "once", createdBy: "browser", nextAt: NOW + 600000, firedCount: 0 },
    { id: "si_b", kind: "recurring", createdBy: "cli", every: 1800000, nextAt: NOW + 1800000, until: NOW + 7200000, count: null, firedCount: 0 },
  ];
  var sent = [];
  var cancelled = [];
  var atCap = false;
  var panel = createSchedulePanel({
    anchorEl: new dom.FakeElement("button"),
    getInputs: function () { return inputs; },
    canArm: function () { return !atCap; },
    onArm: function () {},
    onSendNow: function (id) { sent.push(id); },
    onCancel: function (id) { cancelled.push(id); },
    now: function () { return NOW; },
  });
  panel.toggle();
  var el = document.body.querySelector(".schedule-panel");
  var rows = el.querySelectorAll(".schedule-list-row");
  assert.equal(rows.length, 2);
  assert.match(rows[0].querySelector(".schedule-list-text").textContent, /^Scheduled message · 19:10$/);
  assert.match(rows[1].querySelector(".schedule-list-text").textContent, /^Scheduled repeat · every 30 min · next 19:30 · until 21:00$/);
  click(rows[1].querySelector(".scheduled-msg-send-now"));
  click(rows[0].querySelector(".scheduled-msg-cancel"));
  assert.deepEqual(sent, ["si_b"]);
  assert.deepEqual(cancelled, ["si_a"]);

  atCap = true;
  panel.refresh();
  assert.equal(el.querySelector(".schedule-arm").disabled, true);
  assert.match(el.querySelector(".schedule-preview").textContent, /reached its limit/);
});

test("a session already at the cap can still open the panel; only arming is off, send now and cancel work", async function () {
  await boot();
  var { createSchedulePanel } = await import(dom.moduleUrl("schedule-panel.js"));
  var inputs = [{ id: "si_a", kind: "once", createdBy: "browser", nextAt: NOW + 600000, firedCount: 0 }];
  var armed = [];
  var sent = [];
  var cancelled = [];
  var panel = createSchedulePanel({
    anchorEl: new dom.FakeElement("button"),
    getInputs: function () { return inputs; },
    canArm: function () { return false; },
    onArm: function (spec) { armed.push(spec); },
    onSendNow: function (id) { sent.push(id); },
    onCancel: function (id) { cancelled.push(id); },
    now: function () { return NOW; },
  });
  panel.toggle();
  assert.equal(panel.isOpen(), true, "the panel opens at the cap");
  var el = document.body.querySelector(".schedule-panel");
  var arm = el.querySelector(".schedule-arm");
  dom.typeInto(el.querySelectorAll(".schedule-inline-input")[0], "10");
  assert.equal(arm.disabled, true);
  assert.match(el.querySelector(".schedule-preview").textContent, /reached its limit/);
  click(arm);
  assert.deepEqual(armed, [], "arming is refused at the cap");
  var row = el.querySelectorAll(".schedule-list-row")[0];
  assert.notEqual(row.querySelector(".scheduled-msg-send-now").disabled, true, "send now stays usable");
  assert.notEqual(row.querySelector(".scheduled-msg-cancel").disabled, true, "cancel stays usable");
  click(row.querySelector(".scheduled-msg-send-now"));
  click(row.querySelector(".scheduled-msg-cancel"));
  assert.deepEqual(sent, ["si_a"]);
  assert.deepEqual(cancelled, ["si_a"]);
});

test("a repeat names its end in the panel before it is armed", async function () {
  await boot();
  var { createSchedulePanel } = await import(dom.moduleUrl("schedule-panel.js"));
  var panel = createSchedulePanel({
    anchorEl: new dom.FakeElement("button"), getInputs: function () { return []; }, canArm: function () { return true; },
    onArm: function () {}, onSendNow: function () {}, onCancel: function () {}, now: function () { return NOW; },
  });
  panel.toggle();
  var el = document.body.querySelector(".schedule-panel");
  assert.match(el.textContent, /A repeat always has an end\./);
});

test("the bubbles are drawn from the list, one per input, and their buttons name the input", async function () {
  var env = await boot();
  var wsRef = await import(dom.moduleUrl("ws-ref.js"));
  var sentFrames = [];
  wsRef.setWs({ readyState: 1, send: function (body) { sentFrames.push(JSON.parse(body)); } });
  var rl = await import(dom.moduleUrl("app-rate-limit.js"));
  try {
    rl.applyScheduledInputList({
      type: "scheduled_input_list", localId: "A", limit: 5, inputs: [
        { id: "si_1", kind: "once", createdBy: "browser", text: "first", nextAt: Date.now() + 60000, firedCount: 0 },
        { id: "si_2", kind: "recurring", createdBy: "cli", text: "wake up", every: 600000, nextAt: Date.now() + 600000, until: Date.now() + 3600000, count: null, firedCount: 0 },
        { id: "si_3", kind: "once", createdBy: "rate-limit", text: "continue", nextAt: Date.now() + 120000, firedCount: 0 },
      ],
    });
    var wraps = env.messages.querySelectorAll(".scheduled-msg-wrap");
    assert.equal(wraps.length, 3);
    assert.equal(wraps[0].querySelector(".bubble").textContent, "first");
    assert.match(wraps[1].querySelector(".scheduled-msg-countdown").textContent, /^Scheduled repeat · Next at .* every 10 min until /);
    assert.match(wraps[2].querySelector(".scheduled-msg-countdown").textContent, /^Automatic resume after rate limit · Sends at /);
    click(wraps[1].querySelector(".scheduled-msg-send-now"));
    click(wraps[0].querySelector(".scheduled-msg-cancel"));
    assert.deepEqual(sentFrames, [
      { type: "send_scheduled_now", id: "si_2" },
      { type: "cancel_scheduled_message", id: "si_1" },
    ]);

    // The list changes (one input fired): the bubbles follow it, not events.
    rl.applyScheduledInputList({ type: "scheduled_input_list", localId: "A", limit: 5, inputs: [
      { id: "si_2", kind: "recurring", createdBy: "cli", text: "wake up", every: 600000, nextAt: Date.now() + 600000, until: Date.now() + 3600000, count: null, firedCount: 1 },
    ] });
    assert.equal(env.messages.querySelectorAll(".scheduled-msg-wrap").length, 1);

    // A list for a session that is not on screen is kept, not drawn.
    rl.applyScheduledInputList({ type: "scheduled_input_list", localId: "B", limit: 5, inputs: [
      { id: "si_9", kind: "once", createdBy: "browser", text: "elsewhere", nextAt: Date.now() + 60000, firedCount: 0 },
    ] });
    assert.equal(env.messages.querySelectorAll(".scheduled-msg-wrap").length, 1);
    assert.equal(env.messages.textContent.indexOf("elsewhere"), -1);
  } finally {
    rl.resetRateLimitState();
    wsRef.setWs(null);
  }
});

test("switching to a session asks the server for its current list", async function () {
  await boot();
  var wsRef = await import(dom.moduleUrl("ws-ref.js"));
  var sentFrames = [];
  wsRef.setWs({ readyState: 1, send: function (body) { sentFrames.push(JSON.parse(body)); } });
  var rl = await import(dom.moduleUrl("app-rate-limit.js"));
  try {
    rl.restoreRateLimitStateForSession("A");
    assert.deepEqual(sentFrames.filter(function (f) { return f.type === "scheduled_input_list_request"; }), [{ type: "scheduled_input_list_request" }]);
  } finally {
    rl.resetRateLimitState();
    wsRef.setWs(null);
  }
});
