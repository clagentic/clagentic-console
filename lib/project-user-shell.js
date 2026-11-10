"use strict";

// The server side of the ! command line: a `shell` request runs a command the
// person typed, answered with `shell_result`. This is human input, so its
// refusals bound what a person may type; none of it is offered to an agent.
//
// A request is checked in this order and the first check that applies decides:
//   1. the ! setting is off                 -> refused, reason "disabled"
//      (an empty command is refused here too, reason "empty")
//   2. OS-user isolation is on              -> refused, reason "os_users"
//   3. the session is in plan mode          -> refused, reason "plan"
//      (a user without the terminal permission is refused, reason "no_terminal")
//   4. a turn or a ! command is running     -> refused, reason "busy"
//   5. the session has no live query        -> refused, reason "no_query"
//   6. the adapter lacks runUserShellCommand -> refused, reason "unsupported"
//   7. the permission gate, as a Bash tool call (sdk.handleCanUseTool, never
//      checkToolWhitelist alone), so every mode and rule decides as it does for
//      Bash
// Every outcome, a refusal included, is recorded in the session history and
// sent to the session's clients as `shell_result`.
//
// The server holds no chat: a chat send during a command takes the path it
// takes during a busy turn (project-user-message.js).
//
// ctx fields: slug, cwd, osUsers, sm, sdk (handleCanUseTool), sendTo,
//   getSessionForWs, usersModule, projectAccess, opts (onGetUserShellSettings,
//   onSetUserShellSettings, broadcastAll, onProcessingChanged)

var crypto = require("crypto");
var userShellSettings = require("./user-shell-settings");
var { isServerAdmin } = require("./project-permission-settings");
var { bumpLastActivity } = require("./activity-clock");

var MAX_REQUEST_ID_CHARS = 64;
// A long command must not let the idle reaper end its session; the reaper's
// limit is 30 minutes, so a minute is ample.
var ACTIVITY_TOUCH_MS = 60 * 1000;

// Reason codes are the wire contract; the text is what a person reads.
var REASONS = {
  disabled: { code: "disabled", message: "The ! command line is turned off on this server." },
  empty: { code: "empty", message: "Type a command after !." },
  osUsers: { code: "os_users", message: "The ! command line is off while OS-user isolation is on: the console cannot yet run a command as the session owner's own account, and it never runs one as the daemon's account." },
  plan: { code: "plan", message: "The ! command line is not available in plan mode, which does not run commands. Leave plan mode to use it." },
  noTerminal: { code: "no_terminal", message: "Your account is not allowed to run shell commands." },
  busy: { code: "busy", message: "The session is busy: a turn or another command is running. Stop it or wait for it to end." },
  noQuery: { code: "no_query", message: "This session has no live agent process to record the command in yet. Send a message first (the process starts with it and ends after a long idle time), then use !." },
  unsupported: { code: "unsupported", message: "This session's agent cannot run a command typed with !." },
  denied: { code: "denied", message: "The command was not approved, so it did not run." },
  gone: { code: "gone", message: "The session's agent ended while the command waited for approval, so it did not run." },
};

function attachUserShell(ctx) {
  var opts = ctx.opts || {};
  // One entry per session with a request in flight: { requestId, ac, busy }.
  var running = new Map();

  // A context built without the daemon's callback (a bare harness) runs with
  // the defaults.
  function currentSettings() {
    return typeof opts.onGetUserShellSettings === "function"
      ? opts.onGetUserShellSettings()
      : userShellSettings.readUserShellSettings(null);
  }

  function requestIdOf(msg) {
    return typeof msg.requestId === "string" && msg.requestId && msg.requestId.length <= MAX_REQUEST_ID_CHARS
      ? msg.requestId : crypto.randomUUID();
  }

  function entryFor(requestId, command, fields) {
    return Object.assign({
      type: "shell_result",
      requestId: requestId,
      command: command,
      exitCode: null,
      durationMs: 0,
      output: "",
      truncated: false,
      timedOut: false,
      interrupted: false,
    }, fields);
  }

  function refusal(requestId, command, reason) {
    return entryFor(requestId, command, { refused: true, reason: reason.code, message: reason.message });
  }

  function planMode(session) {
    return (session.permissionMode || ctx.sm.currentPermissionMode) === "plan";
  }

  // Records the outcome and tells every client viewing the session. The busy
  // state ends here whatever happens to the send or the record, so no exit path
  // leaves the session stuck busy.
  function conclude(session, entry) {
    var run = running.get(session.localId);
    running.delete(session.localId);
    bumpLastActivity(session, "user-shell", ctx.slug);
    try {
      ctx.sm.sendAndRecord(session, entry);
    } catch (err) {
      console.error("[project-user-shell] could not record the result (slug=" + ctx.slug + "):", (err && err.message) || err);
    } finally {
      if (run && run.busy) clearBusy(session);
    }
  }

  function processingChanged() {
    if (typeof opts.onProcessingChanged === "function") opts.onProcessingChanged();
  }

  // From approval until the result is recorded the session is busy, the same
  // isProcessing state a model turn uses.
  function markBusy(session, run) {
    run.busy = true;
    session.isProcessing = true;
    processingChanged();
  }

  function clearBusy(session) {
    session.isProcessing = false;
    processingChanged();
  }

  function runLine(ws, msg) {
    var session = ctx.getSessionForWs(ws);
    if (!session) {
      console.error("[project-user-shell] Dropping shell request: no session bound to this websocket (slug=" + ctx.slug + ")");
      ctx.sendTo(ws, { type: "error", text: "Clagentic: Console couldn't find your session — try reloading." });
      return true;
    }

    // Only leading whitespace is dropped: the rest is the command as typed, so
    // a trailing escaped space is part of it.
    var typed = typeof msg.command === "string" ? msg.command : "";
    var command = typed.replace(/^\s+/, "");
    var requestId = requestIdOf(msg);
    var settings = currentSettings();

    function refuse(reason) {
      ctx.sm.sendAndRecord(session, refusal(requestId, command, reason));
      return true;
    }

    if (!settings.enabled) return refuse(REASONS.disabled);
    if (!command.trim()) return refuse(REASONS.empty);
    // The daemon's own account is never used on a user's behalf, and no
    // run-as-user helper exists yet.
    if (ctx.osUsers) return refuse(REASONS.osUsers);
    // Plan mode does not run commands, and the tool-call path does not check it.
    if (planMode(session)) return refuse(REASONS.plan);
    if (ws._clagenticUser && ctx.usersModule) {
      var perms = ctx.usersModule.getEffectivePermissions(ws._clagenticUser, ctx.osUsers);
      if (!perms.terminal) return refuse(REASONS.noTerminal);
    }
    if (running.has(session.localId) || session.isProcessing) return refuse(REASONS.busy);
    var handle = session.queryInstance;
    if (!handle) return refuse(REASONS.noQuery);
    if (typeof handle.runUserShellCommand !== "function") return refuse(REASONS.unsupported);

    // Registered before the gate asks, so a second request during the approval
    // is refused as busy.
    var ac = new AbortController();
    var run = { requestId: requestId, ac: ac, busy: false };
    running.set(session.localId, run);

    var asked;
    try {
      asked = Promise.resolve(ctx.sdk.handleCanUseTool(session, "Bash", { command: command }, {
        toolUseID: "user-shell-" + requestId,
        signal: ac.signal,
        decisionReason: "Typed with !",
      }));
    } catch (err) {
      asked = Promise.reject(err);
    }
    asked.then(function (decision) {
      if (ac.signal.aborted) return conclude(session, entryFor(requestId, command, { interrupted: true }));
      if (!decision || decision.behavior !== "allow") {
        return conclude(session, entryFor(requestId, command, {
          denied: true,
          reason: REASONS.denied.code,
          message: (decision && decision.message) || REASONS.denied.message,
        }));
      }
      return execute(session, run, command, settings);
    }, function (err) {
      conclude(session, entryFor(requestId, command, ac.signal.aborted
        ? { interrupted: true }
        : { denied: true, reason: REASONS.denied.code, message: "The approval ended before it was answered: " + ((err && err.message) || err) }));
    });
    return true;
  }

  function execute(session, run, command, settings) {
    var requestId = run.requestId;
    // The query may have ended while the approval waited.
    var handle = session.queryInstance;
    if (!handle || typeof handle.runUserShellCommand !== "function") {
      return conclude(session, entryFor(requestId, command, { error: true, reason: REASONS.gone.code, output: REASONS.gone.message }));
    }
    // A chat send during the approval may have started a turn. Two writers on one
    // handle would interleave, so the command is refused and the turn's own busy
    // state is left alone.
    if (session.isProcessing) return conclude(session, refusal(requestId, command, REASONS.busy));

    markBusy(session, run);
    var touch = setInterval(function () { bumpLastActivity(session, "user-shell", ctx.slug); }, ACTIVITY_TOUCH_MS);
    if (typeof touch.unref === "function") touch.unref();
    var started;
    try {
      started = handle.runUserShellCommand(command, session.cwd || ctx.cwd, settings.timeoutMs, settings.maxOutputBytes, { signal: run.ac.signal });
    } catch (err) {
      started = Promise.reject(err);
    }
    return Promise.resolve(started).then(function (result) {
      clearInterval(touch);
      return conclude(session, entryFor(requestId, command, {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        output: result.output,
        truncated: !!result.truncated,
        timedOut: !!result.timedOut,
        interrupted: !!result.interrupted,
      }));
    }, function (err) {
      clearInterval(touch);
      console.error("[project-user-shell] command failed to run (slug=" + ctx.slug + "):", (err && err.message) || err);
      return conclude(session, entryFor(requestId, command, { error: true, output: (err && err.message) || String(err) }));
    });
  }

  // Stop cancels a pending approval prompt and aborts a running command.
  function interrupt(ws) {
    var session = ctx.getSessionForWs(ws);
    var run = session && running.get(session.localId);
    if (run) run.ac.abort();
  }

  function changeSettings(ws, msg) {
    if (!isServerAdmin(ctx.projectAccess, ws)) {
      console.warn("[project-user-shell] refused set_user_shell_settings in " + ctx.slug + ": caller is not an admin");
      ctx.sendTo(ws, { type: "error", text: "Only admins can change the ! command line settings." });
      return true;
    }
    var picked = userShellSettings.pickSettingChanges(msg);
    if (picked.rejected.length > 0) {
      ctx.sendTo(ws, { type: "error", text: "Unknown or invalid ! command line setting: " + picked.rejected.join(", ") });
      return true;
    }
    if (Object.keys(picked.values).length === 0) return true;
    if (typeof opts.onSetUserShellSettings !== "function" || typeof opts.onGetUserShellSettings !== "function") {
      ctx.sendTo(ws, { type: "error", text: "The server cannot store the ! command line settings." });
      return true;
    }
    opts.onSetUserShellSettings(picked.values);
    var announce = typeof opts.broadcastAll === "function" ? opts.broadcastAll : ctx.send;
    announce(userShellSettings.settingsMessage(opts.onGetUserShellSettings()));
    return true;
  }

  /** Returns true when msg was handled here. */
  function handleUserShellMessage(ws, msg) {
    if (msg.type === "shell") return runLine(ws, msg);
    if (msg.type === "set_user_shell_settings") return changeSettings(ws, msg);
    // Stop is also the sessions handler's: it ends a running turn.
    if (msg.type === "stop") interrupt(ws);
    return false;
  }

  return { handleUserShellMessage: handleUserShellMessage };
}

module.exports = { attachUserShell: attachUserShell, REASONS: REASONS };
