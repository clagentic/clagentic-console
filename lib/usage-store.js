// usage-store.js — last-seen account usage per (vendor, bucket).
//
// Vendor-neutral: a bucket is whatever string the adapter reports as
// rateLimitType, kept verbatim. Records live in memory and, when a file is
// configured (the daemon's shared instance), are persisted to JSON and reloaded
// at start. Freshness is computed at read time and never stored, so a reloaded
// record reads stale/expired honestly and is never re-stamped as fresh.

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
  if (!isStrOrNull(r.status) || !isStrOrNull(r.source) || !isStrOrNull(r.sessionLocalId)) return null;
  return {
    utilization: r.utilization,
    utilizationObservedAt: r.utilizationObservedAt,
    resetsAt: r.resetsAt,
    status: r.status,
    observedAt: r.observedAt,
    source: r.source,
    sessionLocalId: r.sessionLocalId,
  };
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

  function writeNow() {
    if (!file) return;
    dirty = false;
    var tmp = file + ".tmp";
    try {
      fsImpl.mkdirSync(pathMod.dirname(file), { recursive: true, mode: 0o700 });
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: STORE_FILE_VERSION, vendors: records }), { mode: 0o600 });
      fsImpl.renameSync(tmp, file);
    } catch (e) {
      log("[usage-store] Clagentic: Console could not persist usage to " + file + ": " + (e && e.message ? e.message : e));
    }
  }

  function schedulePersist() {
    if (!file) return;
    dirty = true;
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      if (dirty) writeNow();
    }, throttleMs);
    if (timer && typeof timer.unref === "function") timer.unref();
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
  function record(vendor, info, meta) {
    if (!vendor || !info || !info.rateLimitType) return;
    if (isUnsafeKey(vendor) || isUnsafeKey(info.rateLimitType)) return;
    meta = meta || {};
    var now = meta.now !== undefined ? meta.now : Date.now();
    var util = typeof info.utilization === "number" ? info.utilization : null;
    var resetsAt = info.resetsAt ? toIso(info.resetsAt * 1000) : null;
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
      status: info.status || null,
      observedAt: toIso(now),
      source: meta.source || null,
      sessionLocalId: meta.sessionLocalId || null,
    };
    schedulePersist();
  }

  function view(rec, now, staleSec) {
    if (!rec) {
      return { utilization: null, resetsAt: null, status: null, observedAt: null, ageSeconds: null, state: "unknown", source: null };
    }
    var ageSeconds = Math.max(0, Math.round((now - Date.parse(rec.observedAt)) / 1000));
    var state = "fresh";
    if (rec.resetsAt && Date.parse(rec.resetsAt) <= now) state = "expired";
    else if (ageSeconds > staleSec) state = "stale";
    return {
      utilization: rec.utilization,
      utilizationObservedAt: rec.utilizationObservedAt,
      resetsAt: rec.resetsAt,
      status: rec.status,
      observedAt: rec.observedAt,
      ageSeconds: ageSeconds,
      state: state,
      source: rec.source,
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
      vendors[vendor] = { buckets: buckets };
    });
    return { generatedAt: toIso(now), staleAfterSeconds: staleSec, vendors: vendors };
  }

  function reset() { records = newMap(); }

  return { record: record, snapshot: snapshot, reset: reset, load: load, flush: flush };
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
  module.exports.snapshot = store.snapshot;
  module.exports.reset = store.reset;
  module.exports.flush = store.flush;
  return store;
}

module.exports = {
  createUsageStore: createUsageStore,
  record: shared.record,
  snapshot: shared.snapshot,
  reset: shared.reset,
  flush: shared.flush,
  enablePersistence: enablePersistence,
  STORE_FILE_NAME: STORE_FILE_NAME,
  DEFAULT_STALE_SECONDS: DEFAULT_STALE_SECONDS,
};
