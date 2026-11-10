"use strict";

// The WebSocket side of the composer's ! mode: a line that starts with ! is sent
// as a `shell` request, not a chat message, and answered with `shell_result`.
//
// The checks run in this order, and the first that applies decides:
//   1. the ! mode setting is off          -> the line goes on as ordinary text
//   2. OS-user isolation is on            -> refused, with the reason
//   3. the session is in plan mode        -> refused, with the reason
//   4. the permission gate, as a Bash tool call (sdk.handleCanUseTool), so
//      acceptEdits and bypass decide exactly as they do for Bash
// Between 3 and 4 sit checks that the command can run at all (the user may use
// a terminal, the agent is idle and has a live session that can take it); they
// fail before the gate so nobody is asked to approve a command that cannot run.
//
// The command itself runs through the session query's runUserShellCommand
// (lib/yoke/interface.js), which also puts it in the conversation without a
// model turn. This is an operator input: its refusals bound what a person can
// type, and none of it is offered to an agent.
//
// ctx fields: slug, cwd, osUsers, sm, sdk (handleCanUseTool), sendTo,
//   getSessionForWs, usersModule, projectAccess, opts (onGetUserShellSettings,
//   onSetUserShellSettings, broadcastAll),
//   sendAsMessage(ws, text, vendor) - hands a line on as an ordinary chat message

var crypto = require("crypto");
var userShellSettings = require("./user-shell-settings");
var { isServerAdmin } = require("./project-permission-settings");

var MAX_COMMAND_CHARS = 64 * 1024;
var MAX_REQUEST_ID_CHARS = 64;
// How often a running command marks its session as active, so the idle reaper
// (30 minutes) never ends a session out from under a long command.
var ACTIVITY_TOUCH_MS = 60 * 1000;

var REASONS = {
  empty: "Type a command after !.",
  tooLong: "That command is too long to run.",
  osUsers: "The ! command line is off while OS-user isolation is on: the console cannot yet run a command as the session owner's own account, and it never runs one as the daemon's account.",
  plan: "The ! command line is not available in plan mode, which does not run commands. Leave plan mode to use it.",
  noTerminal: "Your account is not allowed to run shell commands.",
  busy: "The agent is working. Stop it or wait for the turn to end before running a command with !.",
  running: "A command is already running in this session.",
  unsupported: "This session's agent cannot run a command typed with !.",
  noLive: "This session has no live agent process to record the command in yet. Send a message first (the process starts with it and ends after a long idle time), then use !.",
  gone: "The session's agent ended while the command waited for approval, so it did not run.",
};

function attachUserShell(ctx) {
  var opts = ctx.opts || {};
  // One entry per session with a command in flight: { requestId, ac }.
  var running = new Map();

  // The daemon answers with the settings already read; a context built without
  // one (a bare harness) runs with the defaults.
  function currentSettings() {
    return typeof opts.onGetUserShellSettings === "function"
      ? opts.onGetUserShellSettings()
      : userShellSettings.readUserShellSettings(null);
  }

  function requestIdOf(msg) {
    return typeof msg.requestId === "string" && msg.requestId && msg.requestId.length <= MAX_REQUEST_ID_CHARS
      ? msg.requestId : crypto.randomUUID();
  }

  // A refusal is for the person who asked: nothing ran and nothing is recorded.
  function refuse(ws, requestId, command, reason) {
    ctx.sendTo(ws, { type: "shell_result", requestId: requestId, command: command, refused: true, reason: reason });
    return true;
  }

  function planMode(session) {
    return (session.permissionMode || ctx.sm.currentPermissionMode) === "plan";
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

  function runLine(ws, msg) {
    var command = typeof msg.command === "string" ? msg.command.trim() : "";
    var requestId = requestIdOf(msg);
    if (!command) return refuse(ws, requestId, "", REASONS.empty);
    if (command.length > MAX_COMMAND_CHARS) return refuse(ws, requestId, command.slice(0, 200), REASONS.tooLong);

    var settings = currentSettings();
    // 1. Off: the line is what the person typed, and goes on as a message.
    if (!settings.enabled) return ctx.sendAsMessage(ws, "!" + command, msg.vendor);

    // 2. OS-user isolation: no run-as-user helper exists, and the daemon's own
    // account is never used on a user's behalf.
    if (ctx.osUsers) return refuse(ws, requestId, command, REASONS.osUsers);

    var session = ctx.getSessionForWs(ws);
    if (!session) {
      console.error("[project-user-shell] Dropping shell request: no session bound to this websocket (slug=" + ctx.slug + ")");
      ctx.sendTo(ws, { type: "error", text: "Clagentic: Console couldn't find your session — try reloading." });
      return true;
    }

    // 3. Plan mode does not run commands, and the tool-call path does not check it.
    if (planMode(session)) return refuse(ws, requestId, command, REASONS.plan);

    if (ws._clagenticUser && ctx.usersModule) {
      var perms = ctx.usersModule.getEffectivePermissions(ws._clagenticUser, ctx.osUsers);
      if (!perms.terminal) return refuse(ws, requestId, command, REASONS.noTerminal);
    }
    if (running.has(session.localId)) return refuse(ws, requestId, command, REASONS.running);
    if (session.isProcessing) return refuse(ws, requestId, command, REASONS.busy);
    var handle = session.queryInstance;
    if (!handle) return refuse(ws, requestId, command, REASONS.noLive);
    if (typeof handle.runUserShellCommand !== "function") return refuse(ws, requestId, command, REASONS.unsupported);

    // 4. The gate: this command as a Bash tool call.
    var ac = new AbortController();
    running.set(session.localId, { requestId: requestId, ac: ac });
    var asked;
    try {
      asked = Promise.resolve(ctx.sdk.handleCanUseTool(session, "Bash", { command: command }, {
        toolUseID: "user-shell-" + requestId,
        signal: ac.signal,
        decisionReason: "Typed in the composer with !",
      }));
    } catch (err) {
      asked = Promise.reject(err);
    }
    asked.then(function (decision) {
      if (ac.signal.aborted) return conclude(session, entryFor(requestId, command, { interrupted: true }));
      if (!decision || decision.behavior !== "allow") {
        return conclude(session, entryFor(requestId, command, {
          denied: true,
          reason: (decision && decision.message) || "The command was not approved, so it did not run.",
        }));
      }
      return execute(session, requestId, command, settings, ac);
    }, function (err) {
      conclude(session, entryFor(requestId, command, ac.signal.aborted
        ? { interrupted: true }
        : { denied: true, reason: "The approval ended before it was answered: " + ((err && err.message) || err) }));
    });
    return true;
  }

  function execute(session, requestId, command, settings, ac) {
    // The query may have ended while the approval waited.
    var handle = session.queryInstance;
    if (!handle || typeof handle.runUserShellCommand !== "function") {
      return conclude(session, entryFor(requestId, command, { error: true, output: REASONS.gone }));
    }
    // A turn may have started while the approval waited; two writers on one
    // handle would interleave, so the command does not run.
    if (session.isProcessing) {
      return conclude(session, entryFor(requestId, command, { denied: true, reason: REASONS.busy }));
    }
    markBusy(session, requestId);
    var touch = setInterval(function () { session.lastActivityAt = Date.now(); }, ACTIVITY_TOUCH_MS);
    if (typeof touch.unref === "function") touch.unref();
    session.lastActivityAt = Date.now();
    var started;
    try {
      started = handle.runUserShellCommand(command, session.cwd || ctx.cwd, settings.timeoutMs, settings.maxOutputBytes, { signal: ac.signal });
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

  // Records the outcome in the session and tells every client viewing it: a
  // client that reconnected while the command ran gets it when it lands here, and
  // one that connects later replays it from the history.
  function conclude(session, entry) {
    var run = running.get(session.localId);
    running.delete(session.localId);
    session.lastActivityAt = Date.now();
    ctx.sm.sendAndRecord(session, entry);
    if (run && run.busy) clearBusy(session);
  }

  // From approval until the result is recorded the session is busy exactly as it
  // is during a model turn, and chat sends wait instead of reaching the handle.
  function markBusy(session, requestId) {
    var run = running.get(session.localId);
    if (run && run.requestId === requestId) run.busy = true;
    session.isProcessing = true;
    ctx.sdk.holdMessages(session);
    if (typeof opts.onProcessingChanged === "function") opts.onProcessingChanged();
  }

  // Messages sent meanwhile go on in order and start the next turn, which ends
  // the busy state itself; with none (or no live query) the session is idle.
  function clearBusy(session) {
    var released = ctx.sdk.releaseHeldMessages(session);
    if (released === 0 || !session.queryInstance) {
      session.isProcessing = false;
      if (typeof opts.onProcessingChanged === "function") opts.onProcessingChanged();
    }
  }

  // An interrupt stops the command, and the approval prompt if it is still open.
  function interrupt(ws) {
    var session = ctx.getSessionForWs(ws);
    var entry = session && running.get(session.localId);
    if (entry) entry.ac.abort();
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

module.exports = { attachUserShell: attachUserShell, REASONS: REASONS, MAX_COMMAND_CHARS: MAX_COMMAND_CHARS };
