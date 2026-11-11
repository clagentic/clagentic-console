// lib/cli/settings-subcommands.js
//
// `clagentic-console settings get <key>`, `settings set <key> <value>` and
// `settings list`: read and change server-wide settings through the running
// daemon's IPC socket. Each prints the daemon's result as JSON on stdout.
//
// <value> is parsed as JSON when it parses (10 is a number, true a boolean),
// otherwise it is taken as a string; the daemon validates it.
//
// Exit codes (documented in docs/guides/AGENT-GUIDE.md):
//   0  read, saved or listed
//   1  refused, unknown key, error, or a usage error (no daemon contact)

var { requestDaemon } = require("./session-subcommands");

var USAGE = [
  "Usage: clagentic-console settings get <key>",
  "       clagentic-console settings set <key> <value>",
  "       clagentic-console settings list",
].join("\n");

var IPC_COMMAND = { get: "settings_get", set: "settings_set", list: "settings_list" };

// The value is JSON when it parses, else the raw string.
function parseValue(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

// Returns { help: true }, { request } or { error }. Pure: no IPC.
function parseSettingsArgs(args) {
  var sub = args[0];
  if (sub === undefined) return { error: "Missing settings subcommand" };
  if (sub === "-h" || sub === "--help") return { help: true };
  if (!Object.prototype.hasOwnProperty.call(IPC_COMMAND, sub)) return { error: "Unknown settings subcommand: " + sub };
  var rest = args.slice(1);
  if (rest.indexOf("-h") !== -1 || rest.indexOf("--help") !== -1) return { help: true };
  var arity = { get: 1, set: 2, list: 0 }[sub];
  if (rest.length < arity) return { error: "Missing argument for settings " + sub };
  if (rest.length > arity) return { error: "Unexpected argument for settings " + sub + ": " + rest[arity] };
  var request = { cmd: IPC_COMMAND[sub] };
  if (sub !== "list") request.key = rest[0];
  if (sub === "set") request.value = parseValue(rest[1]);
  return { request: request };
}

function runSettingsVerb(args) {
  var parsed = parseSettingsArgs(args);
  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  if (parsed.error) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  requestDaemon(parsed.request).then(function (res) {
    console.log(JSON.stringify(res, null, 2));
    // Not process.exit: on a pipe it can cut the JSON off before stdout drains.
    process.exitCode = res && res.ok ? 0 : 1;
  });
}

module.exports = {
  parseSettingsArgs: parseSettingsArgs,
  parseValue: parseValue,
  runSettingsVerb: runSettingsVerb,
  USAGE: USAGE,
};
