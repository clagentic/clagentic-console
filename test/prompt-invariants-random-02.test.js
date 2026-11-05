"use strict";
// Slice 2 of the random prompt interleavings; see prompt-invariants-random.js.
var nodeTest = require("node:test");
var slice = require("./prompt-invariants-random").slice(2);

nodeTest.describe(slice.suiteName, function () {
  nodeTest.after(slice.assertTally);
  nodeTest.test(slice.testName, { timeout: slice.timeoutMs }, slice.run);
});
