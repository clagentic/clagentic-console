// Type size, line height, spacing and radius in a component stylesheet come from
// the scales declared in lib/public/css/base.css, the way colours come from the
// theme. This scans lib/public/css for a pixel literal in font (the shorthand),
// font-size, line-height, margin, padding, gap or border-radius and fails on any that is not on the
// allowlist in test/pixel-literal-allowlist.js, each row of which carries a
// reason. It sits beside test/colour-literal-guard.test.js and the layer-scale
// guard in test/overlay-stack.test.js.
//
// Covered: a value written in px. Not covered, on purpose: 0, auto and
// percentages (50% is a circle, not a size), em and rem (they follow the text
// they sit in), a unitless line-height (a ratio), and every other property
// (width, height, border, offsets, transforms), which are layout geometry and not
// type, spacing or radius.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var allowlist = require("./pixel-literal-allowlist");

var ROOT = path.join(__dirname, "..");
var CSS_DIR = path.join(ROOT, "lib", "public", "css");

var SIDES = "(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?";
// A covered property, not a custom property that ends in the same word (--msg-gap)
// and not part of a longer one (scroll-padding-top, font-family, font-weight). The
// font shorthand is covered because it sets a size and a line height.
var DECLARATION = new RegExp(
  "(?<![\\w-])((?:font-size|font|line-height|row-gap|column-gap|gap|margin" + SIDES + "|padding" + SIDES +
  "|border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius))\\s*:\\s*([^;{}]*)", "g");
var PIXELS = /(?<![\w.])-?\d*\.?\d+px(?![\w-])/;

// Comments dropped, every newline kept, so a hit reports its real line.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, function (c) { return c.replace(/[^\n]/g, " "); });
}

// [{ line, decl }] for a stylesheet text.
function hitsIn(text) {
  var plain = stripComments(text);
  var hits = [];
  var m;
  DECLARATION.lastIndex = 0;
  while ((m = DECLARATION.exec(plain))) {
    if (!PIXELS.test(m[2])) continue;
    hits.push({ line: plain.slice(0, m.index).split("\n").length, decl: (m[1] + ": " + m[2]).replace(/\s+/g, " ").trim() });
  }
  return hits;
}

function offendersIn(rel, text, rows) {
  return hitsIn(text).filter(function (h) { return !allowlist.isAllowed(rel, h.decl, rows); })
    .map(function (h) { return rel + ":" + h.line + ": " + h.decl; });
}

function stylesheets() {
  return fs.readdirSync(CSS_DIR).filter(function (n) { return /\.css$/.test(n); }).sort().map(function (n) {
    return { rel: "lib/public/css/" + n, text: fs.readFileSync(path.join(CSS_DIR, n), "utf8") };
  });
}

test("no component stylesheet holds a pixel literal for type, spacing or radius outside the allowlist", function () {
  var offenders = [];
  stylesheets().forEach(function (f) { offenders = offenders.concat(offendersIn(f.rel, f.text)); });
  assert.deepEqual(offenders, []);
});

test("every allowlist row has a reason, a batch or a key, and still has a literal behind it", function () {
  var byFile = {};
  stylesheets().forEach(function (f) { byFile[f.rel] = hitsIn(f.text); });
  var stale = [];
  allowlist.ALLOWLIST.forEach(function (row) {
    assert.ok(typeof row.reason === "string" && row.reason.length > 20, row.file + " has a reason");
    assert.ok(byFile[row.file] !== undefined, row.file + " is a scanned stylesheet");
    if (!row.keys) {
      assert.ok(allowlist.BATCHES.indexOf(row.batch) !== -1, row.file + " names the batch task that sweeps it");
      if (byFile[row.file].length === 0) stale.push(row.file);
      return;
    }
    assert.ok(Array.isArray(row.keys) && row.keys.length > 0, row.file + " names a key");
    row.keys.forEach(function (key) {
      if (!byFile[row.file].some(function (h) { return h.decl.indexOf(key) !== -1; })) stale.push(row.file + " " + key);
    });
  });
  assert.deepEqual(stale, [], "a row with no literal left behind it is removed");
});

test("the allowlist names each file once", function () {
  var seen = {};
  allowlist.ALLOWLIST.filter(function (r) { return !r.keys; }).forEach(function (r) {
    assert.ok(!seen[r.file], r.file + " is listed twice");
    seen[r.file] = true;
  });
});

// A literal the guard must catch, and a form it must leave alone.
[
  ["a font size", "a { font-size: 13px; }", 1],
  ["a decimal font size", "a { font-size: 9.5px; }", 1],
  ["a pixel line height", "a { line-height: 15px; }", 1],
  ["a font shorthand with a size and line height", "a { font: 12px/1.4 sans-serif; }", 1],
  ["a font shorthand with a weight and a size", "a { font: 600 12px var(--font-mono); }", 1],
  ["an important padding", "a { padding: 6px !important; }", 1],
  ["a margin", "a { margin: 0 auto 8px; }", 1],
  ["a side margin", "a { margin-left: 6px; }", 1],
  ["a negative margin", "a { margin-top: -4px; }", 1],
  ["a padding shorthand", "a { padding: 4px 10px; }", 1],
  ["a logical padding", "a { padding-inline-start: 12px; }", 1],
  ["a gap", "a { gap: 8px; }", 1],
  ["a row and column gap", "a { gap: 4px 12px; }", 1],
  ["a column gap", "a { column-gap: 6px; }", 1],
  ["a border radius", "a { border-radius: 8px; }", 1],
  ["a corner radius", "a { border-top-left-radius: 8px; }", 1],
  ["a logical corner radius", "a { border-start-start-radius: 8px; }", 1],
  ["a pill radius written as a number", "a { border-radius: 999px; }", 1],
  ["a literal inside calc()", "a { padding-bottom: calc(var(--safe-bottom) + 16px); }", 1],
  ["a literal as a token fallback", "a { gap: var(--space-4, 8px); }", 1],
  ["a literal in a media query body", "@media (max-width: 768px) { a { padding: 10px; } }", 1],
  ["a literal in a keyframe", "@keyframes k { 50% { border-radius: 12px; } }", 1],
  ["a multi-line rule", "a {\n  color: var(--text);\n  padding: 6px;\n}", 1],
  ["two literals in one rule", "a { padding: 4px; margin: 2px; }", 2],
  ["a token", "a { font-size: var(--font-size-md); padding: var(--space-3) var(--space-6); }", 0],
  ["a token in calc()", "a { padding-bottom: calc(var(--safe-bottom) + var(--space-8)); }", 0],
  ["the radius tokens", "a { border-radius: 0 0 var(--radius-7) var(--radius-7); border-radius: var(--radius-pill); }", 0],
  ["a zero and auto", "a { margin: 0 auto; padding: 0; gap: 0; }", 0],
  ["a circle", "a { border-radius: 50%; }", 0],
  ["a unitless line height", "a { line-height: 1.5; }", 0],
  ["a font shorthand that inherits", "a { font: inherit; }", 0],
  ["a font shorthand on the scale tokens", "a { font: 600 var(--font-size-sm)/1.4 var(--font-mono); }", 0],
  ["font properties that are not the shorthand", "a { font-family: 'Fira 12px'; font-weight: 600; font-style: italic; font-variant: small-caps; }", 0],
  ["a relative size", "a { font-size: 0.85em; padding: 0 1rem; }", 0],
  ["a property that is not covered", "a { width: 14px; height: 14px; border: 1px solid var(--border); top: -3px; }", 0],
  ["a custom property that ends in gap", "a { --msg-gap: 6px; }", 0],
  ["a scale token definition", ":root { --space-3: 6px; --radius-2: 4px; --font-size-sm: 12px; }", 0],
  ["a comment", "/* padding: 6px */ a { padding: var(--space-3); }", 0],
].forEach(function (row) {
  test("the scan: " + row[0], function () {
    assert.equal(offendersIn("lib/public/css/fixture.css", row[1]).length, row[2]);
  });
});

test("the scan reports the line of a literal", function () {
  assert.deepEqual(hitsIn("a {\n  color: red;\n}\n/* one\n two */\nb {\n  padding: 6px;\n}").map(function (h) { return h.line; }), [7]);
});

// The allowlist forms: a whole unswept file passes, a keyed row passes only the
// declaration that holds its key, and a file with no row is refused.
// Every row here brings its own fixture rows, so nothing reads the live allowlist
// when the module loads (it is empty once the last batch lands).
var KEYED = [{ file: "lib/public/css/fixture.css", keys: ["999px"], reason: "A named literal, with its reason." }];
var WHOLE = [{ file: "lib/public/css/fixture-unswept.css", batch: allowlist.BATCHES[0], reason: "A whole file not swept yet, with its reason." }];
[
  ["an unswept file on the allowlist", "lib/public/css/fixture-unswept.css", "a { padding: 6px; }", WHOLE, 0],
  ["a whole-file row for another file", "lib/public/css/fixture.css", "a { padding: 6px; }", WHOLE, 1],
  ["an empty allowlist", "lib/public/css/fixture-unswept.css", "a { padding: 6px; }", [], 1],
  ["a file that is not on the allowlist", "lib/public/css/fixture.css", "a { padding: 6px; }", KEYED, 1],
  ["a keyed literal on its row", "lib/public/css/fixture.css", "a { border-radius: 999px; }", KEYED, 0],
  ["another literal in a file with a keyed row", "lib/public/css/fixture.css", "a { border-radius: 999px; padding: 6px; }", KEYED, 1],
  ["a keyed row for another file", "lib/public/css/other.css", "a { border-radius: 999px; }", KEYED, 1],
].forEach(function (row) {
  test("the allowlist: " + row[0], function () {
    assert.equal(offendersIn(row[1], row[2], row[3]).length, row[4]);
  });
});

// The scales are declared once, on :root, so Clagentic Dark and Clagentic Light
// (which only set colour variables) read the same steps.
var SCALE = [
  ["--font-size-2xs", "10px"], ["--font-size-xs", "11px"], ["--font-size-sm", "12px"], ["--font-size-md", "13px"],
  ["--font-size-base", "14px"], ["--font-size-lg", "15px"], ["--font-size-xl", "16px"], ["--font-size-2xl", "18px"],
  ["--font-size-3xl", "20px"], ["--font-size-4xl", "22px"], ["--font-size-5xl", "24px"], ["--font-size-6xl", "28px"],
  ["--line-height-xs", "16px"], ["--line-height-sm", "18px"], ["--line-height-md", "20px"],
  ["--space-1", "2px"], ["--space-2", "4px"], ["--space-3", "6px"], ["--space-4", "8px"], ["--space-5", "10px"],
  ["--space-6", "12px"], ["--space-7", "14px"], ["--space-8", "16px"], ["--space-9", "18px"], ["--space-10", "20px"],
  ["--space-11", "22px"], ["--space-12", "24px"], ["--space-14", "28px"], ["--space-16", "32px"], ["--space-20", "40px"],
  ["--radius-1", "2px"], ["--radius-2", "4px"], ["--radius-3", "6px"], ["--radius-4", "8px"], ["--radius-5", "10px"],
  ["--radius-6", "12px"], ["--radius-7", "14px"], ["--radius-8", "16px"], ["--radius-9", "18px"], ["--radius-10", "20px"],
  ["--radius-pill", "999px"],
];

test("the type, spacing and radius scales are declared once, on :root, with every step", function () {
  var sheets = stylesheets();
  var base = sheets.filter(function (f) { return f.rel === "lib/public/css/base.css"; })[0].text;
  var root = /:root\s*\{([^}]*)\}/.exec(base)[1];
  SCALE.forEach(function (step) {
    var declared = 0;
    sheets.forEach(function (f) {
      declared += f.text.split(new RegExp("(?<![\\w-])" + step[0] + "\\s*:")).length - 1;
    });
    assert.equal(declared, 1, step[0] + " is declared once across the stylesheets");
    assert.match(root, new RegExp("(?<![\\w-])" + step[0] + ":\\s*" + step[1] + ";"), step[0] + " is " + step[1] + " on :root");
  });
});

test("every scale token a stylesheet reads is declared", function () {
  var declared = SCALE.map(function (s) { return s[0]; });
  var unknown = [];
  stylesheets().forEach(function (f) {
    (f.text.match(/var\(\s*--(?:font-size|line-height|space|radius)-[\w-]+/g) || []).forEach(function (use) {
      var name = use.replace(/^var\(\s*/, "");
      if (declared.indexOf(name) === -1) unknown.push(f.rel + " " + name);
    });
  });
  assert.deepEqual(unknown, []);
});
