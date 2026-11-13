"use strict";

// Every colour literal that may stay in a shipped file, and why. A literal that
// is not here follows the active theme (a token from the palette in
// lib/public/theme-core.js), so a new one fails test/colour-literal-guard.test.js.
//
// A row names one file and one or more keys. A key that is a colour literal
// ("#00CFFF") allows that literal in that file; any other key is a piece of the
// line (a selector or a statement) and allows the literals on a line that holds
// it. A row is never a whole file: add the narrowest key that covers the
// literal, and give the reason.
var ALLOWLIST = [
  {
    file: "lib/default-avatar-color.js",
    keys: ["#7c3aed"],
    reason: "The colour a user gets before choosing one. It is stored profile data, so it does not follow the theme.",
  },
  {
    file: "lib/public/modules/profile.js",
    keys: ["#7c3aed", "#4f46e5", "#2563eb", "#0891b2", "#059669", "#65a30d", "#d97706", "#dc2626", "#db2777",
           "#6366f1", "#0d9488", "#ea580c", "#475569", "#1e293b", "#be123c", "#a21caf", "#0369a1", "#15803d"],
    reason: "The avatar colour choices and the default: a user's own pick, saved to their profile and shown to others in the same colour in every theme.",
  },
  {
    file: "lib/public/modules/mention.js",
    keys: ["#cc785c", "#10a37f"],
    reason: "Vendor brand colours of the two plain mention targets.",
  },
  {
    file: "lib/public/modules/mention.js",
    keys: ["#7c3aed", "#6c5ce7"],
    reason: "The avatar colour a chip uses when the person has stored none: the same stored-data default as the profile.",
  },
  {
    file: "lib/public/modules/app-cursors.js",
    keys: ["#F24822", "#FF7262", "#A259FF", "#1ABCFE", "#0ACF83", "#FF6D00", "#E84393", "#6C5CE7", "#00B894",
           "#FDCB6E", "#E17055", "#74B9FF"],
    reason: "Per-person cursor colours: they tell collaborators apart, so each stays one fixed hue in every theme.",
  },
  {
    file: "lib/public/modules/console-logo.js",
    keys: ["#00CFFF", "#4A7FE8", "#7B3FE4"],
    reason: "The brand logo gradient. The mark keeps its colours in every theme.",
  },
  {
    file: "lib/public/index.html",
    keys: ["#00CFFF", "#4A7FE8", "#7B3FE4"],
    reason: "The brand logo gradient. The mark keeps its colours in every theme.",
  },
  {
    file: "lib/public/index.html",
    keys: ["sched-color-swatch"],
    reason: "The colours a person can give a scheduled task: user-chosen data saved with the task.",
  },
  {
    file: "lib/public/modules/scheduler-config.js",
    keys: ["#ffb86c"],
    reason: "The default colour of a new scheduled task, the first of the swatches a person can choose from.",
  },
  {
    file: "lib/public/modules/app-favicon.js",
    keys: ["faviconCtx.fillStyle = \"#fff\""],
    reason: "The favicon is a canvas bitmap. A canvas cannot resolve CSS variables, and the letter on the status disc is fixed.",
  },
  {
    file: "lib/public/modules/markdown.js",
    keys: [".file-viewer-markdown", ".hljs", "  color: #37352f;", "  background: #fff;"],
    reason: "The print and PDF export stylesheet. A printed page is paper, so it is light in every theme.",
  },
  {
    file: "lib/public/modules/markdown.js",
    keys: ["ctx.fillStyle = \"#ffffff\"", "padding:32px;color:#555"],
    reason: "The PDF export raster and its waiting page: paper white behind a diagram, and a plain popup before the print document replaces it.",
  },
  {
    file: "lib/pages.js",
    keys: ["#DA7756", "#57AB5A", "#6CB6FF", "#E8D44D", "#DB61A2", "#F0883E"],
    reason: "The setup page confetti colours: decorative celebration colours, theme-independent.",
  },
  {
    file: "lib/public/theme-core.js",
    keys: ["#000000", "#FFFFFF"],
    reason: "The overlay and shadow bases of the derivation in the palette source itself.",
  },
  {
    file: "lib/public/css/menus.css",
    keys: ["#qr-canvas {"],
    reason: "A QR code scans as dark modules on a light quiet zone, so this one surface stays light in every theme.",
  },
  {
    file: "lib/public/css/sticky-notes.css",
    keys: ["#F9E04B", "#64B5F6", "#66BB6A", "#F06292", "#FFA726", "#AB47BC"],
    reason: "The six hues a person picks for a note. The surface, border and text of a note are mixed from the hue and the theme.",
  },
];

function isLiteralKey(key) {
  return /^(#[0-9a-f]{3,8}|rgba?\()/i.test(key);
}

// Whether the literal `literal`, found on `line` of the file `file` (a path
// relative to the repository root, with forward slashes), is on the list.
function isAllowed(file, literal, line) {
  return ALLOWLIST.some(function (row) {
    if (row.file !== file) return false;
    return row.keys.some(function (key) {
      return isLiteralKey(key) ? key.toLowerCase() === literal.toLowerCase() : line.indexOf(key) !== -1;
    });
  });
}

module.exports = { ALLOWLIST: ALLOWLIST, isAllowed: isAllowed, isLiteralKey: isLiteralKey };
