// usage-store.js — last-seen account usage per (vendor, bucket).
//
// Vendor-neutral: a bucket is whatever string the adapter reports as
// rateLimitType, kept verbatim. Records live in memory and, when a file is
// configured (the daemon's shared instance), are persisted to JSON and reloaded
// at start. Freshness is computed at read time and never stored, so a reloaded
// record reads stale/expired honestly and is never re-stamped as fresh.
//
// Two timestamps per bucket: observedAt (the last reported event, i.e. the last
// time the value changed) and confirmedAt (the last evidence the value still
// holds). Some adapters report only on change, so a steady value goes silent
// while sessions keep running; confirm() lets the caller say "a session whose
// process has already reported just completed a turn without a change". Age and
// state are computed from the newer of the two.

var fsDefault = require("fs");
var pathMod = require("path");
var { readConsoleEnv } = require("./env-compat");

var DEFAULT_STALE_SECONDS = 30 * 60;
// Buckets listed as "unknown" for every registered vendor even when unseen.
var ALWAYS_LISTED_BUCKETS = ["five_hour", "seven_day"];
var DEFAULT_THROTTLE_MS = 5000;
var STORE_FILE_NAME = "usage-store.json";
var STORE_FILE_VERSION = 1;

function staleAfterSeconds(env) {
  var raw = readConsoleEnv("CLAGENTIC_CONSOLE_USAGE_STALE_SECONDS", { env: env });
  var n = raw === undefined ? NaN : Number(raw);
  return isFinite(n) && n > 0 ? n : DEFAULT_STALE_SECONDS;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function isIsoOrNull(v) {
  return v === null || (typeof v === "string" && isFinite(Date.parse(v)));
}
function isStrOrNull(v) {
  return v === null || typeof v === "string";
}
// Session ids arrive as numbers from the session layer and as strings from
// older files; both are stored as strings, which is also how confirm() and
// endProcess() key them. Anything else is not an id.
function idOrNull(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" && isFinite(v)) return String(v);
  return null;
}
function strOrNull(v) {
  return typeof v === "string" ? v : null;
}
function finiteOrNull(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}
// Epoch seconds to ISO, or null when the value is not a representable time.
function epochSecondsToIsoOrNull(sec) {
  if (typeof sec !== "number" || !isFinite(sec) || sec === 0) return null;
  var ms = sec * 1000;
  return isFinite(new Date(ms).getTime()) ? toIso(ms) : null;
}

// Vendor and bucket names come from persisted JSON and CLI output, so they are
// untrusted. Internal maps have no prototype (a name like "constructor" or
// "toString" cannot resolve to an inherited member) and "__proto__" is refused
// outright because the snapshot output objects are plain.
function newMap() {
  return Object.create(null);
}
function isUnsafeKey(k) {
  return k === "__proto__";
}

// Returns a normalised record, or null when the stored one is malformed.
function validRecord(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  if (typeof r.observedAt !== "string" || !isFinite(Date.parse(r.observedAt))) return null;
  if (!(r.utilization === null || (typeof r.utilization === "number" && isFinite(r.utilization)))) return null;
  if (!isIsoOrNull(r.utilizationObservedAt) || !isIsoOrNull(r.resetsAt)) return null;
  if (!isStrOrNull(r.status) || !isStrOrNull(r.source)) return null;
  var sessionLocalId = r.sessionLocalId === undefined ? null : r.sessionLocalId;
  if (sessionLocalId !== null && idOrNull(sessionLocalId) === null) return null;
  // confirmedAt is absent in files written before confirmation existed.
  var confirmedAt = r.confirmedAt === undefined ? null : r.confirmedAt;
  if (!isIsoOrNull(confirmedAt)) return null;
  return {
    utilization: r.utilization,
    utilizationObservedAt: r.utilizationObservedAt,
    resetsAt: r.resetsAt,
    status: r.status,
    observedAt: r.observedAt,
    confirmedAt: confirmedAt,
    source: r.source,
    sessionLocalId: idOrNull(sessionLocalId),
  };
}

function newestMs(rec) {
  var o = Date.parse(rec.observedAt);
  var c = rec.confirmedAt ? Date.parse(rec.confirmedAt) : -Infinity;
  return Math.max(o, c);
}

// opts (all optional; no file means no I/O):
//   file        persistence path
//   fs          fs implementation (tests)
//   log         function(message), defaults to console.log
//   throttleMs  minimum spacing between writes
function createUsageStore(opts) {
  opts = opts || {};
  var file = opts.file || null;
  var fsImpl = opts.fs || fsDefault;
  var log = opts.log || function (m) { console.log(m); };
  var throttleMs = opts.throttleMs !== undefined ? opts.throttleMs : DEFAULT_THROTTLE_MS;
  var timer = null;
  var dirty = false;
  // vendor -> bucket -> record
  var records = newMap();
  // vendor -> session id -> { proc, bucket }: the bucket the session's current
  // process last reported. In memory only; a process never outlives the daemon.
  var emitters = newMap();
  // vendors that produced any evidence since this store was created (not
  // counting records loaded from the file)
  var seenThisRun = newMap();

  // dirty is cleared only once both the tmp write and the rename succeed, so a
  // transient failure (ENOSPC, EACCES) leaves the change pending. A failed
  // write schedules a retry through the same throttle timer, which bounds
  // retries to one per throttle interval.
  function writeNow() {
    if (!file) return;
    var tmp = file + ".tmp";
    try {
      fsImpl.mkdirSync(pathMod.dirname(file), { recursive: true, mode: 0o700 });
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: STORE_FILE_VERSION, vendors: records }), { mode: 0o600 });
      fsImpl.renameSync(tmp, file);
      dirty = false;
    } catch (e) {
      log("[usage-store] Clagentic: Console could not persist usage to " + file + ": " + (e && e.message ? e.message : e));
      try {
        if (typeof fsImpl.unlinkSync === "function") fsImpl.unlinkSync(tmp);
      } catch (u) {
        if (!u || u.code !== "ENOENT") {
          log("[usage-store] Clagentic: Console could not remove " + tmp + ": " + (u && u.message ? u.message : u));
        }
      }
      armTimer();
    }
  }

  function armTimer() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      if (dirty) writeNow();
    }, throttleMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function schedulePersist() {
    if (!file) return;
    dirty = true;
    armTimer();
  }

  // Write any pending change immediately (daemon shutdown, tests).
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (dirty) writeNow();
  }

  // Replace in-memory records from the file. A missing file is quiet; an
  // unparseable or wrong-shape file is logged and set aside as <file>.corrupt.
  function load() {
    if (!file) return;
    var raw;
    try {
      raw = fsImpl.readFileSync(file, "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") return;
      log("[usage-store] Clagentic: Console could not read " + file + ", starting empty: " + (e && e.message ? e.message : e));
      return;
    }
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = undefined; }
    var ok = parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      parsed.vendors && typeof parsed.vendors === "object" && !Array.isArray(parsed.vendors);
    if (!ok) {
      var aside = file + ".corrupt";
      var note = "";
      try { fsImpl.renameSync(file, aside); note = "; kept as " + aside; } catch (e) { note = "; could not move it aside"; }
      log("[usage-store] Clagentic: Console usage file " + file + " is unreadable or has the wrong shape, starting empty" + note);
      return;
    }
    var loaded = newMap();
    var dropped = 0;
    Object.keys(parsed.vendors).forEach(function (vendor) {
      var buckets = parsed.vendors[vendor];
      if (isUnsafeKey(vendor)) { dropped++; return; }
      if (!buckets || typeof buckets !== "object" || Array.isArray(buckets)) { dropped++; return; }
      Object.keys(buckets).forEach(function (b) {
        var rec = isUnsafeKey(b) ? null : validRecord(buckets[b]);
        if (!rec) { dropped++; return; }
        (loaded[vendor] || (loaded[vendor] = newMap()))[b] = rec;
      });
    });
    records = loaded;
    if (dropped > 0) log("[usage-store] Clagentic: Console dropped " + dropped + " malformed usage record(s) from " + file);
  }

  // info.resetsAt is epoch seconds, as the adapters report it.
  //
  // meta.processKey (optional) identifies the session's current process; with
  // meta.sessionLocalId it registers the session as an emitter that confirm()
  // may later act for.
  function record(vendor, info, meta) {
    if (!vendor || !info) return;
    if (!info.rateLimitType) {
      log("[usage-store] Clagentic: Console dropped a rate-limit event with no rateLimitType (vendor=" + vendor + " status=" + (info.status || "none") + ")");
      return;
    }
    if (isUnsafeKey(vendor) || isUnsafeKey(info.rateLimitType)) return;
    meta = meta || {};
    var now = meta.now !== undefined ? meta.now : Date.now();
    var util = finiteOrNull(info.utilization);
    var resetsAt = epochSecondsToIsoOrNull(info.resetsAt);
    var byBucket = records[vendor] || (records[vendor] = newMap());
    var prev = byBucket[info.rateLimitType];
    var utilizationObservedAt = util !== null ? toIso(now) : null;

    // An event without a utilization must not erase a known one for the same
    // reset window; the old value keeps its own observation time.
    if (util === null && prev && prev.utilization !== null && prev.resetsAt === resetsAt) {
      util = prev.utilization;
      utilizationObservedAt = prev.utilizationObservedAt;
    }

    byBucket[info.rateLimitType] = {
      utilization: util,
      utilizationObservedAt: utilizationObservedAt,
      resetsAt: resetsAt,
      status: strOrNull(info.status) || null,
      observedAt: toIso(now),
      confirmedAt: null,
      source: strOrNull(meta.source) || null,
      sessionLocalId: idOrNull(meta.sessionLocalId) || null,
    };
    seenThisRun[vendor] = true;
    if (meta.processKey && meta.sessionLocalId && !isUnsafeKey(String(meta.sessionLocalId))) {
      var bySession = emitters[vendor] || (emitters[vendor] = newMap());
      bySession[String(meta.sessionLocalId)] = { proc: meta.processKey, bucket: info.rateLimitType };
    }
    schedulePersist();
  }

  // A session whose current process has reported at least once completed a
  // turn: the bucket that process last reported still holds. Returns true when
  // a bucket was confirmed. A session that has not reported, or whose process
  // changed, confirms nothing.
  function confirm(vendor, who, meta) {
    if (!vendor || !who || !who.sessionLocalId || isUnsafeKey(vendor) || isUnsafeKey(String(who.sessionLocalId))) return false;
    var entry = emitters[vendor] && emitters[vendor][String(who.sessionLocalId)];
    if (!entry || entry.proc !== who.processKey) return false;
    var rec = records[vendor] && records[vendor][entry.bucket];
    if (!rec) return false;
    var now = meta && meta.now !== undefined ? meta.now : Date.now();
    rec.confirmedAt = toIso(now);
    seenThisRun[vendor] = true;
    schedulePersist();
    return true;
  }

  // The session's process ended or restarted. With processKey, only that
  // process's entry is cleared, so a newer process of the same session keeps its own.
  function endProcess(vendor, sessionLocalId, processKey) {
    var by = emitters[vendor];
    if (!by || sessionLocalId === undefined || sessionLocalId === null) return;
    var id = String(sessionLocalId);
    if (!by[id]) return;
    if (processKey !== undefined && by[id].proc !== processKey) return;
    delete by[id];
  }

  function view(rec, now, staleSec) {
    if (!rec) {
      return { utilization: null, resetsAt: null, status: null, observedAt: null, confirmedAt: null, ageSeconds: null, state: "unknown", source: null, utilizationConfirmed: false };
    }
    var newest = newestMs(rec);
    var ageSeconds = Math.max(0, Math.round((now - newest) / 1000));
    var state = "fresh";
    if (rec.resetsAt && Date.parse(rec.resetsAt) <= now) state = "expired";
    else if (ageSeconds > staleSec) state = "stale";
    // The adapter's change test covers utilization, so a confirmation also
    // confirms it, but only when the latest event itself carried the value.
    var utilizationConfirmed = rec.utilization !== null && rec.confirmedAt !== null &&
      rec.utilizationObservedAt === rec.observedAt;
    var out = {
      utilization: rec.utilization,
      utilizationObservedAt: rec.utilizationObservedAt,
      utilizationConfirmed: utilizationConfirmed,
      resetsAt: rec.resetsAt,
      status: rec.status,
      observedAt: rec.observedAt,
      confirmedAt: rec.confirmedAt,
      ageSeconds: ageSeconds,
      state: state,
      source: rec.source,
    };
    if (state === "stale") {
      out.staleReason = "no rate-limit change reported and no confirming session result since " + toIso(newest);
    }
    return out;
  }

  function freshness(vendor, seen, now, staleSec) {
    var lastEvent = null;
    var lastConfirmed = null;
    Object.keys(seen).forEach(function (b) {
      var o = Date.parse(seen[b].observedAt);
      if (lastEvent === null || o > lastEvent) lastEvent = o;
      if (seen[b].confirmedAt) {
        var c = Date.parse(seen[b].confirmedAt);
        if (lastConfirmed === null || c > lastConfirmed) lastConfirmed = c;
      }
    });
    var active = emitters[vendor] ? Object.keys(emitters[vendor]).length : 0;
    var newest = lastEvent === null ? null : Math.max(lastEvent, lastConfirmed === null ? -Infinity : lastConfirmed);
    var reason;
    if (!seenThisRun[vendor]) reason = "no_event_since_start";
    else if (newest !== null && (now - newest) / 1000 > staleSec && active === 0) reason = "no_active_session";
    else if (lastConfirmed !== null && lastConfirmed > lastEvent) reason = "confirmed_by_result";
    else reason = "event";
    return {
      lastEventAt: lastEvent === null ? null : toIso(lastEvent),
      lastConfirmedAt: lastConfirmed === null ? null : toIso(lastConfirmed),
      activeSessions: active,
      reason: reason,
    };
  }

  // opts.vendorIds: registered vendors, always listed with the standard buckets.
  function snapshot(opts) {
    opts = opts || {};
    var now = opts.now !== undefined ? opts.now : Date.now();
    var staleSec = opts.staleSeconds !== undefined ? opts.staleSeconds : staleAfterSeconds(opts.env);
    var ids = Object.keys(records);
    (opts.vendorIds || []).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
    var vendors = {};
    ids.forEach(function (vendor) {
      var seen = records[vendor] || newMap();
      var names = ALWAYS_LISTED_BUCKETS.slice();
      Object.keys(seen).forEach(function (b) { if (names.indexOf(b) === -1) names.push(b); });
      var buckets = {};
      names.forEach(function (b) { buckets[b] = view(seen[b], now, staleSec); });
      vendors[vendor] = { freshness: freshness(vendor, seen, now, staleSec), buckets: buckets };
    });
    return { generatedAt: toIso(now), staleAfterSeconds: staleSec, vendors: vendors };
  }

  function reset() { records = newMap(); emitters = newMap(); seenThisRun = newMap(); }

  return { record: record, confirm: confirm, endProcess: endProcess, snapshot: snapshot, reset: reset, load: load, flush: flush };
}

// The shared instance does no file I/O until the daemon gives it a path.
var sharedOpts = {};
var shared = createUsageStore(sharedOpts);

// Returns a persistent store bound to `file`, loaded from it, and installs it
// as the shared instance's backend.
function enablePersistence(file, extra) {
  var store = createUsageStore(Object.assign({ file: file }, extra || {}));
  store.load();
  shared = store;
  module.exports.record = store.record;
  module.exports.confirm = store.confirm;
  module.exports.endProcess = store.endProcess;
  module.exports.snapshot = store.snapshot;
  module.exports.reset = store.reset;
  module.exports.flush = store.flush;
  return store;
}

// The vendor a session's usage is keyed under. One definition so record,
// confirm and endProcess can never disagree about it.
function usageVendorFor(session, adapter) {
  return session.vendor || (adapter && adapter.vendor) || "claude";
}

module.exports = {
  createUsageStore: createUsageStore,
  usageVendorFor: usageVendorFor,
  record: shared.record,
  confirm: shared.confirm,
  endProcess: shared.endProcess,
  snapshot: shared.snapshot,
  reset: shared.reset,
  flush: shared.flush,
  enablePersistence: enablePersistence,
  STORE_FILE_NAME: STORE_FILE_NAME,
  DEFAULT_STALE_SECONDS: DEFAULT_STALE_SECONDS,
};
