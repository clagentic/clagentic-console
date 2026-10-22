// schedule-time.js - the time arithmetic and wording of the schedule panel.
// DOM-free, so it can be tested under plain Node.
//
// resolveClockTime mirrors the CLI's (lib/cli/schedule-input-subcommands.js),
// which the browser cannot load; test/scheduled-input-client.test.js feeds both the
// same cases. Everything is the browser's local time zone.

var MIN_EVERY_MIN = 1;
var MAX_EVERY_MIN = 24 * 60;
var MAX_ONCE_MIN = 24 * 60;
var MAX_COUNT = 1000;

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

// A whole number of minutes from a field's text, or null.
export function parseMinutes(raw, max) {
  var text = typeof raw === "string" ? raw.trim() : String(raw == null ? "" : raw);
  if (!/^\d+$/.test(text)) return null;
  var n = parseInt(text, 10);
  return n >= 1 && n <= max ? n : null;
}

// The next occurrence, strictly after `now`, of a local HH:MM. A time that has
// passed today means tomorrow. Returns { ms, tomorrow } or { error }.
export function resolveClockTime(raw, now) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(typeof raw === "string" ? raw.trim() : "");
  if (!m) return { error: "Enter a time as HH:MM." };
  var h = parseInt(m[1], 10);
  var mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return { error: "Enter a time from 00:00 to 23:59." };
  var d = new Date(now);
  d.setHours(h, mi, 0, 0);
  var tomorrow = false;
  if (d.getTime() <= now) {
    d.setDate(d.getDate() + 1);
    tomorrow = true;
  }
  return { ms: d.getTime(), tomorrow: tomorrow };
}

export function clockText(ms) {
  var d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "today at 20:01", "tomorrow at 20:01", or "Mar 3 at 20:01" for a later day.
export function dayTimeText(ms, now) {
  var d = new Date(ms);
  var today = new Date(now);
  today.setHours(0, 0, 0, 0);
  var dayStart = new Date(ms);
  dayStart.setHours(0, 0, 0, 0);
  var days = Math.round((dayStart.getTime() - today.getTime()) / 86400000);
  var when;
  if (days === 0) when = "today";
  else if (days === 1) when = "tomorrow";
  else when = MONTHS[d.getMonth()] + " " + d.getDate();
  return when + " at " + clockText(ms);
}

export function durationText(ms) {
  var mins = Math.round(ms / 60000);
  if (mins < 60) return mins + " min";
  var hrs = Math.floor(mins / 60);
  var rem = mins % 60;
  return rem ? hrs + " h " + rem + " min" : hrs + " h";
}

// form: { mode: "once" | "repeat",
//         onceBy: "in" | "at", inMinutes, at,
//         everyMinutes, endBy: "until" | "count", until, count }
// Returns { spec, summary } or { error }. spec is what the composer arms (see
// scheduleMessageFor); summary says, before anything is armed, when it will go,
// including "tomorrow".
export function buildSchedule(form, now) {
  if (form.mode === "once") {
    if (form.onceBy === "at") {
      var at = resolveClockTime(form.at, now);
      if (at.error) return { error: at.error };
      return { spec: { kind: "once", atMs: at.ms }, summary: "Sends " + dayTimeText(at.ms, now) + "." };
    }
    var mins = parseMinutes(form.inMinutes, MAX_ONCE_MIN);
    if (mins === null) return { error: "Enter a number of minutes from 1 to " + MAX_ONCE_MIN + "." };
    return { spec: { kind: "once", delayMs: mins * 60000 }, summary: "Sends in " + durationText(mins * 60000) + ", at " + clockText(now + mins * 60000) + "." };
  }

  var every = parseMinutes(form.everyMinutes, MAX_EVERY_MIN);
  if (every === null) return { error: "Repeat every a number of minutes from " + MIN_EVERY_MIN + " to " + MAX_EVERY_MIN + " (24 hours)." };
  var everyMs = every * 60000;
  var first = "first " + dayTimeText(now + everyMs, now);
  if (form.endBy === "count") {
    var count = parseMinutes(form.count, MAX_COUNT);
    if (count === null) return { error: "Enter how many times, from 1 to " + MAX_COUNT + "." };
    return {
      spec: { kind: "recurring", everyMs: everyMs, count: count },
      summary: "Sends every " + durationText(everyMs) + ", " + count + (count === 1 ? " time" : " times") + " (" + first + ").",
    };
  }
  var until = resolveClockTime(form.until, now);
  if (until.error) return { error: until.error };
  if (until.ms < now + everyMs) {
    return { error: "That end time is before the first send (" + dayTimeText(now + everyMs, now) + "). Pick a later end or a shorter interval." };
  }
  return {
    spec: { kind: "recurring", everyMs: everyMs, untilMs: until.ms },
    summary: "Sends every " + durationText(everyMs) + " until " + dayTimeText(until.ms, now) + " (" + first + ").",
  };
}

// The websocket message the composer sends for an armed spec and the typed text.
export function scheduleMessageFor(spec, text, now) {
  if (spec.kind === "once") {
    return { type: "schedule_message", text: text, resetsAt: spec.atMs != null ? spec.atMs : now + spec.delayMs };
  }
  var msg = { type: "schedule_message", text: text, kind: "recurring", every: spec.everyMs };
  if (spec.untilMs != null) msg.until = spec.untilMs;
  else msg.count = spec.count;
  return msg;
}

function shortDuration(ms) {
  var mins = Math.round(ms / 60000);
  if (mins < 60) return mins + "m";
  var hrs = Math.floor(mins / 60);
  var rem = mins % 60;
  return rem > 0 ? hrs + "h " + rem + "m" : hrs + "h";
}

// The short text beside the clock button while a schedule is armed.
export function specLabel(spec) {
  if (spec.kind === "once") return spec.atMs != null ? "at " + clockText(spec.atMs) : shortDuration(spec.delayMs);
  return "every " + shortDuration(spec.everyMs);
}

// The longer wording of the same, for the button's tooltip.
export function specTitle(spec, now) {
  if (spec.kind === "once") {
    return spec.atMs != null ? dayTimeText(spec.atMs, now) : "in " + durationText(spec.delayMs);
  }
  var end = spec.untilMs != null ? "until " + dayTimeText(spec.untilMs, now) : spec.count + (spec.count === 1 ? " time" : " times");
  return "every " + durationText(spec.everyMs) + ", " + end;
}

// What the chat and the lists call an input: plain words, and the automatic
// resume under its own name.
export function inputLabel(input) {
  if (input.createdBy === "rate-limit") return "Automatic resume after rate limit";
  return input.kind === "recurring" ? "Scheduled repeat" : "Scheduled message";
}

// The line under a scheduled-message bubble, refreshed every second:
// "Sends at 08:30 PM (4m 12s)", and for a repeat the next time and its end.
export function countdownText(input, now) {
  var lead = "";
  if (input.createdBy === "rate-limit") lead = "Automatic resume after rate limit · ";
  else if (input.kind === "recurring") lead = "Scheduled repeat · ";
  var remaining = input.nextAt - now;
  if (remaining <= 0) return lead + "Sending...";
  var hrs = Math.floor(remaining / 3600000);
  var mins = Math.floor((remaining % 3600000) / 60000);
  var secs = Math.floor((remaining % 60000) / 1000);
  var timeStr = "";
  if (hrs > 0) timeStr += hrs + "h ";
  if (mins > 0 || hrs > 0) timeStr += mins + "m ";
  timeStr += secs + "s";
  var abs = new Date(input.nextAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  var text = lead + (input.kind === "recurring" ? "Next at " : "Sends at ") + abs + " (" + timeStr + ")";
  if (input.kind === "recurring") {
    text += " · every " + durationText(input.every);
    if (input.until != null) text += " until " + dayTimeText(input.until, now).replace(/^today at /, "");
    else if (input.count != null) text += " · " + (input.count - input.firedCount) + " of " + input.count + " left";
  }
  return text;
}

// "Scheduled repeat · every 30 min · next 19:30 · until 21:00", for the panel
// list and the bubble.
export function inputSummary(input, now) {
  var parts = [inputLabel(input)];
  if (input.kind === "recurring") {
    parts.push("every " + durationText(input.every));
    parts.push("next " + dayTimeText(input.nextAt, now).replace(/^today at /, ""));
    if (input.until != null) parts.push("until " + dayTimeText(input.until, now).replace(/^today at /, ""));
    else if (input.count != null) parts.push((input.count - input.firedCount) + " of " + input.count + " left");
  } else {
    parts.push(dayTimeText(input.nextAt, now).replace(/^today at /, ""));
  }
  return parts.join(" · ");
}
