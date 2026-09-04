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
