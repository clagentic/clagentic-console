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
//
// The request answers {} and names no turn, so the command's turn id is learned
// from the turn that follows it. Two things keep that from ever being a model's
// turn: chat is held (whenIdle) until the command settles, so none starts in the
// window; and a run that gave up before its turn started is remembered, and the
// turn that arrives after is held back until one of its own items shows the
// command that was asked for. Only then is it the late turn of that run; a turn
// that ends or runs another command first is released to the stream untouched.

var userShell = require("../user-shell");

// How long to wait for the command's turn to end after its item completed, and
// for the turn an interrupt was asked of to end, before giving up.
var TURN_GRACE_MS = 3000;
// How far past its timeout a command whose turn never started is given up on.
var WATCHDOG_GRACE_MS = 20000;
// How long a settled command's late turn ending is still taken as its own.
var LATE_END_WINDOW_MS = 30000;
// How many notifications of an unidentified late turn are held before it is
// taken to be someone else's and released.
var LATE_HOLD_MAX = 16;

var MODEL_TURN_RUNNING = "Not run: the agent is working. Try again when its turn has ended.";

function refusedResult(message) {
  return { exitCode: null, durationMs: 0, output: message, truncated: false, timedOut: false, interrupted: false };
}

function turnIdOf(params) {
  var id = (params.turn && params.turn.id) || params.turnId;
  return id ? String(id) : null;
}

function isCommandItem(item) {
  return !!item && (item.type === "commandExecution" || item.type === "command_execution");
}

// The item runs the command that was asked for. The app-server may wrap what
// was typed, so containing it is enough.
function runsCommand(item, command) {
  var shown = Array.isArray(item.command) ? item.command.join(" ") : item.command;
  return typeof shown === "string" && typeof command === "string" && shown.indexOf(command) !== -1;
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
 * @param {function(string, object): void} [deps.release]  delivers a notification the
 *        runner held back and found not to be a command's
 */
function createUserShellRunner(deps) {
  var current = null;
  // Turn id of a settled command's turn whose ending is still to arrive -> the
  // time after which it is no longer waited for.
  var lateEnds = {};
  // Commands that settled before their turn started: { command, until, candidate }.
  // candidate is the turn that started since, with what it has sent so far.
  var lateRuns = [];
  var idleWaiters = [];

  function sweepLateRuns() {
    var now = Date.now();
    lateRuns = lateRuns.filter(function (late) { return late.candidate || late.until >= now; });
  }

  function wakeIdle() {
    var waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach(function (resolve) { resolve(); });
  }

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
    if (run.turnId && !run.turnEnded) lateEnds[run.turnId] = Date.now() + LATE_END_WINDOW_MS;
    // No turn yet: the command may still start one. It is told by the command it
    // runs, since the request named no turn.
    if (!run.turnId) lateRuns.push({ command: run.command, until: Date.now() + LATE_END_WINDOW_MS, candidate: null });
    sweepLateEnds();
    sweepLateRuns();
    wakeIdle();
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
    // Before the turn starts the request is held, with no timer: it is sent when
    // this run's turn/started arrives, or the run settles timed out.
    if (run.turnId) interruptNow(run);
  }

  function consumeLateEnd(params) {
    sweepLateEnds();
    var id = turnIdOf(params);
    if (!id || lateEnds[id] === undefined) return false;
    var until = lateEnds[id];
    delete lateEnds[id];
    return Date.now() <= until;
  }

  function releaseCandidate(late) {
    var held = late.candidate ? late.candidate.held : [];
    late.candidate = null;
    held.forEach(function (n) { if (deps.release) deps.release(n.method, n.params); });
  }

  // A turn that started after a run gave up. Held until it shows the command
  // that run was asked for (then it is that run's: its items and end stay out of
  // the stream by id) or shows it is not (it ends, runs another command, or says
  // too much: then everything held is released in order).
  function consumeLateTurn(method, params) {
    sweepLateRuns();
    var id = turnIdOf(params);
    if (id && lateEnds[id] !== undefined && method.indexOf("item/") === 0) return true;
    var holding = null;
    var waiting = null;
    lateRuns.forEach(function (late) {
      if (late.candidate) holding = late;
      else waiting = late;
    });

    if (method === "turn/started") {
      if (!id || holding || !waiting) return false;
      // An unbound running command takes its own turn's start.
      if (current && !current.turnId) return false;
      waiting.candidate = { turnId: id, held: [{ method: method, params: params }] };
      return true;
    }

    if (!holding || !id || id !== holding.candidate.turnId) return false;
    var isItem = method.indexOf("item/") === 0;
    if (isItem && isCommandItem(params.item) && runsCommand(params.item, holding.command)) {
      lateEnds[id] = Date.now() + LATE_END_WINDOW_MS;
      lateRuns.splice(lateRuns.indexOf(holding), 1);
      holding.candidate = null;
      return true;
    }
    var other = method === "turn/completed" || method === "turn/failed" || (isItem && isCommandItem(params.item));
    if (other || holding.candidate.held.length >= LATE_HOLD_MAX) {
      releaseCandidate(holding);
      return false;
    }
    holding.candidate.held.push({ method: method, params: params });
    return true;
  }

  function consumeItem(run, method, params) {
    if (!run.turnId) return false;
    var item = params.item;
    var itemTurn = turnIdOf(params);
    if (itemTurn !== null && itemTurn !== run.turnId) return false;
    if (isCommandItem(item)) {
      if (!run.itemId) run.itemId = item.id;
      if (item.id !== run.itemId) return true;
      var seen = itemOutput(item);
      if (seen) run.output = seen;
      if (method === "item/completed") {
        run.itemStatus = item.status || null;
        var code = item.exitCode != null ? item.exitCode : item.exit_code;
        run.exitCode = typeof code === "number" ? code : null;
        var ms = item.durationMs != null ? item.durationMs : item.duration_ms;
        if (typeof ms === "number") run.durationMs = ms;
        // The turn ends right after its command; if that ending never comes,
        // the command's result is still known.
        run.graceTimer = setTimeout(function () { settle(run, { interrupted: run.interruptSent }); }, TURN_GRACE_MS);
      }
      return true;
    }
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
    if (consumeLateTurn(method, params)) return true;

    if (method === "turn/started") {
      var startedId = turnIdOf(params);
      if (!run) return false;
      // Another turn starting once the command's is known is not the command's.
      if (run.turnId || !startedId) return false;
      // The request names no turn, so the turn that starts while it is the only
      // thing in flight is the command's. It is the only thing in flight because
      // a command is refused while a model turn runs and chat is held until the
      // command settles (whenIdle), and a late turn of an earlier run is held back
      // by consumeLateTurn until it shows its own command. No model turn is bound
      // by arriving first.
      run.turnId = startedId;
      if (run.abortRequested) interruptNow(run);
      return true;
    }

    if (!run) return false;

    if (isEnd) {
      // Only the command's own turn ending settles it; a model turn's end has
      // another id and is delivered.
      if (!run.turnId || turnIdOf(params) !== run.turnId) return false;
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
    // The app-server would run the command inside the model's turn, where it
    // cannot be told from the model's own commands or stopped without stopping
    // the turn, so it is refused while a model turn runs.
    if (deps.activeTurnId()) return Promise.resolve(refusedResult(MODEL_TURN_RUNNING));
    return new Promise(function (resolve, reject) {
      var r = {
        resolve: resolve,
        command: command,
        startedAt: Date.now(),
        timeoutMs: timeoutMs,
        maxBytes: maxOutputBytes,
        signal: signal || null,
        turnId: null,
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
        wakeIdle();
        reject(err);
      });
    });
  }

  return {
    run: run,
    consume: consume,
    isRunning: function () { return !!current; },
    // Resolves when no command is running: chat waits here so its turn cannot
    // start while a command's turn is the one expected.
    whenIdle: function () {
      if (!current) return Promise.resolve();
      return new Promise(function (resolve) { idleWaiters.push(resolve); });
    },
    // The query is being aborted or closed: stop the running command.
    interruptRunning: function () { if (current) requestInterrupt(current); },
  };
}

module.exports = { createUserShellRunner: createUserShellRunner, refusedResult: refusedResult };
