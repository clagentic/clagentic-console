"use strict";
//
// test-file-completion-reporter.js — custom `node --test` reporter for
// scripts/check-test-count.js (lr-795882, hardened after PEACHES/BOBBIE PR
// #395 review).
//
// WHY A CUSTOM REPORTER, NOT TAP TEXT PARSING: when `node --test` is given
// multiple file arguments, all of them run in ONE shared process and their
// results interleave into a single flat TAP stream with no per-file marker
// in the human-readable text — there is no way to tell from TAP output
// alone whether every file in the glob actually reported. An earlier
// version of this check ran each file as its OWN `node --test` invocation
// to get per-file attribution, but that changes timing/jitter
// characteristics enough to expose an unrelated pre-existing flake
// (test/project-connection-hydrate-session-model-lr-041af8.test.js's
// millisecond-tie-break race in findRestoredActiveSession, filed
// separately as a follow-up) — a mechanism change should not itself
// introduce new failure risk. Node's reporter API (this file) receives a
// `file` field on every test:pass/test:fail event regardless of TAP's own
// text output, so this gets real per-file attribution from the SAME
// single-process run `npm test` has always used, with no isolation/timing
// change at all.
//
// CONTRACT: this reporter is used TOGETHER with the default `tap` reporter
// (`node --test --test-reporter=tap --test-reporter-destination=stdout
// --test-reporter=./test-file-completion-reporter.js
// --test-reporter-destination=stderr`, see check-test-count.js) — Node
// supports multiple --test-reporter flags, each with its own
// --test-reporter-destination, so a developer running `npm test` still
// sees normal TAP output on stdout; this reporter's machine-readable
// RESULT lines go to a separate stream that scripts/check-test-count.js
// parses. Output shape, one line per test:pass/test:fail event:
//   RESULT <pass|fail> <absolute-file-path>

module.exports = async function* fileCompletionReporter(source) {
  for await (var event of source) {
    if (event.type === "test:pass" || event.type === "test:fail") {
      var file = (event.data && event.data.file) || "";
      var kind = event.type === "test:pass" ? "pass" : "fail";
      yield "RESULT " + kind + " " + file + "\n";
    }
  }
};
