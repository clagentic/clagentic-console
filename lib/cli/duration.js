// lib/cli/duration.js - the duration a CLI flag takes ("10m", "1h30m", "90").
// Shared by schedule-input (--in, --every) and list-outbound (--since).

var UNIT_MS = Object.freeze({ s: 1000, m: 60000, h: 3600000, d: 86400000 });

var DURATION_RE = /^(?:\d+[smhd])+$/;
var DURATION_PART_RE = /(\d+)([smhd])/g;

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

module.exports = { parseDuration: parseDuration };
