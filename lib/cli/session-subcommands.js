// lib/cli/session-subcommands.js
//
// `clagentic-console open-session`, `send-input` and `list-sessions`: open a
// session in a project, send input to one, or list the sessions, through the
// running daemon's IPC socket. Each prints the daemon's result as JSON on stdout.
//
// Exit codes (documented in docs/guides/AGENT-GUIDE.md):
//   0  the request was acted on (opened, delivered, resumed-and-delivered, listed)
//   1  refused, error, or not-found for a request that named a session id
//   3  ambiguous: an address named several sessions; the candidates are in the JSON
//   4  not-found for a request that gave an address (--to) or --reply

var fs = require("fs");

var { loadConfig, socketPath, isDaemonAliveAsync } = require("../config");
var { sendIPCCommand } = require("../ipc");
var senderRef = require("../sender-ref");

// A resumed session starts a runtime before the call answers: longer than the
// IPC default.
var IPC_TIMEOUT_MS = 30000;

var EXIT = Object.freeze({ OK: 0, FAILED: 1, AMBIGUOUS: 3, NOT_FOUND_BY_ADDRESS: 4 });

var FLAGS = {
  "--project": "projectSlug",
  "--session": "sessionId",
  "--to": "to",
  "--prompt": "prompt",
  "--vendor": "vendor",
  "--agent": "agentName",
  "--name": "sessionName",
  "--state": "state",
  "--visibility": "sessionVisibility",
  "--initiator": "initiator",
  "--context-note": "contextNote",
  "--from": "from",
  "--from-session": "fromSession",
};

// Kept apart from FLAGS because the parser reads a value after every FLAGS
// entry; a flag listed there would swallow the next argument.
var SWITCHES = {
  "--reply": "reply",
};

var USAGE = {
  "open-session": "Usage: clagentic-console open-session (--project <slug> | --to <address>) --prompt <text|-> [--vendor <id>] [--agent <name>] [--name <session-name>] [--visibility shared|private] [--initiator <kind>] [--context-note <text>] [--from <name>] [--from-session <id>]",
  "send-input": "Usage: clagentic-console send-input (--project <slug> --session <id> | --to <address> | --reply) --prompt <text|-> [--initiator <kind>] [--context-note <text>] [--from <name>] [--from-session <id>]",
  "list-sessions": "Usage: clagentic-console list-sessions [--project <slug>] [--agent <name>] [--vendor <id>] [--state live|idle|reaped|any]",
};

var ALLOWED = {
  "open-session": ["projectSlug", "to", "prompt", "vendor", "agentName", "sessionName", "sessionVisibility", "initiator", "contextNote", "from", "fromSession"],
  "send-input": ["projectSlug", "sessionId", "to", "reply", "prompt", "initiator", "contextNote", "from", "fromSession"],
  "list-sessions": ["projectSlug", "agentName", "vendor", "state"],
};

var REQUIRED = {
  "open-session": ["prompt"],
  "send-input": ["prompt"],
  "list-sessions": [],
};

var TARGET_HINT = {
  "open-session": "--project, or --to",
  "send-input": "--session (with --project), or --to, or --reply",
};

var IPC_COMMAND = {
  "open-session": "open_session",
  "send-input": "send_session_input",
  "list-sessions": "list_sessions",
};

function flagOf(key) {
  var all = Object.keys(FLAGS).concat(Object.keys(SWITCHES));
  return all.filter(function (f) { return FLAGS[f] === key || SWITCHES[f] === key; })[0];
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Checks how the target is named: a project (and for send-input a session id),
// or an address (--to, which may be given beside the project it names), or for
// send-input --reply. One way only. Returns an error string or null.
function checkTarget(verb, request) {
  if (!TARGET_HINT[verb]) return null;
  var conflict = "Give the target one way only: " + TARGET_HINT[verb];
  var given = function (k) { return request[k] !== undefined; };
  if (given("to")) return given("sessionId") || given("reply") ? conflict : null;
  if (given("reply")) return given("projectSlug") || given("sessionId") ? conflict : null;
  if (!given("projectSlug") && !given("sessionId")) return "Missing the target: " + TARGET_HINT[verb];
  if (!given("projectSlug")) return "Missing required option --project";
  if (verb === "send-input" && !given("sessionId")) return "Missing required option --session";
  return null;
}

// Parses the arguments after the verb. Returns { request } or { error }.
// Pure: reading a "-" prompt from stdin is the handler's job.
function parseSessionArgs(verb, args) {
  var allowed = ALLOWED[verb];
  var request = {};
  for (var i = 0; i < args.length; i++) {
    if (has(SWITCHES, args[i])) {
      var switchKey = SWITCHES[args[i]];
      if (allowed.indexOf(switchKey) === -1) return { error: "Unknown option for " + verb + ": " + args[i] };
      request[switchKey] = true;
      continue;
    }
    var key = has(FLAGS, args[i]) ? FLAGS[args[i]] : null;
    if (!key || allowed.indexOf(key) === -1) return { error: "Unknown option for " + verb + ": " + args[i] };
    if (i + 1 >= args.length) return { error: "Missing value for " + args[i] };
    request[key] = args[++i];
  }
  var required = REQUIRED[verb];
  for (var r = 0; r < required.length; r++) {
    if (!request[required[r]]) return { error: "Missing required option " + flagOf(required[r]) };
  }
  var targetError = checkTarget(verb, request);
  if (targetError) return { error: targetError };
  return { request: request };
}

// The IPC layer reports its own failures (timeout, refused connection) as
// { ok: false, error }; give them the same result shape as the daemon's.
function normalizeResponse(res) {
  if (res && typeof res === "object" && res.result) return res;
  var reason = res && res.error ? String(res.error) : "unexpected response from the daemon";
  return { ok: false, result: "error", reason: reason };
}

// Called from inside a console session, the caller's environment holds the
// console's reference to that session (lib/sender-ref.js). It is passed to the
// daemon automatically, no flag; outside a console session there is none.
function withSenderRef(request, env) {
  var ref = senderRef.fromEnv(env);
  if (ref) {
    request.senderProject = ref.project;
    request.senderSessionId = ref.sessionId;
  }
  return request;
}

// The process exit code for a result. request says how the target was named: an
// address or a reply is told apart from an id so a script can branch on it.
function exitCodeFor(res, request) {
  if (res && res.ok) return EXIT.OK;
  if (res && res.result === "ambiguous") return EXIT.AMBIGUOUS;
  if (res && res.result === "not-found" && request && (request.to !== undefined || request.reply)) {
    return EXIT.NOT_FOUND_BY_ADDRESS;
  }
  return EXIT.FAILED;
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
  if (verb !== "list-sessions") withSenderRef(request, process.env);

  requestDaemon(request).then(function (res) {
    console.log(JSON.stringify(res, null, 2));
    // Not process.exit: on a pipe it can cut the JSON off before stdout drains.
    process.exitCode = exitCodeFor(res, request);
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
  withSenderRef: withSenderRef,
  exitCodeFor: exitCodeFor,
  runSessionVerb: runSessionVerb,
  EXIT: EXIT,
  SESSION_VERBS: Object.keys(IPC_COMMAND),
};
