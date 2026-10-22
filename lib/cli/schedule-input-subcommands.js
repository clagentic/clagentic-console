// lib/cli/schedule-input-subcommands.js
//
// `clagentic-console schedule-input create | list | delete`: schedule text to be
// sent into a console session later, once or on a repeat that always has an end,
// through the running daemon's IPC socket. The same scheduled input the clock
// button in the browser makes: a record made here shows in that list, and the
// reverse. Each verb prints the daemon's result as JSON on stdout.
//
// Flag/value pairs only, so each command shape can be allow-listed:
//
//   schedule-input create --session <id> [--project <slug>]
//        (--in <dur> | --at <time> | --every <dur> (--until <time> | --count <n>))
//        (--prompt <text|-> | --prompt-file <path>)
//   schedule-input list   [--session <id>] [--project <slug>] [--state armed|done|ended|any]
//   schedule-input delete --id <id> [--project <slug>]
//
// <dur> is a number of minutes or a run of s, m, h and d parts (90, 10m, 1h30m).
// <time> is a local HH:MM, or a local YYYY-MM-DDTHH:MM; an HH:MM already past
// today means tomorrow. The times are resolved here, in the caller's own time
// zone, and the daemon is sent absolute times.
//
// Exit codes (the same pattern as open-session and send-input):
//   0  done (scheduled, listed, deleted)
//   1  refused, error, or not found

var fs = require("fs");

var senderRef = require("../sender-ref");
var { requestDaemon, withSenderRef, EXIT } = require("./session-subcommands");

// --- The time inputs: a duration ("10m", "1h30m"), a local clock time ("20:01")
// and a local date-time ("2026-03-01T20:01"). Pure: each takes the current time
// as an argument. The browser client carries a small mirror of resolveClockTime
// (lib/public/modules/schedule-time.js) because it cannot load this CommonJS
// file; test/scheduled-input-client.test.js feeds both the same cases.

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
// printed beside every resolved time.
function formatLocal(ms) {
  var d = new Date(ms);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

var SUBCOMMANDS = Object.freeze(["create", "list", "delete"]);

var FLAGS = {
  "--session": "sessionId",
  "--project": "projectSlug",
  "--in": "in",
  "--at": "at",
  "--every": "every",
  "--until": "until",
  "--count": "count",
  "--prompt": "prompt",
  "--prompt-file": "promptFile",
  "--id": "id",
  "--state": "state",
};

var ALLOWED = {
  create: ["sessionId", "projectSlug", "in", "at", "every", "until", "count", "prompt", "promptFile"],
  list: ["sessionId", "projectSlug", "state"],
  delete: ["id", "projectSlug"],
};

var USAGE = {
  create: "Usage: clagentic-console schedule-input create --session <id> [--project <slug>] (--in <dur> | --at <time> | --every <dur> (--until <time> | --count <n>)) (--prompt <text|-> | --prompt-file <path>)",
  list: "Usage: clagentic-console schedule-input list [--session <id>] [--project <slug>] [--state armed|done|ended|any]",
  delete: "Usage: clagentic-console schedule-input delete --id <id> [--project <slug>]",
};

var IPC_COMMAND = {
  create: "schedule_input_create",
  list: "schedule_input_list",
  delete: "schedule_input_delete",
};

var COUNT_RE = /^\d+$/;

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function given(parsed, key) {
  return parsed[key] !== undefined;
}

// The timing flags of create, resolved against `now` (ms). Returns
// { fields, resolved } or { error }: fields go to the daemon, resolved says what
// the times came to (absolute, local, and whether a clock time rolled to
// tomorrow).
function resolveTiming(parsed, now) {
  var shapes = ["in", "at", "every"].filter(function (k) { return given(parsed, k); });
  if (shapes.length !== 1) return { error: "Give exactly one of --in, --at or --every" };
  var shape = shapes[0];
  var resolved = {};

  if (shape !== "every") {
    if (given(parsed, "until") || given(parsed, "count")) return { error: "--until and --count belong to --every" };
    if (shape === "in") {
      var dur = parseDuration(parsed.in);
      if (dur.error) return { error: "--in: " + dur.error };
      resolved.at = now + dur.ms;
    } else {
      var when = resolveClockTime(parsed.at, now);
      if (when.error) return { error: "--at: " + when.error };
      resolved.at = when.ms;
      resolved.tomorrow = when.tomorrow;
    }
    return { fields: { at: resolved.at }, resolved: { at: resolved.at, atLocal: formatLocal(resolved.at), tomorrow: !!resolved.tomorrow } };
  }

  var every = parseDuration(parsed.every);
  if (every.error) return { error: "--every: " + every.error };
  if (given(parsed, "until") === given(parsed, "count")) {
    return { error: "A repeat needs an end: give exactly one of --until or --count" };
  }
  var fields = { every: every.ms };
  var out = { every: every.ms, firstAt: now + every.ms, firstAtLocal: formatLocal(now + every.ms) };
  if (given(parsed, "until")) {
    var until = resolveClockTime(parsed.until, now);
    if (until.error) return { error: "--until: " + until.error };
    fields.until = until.ms;
    out.until = until.ms;
    out.untilLocal = formatLocal(until.ms);
    out.tomorrow = until.tomorrow;
  } else {
    if (!COUNT_RE.test(parsed.count)) return { error: "--count must be a whole number" };
    fields.count = parseInt(parsed.count, 10);
    out.count = fields.count;
  }
  return { fields: fields, resolved: out };
}

// Parses the arguments after the subcommand. Returns { request, resolved } or
// { error }. Pure: reading a "-" prompt from stdin or a --prompt-file is the
// handler's job. env supplies the calling session's project as the default.
function parseScheduleArgs(sub, args, now, env) {
  if (!has(ALLOWED, sub)) return { error: "Unknown schedule-input command: " + sub };
  var allowed = ALLOWED[sub];
  var parsed = {};
  for (var i = 0; i < args.length; i++) {
    var key = has(FLAGS, args[i]) ? FLAGS[args[i]] : null;
    if (!key || allowed.indexOf(key) === -1) return { error: "Unknown option for schedule-input " + sub + ": " + args[i] };
    if (i + 1 >= args.length) return { error: "Missing value for " + args[i] };
    if (given(parsed, key)) return { error: "Option given twice: " + args[i] };
    parsed[key] = args[++i];
  }

  var request = { cmd: IPC_COMMAND[sub] };
  if (given(parsed, "projectSlug")) request.projectSlug = parsed.projectSlug;

  if (sub === "delete") {
    if (!given(parsed, "id")) return { error: "Missing required option --id" };
    request.id = parsed.id;
    return { request: request };
  }

  if (sub === "list") {
    if (given(parsed, "sessionId")) request.sessionId = parsed.sessionId;
    if (given(parsed, "state")) request.state = parsed.state;
    return { request: request };
  }

  if (!given(parsed, "sessionId")) return { error: "Missing required option --session" };
  request.sessionId = parsed.sessionId;
  // The session's own project when the caller is a console session and names none.
  if (!request.projectSlug) {
    var ref = senderRef.fromEnv(env);
    if (ref) request.projectSlug = ref.project;
  }
  if (!request.projectSlug) return { error: "Missing required option --project (this shell is not inside a console session)" };
  if (given(parsed, "prompt") === given(parsed, "promptFile")) {
    return { error: "Give the text one way only: --prompt <text|-> or --prompt-file <path>" };
  }
  if (given(parsed, "prompt")) request.prompt = parsed.prompt;
  else request.promptFile = parsed.promptFile;
  var timing = resolveTiming(parsed, now);
  if (timing.error) return { error: timing.error };
  Object.assign(request, timing.fields);
  return { request: request, resolved: timing.resolved };
}

// Reads a "-" prompt from stdin and a --prompt-file from disk, as the verbs of
// session-subcommands read their prompt. Returns an error string or null.
function loadPrompt(request, readStdin, readFile) {
  if (request.promptFile !== undefined) {
    try { request.prompt = readFile(request.promptFile).replace(/\n$/, ""); }
    catch (e) { return "Cannot read --prompt-file " + request.promptFile + ": " + (e && e.message ? e.message : String(e)); }
    delete request.promptFile;
  } else if (request.prompt === "-") {
    request.prompt = readStdin().replace(/\n$/, "");
  }
  return null;
}

// Says, beside the daemon's answer, what the times came to in the caller's own
// local time, so a clock time that rolled to tomorrow is plain to see.
function withResolved(res, resolved) {
  if (res && res.ok && resolved) res.resolved = resolved;
  return res;
}

function exitCodeFor(res) {
  return res && res.ok ? EXIT.OK : EXIT.FAILED;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runScheduleInput(args) {
  var sub = args[0];
  if (SUBCOMMANDS.indexOf(sub) === -1) {
    console.error("Unknown schedule-input command: " + String(sub));
    fail("Usage: clagentic-console schedule-input (" + SUBCOMMANDS.join(" | ") + ") ...");
    return;
  }
  var parsed = parseScheduleArgs(sub, args.slice(1), Date.now(), process.env);
  if (parsed.error) {
    console.error(parsed.error);
    fail(USAGE[sub]);
    return;
  }
  var request = parsed.request;
  if (sub === "create") {
    var promptError = loadPrompt(request, function () { return fs.readFileSync(0, "utf8"); }, function (p) { return fs.readFileSync(p, "utf8"); });
    if (promptError) { fail(promptError); return; }
    withSenderRef(request, process.env);
  }
  requestDaemon(request).then(function (res) {
    console.log(JSON.stringify(withResolved(res, parsed.resolved), null, 2));
    // Not process.exit: on a pipe it can cut the JSON off before stdout drains.
    process.exitCode = exitCodeFor(res);
  });
}

module.exports = {
  parseDuration: parseDuration,
  resolveClockTime: resolveClockTime,
  formatLocal: formatLocal,
  parseScheduleArgs: parseScheduleArgs,
  loadPrompt: loadPrompt,
  withResolved: withResolved,
  exitCodeFor: exitCodeFor,
  runScheduleInput: runScheduleInput,
  USAGE: USAGE,
};
