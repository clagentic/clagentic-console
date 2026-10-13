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

// The IPC layer reports its own failures (timeout, refused connection) as
// { ok: false, error }; give them the same result shape as the daemon's.
function normalizeResponse(res) {
  if (res && typeof res === "object" && res.result) return res;
  var reason = res && res.error ? String(res.error) : "unexpected response from the daemon";
  return { ok: false, result: "error", reason: reason };
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

  requestDaemon(request).then(function (res) {
    console.log(JSON.stringify(res, null, 2));
    process.exit(res && res.ok ? 0 : 1);
  });
}

// Always resolves to a result object: an IPC failure of any kind (a rejected
// promise included) becomes { ok: false, result: "error" }. deps is for tests.
function requestDaemon(request, deps) {
  deps = deps || {};
  var isAlive = deps.isDaemonAlive || function () { return isDaemonAliveAsync(loadConfig()); };
  var send = deps.sendIPC || function (req) { return sendIPCCommand(socketPath(), req, IPC_TIMEOUT_MS); };
  return Promise.resolve().then(isAlive).then(function (alive) {
    if (!alive) return { ok: false, result: "error", reason: "no running daemon" };
    return send(request).then(normalizeResponse);
  }).catch(function (err) {
    return { ok: false, result: "error", reason: "daemon request failed: " + (err && err.message ? err.message : String(err)) };
  });
}

module.exports = {
  requestDaemon: requestDaemon,
  parseSessionArgs: parseSessionArgs,
  runSessionVerb: runSessionVerb,
  SESSION_VERBS: Object.keys(IPC_COMMAND),
};
