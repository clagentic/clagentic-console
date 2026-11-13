// Every colour a console surface shows comes from the active theme. This scans
// the shipped stylesheets, scripts and page (and the server files that write
// pages and defaults) for a hardcoded colour and fails on any that is not on the
// allowlist in test/colour-literal-allowlist.js, each of which carries a reason.
// It extends the no-literal-colour assertions in
// test/injected-message-layout.test.js and
// test/build-update-card-layout-lr-243438.test.js from one stylesheet to all.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var allowlist = require("./colour-literal-allowlist");

var ROOT = path.join(__dirname, "..");
var PUBLIC = path.join(ROOT, "lib", "public");

// Server files that hold page styles or a colour default. The shipped frontend
// is scanned whole; these are the files outside it that write a colour.
var SERVER_FILES = ["users.js", "server-settings.js", "server-auth.js", "project-user-mention.js",
                    "server-dm.js", "server.js", "daemon.js", "default-avatar-color.js", "pages.js"];

function walk(dir, exts, out) {
  out = out || [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full, exts, out);
    if (exts.indexOf(path.extname(e.name)) !== -1 && !/\.min\.js$/.test(e.name)) out.push(full);
  });
  return out;
}

// A hex colour, an rgb()/hsl() call written with numbers, a fallback that
// carries one of those or a bare number triplet, and white/black as a colour.
var LITERAL = new RegExp([
  // Not an HTML character reference (&#9660;) and not a word that ends in one.
  "(?<![&\\w])#[0-9a-fA-F]{8}(?![\\w-])", "(?<![&\\w])#[0-9a-fA-F]{6}(?![\\w-])", "(?<![&\\w])#[0-9a-fA-F]{3,4}(?![\\w-])",
  "\\b(?:rgba?|hsla?)\\(\\s*[\\d.]",
  "(?:color|background|border(?:-[a-z]+)?|fill|stroke|outline)\\s*[:=]\\s*[\"']?\\s*(?:white|black)\\b",
].join("|"), "g");
var TRIPLET_FALLBACK = /var\(\s*--[\w-]+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+/g;

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

// [{ literal, line }] for a text, comments dropped.
function hitsIn(text) {
  var hits = [];
  stripComments(text).split("\n").forEach(function (line) {
    var m;
    LITERAL.lastIndex = 0;
    while ((m = LITERAL.exec(line))) hits.push({ literal: m[0].replace(/\s*[:=]\s*["']?\s*/, " ").trim(), line: line });
    TRIPLET_FALLBACK.lastIndex = 0;
    while ((m = TRIPLET_FALLBACK.exec(line))) hits.push({ literal: m[0], line: line });
  });
  return hits;
}

function shippedFiles() {
  var files = walk(PUBLIC, [".css", ".js", ".html"]);
  SERVER_FILES.forEach(function (name) { files.push(path.join(ROOT, "lib", name)); });
  return files;
}

// The literal a hit names, as the allowlist spells a key ("#fff", not "color: #fff").
function literalOf(hit) {
  var m = /#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\(\s*[\d.]|\b(?:white|black)\b|var\([^)]*/.exec(hit.literal);
  return m ? m[0] : hit.literal;
}

function offendersIn(rel, text, used) {
  var out = [];
  hitsIn(text).forEach(function (h) {
    var lit = literalOf(h);
    if (allowlist.isAllowed(rel, lit, h.line)) {
      if (used) used.push(rel + "\u0000" + lit + "\u0000" + h.line);
      return;
    }
    out.push(rel + ": " + h.line.trim().slice(0, 140));
  });
  return out;
}

test("no shipped stylesheet, script or page holds a colour literal outside the allowlist", function () {
  var offenders = [];
  shippedFiles().forEach(function (file) {
    var rel = path.relative(ROOT, file).split(path.sep).join("/");
    offenders = offenders.concat(offendersIn(rel, fs.readFileSync(file, "utf8")));
  });
  assert.deepEqual(offenders, []);
});

test("every allowlist row has a reason and every key is still in use", function () {
  var texts = {};
  shippedFiles().forEach(function (file) {
    texts[path.relative(ROOT, file).split(path.sep).join("/")] = fs.readFileSync(file, "utf8");
  });
  var stale = [];
  allowlist.ALLOWLIST.forEach(function (row) {
    assert.ok(typeof row.reason === "string" && row.reason.length > 20, row.file + " has a reason");
    assert.ok(Array.isArray(row.keys) && row.keys.length > 0, row.file + " names a key");
    assert.ok(texts[row.file] !== undefined, row.file + " is a scanned file");
    var hits = hitsIn(texts[row.file]);
    row.keys.forEach(function (key) {
      var used = hits.some(function (h) {
        return allowlist.isLiteralKey(key) ? key.toLowerCase() === literalOf(h).toLowerCase() : h.line.indexOf(key) !== -1;
      });
      if (!used) stale.push(row.file + " " + key);
    });
  });
  assert.deepEqual(stale, [], "a key with no literal left behind it is removed");
});

// A literal the guard must catch, and a token use it must leave alone.
[
  ["a hex colour", "a { color: #123456; }", 1],
  ["a short hex colour", "a { color: #fff; }", 1],
  ["an rgba() literal", "a { background: rgba(0, 0, 0, 0.5); }", 1],
  ["a fallback that carries a literal", "a { color: var(--accent, #6c5ce7); }", 1],
  ["a fallback that carries a triplet", "a { background: rgba(var(--accent-rgb, 99, 102, 241), 0.1); }", 1],
  ["white as a colour", "a { color: white; }", 1],
  ["an inline style in a script", "el.style.cssText = \"color:#e74c3c\";", 1],
  ["a token", "a { color: var(--accent); background: rgba(var(--shadow-rgb), 0.2); }", 0],
  ["a mix of tokens", "a { background: color-mix(in srgb, var(--error) 12%, transparent); }", 0],
  ["a selector that looks like a colour", "#add-project-input { color: var(--text); }", 0],
  ["a comment", "/* #123456 is the old colour */ a { color: var(--text); }", 0],
].forEach(function (row) {
  test("the scan: " + row[0], function () {
    assert.equal(offendersIn("lib/public/css/fixture.css", row[1]).length, row[2]);
  });
});

// AC5, AC8: selection, focus and scrollbars are token-driven, and the orphaned
// picker selectors are gone.
test("selection and scrollbars use tokens, and the orphaned theme-picker selectors are gone", function () {
  var base = fs.readFileSync(path.join(PUBLIC, "css", "base.css"), "utf8");
  [/::selection\s*\{[^}]*var\(--/, /scrollbar-color:\s*[^;]*var\(--/, /::-webkit-scrollbar-thumb\s*\{[^}]*var\(--/].forEach(function (re) {
    assert.match(base, re);
  });
  var css = walk(path.join(PUBLIC, "css"), [".css"]).map(function (f) { return fs.readFileSync(f, "utf8"); }).join("\n");
  assert.ok(!/\.theme-picker\b/.test(css), "no .theme-picker rule");
  assert.ok(!/\.mobile-settings-theme-/.test(css), "no .mobile-settings-theme-* rule");
});
