// usage-store.js — last-seen account usage per (vendor, bucket).
//
// Vendor-neutral: a bucket is whatever string the adapter reports as
// rateLimitType, kept verbatim. The store is in-memory in the daemon, so after
// a restart every bucket reads "unknown" until the next event, which is
// truthful. Freshness is computed at read time and never stored.

var { readConsoleEnv } = require("./env-compat");

var DEFAULT_STALE_SECONDS = 30 * 60;
// Buckets listed as "unknown" for every registered vendor even when unseen.
var ALWAYS_LISTED_BUCKETS = ["five_hour", "seven_day"];

function staleAfterSeconds(env) {
  var raw = readConsoleEnv("CLAGENTIC_CONSOLE_USAGE_STALE_SECONDS", { env: env });
  var n = raw === undefined ? NaN : Number(raw);
  return isFinite(n) && n > 0 ? n : DEFAULT_STALE_SECONDS;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function createUsageStore() {
  // vendor -> bucket -> record
  var records = {};

  // info.resetsAt is epoch seconds, as the adapters report it.
  function record(vendor, info, meta) {
    if (!vendor || !info || !info.rateLimitType) return;
    meta = meta || {};
    var now = meta.now !== undefined ? meta.now : Date.now();
    var util = typeof info.utilization === "number" ? info.utilization : null;
    var resetsAt = info.resetsAt ? toIso(info.resetsAt * 1000) : null;
    var byBucket = records[vendor] || (records[vendor] = {});
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
      var seen = records[vendor] || {};
      var names = ALWAYS_LISTED_BUCKETS.slice();
      Object.keys(seen).forEach(function (b) { if (names.indexOf(b) === -1) names.push(b); });
      var buckets = {};
      names.forEach(function (b) { buckets[b] = view(seen[b], now, staleSec); });
      vendors[vendor] = { buckets: buckets };
    });
    return { generatedAt: toIso(now), staleAfterSeconds: staleSec, vendors: vendors };
  }

  function reset() { records = {}; }

  return { record: record, snapshot: snapshot, reset: reset };
}

var shared = createUsageStore();

module.exports = {
  createUsageStore: createUsageStore,
  record: shared.record,
  snapshot: shared.snapshot,
  reset: shared.reset,
  DEFAULT_STALE_SECONDS: DEFAULT_STALE_SECONDS,
};
