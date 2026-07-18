// toast-error-duration-lr-76fbc3.test.js — regression coverage for lr-76fbc3
// debuggability requirement.
//
// The worktree-remove failure toast ("...is not a valid worktree") used the
// default showToast() duration (1500ms) for level "error", the same as a
// plain success toast. That is too fast to read an error message, which is
// why the underlying path-resolution bug (fixed in
// worktree-remove-path-mismatch-lr-76fbc3.test.js) was so hard to diagnose
// from the UI. Fix: "error" toasts now get the same longer window as "warn"
// toasts (5000ms) so failure text is actually readable.
//
// utils.js's showToast() touches document/requestAnimationFrame with no DOM
// harness in this suite (see the existing diagnostics-toast-*-lr-*.test.js
// convention) — this is a source-text regression check matching that
// convention.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var UTILS_JS = fs.readFileSync(
  path.join(__dirname, "../lib/public/modules/utils.js"),
  "utf8"
);

test("lr-76fbc3: showToast gives 'error' level toasts the same non-default duration as 'warn' (not the 1500ms default)", function () {
  var idx = UTILS_JS.indexOf("var duration =");
  assert.ok(idx !== -1, "expected a `var duration =` assignment in showToast");
  var line = UTILS_JS.slice(idx, UTILS_JS.indexOf("\n", idx));

  assert.match(
    line,
    /level\s*===\s*["']warn["']/,
    "duration must still special-case 'warn'"
  );
  assert.match(
    line,
    /level\s*===\s*["']error["']/,
    "duration must ALSO special-case 'error' -- a fast-dismissing error toast is undebuggable (lr-76fbc3)"
  );
});
