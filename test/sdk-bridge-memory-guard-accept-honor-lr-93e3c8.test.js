/**
 * Regression tests for lr-93e3c8 (PEACHES fold-in, PR #414): two
 * "saved-but-not-effective" defects on the memory-guard surface.
 *
 * Finding 1 — accept/honor mismatch on memAvailableMinMB:
 *   daemon.js's onSetMemAvailableThreshold (and the CLI IPC path) both
 *   accept and persist 0 as a legitimate "disable this threshold" value,
 *   but the consuming guard in sdk-bridge.js's startQuery previously used a
 *   `> 0` check, so a configured 0 was silently discarded in favor of the
 *   1024 MB default — the operator got a "Saved" acknowledgement for a
 *   setting that did nothing. resolveMemAvailableThresholdMB is the pure
 *   function this consumer now goes through; these tests pin the
 *   accept/honor agreement directly, without needing to fake
 *   /proc/meminfo (readMemAvailableMB reads the real file and is not
 *   host-independently mockable).
 *
 * Finding 2 — cgroup-block cause-attribution boundary + null-read fallback:
 *   computeCgroupBlockCauseMessage's "is the host generous" check was
 *   `hostMemAvailMB > cgHeadroomMB * 2`, which inverts at exactly the 2x
 *   boundary (e.g. 4096 MB host-available / 2048 MB cgroup headroom is
 *   exactly 2x, so `4096 > 4096` is false) and asserted "genuinely low"
 *   even though the host was not under pressure. A null host read (never
 *   measured) fell into the same branch by default. Both are fixed to
 *   never claim a cause the code has not actually established.
 */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var {
  resolveMemAvailableThresholdMB,
  computeCgroupBlockCauseMessage,
  DEFAULT_MEM_AVAILABLE_MIN_MB,
} = require("../lib/sdk-bridge");

// ---------------------------------------------------------------------------
// Finding 1: resolveMemAvailableThresholdMB — accept/honor agreement
// ---------------------------------------------------------------------------

test("resolveMemAvailableThresholdMB: a configured 0 is honored as 0, not silently replaced by the default", function () {
  var threshold = resolveMemAvailableThresholdMB({ memAvailableMinMB: 0 });
  assert.equal(threshold, 0, "0 must be honored -- it is a legitimate 'disable this gate' value the setter accepts and persists");
});

test("resolveMemAvailableThresholdMB: a positive configured value is honored as-is", function () {
  assert.equal(resolveMemAvailableThresholdMB({ memAvailableMinMB: 512 }), 512);
});

test("resolveMemAvailableThresholdMB: no config object falls back to the default", function () {
  assert.equal(resolveMemAvailableThresholdMB(null), DEFAULT_MEM_AVAILABLE_MIN_MB);
});

test("resolveMemAvailableThresholdMB: memAvailableMinMB absent from config falls back to the default", function () {
  assert.equal(resolveMemAvailableThresholdMB({}), DEFAULT_MEM_AVAILABLE_MIN_MB);
});

test("resolveMemAvailableThresholdMB: a non-number config value falls back to the default (defensive)", function () {
  assert.equal(resolveMemAvailableThresholdMB({ memAvailableMinMB: "0" }), DEFAULT_MEM_AVAILABLE_MIN_MB);
});

test("resolveMemAvailableThresholdMB: a negative configured value falls back to the default (setter already rejects negatives, but the consumer must not trust a corrupted config file)", function () {
  assert.equal(resolveMemAvailableThresholdMB({ memAvailableMinMB: -5 }), DEFAULT_MEM_AVAILABLE_MIN_MB);
});

// ---------------------------------------------------------------------------
// Finding 2: computeCgroupBlockCauseMessage — boundary + null-read handling
// ---------------------------------------------------------------------------

test("computeCgroupBlockCauseMessage: exactly 2x host/cgroup headroom is treated as host-generous, not 'genuinely low'", function () {
  // 4096 MB host-available, 2048 MB cgroup headroom -- exactly 2x.
  var msg = computeCgroupBlockCauseMessage(4096, 2048);
  assert.match(msg, /service memory cap.*is the limiting factor/, "at exactly 2x, the message must attribute the block to the service cap, not host pressure");
  assert.doesNotMatch(msg, /genuinely low/);
});

test("computeCgroupBlockCauseMessage: just below 2x is genuinely low (host is the limiting factor)", function () {
  var msg = computeCgroupBlockCauseMessage(4095, 2048);
  assert.match(msg, /genuinely low/);
});

test("computeCgroupBlockCauseMessage: well above 2x is host-generous", function () {
  var msg = computeCgroupBlockCauseMessage(10000, 2048);
  assert.match(msg, /service memory cap.*is the limiting factor/);
});

test("computeCgroupBlockCauseMessage: a null host read (unreadable /proc/meminfo, or non-Linux) never claims host memory pressure", function () {
  var msg = computeCgroupBlockCauseMessage(null, 2048);
  assert.doesNotMatch(msg, /genuinely low/, "must not assert a cause (host pressure) that was never actually measured");
  assert.doesNotMatch(msg, /is the limiting factor, not host memory/, "must not assert the host is generous either -- it was never measured");
  assert.match(msg, /[Cc]ould not read host memory/);
});
