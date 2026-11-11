"use strict";

// Reads theme files from disk and decides which ones the Appearance choice may
// offer. Two sources: the themes shipped in lib/themes/ and the user's own
// files in <console home>/themes/. A file that is unreadable, oversized, not
// JSON or not a complete palette is skipped, so one bad file never hides the
// good ones or breaks the page.
//
// File format (documented in docs/guides/THEMES.md): a JSON object with a
// "name", sixteen base16 colours "base00".."base0F" as six hex digits without
// a leading "#", an optional "variant" ("dark" or "light"; derived from
// base00 when absent) and an optional "accent2". The theme id is the file
// name without ".json".

var fs = require("fs");
var path = require("path");

var BASE_KEYS = [
  "base00", "base01", "base02", "base03", "base04", "base05", "base06", "base07",
  "base08", "base09", "base0A", "base0B", "base0C", "base0D", "base0E", "base0F",
];

var MAX_THEME_BYTES = 16 * 1024;
var MAX_NAME_LENGTH = 60;
var HEX6 = /^[0-9a-fA-F]{6}$/;
// The same rule theme-prefs.js applies in the browser; a test holds them together.
var THEME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isValidThemeId(id) {
  return typeof id === "string" && THEME_ID.test(id);
}

function luminance(hex) {
  var r = parseInt(hex.substring(0, 2), 16);
  var g = parseInt(hex.substring(2, 4), 16);
  var b = parseInt(hex.substring(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * A palette the client can draw, or null. Only known fields are copied, so a
 * file cannot smuggle extra properties into the page.
 */
function normalizeTheme(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.name !== "string") return null;
  var name = raw.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;

  var theme = { name: name };
  for (var i = 0; i < BASE_KEYS.length; i++) {
    var value = raw[BASE_KEYS[i]];
    if (typeof value !== "string" || !HEX6.test(value)) return null;
    theme[BASE_KEYS[i]] = value;
  }

  if (raw.variant === undefined || raw.variant === null || raw.variant === "") {
    theme.variant = luminance(theme.base00) > 0.5 ? "light" : "dark";
  } else if (raw.variant === "dark" || raw.variant === "light") {
    theme.variant = raw.variant;
  } else {
    return null;
  }

  if (raw.accent2 !== undefined && raw.accent2 !== null) {
    if (typeof raw.accent2 !== "string" || !HEX6.test(raw.accent2)) return null;
    theme.accent2 = raw.accent2;
  }
  return theme;
}

/** One theme file: { id, theme } or { id, reason }. Never throws. */
function readThemeFile(dir, fileName) {
  var id = fileName.replace(/\.json$/, "");
  if (!isValidThemeId(id)) return { id: id, reason: "invalid-id" };
  try {
    var full = path.join(dir, fileName);
    var stat = fs.statSync(full);
    if (!stat.isFile()) return { id: id, reason: "not-a-file" };
    if (stat.size > MAX_THEME_BYTES) return { id: id, reason: "too-large" };
    var parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    var theme = normalizeTheme(parsed);
    return theme ? { id: id, theme: theme } : { id: id, reason: "invalid-palette" };
  } catch (e) {
    return { id: id, reason: "unreadable" };
  }
}

function readDir(dir, into, skipped, taken) {
  var files;
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return; // no folder is the normal case for a fresh install
  }
  files.sort();
  for (var i = 0; i < files.length; i++) {
    if (!files[i].endsWith(".json")) continue;
    var result = readThemeFile(dir, files[i]);
    if (!result.theme) {
      skipped.push({ file: files[i], reason: result.reason });
    } else if (taken && Object.prototype.hasOwnProperty.call(taken, result.id)) {
      // Dark and Light are always the console's own palettes.
      skipped.push({ file: files[i], reason: "reserved-id" });
    } else {
      into[result.id] = result.theme;
    }
  }
}

/**
 * { bundled, custom, skipped } for the two directories. `skipped` is for
 * tests and diagnostics; the API does not return it.
 */
function listThemes(dirs) {
  var bundled = {};
  var custom = {};
  var skipped = [];
  readDir(dirs.bundledDir, bundled, skipped, null);
  readDir(dirs.customDir, custom, skipped, bundled);
  return { bundled: bundled, custom: custom, skipped: skipped };
}

module.exports = {
  BASE_KEYS: BASE_KEYS,
  MAX_THEME_BYTES: MAX_THEME_BYTES,
  THEME_ID: THEME_ID,
  isValidThemeId: isValidThemeId,
  normalizeTheme: normalizeTheme,
  listThemes: listThemes,
};
