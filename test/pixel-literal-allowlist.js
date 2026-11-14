"use strict";

// Every stylesheet that may still hold a pixel literal for font-size, line-height,
// margin, padding, gap or border-radius, and why. A file that is not here takes
// those values from the scales in lib/public/css/base.css (--font-size-*,
// --line-height-*, --space-*, --radius-*), so a new literal fails
// test/pixel-literal-guard.test.js.
//
// A row names one file. With `keys` it allows only the declarations that hold one
// of the keys (a piece of the declaration, such as "999px"); without `keys` it
// allows the whole file, which is only for a file that has not been swept yet and
// then carries the `batch` task that sweeps it. The sweep removes the row, and the
// guard fails on a row whose file no longer holds a literal, so the list only
// shrinks.

var BATCH_B3 = "lr-16d9a0";
var BATCH_B4 = "lr-b182d8";
var BATCH_B5 = "lr-d3e1ea";

var BATCHES = [BATCH_B3, BATCH_B4, BATCH_B5];

function unswept(batch, files) {
  return files.map(function (name) {
    return {
      file: "lib/public/css/" + name + ".css",
      batch: batch,
      reason: "Not swept onto the scales yet; the batch task " + batch + " sweeps this file and removes the row.",
    };
  });
}

var ALLOWLIST = [
  {
    file: "lib/public/css/title-bar.css",
    keys: ["+ 0px"],
    reason: "A zero term that keeps the safe-area sum a length; zero is not a spacing step.",
  },
  {
    file: "lib/public/css/command-palette.css",
    keys: ["env(safe-area-inset-bottom, 0px)"],
    reason: "The zero fallback of the safe-area inset where the platform reports none; zero is not a spacing step.",
  },
  {
    file: "lib/public/css/sticky-notes.css",
    keys: ["80px"],
    reason: "The empty archive's top and bottom clearance is 80px, past the largest spacing step (40px); rounding would halve it.",
  },
  {
    file: "lib/public/css/home-hub.css",
    keys: ["48px", "80px", "44px"],
    reason: "Clearances sized to the hub's close button and the bottom navigation (48px top padding, 80px mobile bottom padding, 44px mobile content offset), past or between the spacing steps; rounding would move them more than 1px.",
  },
]
  .concat(unswept(BATCH_B3, ["skills", "menus", "rewind", "admin", "input", "icon-strip"]))
  .concat(unswept(BATCH_B4, ["mobile-nav", "sidebar", "server-settings", "scheduler"]))
  .concat(unswept(BATCH_B5, ["scheduler-modal", "loop", "overlays", "messages", "filebrowser"]));

// Whether the declaration `decl` in the file `file` (a path relative to the
// repository root, with forward slashes) is on the list. `rows` stands in for the
// list when the guard's own tests need a row of a given shape.
function isAllowed(file, decl, rows) {
  return (rows || ALLOWLIST).some(function (row) {
    if (row.file !== file) return false;
    if (!row.keys) return true;
    return row.keys.some(function (key) { return decl.indexOf(key) !== -1; });
  });
}

module.exports = { ALLOWLIST: ALLOWLIST, BATCHES: BATCHES, isAllowed: isAllowed };
