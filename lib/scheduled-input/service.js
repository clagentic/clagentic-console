// service.js - scheduled input: text the console sends into a session at a
// later time, once or on a repeat that always has an end. For people (the clock
// button) and for agents and scripts (the schedule-input CLI) alike.
//
// One service per daemon:
//   - one persisted list of records per project (store.js), shared by every way
//     of making, listing and deleting a record;
//   - one timer, set for the earliest time any armed record is due, re-armed
//     whenever a record is created, fired, skipped, deleted or ended;
//   - one firing path: session-input fireScheduled(), which delivers through
//     deliver(), the path send-input uses.
//
// Lifecycle: a record ends (state "ended") when its session is closed or
// deleted, and is done when it ran its course. A session whose runtime was
// reaped is not ended; the firing resumes it by id. Nothing here moves a record
// to another session. Missed firings are not made up: a once record that came
// due while the daemon was down fires once at startup, and a recurring record
// fires at most once and then continues from that delivery. Delivery is at most
// once: a record is advanced and saved before its text is delivered, and when
// the list cannot be saved nothing is delivered (see fire() and commit()).
//
// Memory always equals the disk. Every change to a record or to the list is made
// inside commit(), which saves it and, when the save fails, puts everything back
// as it was last saved. There is no other write path in this file.
//
// One owner while a delivery is in flight: from the moment fire() starts the
// delivery until settle() has run, only settle() changes that record. A daemon-made
// transition with no caller (a session ending, a vendor-id upgrade) records what
// it wants as an op in `pending`, and settle() applies its own outcome and then
// those ops, in order, in one commit(). An operation with a caller is never held:
// deleting a record that is being sent is refused as busy, and arming a resume
// creates its record durably at once (settle() ends the older resume if both
// would be armed).

var path = require("path");

var sessionResume = require("../session-resume");
var { encodeCwd } = require("../utils");
var { INITIATORS } = require("../turn-initiator");
var records = require("./records");
var { createStore } = require("./store");

var KIND = records.KIND;
var STATE = records.STATE;

// A firing skipped because the session was mid-turn retries after this long.
// Short and bounded (never over 30 s) rather than at full timer precision.
var RETRY_BUSY_MS = 15 * 1000;
var RETRY_ERROR_MS = 30 * 1000;
var MAX_FAILURES = 10;
// Sessions and runtimes are settling when a project is attached at startup.
var STARTUP_GRACE_MS = 5 * 1000;
// The timer never sleeps longer than this, so a clock change is noticed.
var MAX_WAIT_MS = 30 * 60 * 1000;

// A browser's bubble shows the start of a long text; the record keeps it whole.
var BUBBLE_TEXT_CHARS = 2000;

// What a record was made for, kept in createdBy for the rate-limit resume (the
// only record the daemon makes by itself).
var CREATED_BY_RATE_LIMIT = "rate-limit";

function messageOf(err) {
  return err && err.message ? err.message : String(err);
}

function fail(result, reason) {
  return { ok: false, result: result, reason: reason };
}

// deps:
//   dir                  directory the per-project files live in
//   getProject(slug)     -> project context | null
//   sessionInput         the createSessionInput() instance (fireScheduled)
//   publish(event)       optional; { type, slug, record, session }
//   now() / setTimer(fn, ms) / clearTimer(handle)   optional, for tests
function createScheduledInputService(deps) {
  var now = deps.now || Date.now;
  var setTimer = deps.setTimer || function (fn, ms) {
    var handle = setTimeout(fn, ms);
    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
  };
  var clearTimer = deps.clearTimer || clearTimeout;
  var projects = new Map(); // slug -> { store }
  var inFlight = new Set(); // record ids being delivered
  // In-flight record id -> ops to apply once settle() has run. Only transitions
  // the daemon makes by itself with no caller to tell (sessionEnded,
  // upgradeTargets, endUnstableTargets) are ever held here. Each heals after a
  // crash: a closed session's record fires, gets not-found and ends; an upgrade
  // is redone on the next tick or list; a console-keyed record is ended again at
  // attach. A caller-facing operation (remove, armResume) is never held, because
  // its caller would be told it happened before it is saved.
  var pending = new Map();
  var notBefore = new Map(); // record id -> earliest next attempt (ms)
  var timer = null;
  var stopped = false;

  function publish(type, slug, record, session) {
    if (typeof deps.publish !== "function") return;
    try { deps.publish({ type: type, slug: slug, record: record, session: session || null }); }
    catch (e) { console.error("[scheduled-input] publish failed:", messageOf(e)); }
  }

  // --- the timer ---

  function dueAt(record) {
    return Math.max(record.nextAt, notBefore.get(record.id) || 0);
  }

  // --- saving ---
  //
  // Every write of a project's list goes through commit(). A write that fails
  // marks the project unhealthy: nothing of it is delivered until a write
  // succeeds, because a delivery that cannot be recorded would be made again
  // after a restart. A read-only store (see store.js) never recovers on its own.

  // Saves the list and keeps the project's health. Called only by commit() and
  // by mayFire()'s retry of a save (which changes nothing).
  function persist(slug, entry) {
    if (entry.store.save()) {
      if (entry.unhealthy) {
        console.error("[scheduled-input] " + slug + ": the list saved again; firing resumes");
        entry.unhealthy = null;
      }
      return true;
    }
    var health = entry.store.health();
    if (!entry.unhealthy) console.error("[scheduled-input] " + slug + ": the list cannot be saved; nothing is delivered until a save succeeds");
    entry.unhealthy = {
      readOnly: health.readOnly,
      error: health.error || "the list could not be written",
      retryAt: now() + RETRY_ERROR_MS,
    };
    return false;
  }

  // The one way a record or the list changes. mutate() makes the change; the list
  // is then saved. If the save fails, every record is put back (in place, so
  // references held elsewhere stay valid) to the state that was last saved, the
  // project is marked unhealthy by persist(), and false is answered. A change is
  // never kept in memory unsaved. mutate() changes records and the list only.
  function commit(slug, entry, mutate) {
    var snap = entry.store.all().map(function (r) {
      return { record: r, copy: JSON.parse(JSON.stringify(r)) };
    });
    try {
      mutate();
    } catch (err) {
      rollback(entry, snap);
      throw err;
    }
    if (persist(slug, entry)) return true;
    rollback(entry, snap);
    // The project is unhealthy now; make sure a retry of the save is waited for.
    rearm();
    return false;
  }

  function rollback(entry, snap) {
    entry.store.all().slice().forEach(function (r) { entry.store.remove(r.id); });
    snap.forEach(function (s) {
      Object.keys(s.record).forEach(function (k) { delete s.record[k]; });
      Object.assign(s.record, s.copy);
      entry.store.add(s.record);
    });
  }

  // True when the project may fire: it is healthy, or a retried save worked.
  function mayFire(slug, entry) {
    if (!entry.unhealthy) return true;
    if (entry.unhealthy.readOnly || now() < entry.unhealthy.retryAt) return false;
    return persist(slug, entry);
  }

  // --- operations on a record that is being delivered ---

  // Remembers what an operation wanted done to an in-flight record. Upgrading and
  // ending are idempotent, so the first one held is enough.
  function holdOp(id, op) {
    var ops = pending.get(id);
    if (!ops) { ops = []; pending.set(id, ops); }
    if ((op.type === "upgrade" || op.type === "ended") && ops.some(function (o) { return o.type === op.type; })) return;
    ops.push(op);
  }

  // Applies held ops in the order they came, each as the operation itself would
  // have on the record as it stands. Called inside commit() only. Answers the
  // events to publish once the commit succeeded and the ids of moved resumes.
  function applyOps(record, ops, t) {
    var out = { events: [], moved: [] };
    ops.forEach(function (op) {
      if (op.type === "upgrade") {
        if (records.isArmed(record) && record.sessionIdKind === records.ID_KIND.CONSOLE) {
          record.sessionId = op.id;
          record.sessionIdKind = records.ID_KIND.VENDOR;
        }
      } else if (op.type === "ended") {
        if (records.isArmed(record)) {
          records.sessionGone(record, t, op.reason);
          // Not given the session: it is gone (see sessionEnded()).
          out.events.push({ type: "ended", record: record, session: null });
        }
      }
    });
    return out;
  }

  // A delivery that did not happen puts a resume record back to armed. If the
  // session has a newer armed resume meanwhile (armResume() created it while this
  // one was being delivered), the older one ends: a session never has two armed
  // resumes and the newer wins. Called inside commit() only.
  function endIfReplaced(entry, record, t, out) {
    if (record.createdBy !== CREATED_BY_RATE_LIMIT || !records.isArmed(record)) return;
    var newer = entry.store.all().some(function (r) {
      return r !== record && r.createdBy === CREATED_BY_RATE_LIMIT && records.isArmed(r) && records.sameTarget(r, record);
    });
    if (!newer) return;
    records.sessionGone(record, t, "replaced by a newer resume");
    out.events.push({ type: "ended", record: record, session: null });
  }

  // One commit for a record's own change (step, optional) and the ops held for
  // it. The held ops are dropped only when the commit succeeded; otherwise
  // drainHeld() applies them at the next tick.
  function commitHeld(slug, entry, record, step) {
    var ops = pending.get(record.id) || null;
    var applied = null;
    var kept = commit(slug, entry, function () {
      var t = now();
      if (step) step();
      applied = ops ? applyOps(record, ops, t) : { events: [], moved: [] };
      endIfReplaced(entry, record, t, applied);
    });
    if (kept) pending.delete(record.id);
    return { kept: kept, applied: applied };
  }

  function publishApplied(slug, applied) {
    if (!applied) return;
    applied.moved.forEach(function (id) { notBefore.delete(id); });
    applied.events.forEach(function (e) { publish(e.type, slug, e.record, e.session); });
  }

  // Ops held for a record whose settle() could not save them.
  function drainHeld(slug, entry) {
    entry.store.all().slice().forEach(function (r) {
      if (entry.unhealthy || !pending.has(r.id) || inFlight.has(r.id)) return;
      var done = commitHeld(slug, entry, r, null);
      if (done.kept) publishApplied(slug, done.applied);
    });
  }

  function rearm() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (stopped) return;
    var earliest = null;
    projects.forEach(function (entry) {
      if (entry.unhealthy) {
        // Only a retry of the save is waited for, not the records themselves.
        if (!entry.unhealthy.readOnly && (earliest === null || entry.unhealthy.retryAt < earliest)) earliest = entry.unhealthy.retryAt;
        return;
      }
      entry.store.all().forEach(function (r) {
        if (!records.isArmed(r) || inFlight.has(r.id)) return;
        var at = dueAt(r);
        if (earliest === null || at < earliest) earliest = at;
      });
    });
    if (earliest === null) return;
    var wait = Math.min(Math.max(0, earliest - now()), MAX_WAIT_MS);
    timer = setTimer(tick, wait);
  }

  function tick() {
    timer = null;
    if (stopped) return;
    var t = now();
    projects.forEach(function (entry, slug) {
      if (!mayFire(slug, entry)) return;
      drainHeld(slug, entry);
      endUnstableTargets(slug, entry);
      upgradeTargets(slug, entry);
      entry.store.all().slice().forEach(function (r) {
        if (entry.unhealthy || !records.isArmed(r) || inFlight.has(r.id) || dueAt(r) > t) return;
        if (records.pastItsEnd(r, t)) {
          if (commit(slug, entry, function () { records.endReached(r, t); })) publish("ended", slug, r, null);
          return;
        }
        fire(slug, r, { initiator: INITIATORS.SCHEDULED, force: false });
      });
    });
    rearm();
  }

  // --- firing ---

  // Delivers a record's text now. Answers (as a Promise) the firing's result.
  //
  // At most once: the record is advanced (nextAt, firedCount, state) and saved
  // BEFORE the text is delivered, so a crash or a restart after a delivery
  // cannot make it again. If that save fails nothing is delivered. A delivery
  // that then does not happen (busy session, error) puts the record back as it
  // was, saves that, and tries again shortly.
  function fire(slug, record, how) {
    var entry = projects.get(slug);
    if (!entry || !mayFire(slug, entry)) {
      return Promise.resolve({ ok: false, result: "error", reason: "not delivered: the scheduled inputs of this project cannot be saved" + (entry && entry.unhealthy ? " (" + entry.unhealthy.error + ")" : "") });
    }
    var before = records.snapshot(record);
    if (!commit(slug, entry, function () { records.afterDelivery(record, now(), "sending"); })) {
      return Promise.resolve({ ok: false, result: "error", reason: "not delivered: the schedule could not be saved first (" + entry.unhealthy.error + ")" });
    }
    inFlight.add(record.id);
    // Started in this turn, not after a microtask: a person's "send now" is
    // delivered before the next thing they do, in order.
    var started;
    try {
      started = deps.sessionInput.fireScheduled({
        projectSlug: slug,
        sessionId: record.sessionId,
        prompt: record.text,
        note: record.note,
        initiator: how.initiator,
        force: how.force,
      });
    } catch (err) {
      started = { ok: false, result: "error", retryable: true, reason: "firing failed: " + messageOf(err) };
    }
    return Promise.resolve(started).catch(function (err) {
      return { ok: false, result: "error", retryable: true, reason: "firing failed: " + messageOf(err) };
    }).then(function (res) {
      inFlight.delete(record.id);
      if (!entry || projects.get(slug) !== entry || entry.store.get(record.id) !== record) return res;
      settle(slug, entry, record, res, how, before);
      rearm();
      return res;
    });
  }

  // The record was advanced and saved as "sending" before delivery (see fire).
  // Each branch is one commit. A save that fails leaves the record as last saved:
  //   - a delivered text keeps "sending" (it was delivered, once, and is not
  //     delivered again);
  //   - a failed delivery whose put-back cannot be saved stays advanced, so the
  //     text is not delivered at all, which at-most-once accepts.
  //
  // The record is owned by this function while it is in flight (see the top of
  // the file), so the outcome is always applied to what fire() saved: there is no
  // comparison with a snapshot. The ops other operations held meanwhile are
  // applied in the same commit, after the outcome.
  function settle(slug, entry, record, res, how, before) {
    var t = now();
    var step;
    var retryMs = 0;
    var event = null;
    if (res.ok) {
      step = function () { record.lastOutcome = res.result; };
      event = "sent";
    } else if (res.result === "busy") {
      // Skipped, not failed: the same record is tried again soon.
      step = function () {
        records.restore(record, before);
        record.lastOutcome = "skipped: the session was mid-turn";
      };
      retryMs = RETRY_BUSY_MS;
    } else if (res.result === "not-found") {
      step = function () {
        records.restore(record, before);
        records.sessionGone(record, t, "the session no longer exists");
      };
      event = "ended";
    } else if (how.force) {
      // A person's "send now" that failed is reported to them; the schedule goes on.
      step = function () { records.restore(record, before); };
    } else {
      var reason = String(res.reason || res.result).slice(0, 200);
      step = function () {
        records.restore(record, before);
        record.failures += 1;
        record.lastOutcome = "error: " + reason;
        event = "changed";
        if (record.failures >= MAX_FAILURES) {
          records.sessionGone(record, t, "delivery kept failing: " + reason);
          event = "ended";
        }
      };
      retryMs = RETRY_ERROR_MS;
    }
    notBefore.delete(record.id);
    var done = commitHeld(slug, entry, record, step);
    if (!done.kept) {
      // Whatever was last saved stands: a delivered text stays "sending" (it is
      // not delivered again); a failed delivery stays advanced (it is not
      // delivered at all), which at-most-once accepts. Held ops are applied at
      // the next tick.
      console.error("[scheduled-input] " + slug + ": " + record.id + (res.ok
        ? " was delivered but its outcome could not be saved; it stays recorded as sending"
        : " could not be put back after a delivery that did not happen; it stays as last saved and the text is not delivered"));
      return;
    }
    var stillHere = entry.store.get(record.id) === record;
    if (stillHere && retryMs && records.isArmed(record)) notBefore.set(record.id, t + retryMs);
    if (stillHere && event) publish(event, slug, record, null);
    publishApplied(slug, done.applied);
  }

  // --- projects ---

  function storeFile(project) {
    return path.join(deps.dir, encodeCwd(project.cwd) + ".json");
  }

  // A record bound by console id when the project was attached belongs to a
  // session that had not run a turn; a restart numbers sessions anew, so it can
  // no longer be trusted to name the same one and ends. If that cannot be saved
  // the ids stay in entry.stale and the end is made again at the next tick.
  function endUnstableTargets(slug, entry) {
    if (!entry.stale.size || entry.unhealthy) return;
    var t = now();
    var reason = "the session had not started when the daemon restarted";
    var stale = entry.store.all().filter(function (r) {
      return entry.stale.has(r.id) && r.sessionIdKind === records.ID_KIND.CONSOLE && (inFlight.has(r.id) || records.isArmed(r));
    });
    // An in-flight record is changed by settle() only; it is ended there, and
    // stays listed here until then.
    var free = stale.filter(function (r) { return !inFlight.has(r.id); });
    stale.forEach(function (r) { if (inFlight.has(r.id)) holdOp(r.id, { type: "ended", reason: reason }); });
    if (free.length && !commit(slug, entry, function () {
      free.forEach(function (r) { records.sessionGone(r, t, reason); });
    })) return;
    entry.stale.forEach(function (id) { if (!inFlight.has(id)) entry.stale.delete(id); });
  }

  // A record made before its session had a vendor id takes it once it has one.
  function upgradeTargets(slug, entry) {
    if (entry.unhealthy) return;
    var project = deps.getProject(slug);
    if (!project || !project.sm) return;
    var upgrades = [];
    entry.store.all().forEach(function (r) {
      var delivering = inFlight.has(r.id);
      if ((!delivering && !records.isArmed(r)) || r.sessionIdKind !== records.ID_KIND.CONSOLE || entry.stale.has(r.id)) return;
      var session = records.liveSessionOf(project.sm, r);
      if (!session || !session.cliSessionId) return;
      // An in-flight record is changed by settle() only.
      if (delivering) holdOp(r.id, { type: "upgrade", id: session.cliSessionId });
      else upgrades.push({ record: r, id: session.cliSessionId });
    });
    if (!upgrades.length) return;
    commit(slug, entry, function () {
      upgrades.forEach(function (u) {
        u.record.sessionId = u.id;
        u.record.sessionIdKind = records.ID_KIND.VENDOR;
      });
    });
  }

  function attachProject(slug) {
    var project = deps.getProject(slug);
    if (!project) return false;
    var store = createStore({ file: storeFile(project) });
    store.load();
    var entry = { store: store, unhealthy: null, stale: new Set() };
    store.all().forEach(function (r) {
      if (records.isArmed(r) && r.sessionIdKind === records.ID_KIND.CONSOLE) entry.stale.add(r.id);
    });
    var health = store.health();
    if (health.readOnly) entry.unhealthy = { readOnly: true, error: health.error, retryAt: Infinity };
    projects.set(slug, entry);
    endUnstableTargets(slug, entry);
    var t = now();
    store.all().forEach(function (r) {
      if (records.isArmed(r) && dueAt(r) <= t) notBefore.set(r.id, t + STARTUP_GRACE_MS);
    });
    rearm();
    return true;
  }

  function detachProject(slug) {
    var entry = projects.get(slug);
    if (!entry) return;
    entry.store.all().forEach(function (r) { notBefore.delete(r.id); inFlight.delete(r.id); pending.delete(r.id); });
    projects.delete(slug);
    rearm();
  }

  function entryFor(slug) {
    var entry = projects.get(slug);
    return entry || null;
  }

  // --- reads ---

  function armedFor(entry, session) {
    return entry.store.all().filter(function (r) { return records.isArmed(r) && records.recordIsFor(r, session); });
  }

  // The armed records of a live session as its browser lists them: the summary
  // plus the text, cut to what a bubble shows.
  function armedForSession(slug, session) {
    var entry = entryFor(slug);
    if (!entry) return [];
    upgradeTargets(slug, entry);
    return armedFor(entry, session).map(function (r) {
      return Object.assign(records.summarize(r), { text: r.text.slice(0, BUBBLE_TEXT_CHARS) });
    });
  }

  // filter: { sessionId?, state? } state is armed (default), done, ended or any.
  function list(slug, filter) {
    var entry = entryFor(slug);
    if (!entry) return fail("refused", "unknown project " + JSON.stringify(String(slug).slice(0, 64)));
    upgradeTargets(slug, entry);
    filter = filter || {};
    var state = filter.state || STATE.ARMED;
    if (state !== "any" && state !== STATE.ARMED && state !== STATE.DONE && state !== STATE.ENDED) {
      return fail("refused", "unknown state " + JSON.stringify(String(state).slice(0, 32)) + " (use armed, done, ended or any)");
    }
    var project = deps.getProject(slug);
    var live = null;
    if (filter.sessionId) live = records.liveSessionById(project.sm, filter.sessionId);
    var found = entry.store.all().filter(function (r) {
      if (state !== "any" && r.state !== state) return false;
      if (!filter.sessionId) return true;
      return live ? records.recordIsFor(r, live) : r.sessionId === filter.sessionId;
    });
    var listed = { ok: true, result: "listed", count: found.length, inputs: found.map(records.summarize) };
    // A project whose list cannot be saved says so: nothing of it is delivered.
    if (entry.unhealthy) {
      listed.store = { state: entry.unhealthy.readOnly ? "read-only" : "unhealthy", error: entry.unhealthy.error };
    }
    return listed;
  }

  // --- writes ---

  // Resolves the session an id names to the stable target a record keeps.
  // Answers a Promise of { target, session? } or a failure result.
  function resolveTarget(slug, rawId) {
    var project = deps.getProject(slug);
    if (!project || !project.sm) return Promise.resolve(fail("refused", "unknown project " + JSON.stringify(String(slug).slice(0, 64))));
    if (typeof rawId !== "string" || !rawId) return Promise.resolve(fail("refused", "a session id is required"));
    if (!sessionResume.isSafeSessionId(rawId)) return Promise.resolve(fail("refused", "unsafe session id " + JSON.stringify(rawId.slice(0, 64)) + " refused"));
    var live = records.liveSessionById(project.sm, rawId);
    if (live) return Promise.resolve({ ok: true, target: records.targetOf(live), session: live });
    return sessionResume.sessionExistsInStore(project.sm, rawId).then(function (exists) {
      if (!exists) return fail("not-found", "no session " + JSON.stringify(rawId.slice(0, 64)) + " in project " + JSON.stringify(String(slug).slice(0, 64)));
      return { ok: true, target: { sessionId: rawId, sessionIdKind: records.ID_KIND.VENDOR }, session: null };
    }).catch(function (err) {
      return fail("error", "could not look up the session: " + messageOf(err));
    });
  }

  // input: { target, session?, kind, text, note?, createdBy, at?, every?,
  //          until?, count?, exemptFromCap? }
  // target and session come from resolveTarget (or targetOf for a live session).
  function create(slug, input) {
    var entry = entryFor(slug);
    if (!entry) return fail("refused", "unknown project " + JSON.stringify(String(slug).slice(0, 64)));
    var armedHere = entry.store.all().filter(function (r) {
      if (!records.isArmed(r)) return false;
      return input.session ? records.recordIsFor(r, input.session) : records.sameTarget(r, input.target);
    }).length;
    var built = records.buildRecord({
      sessionId: input.target.sessionId,
      sessionIdKind: input.target.sessionIdKind,
      kind: input.kind,
      text: input.text,
      note: input.note,
      createdBy: input.createdBy,
      at: input.at,
      every: input.every,
      until: input.until,
      count: input.count,
    }, { now: now(), armedForSession: armedHere, exemptFromCap: !!input.exemptFromCap });
    if (built.error) return fail("refused", built.error);
    if (!commit(slug, entry, function () { entry.store.add(built.record); })) {
      return fail("error", "could not save the scheduled input" + (entry.unhealthy && entry.unhealthy.readOnly ? ": " + entry.unhealthy.error : ""));
    }
    rearm();
    publish("queued", slug, built.record, input.session || null);
    return { ok: true, result: "scheduled", record: records.summarize(built.record) };
  }

  // session, when given, is the live session the caller is acting for: a record
  // of another session is not found for it.
  function findFor(slug, id, session) {
    var entry = entryFor(slug);
    if (!entry) return { failure: fail("refused", "unknown project " + JSON.stringify(String(slug).slice(0, 64))) };
    var record = entry.store.get(id);
    if (!record || (session && !records.recordIsFor(record, session))) {
      return { failure: fail("not-found", "no scheduled input " + JSON.stringify(String(id).slice(0, 64))) };
    }
    return { entry: entry, record: record };
  }

  function remove(slug, id, session) {
    var found = findFor(slug, id, session);
    if (found.failure) return found.failure;
    // Refused, not held: a deletion held in memory would be answered as done
    // before it is saved, and a crash would bring the record back.
    if (inFlight.has(id)) return fail("busy", "that scheduled input is being sent; try again in a moment");
    var wasArmed = records.isArmed(found.record);
    // A deletion that did not reach the disk would come back after a restart and
    // fire a schedule the person cancelled, so it is refused instead.
    if (!commit(slug, found.entry, function () { found.entry.store.remove(id); })) {
      return fail("error", "could not save the deletion of " + JSON.stringify(String(id).slice(0, 64)));
    }
    notBefore.delete(id);
    rearm();
    if (wasArmed) publish("cancelled", slug, found.record, session || null);
    return { ok: true, result: "deleted", record: records.summarize(found.record) };
  }

  // A person pressed "send now": the record is delivered at once as
  // scheduled-now, even into a running turn.
  function sendNow(slug, id, session) {
    var found = findFor(slug, id, session);
    if (found.failure) return Promise.resolve(found.failure);
    if (!records.isArmed(found.record)) return Promise.resolve(fail("refused", "that scheduled input is no longer armed"));
    if (inFlight.has(id)) return Promise.resolve(fail("refused", "that scheduled input is being sent"));
    return fire(slug, found.record, { initiator: INITIATORS.SCHEDULED_NOW, force: true }).then(function (res) {
      if (res.ok) return { ok: true, result: "sent", record: records.summarize(found.record) };
      return { ok: false, result: res.result, reason: res.reason };
    });
  }

  // The session was closed or deleted (the session object as it was).
  function sessionEnded(slug, session) {
    var entry = entryFor(slug);
    if (!entry || !session) return;
    var t = now();
    var reason = "the session was closed or deleted";
    var every = entry.store.all().filter(function (r) { return (inFlight.has(r.id) || records.isArmed(r)) && records.recordIsFor(r, session); });
    // An in-flight record is changed by settle() only; it is ended there if it is
    // still armed once the delivery's outcome is applied.
    every.forEach(function (r) { if (inFlight.has(r.id)) holdOp(r.id, { type: "ended", reason: reason }); });
    var mine = every.filter(function (r) { return !inFlight.has(r.id); });
    if (!mine.length) return;
    // If this cannot be saved the records stay armed; their next firing finds no
    // session and ends them (see settle()).
    if (!commit(slug, entry, function () {
      mine.forEach(function (r) { records.sessionGone(r, t, reason); });
    })) return;
    mine.forEach(function (r) {
      notBefore.delete(r.id);
      // Not given the session: it is gone, and writing an event into its
      // history would recreate the file the deletion removed.
      publish("ended", slug, r, null);
    });
    rearm();
  }

  // --- the rate-limit resume ---
  // The one record the daemon makes by itself. A session has at most one armed;
  // arming again moves it. It is exempt from the per-session limit (it still
  // counts toward it) so a person's own schedules can never make a rate-limited
  // session lose its resume.

  function armedResume(entry, session) {
    return armedFor(entry, session).filter(function (r) { return r.createdBy === CREATED_BY_RATE_LIMIT && !inFlight.has(r.id); })[0] || null;
  }

  function hasArmedResume(slug, session) {
    var entry = entryFor(slug);
    return !!(entry && armedResume(entry, session));
  }

  function moveResume(record, spec) {
    record.at = spec.at;
    record.nextAt = Math.max(spec.at, spec.armedAt);
    record.text = spec.text;
    record.note = spec.note;
  }

  function armResume(slug, session, spec) {
    var entry = entryFor(slug);
    if (!entry) return fail("refused", "unknown project " + JSON.stringify(String(slug).slice(0, 64)));
    var existing = armedResume(entry, session);
    // Never held and never refused: while a resume is being delivered it is not
    // armed (it was advanced and saved first), so the new one is created durably
    // here, before the answer. If the delivery then fails and the old record would
    // be armed again, settle() ends it in favour of this one.
    if (existing) {
      if (!commit(slug, entry, function () {
        moveResume(existing, { at: spec.at, armedAt: now(), text: spec.text, note: spec.note });
      })) {
        return fail("error", "could not save the scheduled input");
      }
      notBefore.delete(existing.id);
      rearm();
      publish("queued", slug, existing, session);
      return { ok: true, result: "scheduled", record: records.summarize(existing) };
    }
    return create(slug, {
      target: records.targetOf(session),
      session: session,
      kind: KIND.ONCE,
      text: spec.text,
      note: spec.note,
      createdBy: CREATED_BY_RATE_LIMIT,
      at: spec.at,
      exemptFromCap: true,
    });
  }

  function projectSlugs() {
    return Array.from(projects.keys());
  }

  function stop() {
    stopped = true;
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  return {
    attachProject: attachProject,
    detachProject: detachProject,
    projectSlugs: projectSlugs,
    resolveTarget: resolveTarget,
    create: create,
    list: list,
    armedForSession: armedForSession,
    remove: remove,
    sendNow: sendNow,
    sessionEnded: sessionEnded,
    armResume: armResume,
    hasArmedResume: hasArmedResume,
    tick: tick,
    stop: stop,
    CREATED_BY_RATE_LIMIT: CREATED_BY_RATE_LIMIT,
  };
}

module.exports = {
  createScheduledInputService: createScheduledInputService,
  RETRY_BUSY_MS: RETRY_BUSY_MS,
  RETRY_ERROR_MS: RETRY_ERROR_MS,
  MAX_FAILURES: MAX_FAILURES,
  STARTUP_GRACE_MS: STARTUP_GRACE_MS,
  CREATED_BY_RATE_LIMIT: CREATED_BY_RATE_LIMIT,
};
