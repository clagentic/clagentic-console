// lib/cli/restart-verb.js
//
// The `clagentic-console --restart` verb as one function over injected I/O, so
// the wait is testable without a daemon. It does not restart anything itself:
// the restart is the daemon's existing IPC "restart" command (supervisor-aware,
// see spawnAndRestart in lib/daemon.js). This module only reports the sessions
// in flight before it, waits for the NEW process after it, and reads that
// process's build status.
//
// It never refuses on in-flight sessions, and it has no notion of who is
// calling: the same verb runs the same way for every caller.

var EXIT = {
  OK: 0,
  // No daemon to restart, the restart was not acknowledged, or the old pid is unknown.
  FAILED: 1,
  // No new process answered within the timeout.
  TIMEOUT: 2,
  // A new process is up but it did not load the installed build.
  BUILD_MISMATCH: 3,
};

var DEFAULT_TIMEOUT_MS = 60 * 1000;
var DEFAULT_POLL_MS = 500;

function buildMatches(status) {
  return !!status.loadedBuildSha && status.loadedBuildSha === status.installedBuildSha;
}

// What the wait last saw, so a timeout says what was there instead of the new process.
function seenOf(res) {
  if (res && res.ok) return { pid: res.pid || null, state: res.state || null, error: null };
  return { pid: null, state: null, error: (res && res.error) || "no answer" };
}

/**
 * @param {object} deps
 * @param {function(object): Promise<object>} deps.send   one IPC command to the daemon
 * @param {function(number): Promise<void>} deps.sleep
 * @param {function(): number} deps.now
 * @param {number|null} [deps.configPid]  pid recorded in the config, used when the daemon does not report one
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.pollMs]
 * @returns {Promise<{code: number, report: object}>}
 */
async function runRestart(deps, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  var pollMs = opts.pollMs || DEFAULT_POLL_MS;
  var report = {
    outcome: null,
    oldPid: null,
    sessions: null,
    newPid: null,
    loadedBuildSha: null,
    installedBuildSha: null,
    state: null,
    lastSeen: null,
  };

  var before = await deps.send({ cmd: "get_build_status" });
  report.oldPid = (before && before.ok && before.pid) || deps.configPid || null;
  if (!report.oldPid) {
    // Without the old pid the wait cannot tell the old process from the new one.
    report.outcome = "old-pid-unknown";
    return { code: EXIT.FAILED, report: report };
  }

  var flight = await deps.send({ cmd: "get_interruptions" });
  report.sessions = flight && flight.ok && Array.isArray(flight.sessions) ? flight.sessions : null;

  var ack = await deps.send({ cmd: "restart" });
  if (!ack || !ack.ok) {
    report.outcome = "restart-not-acknowledged";
    report.lastSeen = seenOf(ack);
    return { code: EXIT.FAILED, report: report };
  }

  var started = deps.now();
  var res;
  for (;;) {
    res = await deps.send({ cmd: "get_build_status" });
    report.lastSeen = seenOf(res);
    // The old process can still answer between the acknowledgement and its exit;
    // only a different pid is the new process.
    if (res && res.ok && res.pid && res.pid !== report.oldPid) break;
    if (deps.now() - started >= timeoutMs) {
      report.outcome = "timeout";
      return { code: EXIT.TIMEOUT, report: report };
    }
    await deps.sleep(pollMs);
  }

  report.newPid = res.pid;
  report.loadedBuildSha = res.loadedBuildSha || null;
  report.installedBuildSha = res.installedBuildSha || null;
  report.state = res.state || null;
  if (!buildMatches(res)) {
    report.outcome = "build-mismatch";
    return { code: EXIT.BUILD_MISMATCH, report: report };
  }
  report.outcome = "restarted";
  return { code: EXIT.OK, report: report };
}

function humanLines(result) {
  var r = result.report;
  var lines = [];
  var n = r.sessions ? r.sessions.length : 0;
  if (r.outcome === "restarted") {
    if (n) lines.push("Sessions in flight before the restart: " + n);
    lines.push("Server restarted (pid " + r.oldPid + " -> " + r.newPid + ", build " + r.loadedBuildSha + ").");
  } else if (r.outcome === "timeout") {
    lines.push("Restart requested, but no new process answered in time. Last seen: " + JSON.stringify(r.lastSeen));
  } else if (r.outcome === "build-mismatch") {
    lines.push("Server restarted (pid " + r.oldPid + " -> " + r.newPid + ") but did not load the installed build: loaded "
      + r.loadedBuildSha + ", installed " + r.installedBuildSha + ", state " + r.state + ".");
  } else if (r.outcome === "old-pid-unknown") {
    lines.push("Restart not attempted: the running daemon's pid is unknown, so the new process could not be told from the old one.");
  } else {
    lines.push("Restart failed: daemon did not acknowledge the command.");
  }
  return lines;
}

module.exports = {
  runRestart: runRestart,
  humanLines: humanLines,
  EXIT: EXIT,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
};
