"use strict";

// Reminders for operator prompts nobody has answered.
//
// A permission prompt has no timeout, so a prompt the operator never saw (their
// own, or a background agent's) waits for ever and pins its session. A reminder
// is the notification that closes that: it repeats at growing intervals, through
// the notification paths that already exist (the in-app banner and push).
//
// Derived, not timed: nothing is scheduled per prompt. A sweep reads the pending
// prompts from each session's prompt registry (lib/prompt-registry.js) and
// decides from their opening times what is due:
//   - the schedule is offsets from the oldest pending prompt's opening: the
//     configured steps, then one more every `repeatMs`;
//   - a session has at most ONE live reminder; the next one replaces it, with
//     the current count, the oldest age, and the waiting agents and tools;
//   - a prompt that settles (an answer, a cancel, an end of turn) clears or
//     recounts the reminder at once, through the notifications module's
//     reconcile hook, not at the next tick;
//   - the sweep only reads. A reminder never opens, settles or touches a prompt,
//     and nothing here is consulted by the idle reaper.
// Nothing survives a restart because no prompt does (the registry ends every
// prompt at shutdown): a prompt that is pending again after one (the agent
// asked once more) starts its own schedule from its own opening time.
//
// Per-session switch: session.promptRemindersOff (persisted with the session).
// Configuration: daemon.json `promptReminders` { enabled, scheduleMinutes,
// repeatMinutes }. The schedule is read on every sweep, so a change needs no
// restart. The sweep tick is a constant, not configuration: a timer period taken
// from a config file is a value that can be set to nothing. A `tickSeconds` key
// left in daemon.json is ignored.

var { pushForSession, audienceFor } = require("./push-audience");

var DEFAULT_SCHEDULE_MINUTES = [5, 15, 30];
var DEFAULT_REPEAT_MINUTES = 60;
var SWEEP_TICK_MS = 30000;
var MAX_NAMED = 3;

// A configured interval is at least one whole minute once rounded to
// milliseconds. Anything smaller would round the repeat step to 0 and make the
// due count divide by zero.
var MIN_INTERVAL_MS = 60000;

// The one validator for every configurable interval: the minutes, or null.
function intervalMinutes(v) {
  var ms = typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v * 60000) : 0;
  return ms >= MIN_INTERVAL_MS ? v : null;
}

var warned = Object.create(null);

// One warning per key and value, not one per sweep: the schedule is re-read on
// every tick.
function warnOnce(key, value) {
  var id = key + "=" + JSON.stringify(value);
  if (warned[id]) return;
  warned[id] = true;
  console.warn("[prompt-reminders] promptReminders." + key + " must be at least 1 minute; using the default");
}

function repeatMinutes(v) {
  var ok = intervalMinutes(v);
  if (ok !== null) return ok;
  if (v !== undefined) warnOnce("repeatMinutes", v);
  return DEFAULT_REPEAT_MINUTES;
}

/**
 * The schedule daemon.json asks for, with the defaults wherever it is silent
 * or malformed.
 * @param {?object} cfg the daemon.json `promptReminders` value
 * @returns {{enabled: boolean, offsetsMs: number[], repeatMs: number}}
 */
function resolveSchedule(cfg) {
  cfg = cfg && typeof cfg === "object" ? cfg : {};
  var minutes = Array.isArray(cfg.scheduleMinutes) ? cfg.scheduleMinutes.map(intervalMinutes) : null;
  if (!minutes || minutes.length === 0 || minutes.indexOf(null) !== -1) {
    if (cfg.scheduleMinutes !== undefined) warnOnce("scheduleMinutes", cfg.scheduleMinutes);
    minutes = DEFAULT_SCHEDULE_MINUTES;
  }
  // Increasing, so "due" is a count.
  minutes = minutes.slice().sort(function (a, b) { return a - b; });
  return {
    enabled: cfg.enabled !== false,
    offsetsMs: minutes.map(function (m) { return Math.round(m * 60000); }),
    repeatMs: Math.round(repeatMinutes(cfg.repeatMinutes) * 60000),
  };
}

/** How many reminders a prompt this old has earned. */
function dueCount(ageMs, schedule) {
  var offsets = schedule.offsetsMs;
  var n = 0;
  while (n < offsets.length && ageMs >= offsets[n]) n++;
  if (n < offsets.length) return n;
  return n + Math.floor((ageMs - offsets[offsets.length - 1]) / schedule.repeatMs);
}

function waitingFor(ageMs) {
  // Under a minute only a short configured schedule gets here.
  if (ageMs < 60000) return Math.max(1, Math.floor(ageMs / 1000)) + " sec";
  var min = Math.floor(ageMs / 60000);
  return min >= 120 ? Math.floor(min / 60) + " h" : min + " min";
}

function uniqueNamed(values) {
  var seen = Object.create(null);
  var out = [];
  values.forEach(function (v) {
    if (v && !seen[v]) { seen[v] = true; out.push(v); }
  });
  return out;
}

function nameList(values) {
  var shown = values.slice(0, MAX_NAMED).join(", ");
  return values.length > MAX_NAMED ? shown + " +" + (values.length - MAX_NAMED) + " more" : shown;
}

/**
 * The reminder's text for one session's pending prompts.
 * @param {{project: string, session: string, infos: object[], ageMs: number}} s
 */
function describe(s) {
  var count = s.infos.length;
  var agents = uniqueNamed(s.infos.map(function (i) { return i.agent; }));
  var tools = uniqueNamed(s.infos.map(function (i) { return i.toolName; }));
  var parts = [];
  if (s.project) parts.push("Project: " + s.project);
  if (s.session) parts.push("Session: " + s.session);
  if (agents.length) parts.push("Agent: " + nameList(agents));
  if (tools.length) parts.push("Tool: " + nameList(tools));
  return {
    title: count + (count === 1 ? " prompt" : " prompts") + " waiting, oldest " + waitingFor(s.ageMs),
    body: parts.join(" | "),
    agents: agents,
    tools: tools,
  };
}

/**
 * @param {object} deps
 * @param {function(): Array<{slug: string, project: string, session: object, prompts: object}>} deps.listSessions
 *   every session of every project with its prompt registry.
 * @param {object} deps.notifications the notifications module (replaceReminder,
 *   dismissReminder, setReminderReconciler).
 * @param {?object} [deps.push] the push module.
 * @param {function(): ?object} [deps.getConfig] daemon.json `promptReminders`.
 * @param {function(): boolean} [deps.isMultiUser] true when the daemon has
 *   accounts; absent means single-user. A throw reads as multi-user, the
 *   stricter mode.
 * @param {function(): number} [deps.now]
 */
function createPromptReminders(deps) {
  var notifications = deps.notifications;
  var push = deps.push || null;
  var getConfig = deps.getConfig || function () { return null; };
  var now = deps.now || Date.now;
  var isMultiUser = deps.isMultiUser || function () { return false; };
  var listAdmins = deps.listAdmins;
  // sessionKey -> { sent: reminders already sent, live: a reminder is showing,
  // sig: the prompts it names }
  var states = Object.create(null);
  var timer = null;

  // What a live reminder says about the set of waiting prompts; a change in it
  // (one answered, one more opened) recounts the reminder, no change leaves it.
  function signature(infos) {
    return infos.map(function (i) { return i.requestId; }).join(",");
  }

  function keyOf(slug, session) {
    return slug + ":" + session.localId;
  }

  function sendPush(entry, key, text) {
    if (!push) return;
    var payload = {
      type: "permission_reminder",
      slug: entry.slug,
      requestId: entry.requestId,
      title: text.title,
      body: text.body,
      tag: "prompt-reminder-" + key,
    };
    pushForSession(push, entry.session.ownerId, payload, isMultiUser, listAdmins);
  }

  function raise(entry, infos, ageMs, key, withPush) {
    states[key].sig = signature(infos);
    var text = describe({ project: entry.project, session: entry.session.title, infos: infos, ageMs: ageMs });
    // The banner follows the push audience: the owner, or the admins for a
    // session with no owner in multi-user mode, so no one else reads its title.
    var audience = audienceFor(entry.session.ownerId, isMultiUser, listAdmins);
    notifications.replaceReminder(key, {
      title: text.title,
      body: text.body,
      slug: entry.slug,
      sessionId: entry.session.localId,
      ownerId: entry.session.ownerId || null,
      targetUserId: audience.kind === "owner" ? audience.userIds[0] : null,
      targetUserIds: audience.kind === "admins" ? audience.userIds : null,
      requestIds: infos.map(function (i) { return i.requestId; }),
      count: infos.length,
      ageMs: ageMs,
      agents: text.agents,
      tools: text.tools,
    });
    if (withPush) sendPush({ slug: entry.slug, session: entry.session, requestId: infos[0].requestId }, key, text);
  }

  function clear(key) {
    if (states[key]) {
      delete states[key];
      notifications.dismissReminder(key);
    }
  }

  /**
   * One pass over every pending prompt.
   * @param {boolean} sendDue true on the clock: send what the schedule says is
   *   due. false when a prompt settled: only clear or recount a live reminder.
   */
  function sweep(sendDue) {
    var schedule = resolveSchedule(getConfig());
    var t = now();
    var seen = Object.create(null);
    deps.listSessions().forEach(function (entry) {
      var session = entry.session;
      var key = keyOf(entry.slug, session);
      var infos = entry.prompts.pendingInfo(session);
      if (!infos.length || session.promptRemindersOff === true || !schedule.enabled) return;
      seen[key] = true;
      infos.sort(function (a, b) { return a.createdAt - b.createdAt; });
      var ageMs = Math.max(0, t - infos[0].createdAt);
      var state = states[key] || (states[key] = { sent: 0, live: false, sig: "" });
      var due = dueCount(ageMs, schedule);
      // The oldest prompt was answered and a newer one remains: its schedule
      // starts from its own opening.
      if (due < state.sent) state.sent = due;
      if (sendDue && due > state.sent) {
        state.sent = due;
        state.live = true;
        raise(entry, infos, ageMs, key, true);
      } else if (state.live && state.sig !== signature(infos)) {
        raise(entry, infos, ageMs, key, false);
      }
    });
    Object.keys(states).forEach(function (key) {
      if (!seen[key]) clear(key);
    });
  }

  function start() {
    if (timer) return;
    notifications.setReminderReconciler(function () { sweep(false); });
    timer = setInterval(function () { sweep(true); }, SWEEP_TICK_MS);
    // The sweep must not keep a daemon that is going away alive.
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    notifications.setReminderReconciler(null);
  }

  return { start: start, stop: stop, sweep: sweep };
}

module.exports = {
  createPromptReminders: createPromptReminders,
  resolveSchedule: resolveSchedule,
  dueCount: dueCount,
  SWEEP_TICK_MS: SWEEP_TICK_MS,
  describe: describe,
};
