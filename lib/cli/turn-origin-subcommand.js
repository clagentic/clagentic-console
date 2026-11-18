// lib/cli/turn-origin-subcommand.js
//
// `clagentic-console turn-origin`: a hook running inside a session pipes its own
// hook input (JSON) to this verb on stdin; the verb asks the running daemon how
// the turn with that prompt was started and prints one word on stdout: user,
// schedule_wakeup, loop_wakeup, system or unknown. It only reads.
//
// Exit codes (documented in docs/guides/AGENT-GUIDE.md):
//   0   an answer was given, unknown included
//   1   the input is not usable (not JSON, not an object, an unknown option)
//   69  not available: Clagentic: Console is not running, or did not answer.
//       Distinct from the session verbs' codes (0, 1, 3, 4).

var fs = require("fs");

var { loadConfig, socketPath, isDaemonAliveAsync } = require("../config");
var { sendIPCCommand } = require("../ipc");
var senderRef = require("../sender-ref");
var agentUsage = require("./agent-usage");

var IPC_TIMEOUT_MS = 5000;

var EXIT = Object.freeze({ OK: 0, FAILED: 1, NOT_AVAILABLE: 69 });

// The daemon is asked with the session named by the verb's own environment when
// the console set it there (every session process it starts), else by the
// vendor session id in the hook input.
function buildRequest(input, env) {
  var request = { cmd: "get_turn_origin" };
  if (typeof input.prompt === "string") request.prompt = input.prompt;
  var ref = senderRef.fromEnv(env);
  if (ref) {
    request.project = ref.project;
    request.sessionId = ref.sessionId;
  } else if (typeof input.session_id === "string" && input.session_id) {
    request.cliSessionId = input.session_id;
  }
  return request;
}

// Returns { input } or { error }.
function parseHookInput(text) {
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: "the hook input on stdin is not JSON: " + err.message };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "the hook input on stdin must be a JSON object" };
  }
  return { input: parsed };
}

// Runs the verb. Resolves { code, stdout, stderr }; the caller prints. deps is
// for tests: readStdin(), isDaemonAlive(), sendIPC(request), env.
async function turnOrigin(args, deps) {
  deps = deps || {};
  if (agentUsage.wantsHelp(args, [])) {
    return { code: EXIT.OK, stdout: agentUsage.helpText("turn-origin"), stderr: "" };
  }
  if (args.length > 0) {
    return { code: EXIT.FAILED, stdout: "", stderr: "Unknown option for turn-origin: " + args[0] + "\n" + agentUsage.usageLine("turn-origin") + "\n" };
  }
  var readStdin = deps.readStdin || function () { return fs.readFileSync(0, "utf8"); };
  var text;
  try {
    text = readStdin();
  } catch (err) {
    return { code: EXIT.FAILED, stdout: "", stderr: "could not read the hook input on stdin: " + err.message + "\n" + agentUsage.usageLine("turn-origin") + "\n" };
  }
  var parsed = parseHookInput(text);
  if (parsed.error) {
    return { code: EXIT.FAILED, stdout: "", stderr: parsed.error + "\n" + agentUsage.usageLine("turn-origin") + "\n" };
  }
  var request = buildRequest(parsed.input, deps.env || process.env);

  var isAlive = deps.isDaemonAlive || function () { return isDaemonAliveAsync(loadConfig()); };
  var send = deps.sendIPC || function (req) { return sendIPCCommand(socketPath(), req, IPC_TIMEOUT_MS); };
  var res;
  try {
    if (!(await isAlive())) return notAvailable("Clagentic: Console is not running");
    res = await send(request);
  } catch (err) {
    return notAvailable("Clagentic: Console did not answer: " + (err && err.message ? err.message : String(err)));
  }
  if (!res || res.ok !== true || typeof res.origin !== "string") {
    return notAvailable("Clagentic: Console did not answer" + (res && res.error ? ": " + res.error : ""));
  }
  return { code: EXIT.OK, stdout: res.origin + "\n", stderr: "" };
}

function notAvailable(message) {
  return { code: EXIT.NOT_AVAILABLE, stdout: "", stderr: message + "\n" };
}

function emit(out) {
  if (out.stdout) console.log(out.stdout.replace(/\n$/, ""));
  if (out.stderr) console.error(out.stderr.replace(/\n$/, ""));
  // Not process.exit: on a pipe it can cut the output off before it drains.
  process.exitCode = out.code;
}

function runTurnOrigin(args) {
  // Help is answered at once, before stdin or the daemon are touched.
  if (agentUsage.wantsHelp(args, [])) {
    emit({ code: EXIT.OK, stdout: agentUsage.helpText("turn-origin"), stderr: "" });
    return Promise.resolve();
  }
  return turnOrigin(args).then(emit);
}

module.exports = {
  EXIT: EXIT,
  buildRequest: buildRequest,
  parseHookInput: parseHookInput,
  turnOrigin: turnOrigin,
  runTurnOrigin: runTurnOrigin,
};
