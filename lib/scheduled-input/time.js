// time.js - the time inputs of a scheduled input: a duration ("10m", "1h30m"),
// a local clock time ("20:01") and a local date-time ("2026-03-01T20:01").
// Pure: every function takes the current time as an argument.
//
// The browser client carries a small mirror of resolveClockTime
// (lib/public/modules/schedule-time.js) because it cannot load this CommonJS
// file; test/scheduled-input-time.test.js feeds both the same cases.

var UNIT_MS = Object.freeze({ s: 1000, m: 60000, h: 3600000, d: 86400000 });

var DURATION_RE = /^(?:\d+[smhd])+$/;
var DURATION_PART_RE = /(\d+)([smhd])/g;
var CLOCK_RE = /^(\d{1,2}):(\d{2})$/;
var DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/;

// A bare number is minutes, the unit the person's own field uses.
// Returns { ms } or { error }.
function parseDuration(raw) {
  var text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (/^\d+$/.test(text)) text += "m";
  if (!DURATION_RE.test(text)) {
    return { error: "not a duration: " + JSON.stringify(String(raw).slice(0, 32)) + " (use for example 90, 10m, 2h, 1h30m)" };
  }
  var total = 0;
  var part;
  DURATION_PART_RE.lastIndex = 0;
  while ((part = DURATION_PART_RE.exec(text)) !== null) {
    total += parseInt(part[1], 10) * UNIT_MS[part[2]];
  }
  if (!Number.isSafeInteger(total) || total <= 0) return { error: "a duration must be longer than zero" };
  return { ms: total };
}

function validClock(hours, minutes) {
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

// A local clock time resolves to its next occurrence strictly after `now`: a
// time that has passed today means tomorrow. A full local date-time is taken as
// given and must lie in the future. Returns { ms, tomorrow } or { error }.
function resolveClockTime(raw, now) {
  var text = typeof raw === "string" ? raw.trim() : "";
  var clock = CLOCK_RE.exec(text);
  if (clock) {
    var h = parseInt(clock[1], 10);
    var m = parseInt(clock[2], 10);
    if (!validClock(h, m)) return { error: "not a time of day: " + JSON.stringify(text) + " (use HH:MM, 00:00 to 23:59)" };
    var candidate = new Date(now);
    candidate.setHours(h, m, 0, 0);
    var tomorrow = false;
    if (candidate.getTime() <= now) {
      // setDate keeps the wall-clock time across a daylight-saving change.
      candidate.setDate(candidate.getDate() + 1);
      tomorrow = true;
    }
    return { ms: candidate.getTime(), tomorrow: tomorrow };
  }
  var full = DATE_TIME_RE.exec(text);
  if (full) {
    var when = new Date(parseInt(full[1], 10), parseInt(full[2], 10) - 1, parseInt(full[3], 10), parseInt(full[4], 10), parseInt(full[5], 10), 0, 0);
    var sameDay = when.getFullYear() === parseInt(full[1], 10) && when.getMonth() === parseInt(full[2], 10) - 1
      && when.getDate() === parseInt(full[3], 10) && validClock(when.getHours(), when.getMinutes());
    if (!sameDay) return { error: "not a date and time: " + JSON.stringify(text) };
    if (when.getTime() <= now) return { error: "that date and time has already passed: " + JSON.stringify(text) };
    return { ms: when.getTime(), tomorrow: false };
  }
  return { error: "not a time: " + JSON.stringify(text.slice(0, 32)) + " (use HH:MM, or YYYY-MM-DDTHH:MM, local time)" };
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

// "2026-03-01 20:01" in the host's local time: the unambiguous absolute form
// the CLI prints beside every resolved time.
function formatLocal(ms) {
  var d = new Date(ms);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

module.exports = {
  parseDuration: parseDuration,
  resolveClockTime: resolveClockTime,
  formatLocal: formatLocal,
};
