// memory-setting-validate-lr-553d27.test.js
//
// Unit coverage for the pure validators extracted for lr-553d27 (see
// lib/memory-setting-validate.js header comment for why this was extracted:
// a single shared contract for the memAvailableMinMB / tokensPerMbHeadroom
// range checks, instead of two independently-maintained copies -- the
// divergence between which was the actual root cause of the raw IPC path's
// silent-clamp defect).
//
// This file covers the pure function in isolation; it is NOT a substitute
// for the reachability coverage in
// test/daemon-ipc-memory-setter-parity-lr-553d27.test.js, which proves a
// real caller over the real raw IPC socket gets this exact behavior (see
// that file's header comment on plumbing vs. reachability coverage,
// tome #845).

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var {
  validateMemAvailableThresholdMB,
  validateTokensPerMbHeadroom,
} = require("../lib/memory-setting-validate");

test("validateMemAvailableThresholdMB: rejects a negative value with a band-naming error", function () {
  var result = validateMemAvailableThresholdMB(-5);
  assert.equal(result.ok, false);
  assert.match(result.error, />=\s*0/);
});

test("validateMemAvailableThresholdMB: rejects a non-numeric value", function () {
  var result = validateMemAvailableThresholdMB("not-a-number");
  assert.equal(result.ok, false);
});

test("validateMemAvailableThresholdMB: accepts 0 (legitimate 'disable this gate' value, lr-93e3c8 finding 1)", function () {
  var result = validateMemAvailableThresholdMB(0);
  assert.equal(result.ok, true);
  assert.equal(result.value, 0);
});

test("validateMemAvailableThresholdMB: accepts a positive in-range value unchanged", function () {
  var result = validateMemAvailableThresholdMB(512);
  assert.equal(result.ok, true);
  assert.equal(result.value, 512);
});

test("validateTokensPerMbHeadroom: rejects a value above the band (1000) with a band-naming error", function () {
  var result = validateTokensPerMbHeadroom(1000);
  assert.equal(result.ok, false);
  assert.match(result.error, /10-500/);
});

test("validateTokensPerMbHeadroom: rejects a value below the band (5)", function () {
  var result = validateTokensPerMbHeadroom(5);
  assert.equal(result.ok, false);
  assert.match(result.error, /10-500/);
});

test("validateTokensPerMbHeadroom: accepts the lower boundary (10)", function () {
  var result = validateTokensPerMbHeadroom(10);
  assert.equal(result.ok, true);
  assert.equal(result.value, 10);
});

test("validateTokensPerMbHeadroom: accepts the upper boundary (500)", function () {
  var result = validateTokensPerMbHeadroom(500);
  assert.equal(result.ok, true);
  assert.equal(result.value, 500);
});

test("validateTokensPerMbHeadroom: accepts an in-range value unchanged", function () {
  var result = validateTokensPerMbHeadroom(300);
  assert.equal(result.ok, true);
  assert.equal(result.value, 300);
});

// ---------------------------------------------------------------------------
// Prefix-string coercion (fold-in, BOBBIE PR #417 coercion review): parseInt
// alone truncate-parses a garbage-suffixed string ("300abc" -> 300) instead
// of rejecting it, silently substituting a different value than the caller
// sent -- the same "reports success while nothing happened" contract
// violation this task exists to eliminate, one level below the out-of-range
// case. A clean numeric STRING (e.g. "1000") must still be accepted -- only
// malformed input is rejected.
// ---------------------------------------------------------------------------

test("validateTokensPerMbHeadroom: rejects a prefix-numeric garbage-suffixed string ('300abc') instead of truncate-parsing it to 300", function () {
  var result = validateTokensPerMbHeadroom("300abc");
  assert.equal(result.ok, false, "\"300abc\" must be rejected, not silently truncate-parsed to 300");
  assert.match(result.error, /10-500/);
});

test("validateMemAvailableThresholdMB: rejects a prefix-numeric garbage-suffixed string ('128xyz') instead of truncate-parsing it to 128", function () {
  var result = validateMemAvailableThresholdMB("128xyz");
  assert.equal(result.ok, false, "\"128xyz\" must be rejected, not silently truncate-parsed to 128");
});

test("validateTokensPerMbHeadroom: still accepts a clean in-range numeric STRING ('300') -- a plausible caller over a JSON socket", function () {
  var result = validateTokensPerMbHeadroom("300");
  assert.equal(result.ok, true, "a clean numeric string must remain accepted -- only malformed input is rejected");
  assert.equal(result.value, 300);
});

test("validateMemAvailableThresholdMB: still accepts a clean numeric STRING ('1000') -- a plausible caller over a JSON socket", function () {
  var result = validateMemAvailableThresholdMB("1000");
  assert.equal(result.ok, true);
  assert.equal(result.value, 1000);
});

test("validateTokensPerMbHeadroom: rejects a decimal-fraction string ('300.5') rather than truncating it", function () {
  var result = validateTokensPerMbHeadroom("300.5");
  assert.equal(result.ok, false, "a fractional value must be rejected, not silently floored to 300");
});

test("validateTokensPerMbHeadroom: rejects leading/trailing whitespace-wrapped garbage ('  300 tokens  ')", function () {
  var result = validateTokensPerMbHeadroom("  300 tokens  ");
  assert.equal(result.ok, false);
});

test("validateTokensPerMbHeadroom: still accepts a whitespace-padded clean numeric string ('  300  ')", function () {
  var result = validateTokensPerMbHeadroom("  300  ");
  assert.equal(result.ok, true, "surrounding whitespace around an otherwise-clean numeric string is not the malformed-input case this fix targets");
  assert.equal(result.value, 300);
});
