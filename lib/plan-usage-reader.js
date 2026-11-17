// plan-usage-reader.js — turn-end read of plan usage into the usage store.
//
// The Claude CLI reports rate limits only above its warning threshold, so a
// low utilization is invisible to rate_limit_event. A live query handle that
// can read plan usage (handle.readPlanUsage, a Claude adapter capability that
// resolves readings or null) is asked at turn end, at most once per interval
// per process, and each reading is recorded like a rate-limit event. A handle
// without the method, a null or malformed reading, or a failure records
// nothing and surfaces nothing: the rate_limit_event path is the fallback and
// is untouched.

var usageStore = require("./usage-store");

var DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
var SOURCE = "claude-sdk:get_usage";

// opts (all optional):
//   store       { record }, defaults to the shared usage store (looked up at call
//               time, because enabling persistence swaps its functions)
//   intervalMs  minimum spacing between reads
//   now         function() -> ms, for tests
function createPlanUsageReader(opts) {
  opts = opts || {};
  var store = opts.store || usageStore;
  var intervalMs = opts.intervalMs !== undefined ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  var clock = opts.now || Date.now;
  // The spacing starts when a read is issued, so a failing read is not retried
  // by every turn that ends inside the interval.
  var lastIssuedAt = null;

  // Resolves true when a read was issued, whatever it returned. Never rejects.
  function maybeRead(handle, vendor) {
    if (!handle || typeof handle.readPlanUsage !== "function" || !vendor) return Promise.resolve(false);
    var now = clock();
    if (lastIssuedAt !== null && now - lastIssuedAt < intervalMs) return Promise.resolve(false);
    lastIssuedAt = now;
    var pending;
    try {
      pending = Promise.resolve(handle.readPlanUsage());
    } catch (e) {
      return Promise.resolve(true);
    }
    return pending.then(function (readings) {
      if (!Array.isArray(readings)) return true;
      readings.forEach(function (info) {
        try {
          store.record(vendor, info, { source: SOURCE, now: now, keepStatus: true });
        } catch (e) {
          // A reading that cannot be recorded is dropped, like a malformed one.
        }
      });
      return true;
    }, function () {
      return true;
    });
  }

  return { maybeRead: maybeRead };
}

module.exports = {
  createPlanUsageReader: createPlanUsageReader,
  DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  SOURCE: SOURCE,
};
