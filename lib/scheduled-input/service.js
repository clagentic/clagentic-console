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
// fires at most once and then continues from that delivery.

var path = require("path");

var sessionResume = require("../session-resume");
var { encodeCwd } = require("../utils");
var { INITIATORS } = require("../turn-initiator");
var records = require("./records");
var { createStore } = require("./store");
var target = require("./target");

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

  function rearm() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (stopped) return;
    var earliest = null;
    projects.forEach(function (entry) {
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
      upgradeTargets(slug, entry);
      var changed = false;
      entry.store.all().slice().forEach(function (r) {
        if (!records.isArmed(r) || inFlight.has(r.id) || dueAt(r) > t) return;
        if (records.pastItsEnd(r, t)) {
          records.endReached(r, t);
          changed = true;
          publish("ended", slug, r, null);
          return;
        }
        fire(slug, r, { initiator: INITIATORS.SCHEDULED, force: false });
      });
      if (changed) entry.store.save();
    });
    rearm();
  }

  // --- firing ---

  // Delivers a record's text now. Answers (as a Promise) the firing's result;
  // a delivery moves the record on (afterDelivery), a busy session or an error
  // leaves its cadence alone and tries again shortly.
  function fire(slug, record, how) {
    var entry = projects.get(slug);
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
      if (!entry || projects.get(slug) !== entry || !entry.store.get(record.id)) return res;
      settle(slug, entry, record, res, how);
      rearm();
      return res;
    });
  }

  function settle(slug, entry, record, res, how) {
    var t = now();
    if (res.ok) {
      notBefore.delete(record.id);
      records.afterDelivery(record, t, res.result);
      entry.store.save();
      publish("sent", slug, record, null);
      return;
    }
    if (res.result === "busy") {
      // Skipped, not failed: no write, the same record is tried again soon.
      record.lastOutcome = "skipped: the session was mid-turn";
      notBefore.set(record.id, t + RETRY_BUSY_MS);
      return;
    }
    if (res.result === "not-found") {
      notBefore.delete(record.id);
      records.sessionGone(record, t, "the session no longer exists");
      entry.store.save();
      publish("ended", slug, record, null);
      return;
    }
    // A person's "send now" that failed is reported to them; the schedule goes on.
    if (how.force) return;
    record.failures += 1;
    record.lastOutcome = "error: " + String(res.reason || res.result).slice(0, 200);
    if (record.failures >= MAX_FAILURES) {
      notBefore.delete(record.id);
      records.sessionGone(record, t, "delivery kept failing: " + String(res.reason || res.result).slice(0, 200));
      entry.store.save();
      publish("ended", slug, record, null);
      return;
    }
    notBefore.set(record.id, t + RETRY_ERROR_MS);
    entry.store.save();
    publish("changed", slug, record, null);
  }

  // --- projects ---

  function storeFile(project) {
    return path.join(deps.dir, encodeCwd(project.cwd) + ".json");
  }

  // A record bound by console id belongs to a session that had not run a turn;
  // a restart numbers sessions anew, so it can no longer be trusted to name the
  // same one and ends.
  function endUnstableTargets(slug, entry) {
    var t = now();
    var changed = false;
    entry.store.all().forEach(function (r) {
      if (records.isArmed(r) && r.sessionIdKind === records.ID_KIND.CONSOLE) {
        records.sessionGone(r, t, "the session had not started when the daemon restarted");
        changed = true;
      }
    });
    if (changed) entry.store.save();
  }

  // A record made before its session had a vendor id takes it once it has one.
  function upgradeTargets(slug, entry) {
    var project = deps.getProject(slug);
    if (!project || !project.sm) return;
    var changed = false;
    entry.store.all().forEach(function (r) {
      if (!records.isArmed(r) || r.sessionIdKind !== records.ID_KIND.CONSOLE) return;
      var session = target.liveSessionOf(project.sm, r);
      if (session && session.cliSessionId) {
        r.sessionId = session.cliSessionId;
        r.sessionIdKind = records.ID_KIND.VENDOR;
        changed = true;
      }
    });
    if (changed) entry.store.save();
  }

  function attachProject(slug) {
    var project = deps.getProject(slug);
    if (!project) return false;
    var store = createStore({ file: storeFile(project) });
    store.load();
    var entry = { store: store };
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
    entry.store.all().forEach(function (r) { notBefore.delete(r.id); inFlight.delete(r.id); });
    projects.delete(slug);
    rearm();
  }

  function entryFor(slug) {
    var entry = projects.get(slug);
    return entry || null;
  }

  // --- reads ---

  function armedFor(entry, session) {
    return entry.store.all().filter(function (r) { return records.isArmed(r) && target.recordIsFor(r, session); });
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
    if (filter.sessionId) live = target.liveSessionById(project.sm, filter.sessionId);
    var found = entry.store.all().filter(function (r) {
      if (state !== "any" && r.state !== state) return false;
      if (!filter.sessionId) return true;
      return live ? target.recordIsFor(r, live) : r.sessionId === filter.sessionId;
    });
    return { ok: true, result: "listed", count: found.length, inputs: found.map(records.summarize) };
  }

  // --- writes ---

  // Resolves the session an id names to the stable target a record keeps.
  // Answers a Promise of { target, session? } or a failure result.
  function resolveTarget(slug, rawId) {
    var project = deps.getProject(slug);
    if (!project || !project.sm) return Promise.resolve(fail("refused", "unknown project " + JSON.stringify(String(slug).slice(0, 64))));
    if (typeof rawId !== "string" || !rawId) return Promise.resolve(fail("refused", "a session id is required"));
    if (!sessionResume.isSafeSessionId(rawId)) return Promise.resolve(fail("refused", "unsafe session id " + JSON.stringify(rawId.slice(0, 64)) + " refused"));
    var live = target.liveSessionById(project.sm, rawId);
    if (live) return Promise.resolve({ ok: true, target: target.targetOf(live), session: live });
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
      return input.session ? target.recordIsFor(r, input.session) : target.sameTarget(r, input.target);
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
    entry.store.add(built.record);
    if (!entry.store.save()) {
      entry.store.remove(built.record.id);
      return fail("error", "could not save the scheduled input");
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
    if (!record || (session && !target.recordIsFor(record, session))) {
      return { failure: fail("not-found", "no scheduled input " + JSON.stringify(String(id).slice(0, 64))) };
    }
    return { entry: entry, record: record };
  }

  function remove(slug, id, session) {
    var found = findFor(slug, id, session);
    if (found.failure) return found.failure;
    var wasArmed = records.isArmed(found.record);
    found.entry.store.remove(id);
    notBefore.delete(id);
    found.entry.store.save();
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
    var changed = false;
    entry.store.all().forEach(function (r) {
      if (!records.isArmed(r) || !target.recordIsFor(r, session)) return;
      records.sessionGone(r, t, "the session was closed or deleted");
      notBefore.delete(r.id);
      changed = true;
      // Not given the session: it is gone, and writing an event into its
      // history would recreate the file the deletion removed.
      publish("ended", slug, r, null);
    });
    if (changed) {
      entry.store.save();
      rearm();
    }
  }

  // --- the rate-limit resume ---
  // The one record the daemon makes by itself. A session has at most one armed;
  // arming again moves it. It is exempt from the per-session limit (it still
  // counts toward it) so a person's own schedules can never make a rate-limited
  // session lose its resume.

  function armedResume(entry, session) {
    return armedFor(entry, session).filter(function (r) { return r.createdBy === CREATED_BY_RATE_LIMIT; })[0] || null;
  }

  function hasArmedResume(slug, session) {
    var entry = entryFor(slug);
    return !!(entry && armedResume(entry, session));
  }

  function armResume(slug, session, spec) {
    var entry = entryFor(slug);
    if (!entry) return fail("refused", "unknown project " + JSON.stringify(String(slug).slice(0, 64)));
    var existing = armedResume(entry, session);
    if (existing) {
      existing.at = spec.at;
      existing.nextAt = Math.max(spec.at, now());
      existing.text = spec.text;
      existing.note = spec.note;
      notBefore.delete(existing.id);
      entry.store.save();
      rearm();
      publish("queued", slug, existing, session);
      return { ok: true, result: "scheduled", record: records.summarize(existing) };
    }
    return create(slug, {
      target: target.targetOf(session),
      session: session,
      kind: KIND.ONCE,
      text: spec.text,
      note: spec.note,
      createdBy: CREATED_BY_RATE_LIMIT,
      at: spec.at,
      exemptFromCap: true,
    });
  }

  // The slugs of the projects whose lists this service holds.
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
