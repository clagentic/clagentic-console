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

var BATCH_B5 = "lr-d3e1ea";

var BATCHES = [BATCH_B5];

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
  {
    file: "lib/public/css/skills.css",
    keys: ["48px"],
    reason: "The loading and empty states' 48px top and bottom padding is past the largest spacing step (40px); rounding would move it 8px.",
  },
  {
    file: "lib/public/css/skills.css",
    keys: ["margin-bottom: -1px"],
    reason: "A 1px offset coupled to a 1px border (border widths are not on the spacing scale); rounding would break the overlap.",
  },
  {
    file: "lib/public/css/input.css",
    keys: ["56px"],
    reason: "The mobile input area clears the 56px bottom tab bar; the clearance is sized to that bar, past the largest spacing step (40px), and rounding would move it 16px.",
  },
  {
    file: "lib/public/css/icon-strip.css",
    keys: ["64px"],
    reason: "The strip's 64px bottom padding clears the user island that sits over it, past the largest spacing step (40px); rounding would move it 24px.",
  },
  {
    file: "lib/public/css/sidebar.css",
    keys: ["58px"],
    reason: "The sidebar column's 58px bottom padding is a clearance at the foot of the column, past the largest spacing step (40px); rounding would move it 18px.",
  },
  {
    file: "lib/public/css/sidebar.css",
    keys: ["54px"],
    reason: "A session row's 54px right padding (the row with a presence marker) is a clearance at its trailing edge, past the largest spacing step (40px); rounding would move it 14px.",
  },
  {
    file: "lib/public/css/sidebar.css",
    keys: ["36px"],
    reason: "A loop group's 36px right padding is a clearance at its trailing edge and sits between the 32px and 40px spacing steps; rounding would move it 4px.",
  },
  {
    file: "lib/public/css/sidebar.css",
    keys: ["margin-left: -1px"],
    reason: "The resize handle's -1px margin is half of its 2px indicator line, which centres the line on the handle edge; it is sized to the line width, not a spacing step, and rounding to 2px would push the line a full 1px off centre.",
  },
  {
    file: "lib/public/css/server-settings.css",
    keys: ["60px"],
    reason: "The nav's and content's 60px top and bottom clearance beside the safe-area inset is past the largest spacing step (40px); rounding would move it 20px.",
  },
  {
    file: "lib/public/css/server-settings.css",
    keys: ["56px"],
    reason: "The settings palette's 56px top padding clears the shared close control above it, past the largest spacing step (40px); rounding would move it 16px.",
  },
  {
    file: "lib/public/css/server-settings.css",
    keys: ["48px"],
    reason: "The mobile nav header's 48px right padding clears the 36px close button, past the largest spacing step (40px); rounding would move it 8px.",
  },
  {
    file: "lib/public/css/server-settings.css",
    keys: ["var(--space-5) 36px"],
    reason: "A card's 36px right padding is a clearance at its trailing edge and sits between the 32px and 40px spacing steps; rounding would move it 4px.",
  },
  {
    file: "lib/public/css/server-settings.css",
    keys: ["line-height: 36px"],
    reason: "The mobile nav header's 36px line height matches the 36px close button height so the title centres on it, past the largest line-height step (20px); rounding would move it 16px.",
  },
  {
    file: "lib/public/css/scheduler.css",
    keys: ["48px"],
    reason: "The empty state's 48px top and bottom padding is past the largest spacing step (40px); rounding would move it 8px.",
  },
  {
    file: "lib/public/css/scheduler.css",
    keys: ["font-size: 40px"],
    reason: "The empty state's 40px icon size is past the largest type step (28px); rounding would move it 12px.",
  },
]
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
