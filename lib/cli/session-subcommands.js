// lib/cli/session-subcommands.js
//
// `clagentic-console open-session` and `clagentic-console send-input`: open a
// session in a project, or send input to one, through the running daemon's IPC
// socket. Both print the daemon's result as JSON on stdout and exit 0 when the
// request was acted on (opened, delivered, resumed-and-delivered), 1 otherwise
// (not-found, refused, error), so a script can branch on either.

var fs = require("fs");

var { loadConfig, socketPath, isDaemonAliveAsync } = require("../config");
var { sendIPCCommand } = require("../ipc");

// An opened session can wait for its vendor-assigned id, and a resumed one
// starts a runtime: longer than the IPC default.
var IPC_TIMEOUT_MS = 30000;

var FLAGS = {
  "--project": "projectSlug",
  "--session": "sessionId",
  "--prompt": "prompt",
  "--vendor": "vendor",
  "--agent": "agentName",
  "--visibility": "sessionVisibility",
  "--initiator": "initiator",
  "--context-note": "contextNote",
};

var USAGE = {
  "open-session": "Usage: clagentic-console open-session --project <slug> --prompt <text|-> [--vendor <id>] [--agent <name>] [--visibility shared|private] [--initiator <kind>] [--context-note <text>]",
  "send-input": "Usage: clagentic-console send-input --project <slug> --session <id> --prompt <text|-> [--initiator <kind>] [--context-note <text>]",
};

var ALLOWED = {
  "open-session": ["projectSlug", "prompt", "vendor", "agentName", "sessionVisibility", "initiator", "contextNote"],
  "send-input": ["projectSlug", "sessionId", "prompt", "initiator", "contextNote"],
};

var REQUIRED = {
  "open-session": ["projectSlug", "prompt"],
  "send-input": ["projectSlug", "sessionId", "prompt"],
};

var IPC_COMMAND = {
  "open-session": "open_session",
  "send-input": "send_session_input",
};

// Parses the arguments after the verb. Returns { request } or { error }.
// Pure: reading a "-" prompt from stdin is the handler's job.
function parseSessionArgs(verb, args) {
  var allowed = ALLOWED[verb];
  var request = {};
  for (var i = 0; i < args.length; i++) {
    var key = Object.prototype.hasOwnProperty.call(FLAGS, args[i]) ? FLAGS[args[i]] : null;
    if (!key || allowed.indexOf(key) === -1) return { error: "Unknown option for " + verb + ": " + args[i] };
    if (i + 1 >= args.length) return { error: "Missing value for " + args[i] };
    request[key] = args[++i];
  }
  var required = REQUIRED[verb];
  for (var r = 0; r < required.length; r++) {
    if (!request[required[r]]) {
      var flag = Object.keys(FLAGS).filter(function (f) { return FLAGS[f] === required[r]; })[0];
      return { error: "Missing required option " + flag };
    }
  }
  return { request: request };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runSessionVerb(verb, args) {
  var parsed = parseSessionArgs(verb, args);
  if (parsed.error) {
    console.error(parsed.error);
    fail(USAGE[verb]);
    return;
  }
  var request = parsed.request;
  if (request.prompt === "-") {
    request.prompt = fs.readFileSync(0, "utf8").replace(/\n$/, "");
  }
  request.cmd = IPC_COMMAND[verb];

  isDaemonAliveAsync(loadConfig()).then(function (alive) {
    if (!alive) {
      console.log(JSON.stringify({ ok: false, result: "error", reason: "no running daemon" }, null, 2));
      process.exit(1);
      return;
    }
    sendIPCCommand(socketPath(), request, IPC_TIMEOUT_MS).then(function (res) {
      console.log(JSON.stringify(res, null, 2));
      process.exit(res && res.ok ? 0 : 1);
    });
  });
}

module.exports = {
  parseSessionArgs: parseSessionArgs,
  runSessionVerb: runSessionVerb,
  SESSION_VERBS: Object.keys(IPC_COMMAND),
};
