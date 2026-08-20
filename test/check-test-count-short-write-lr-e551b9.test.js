"use strict";
// Regression test for the lr-e551b9 fold-in (BOBBIE, PR #402 comment
// 5360992190). Both writeSync call sites in scripts/check-test-count.js
// (the ::error:: annotation and the raw TAP dump) used a SINGLE, UNLOOPED
// fs.writeSync call with the return value discarded. fs.writeSync performs
// exactly one write(2) syscall attempt and does not loop to guarantee full
// delivery; a pipe fd can legitimately short-write under backpressure once
// the payload is large enough — the exact condition the multi-MB TAP dump
// this script also writes is built to hit. The existing delivery test
// (test/check-test-count-delivery-lr-e551b9.test.js) gives EMPIRICAL
// coverage — it happens to pass at that fixture's size in this CI shape —
// but nothing in it guarantees the loop as the suite grows or under a
// slower-reader backpressure shape that hits a mid-write short-write instead
// of a single flush boundary. This file unit-tests the write HELPER itself
// (writeFullySync, exported alongside classifyRun/emitAnnotation) with an
// injected write function that deliberately returns partial byte counts, so
// the short-write path is covered structurally, not just empirically.
//
// DEMONSTRATED-FAILURE VERIFICATION (lr-4e1242 convention): this exact
// short-write scenario (a 300KB buffer against a stub that always returns a
// 64KB-capped partial count, mirroring an OS pipe's kernel buffer) was run
// against a PRE-FIX single-unlooped-call shape (`if (buffer.length)
// writeSyncFn(fd, buffer, 0, buffer.length);`, discarding the return value —
// exactly what scripts/check-test-count.js's two writeSync call sites did
// before this diff) in an isolated scratch harness before this file was
// written. It failed with a genuine wrong-content assertion:
//
//   AssertionError [ERR_ASSERTION]: delivered length must equal input length
//   65536 !== 300000
//
// only 65536 of 300000 bytes were ever handed to the stub — the rest was
// silently discarded, reproducing the exact truncation class this task
// exists to eliminate. Against the post-fix looped shape (identical to
// writeFullySync below), the same scenario delivered all 300000 bytes
// exactly. This test below exercises the REAL exported writeFullySync
// function directly (not a reimplementation), so it fails against the
// current working tree if the loop is ever removed or short-circuited.
var test = require("node:test");
var assert = require("node:assert/strict");
var checkTestCount = require("../scripts/check-test-count.js");

test(
  "lr-e551b9 short-write: writeFullySync keeps calling fs.writeSync until a short-write-prone destination has received every byte",
  function () {
    var fs = require("fs");
    var originalWriteSync = fs.writeSync;
    var delivered = [];
    var callCount = 0;
    var CHUNK_CAP = 65536; // mirrors a 64KB OS pipe kernel buffer short-write

    fs.writeSync = function (fd, buffer, offset, length) {
      callCount += 1;
      var n = Math.min(CHUNK_CAP, length);
      delivered.push(Buffer.from(buffer.slice(offset, offset + n)));
      return n;
    };

    var input = Buffer.alloc(300000, 65); // 300KB, comfortably > one chunk cap

    try {
      checkTestCount.writeFullySync(1, input);
    } finally {
      fs.writeSync = originalWriteSync;
    }

    var result = Buffer.concat(delivered);

    assert.ok(
      callCount > 1,
      "the stub must have been invoked more than once for this to be a real short-write test; got " + callCount + " call(s)"
    );
    assert.equal(
      result.length, input.length,
      "writeFullySync must keep looping until the full buffer is delivered, not stop after the first short write"
    );
    assert.ok(
      result.equals(input),
      "the concatenated delivered bytes must equal the input buffer exactly, byte for byte"
    );
  }
);

test(
  "lr-e551b9 short-write: writeFullySync converts a string input to a Buffer once up front, so byte offsets from a short write never misalign against UTF-16 code-unit indices",
  function () {
    var fs = require("fs");
    var originalWriteSync = fs.writeSync;
    var delivered = [];
    // Force a short write partway through a multi-byte UTF-8 sequence: "e"
    // followed by a 3-byte euro sign, encoded as UTF-8 that is 4 bytes total
    // (1 + 3). A cap of 2 forces the split to land INSIDE the euro sign's
    // byte sequence on the first call, which only a byte-indexed Buffer
    // offset (not a JS string character slice) can resume correctly.
    var CHUNK_CAP = 2;

    fs.writeSync = function (fd, buffer, offset, length) {
      var n = Math.min(CHUNK_CAP, length);
      delivered.push(Buffer.from(buffer.slice(offset, offset + n)));
      return n;
    };

    var input = "e€"; // "e" + EURO SIGN, 4 bytes UTF-8, 2 UTF-16 code units

    try {
      checkTestCount.writeFullySync(1, input);
    } finally {
      fs.writeSync = originalWriteSync;
    }

    var result = Buffer.concat(delivered);
    assert.equal(
      result.toString("utf8"), input,
      "the reassembled bytes must decode back to the exact original string, even when a short write splits a multi-byte character"
    );
  }
);
