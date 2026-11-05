"use strict";
// One slice of the random-interleaving seeds of the prompt invariant harness,
// run by a prompt-invariants-random-NN.test.js file. Each slice is its own
// test file, so it runs in a fresh process: the harness slows down as one
// process accumulates runs (about 5 s for the first 15 seeds, about 70 s for
// the later ones), so one file for all 150 seeds took about 12 minutes where
// ten files of 15 take seconds each and run in parallel.
//
// This module only describes a slice. The wrapper file calls describe/test
// itself, because the completion check in scripts/check-test-count.js buckets
// results by the file that registered the test.

var assert = require("node:assert/strict");
var harness = require("./prompt-invariants-harness");

var SEEDS = 150;
var STEPS = 40;
var PARTS = 10;
var SEEDS_PER_PART = SEEDS / PARTS;

// Seeds keep their values (1..SEEDS) whichever file runs them, so together the
// files make the same runs the single loop once made.
function slice(part) {
  var first = (part - 1) * SEEDS_PER_PART + 1;
  var last = part * SEEDS_PER_PART;
  var tally = harness.newTally();
  var completed = false;
  var range = "seeds " + first + " to " + last;

  return {
    suiteName: "random interleavings keep every prompt invariant, for every kind (" + range + ")",
    testName: range,
    timeoutMs: 120000,

    run: async function (t) {
      // Card ack timers must not fire in wall-clock time mid-run.
      if (harness.RENDER) t.mock.timers.enable({ apis: ["setTimeout"] });
      await harness.freshDom();
      for (var seed = first; seed <= last && !t.signal.aborted; seed++) {
        await harness.randomRun(seed, STEPS, tally, t.signal);
      }
      if (t.signal.aborted) return;
      completed = true;
      t.diagnostic("prompt endings across " + range + ": " + JSON.stringify(tally));
    },

    // The seeds are fixed, so every slice's endings are the same on every run:
    // each slice reaches every ending the harness counts, and one that stops
    // doing so has lost coverage. A slice that failed or timed out is already
    // reported and its tally proves nothing.
    assertTally: function () {
      if (!completed) return;
      Object.keys(tally).forEach(function (k) {
        if (k === "dead") return;
        assert.ok(tally[k] > 0, "the random runs never produced a prompt that is '" + k + "': " + JSON.stringify(tally));
      });
      assert.equal(tally.dead, 0, "every prompt open at a restart was ended by it");
    },
  };
}

module.exports = { slice: slice };
