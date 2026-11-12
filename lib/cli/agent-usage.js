// lib/cli/agent-usage.js
//
// The one source of the usage text of the agent verbs: open-session, send-input,
// end-session, answer-prompt, list-sessions, list-outbound and the three
// schedule-input subcommands. The verbs' own -h/--help, their error output and
// the top-level `clagentic-console --help` all read it, so a flag is added in one
// place.

var VERB_ORDER = Object.freeze([
  "open-session",
  "send-input",
  "end-session",
  "answer-prompt",
  "list-sessions",
  "list-outbound",
  "schedule-input create",
  "schedule-input list",
  "schedule-input delete",
]);

// usage: the call shape. summary: what it does, one sentence, no names.
var ENTRIES = {
  "open-session": {
    usage: "clagentic-console open-session (--project <slug> | --to <address>) --prompt <text|-> [--vendor <id>] [--agent <name>] [--name <session-name>] [--visibility shared|private] [--permission-mode <mode>] [--settings <path>] [--initiator <kind>] [--context-note <text>] [--from <name>] [--from-session <id>]",
    summary: "Open a session and run a first prompt (prints JSON)",
  },
  "send-input": {
    usage: "clagentic-console send-input (--project <slug> --session <id> | --to <address> | --reply) --prompt <text|-> [--initiator <kind>] [--context-note <text>] [--from <name>] [--from-session <id>]",
    summary: "Send input to a session, resuming it if needed (prints JSON; exit 3 ambiguous, 4 not found by address)",
  },
  "end-session": {
    usage: "clagentic-console end-session (--project <slug> --session <id> | --to <address>) [--from <name>] [--from-session <id>] [--reason <text>]",
    summary: "Stand one live session down, even one blocked on a permission prompt; history is kept and the session resumes by id (prints JSON; exit 3 ambiguous, 4 not found by address)",
  },
  "answer-prompt": {
    usage: "clagentic-console answer-prompt (--project <slug> --session <id> | --to <address>) --request <id> --decision <allow|deny|allow_always|text> [--from <name>] [--from-session <id>]",
    summary: "Answer one pending prompt of a live session, as the browser would (prints JSON; exit 3 ambiguous, 4 not found by address)",
  },
  "list-sessions": {
    usage: "clagentic-console list-sessions [--project <slug>] [--agent <name>] [--vendor <id>] [--state <live|idle|reaped|any>[,...]] [--limit <n>] [--verbose]",
    summary: "List the console's sessions, newest first: live and idle ones unless --state says otherwise (--state any lists every session); one compact row each, or the full record with --verbose (prints JSON)",
  },
  "list-outbound": {
    usage: "clagentic-console list-outbound --session <vendor-session-id> [--project <slug>] [--since <dur>] [--kind sent|opens] [--verbose]",
    summary: "List what a session (by vendor session id, see list-sessions) sent out with send-input and open-session: target, prompt, time, initiator; compact rows, or the full record with --verbose (prints JSON; read-only; kept 30 days by default)",
  },
  "schedule-input create": {
    usage: "clagentic-console schedule-input create --session <id> [--project <slug>] (--in <dur> | --at <time> | --every <dur> (--until <time> | --count <n>)) (--prompt <text|-> | --prompt-file <path>)",
    summary: "Send text into a session later, once or on a repeat with an end (prints JSON)",
  },
  "schedule-input list": {
    usage: "clagentic-console schedule-input list [--session <id>] [--project <slug>] [--state armed|done|ended|any] [--verbose]",
    summary: "List scheduled input, from the browser or the CLI; compact rows, or the full record with --verbose (prints JSON)",
  },
  "schedule-input delete": {
    usage: "clagentic-console schedule-input delete --id <id> [--project <slug>]",
    summary: "Cancel a scheduled input",
  },
};

// Notes for the verbs that take a duration, a time or an address.
var NOTES = Object.freeze([
  "<dur> is minutes or parts like 90, 10m, 1h30m; <time> is a local HH:MM (a past one means tomorrow)",
  "<address> is <agent>@<project>, <vendor>@<project> (a plain session) or @<project>, each with an optional /<session-name>",
  "Several matches resolve live over idle over reaped; /<session-name> names one session exactly",
]);

function entryFor(key) {
  return Object.prototype.hasOwnProperty.call(ENTRIES, key) ? ENTRIES[key] : null;
}

// "Usage: clagentic-console ..." for a verb or "schedule-input <sub>".
function usageLine(key) {
  var e = entryFor(key);
  if (!e) throw new Error("no usage text for " + String(key));
  return "Usage: " + e.usage;
}

// What `<verb> --help` prints: the call shape, then what it does.
function helpText(key) {
  return usageLine(key) + "\n\n" + entryFor(key).summary + "\n";
}

// What `schedule-input --help` prints: the three call shapes.
function scheduleHelpText() {
  var lines = ["Usage: clagentic-console schedule-input (create | list | delete) ...", ""];
  VERB_ORDER.filter(function (k) { return k.indexOf("schedule-input ") === 0; }).forEach(function (k) {
    lines.push("  " + ENTRIES[k].usage);
    lines.push("      " + ENTRIES[k].summary);
  });
  lines.push("");
  lines.push("  " + NOTES[0]);
  return lines.join("\n") + "\n";
}

// The agent-verb lines of the top-level --help, in the same shape as its other
// command lines.
function topLevelLines() {
  var lines = [];
  VERB_ORDER.forEach(function (key) {
    lines.push("       " + ENTRIES[key].usage + "  " + ENTRIES[key].summary);
    // The notes follow the last schedule-input line, as they always have.
    if (key === "schedule-input delete") NOTES.forEach(function (n) { lines.push("         " + n); });
  });
  return lines;
}

// Whether args ask for help. A value that follows a flag taking one (a prompt
// that reads "--help") is text, not a request. valueFlags: the flags that take a
// value.
function wantsHelp(args, valueFlags) {
  for (var i = 0; i < args.length; i++) {
    if (args[i] === "-h" || args[i] === "--help") return true;
    if (valueFlags.indexOf(args[i]) !== -1) i++;
  }
  return false;
}

module.exports = {
  VERB_ORDER: VERB_ORDER,
  usageLine: usageLine,
  helpText: helpText,
  scheduleHelpText: scheduleHelpText,
  topLevelLines: topLevelLines,
  wantsHelp: wantsHelp,
};
