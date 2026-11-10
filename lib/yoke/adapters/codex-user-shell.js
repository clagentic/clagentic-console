"use strict";

// A command the person typed, run through the app-server's thread/shellCommand.
//
// The app-server runs it as a turn of its own on the thread (a standalone one
// when the thread is idle) and reports it only as turn and item notifications;
// the request itself answers {}. The console shows the command as its own result
// and keeps those notifications out of the event stream, so this module decides,
// for every notification, whether it belongs to the command. The rule is one:
// a notification is the command's only when its turn id is the command's turn
// id. A model turn's start, items and end carry another id and always go on to
// the stream; the end of an earlier command's turn that arrives late is matched
// by its id too, never by how many are expected.

var userShell = require("../user-shell");

// How long to wait for the command's turn to end after its item completed, and
// for the turn an interrupt was asked of to start or end, before giving up.
var TURN_GRACE_MS = 3000;
// How far past its timeout a command that has reported nothing is given up on.
var WATCHDOG_GRACE_MS = 20000;
// How long a settled command's late turn ending is still taken as its own.
var LATE_END_WINDOW_MS = 30000;

function turnIdOf(params) {
  var id = (params.turn && params.turn.id) || params.turnId;
  return id ? String(id) : null;
}

function isCommandItem(item) {
  return !!item && (item.type === "commandExecution" || item.type === "command_execution");
}

function itemOutput(item) {
  var text = item.aggregatedOutput != null ? item.aggregatedOutput
    : item.aggregated_output != null ? item.aggregated_output
    : item.output != null ? item.output : "";
  return typeof text === "string" ? text : "";
}

/**
 * @param {object} deps
 * @param {function(string, object, number): Promise} deps.send   JSON-RPC request to the app-server
 * @param {function(): boolean} deps.isReady                      the app-server is running
 * @param {function(): ?string} deps.threadId
 * @param {function(): ?string} deps.activeTurnId  the model turn running now, if any
 */
function createUserShellRunner(deps) {
  var current = null;
  // Turn id of a settled command's turn whose ending is still to arrive -> the
  // time after which it is no longer waited for.
  var lateEnds = {};

  function sweepLateEnds() {
    var now = Date.now();
    Object.keys(lateEnds).forEach(function (id) {
      if (lateEnds[id] < now) delete lateEnds[id];
    });
  }

  function clearTimers(run) {
    clearTimeout(run.watchdog);
    clearTimeout(run.graceTimer);
    clearTimeout(run.interruptTimer);
    if (run.signal) run.signal.removeEventListener("abort", run.onAbort);
  }

  function sendInterrupt() {
    if (!deps.threadId() || !deps.isReady()) return;
    deps.send("turn/interrupt", { threadId: deps.threadId() }, 5000).catch(function (err) {
      console.warn("[yoke/codex] turn/interrupt for a shell command failed:", err && err.message || err);
    });
  }

  function settle(run, how) {
    if (current !== run || run.settled) return;
    run.settled = true;
    current = null;
    clearTimers(run);
    // A standalone turn that started and has not ended will still end, and that
    // ending is this command's.
    if (run.turnId && !run.turnEnded && !run.aux) lateEnds[run.turnId] = Date.now() + LATE_END_WINDOW_MS;
    sweepLateEnds();
    var elapsed = Date.now() - run.startedAt;
    var text = run.output;
    if (how.failure) text = (text ? text + "\n" : "") + how.failure;
    var capped = userShell.capText(text, run.maxBytes);
    var timedOut = !!how.timedOut ||
      (run.itemStatus === "failed" && run.exitCode === null && !run.interruptSent && elapsed >= run.timeoutMs - 2000);
    run.resolve({
      exitCode: run.exitCode,
      durationMs: typeof run.durationMs === "number" ? run.durationMs : elapsed,
      output: capped.output,
      truncated: capped.truncated,
      timedOut: timedOut,
      interrupted: !!how.interrupted,
    });
  }

  // turn/interrupt only reaches a turn that has started, and only the turn the
  // command is in can be named, so before its id is known the request is held.
  function interruptNow(run) {
    run.interruptSent = true;
    sendInterrupt();
    // Reported as interrupted only when the turn is then seen to end; if it
    // does not, the command may still be running and the result says so.
    clearTimeout(run.interruptTimer);
    run.interruptTimer = setTimeout(function () { settle(run, { interrupted: false }); }, TURN_GRACE_MS);
  }

  function requestInterrupt(run) {
    if (run.settled || run.abortRequested) return;
    run.abortRequested = true;
    if (run.turnId) {
      interruptNow(run);
    } else {
      run.interruptTimer = setTimeout(function () { settle(run, { interrupted: false }); }, TURN_GRACE_MS);
    }
  }

  function consumeLateEnd(params) {
    sweepLateEnds();
    var id = turnIdOf(params);
    if (!id || lateEnds[id] === undefined) return false;
    var until = lateEnds[id];
    delete lateEnds[id];
    return Date.now() <= until;
  }

  function consumeItem(run, method, params) {
    if (!run.turnId) return false;
    var item = params.item;
    var itemTurn = turnIdOf(params);
    var byTurn = itemTurn !== null && itemTurn === run.turnId;
    var byItem = itemTurn === null && ((item && item.id && item.id === run.itemId) || (params.itemId && params.itemId === run.itemId));
    if (itemTurn !== null && !byTurn) return false;
    if (isCommandItem(item)) {
      // On a model turn the command is one of its items among the model's own,
      // so it is told apart by its text.
      if (run.aux && !run.itemId && String(item.command || "").indexOf(run.command) === -1) return false;
      if (!run.itemId) run.itemId = item.id;
      if (item.id !== run.itemId) return !run.aux;
      var seen = itemOutput(item);
      if (seen) run.output = seen;
      if (method === "item/completed") {
        run.itemStatus = item.status || null;
        var code = item.exitCode != null ? item.exitCode : item.exit_code;
        run.exitCode = typeof code === "number" ? code : null;
        var ms = item.durationMs != null ? item.durationMs : item.duration_ms;
        if (typeof ms === "number") run.durationMs = ms;
        if (run.aux) {
          // No turn of its own to wait for.
          settle(run, { interrupted: run.interruptSent });
        } else {
          // The turn ends right after its command; if that ending never comes,
          // the command's result is still known.
          run.graceTimer = setTimeout(function () { settle(run, { interrupted: run.interruptSent }); }, TURN_GRACE_MS);
        }
      }
      return true;
    }
    if (run.aux) return byItem;
    return true;
  }

  /**
   * True when the notification belongs to the running command (or to a settled
   * one's late turn ending) and must not reach the event stream.
   */
  function consume(method, params) {
    var isEnd = method === "turn/completed" || method === "turn/failed";
    if (isEnd && consumeLateEnd(params)) return true;
    var run = current;
    if (!run) return false;

    if (method === "turn/started") {
      var startedId = turnIdOf(params);
      // Another turn starting once the command's is known, or while it runs as
      // part of a model turn, is not the command's.
      if (run.turnId || run.aux || !startedId) return false;
      run.turnId = startedId;
      if (run.abortRequested) interruptNow(run);
      return true;
    }

    if (isEnd) {
      // Only the command's own turn ending settles it; a model turn's end has
      // another id and is delivered.
      if (run.aux || !run.turnId || turnIdOf(params) !== run.turnId) return false;
      run.turnEnded = true;
      var status = params.turn && params.turn.status;
      var failure = method === "turn/failed" ? ((params.error && params.error.message) || "The command's turn failed") : null;
      settle(run, { interrupted: run.interruptSent || status === "interrupted", failure: failure });
      return true;
    }

    if (method.indexOf("item/") !== 0) return false;
    return consumeItem(run, method, params);
  }

  /**
   * Sends the command and resolves with its result. Rejects when the app-server
   * refuses the request.
   */
  function run(command, timeoutMs, maxOutputBytes, signal) {
    if (!deps.threadId() || !deps.isReady()) {
      return Promise.reject(new Error("There is no running Codex thread to run the command in."));
    }
    if (current) return Promise.reject(new Error("A shell command is already running in this thread."));
    return new Promise(function (resolve, reject) {
      var active = deps.activeTurnId();
      var r = {
        resolve: resolve,
        command: command,
        startedAt: Date.now(),
        timeoutMs: timeoutMs,
        maxBytes: maxOutputBytes,
        signal: signal || null,
        // With a model turn running, the app-server runs the command as part of
        // that turn: its id is the command's, and its end is the model's.
        aux: !!active,
        turnId: active ? String(active) : null,
        itemId: null,
        itemStatus: null,
        output: "",
        exitCode: null,
        durationMs: null,
        turnEnded: false,
        interruptSent: false,
        abortRequested: false,
        settled: false,
        watchdog: null,
        graceTimer: null,
        interruptTimer: null,
        onAbort: null,
      };
      current = r;
      r.watchdog = setTimeout(function () {
        sendInterrupt();
        settle(r, { timedOut: true });
      }, timeoutMs + WATCHDOG_GRACE_MS);
      r.onAbort = function () { requestInterrupt(r); };
      if (r.signal) {
        if (r.signal.aborted) r.onAbort();
        else r.signal.addEventListener("abort", r.onAbort, { once: true });
      }
      deps.send("thread/shellCommand", { threadId: deps.threadId(), command: command, timeoutMs: timeoutMs }, 15000).catch(function (err) {
        if (current !== r || r.settled) return;
        r.settled = true;
        current = null;
        clearTimers(r);
        reject(err);
      });
    });
  }

  return {
    run: run,
    consume: consume,
    isRunning: function () { return !!current; },
    // The query is being aborted or closed: stop the running command.
    interruptRunning: function () { if (current) requestInterrupt(current); },
  };
}

module.exports = { createUserShellRunner: createUserShellRunner };
