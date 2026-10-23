"use strict";

// The one way a test removes a temp home that a process or an in-process async
// writer may still be writing into. A bare synchronous rm races those writers:
// a file or directory created while the removal runs leaves the parent
// non-empty (ENOTEMPTY), and a write queued behind the removal recreates the
// tree afterwards.
//
// Order matters and is the fix, not a retry: (0) run the caller's quiesce step,
// which stops in-process writers that schedule work on a timer; (1) wait,
// bounded, for every child the test was told about to exit, failing with its
// pid when one does not; (2) let in-process promise-based fs work finish, so
// the event loop is free to run the chain that is still writing; (3) remove;
// (4) confirm the home stayed gone. The retry options only cover a transient
// directory listing race after (1) and (2).
//
// Limit: the drain in (2) sees fs requests that already exist. It cannot see a
// timer or debounce that will start a write later, so a writer that schedules
// on a timer must be stopped by the caller through its own close, flush or stop
// API, passed as `quiesce`.

var fs = require("fs");
var path = require("path");
var util = require("util");
var { verifyOwnedPid } = require("../fixtures/process-ownership");

var REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
var DEFAULT_WAIT_MS = 10000;
var POLL_MS = 25;
var debugLog = util.debuglog("remove-temp-home");

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// A zombie has exited and only waits for its parent to reap it; it writes nothing.
function pidAlive(pid) {
  try { process.kill(pid, 0); } catch (e) { return e.code === "EPERM"; }
  try {
    var stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2, stat.lastIndexOf(") ") + 3) !== "Z";
  } catch (e) {
    return true;
  }
}

// Every live process that carries the harness token: the daemon's own children
// and grandchildren inherit its environment, and one outlives the daemon when
// the daemon exits first (it is re-parented, so no handle to it exists).
// scanned:false means /proc cannot be listed (macOS), so nothing was checked.
function ownedProcesses(token) {
  var out = [];
  var entries;
  try { entries = fs.readdirSync("/proc"); } catch (e) { return { scanned: false, procs: out }; }
  entries.forEach(function (name) {
    if (!/^\d+$/.test(name)) return;
    var pid = Number(name);
    if (pid === process.pid || !pidAlive(pid)) return;
    if (!verifyOwnedPid(pid, token).ok) return;
    out.push({ pid: pid, start: startTimeOf(pid) });
  });
  return { scanned: true, procs: out };
}

// Field 22 of /proc/<pid>/stat, the process start time in clock ticks since
// boot: with the pid it identifies one process, so a recycled pid differs.
function startTimeOf(pid) {
  try {
    var stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] || null;
  } catch (e) {
    return null;
  }
}

// Still the process that was found: alive, started at the same time, and still
// carrying the token. A pid recycled for an unrelated process fails this.
function stillOwned(proc, token) {
  return pidAlive(proc.pid) && proc.start !== null &&
    startTimeOf(proc.pid) === proc.start && verifyOwnedPid(proc.pid, token).ok;
}

function signalAll(pids, signal) {
  pids.forEach(function (pid) {
    try { process.kill(pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; }
  });
}

// Stops what the harness started and the test holds no handle to. Only a
// process that carries this instance's token is signalled, and it is checked
// again right before SIGKILL. Returns the pids that survived, so the caller
// fails loudly rather than skipping them.
async function stopOwned(token, ms, log) {
  var found = ownedProcesses(token);
  if (!found.scanned) {
    log("token scan skipped: /proc cannot be listed on this platform");
    return [];
  }
  var procs = found.procs;
  if (procs.length === 0) return [];
  function owned(p) { return stillOwned(p, token); }
  function pidOf(p) { return p.pid; }
  signalAll(procs.map(pidOf), "SIGTERM");
  var end = Date.now() + ms;
  var killedAt = Date.now() + ms / 2;
  var killed = false;
  while (Date.now() < end) {
    procs = procs.filter(owned);
    if (procs.length === 0) return [];
    if (!killed && Date.now() >= killedAt) { signalAll(procs.map(pidOf), "SIGKILL"); killed = true; }
    await sleep(POLL_MS);
  }
  return procs.filter(owned).map(pidOf);
}

// A child is a ChildProcess the test spawned, or a bare pid recorded elsewhere
// (a self-spawned successor). Resolves null once it has exited, or a message
// naming it when the bound expires.
function waitForChild(child, ms) {
  if (typeof child === "number") {
    return (async function () {
      var end = Date.now() + ms;
      while (Date.now() < end) {
        if (!pidAlive(child)) return null;
        await sleep(POLL_MS);
      }
      return pidAlive(child) ? "pid " + child + " was still running after " + ms + " ms" : null;
    })();
  }
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(null);
  return new Promise(function (resolve) {
    var timer = setTimeout(function () {
      resolve("pid " + child.pid + " was still running after " + ms + " ms");
    }, ms);
    child.once("exit", function () { clearTimeout(timer); resolve(null); });
  });
}

function fsPromiseRequestsInFlight() {
  return process.getActiveResourcesInfo().indexOf("FSReqPromise") !== -1;
}

// Every step of a promise-based fs chain (mkdir, then writeFile, then rename)
// is queued from a microtask after the previous step settles, so a check that
// runs after a macrotask turn sees the chain's next request if there is one.
async function drainPromiseFs(ms) {
  var end = Date.now() + ms;
  do {
    await new Promise(function (resolve) { setImmediate(resolve); });
    if (!fsPromiseRequestsInFlight()) return null;
    await sleep(POLL_MS);
  } while (Date.now() < end);
  return "promise-based fs requests were still in flight after " + ms + " ms";
}

/**
 * @param {string} home the directory to remove
 * @param {object} [o]
 * @param {Array<import("child_process").ChildProcess|number>} [o.children] processes that may write into home
 * @param {string} [o.token] the harness token the spawned processes carry; every live process with it is stopped (an orphaned grandchild included)
 * @param {number} [o.waitMs] bound for each wait (default 10000)
 * @param {function(): (void|Promise<void>)} [o.quiesce] stops in-process writers
 *   that schedule a write on a timer or debounce, through the component's own
 *   close, flush or stop API. Runs first. The helper cannot detect such a
 *   writer: a timer that has not fired yet has no fs request to wait for.
 * @param {function(string): void} [o.log] receives the one-line notice that the
 *   token scan was skipped (default: util.debuglog("remove-temp-home"))
 * @throws when a child outlives the bound or the home comes back; the message names each pid
 */
async function removeTempHome(home, o) {
  var opts = o || {};
  var waitMs = opts.waitMs || DEFAULT_WAIT_MS;
  var problems = [];
  var log = opts.log || debugLog;

  if (opts.quiesce) {
    try { await opts.quiesce(); } catch (e) { problems.push("quiesce failed: " + (e && e.message ? e.message : e)); }
  }

  var verdicts = await Promise.all((opts.children || []).map(function (c) { return waitForChild(c, waitMs); }));
  verdicts.forEach(function (v) { if (v) problems.push(v + " (it may still write into " + home + ")"); });

  if (opts.token) {
    var survivors = await stopOwned(opts.token, waitMs, log);
    survivors.forEach(function (pid) {
      problems.push("pid " + pid + " carrying the harness token survived SIGKILL (it may still write into " + home + ")");
    });
  }

  var drained = await drainPromiseFs(waitMs);
  if (drained) problems.push(drained);

  // Bounded passes: a chain that began before the first pass and wrote after it
  // shows up as the home existing again on the confirming check.
  for (var pass = 0; pass < 3; pass++) {
    await fs.promises.rm(home, REMOVE_OPTIONS);
    await new Promise(function (resolve) { setImmediate(resolve); });
    if (!fsPromiseRequestsInFlight() && !fs.existsSync(home)) break;
    var again = await drainPromiseFs(waitMs);
    if (again) { problems.push(again); break; }
    if (pass === 2 && fs.existsSync(home)) problems.push(path.basename(home) + " was recreated after removal");
  }

  if (problems.length > 0) throw new Error(problems.join("; "));
}

module.exports = { removeTempHome, pidAlive, startTimeOf, stillOwned, REMOVE_OPTIONS };
