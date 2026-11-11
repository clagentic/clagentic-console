// Themes: the console ships Dark and Light only, plus the user's custom theme
// files. Pins the one-time migration of retired theme ids, the fallback for an
// id that matches nothing, custom theme listing and persistence, the skipping
// of invalid files, the user-visible labels, and the shipped file set.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { pathToFileURL } = require("url");

var themeFiles = require("../lib/theme-files");
var { attachPreferences } = require("../lib/users-preferences");
var { attachSettings } = require("../lib/server-settings");

var ROOT = path.join(__dirname, "..");
var THEMES_DIR = path.join(ROOT, "lib", "themes");
var PREFS_URL = pathToFileURL(path.join(ROOT, "lib", "public", "modules", "theme-prefs.js")).href;

function prefs() {
  return import(PREFS_URL);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "themes-test-"));
}

function palette(over) {
  var t = {
    name: "Harbor", variant: "dark",
    base00: "0B1620", base01: "12202D", base02: "1F3345", base03: "4A6378",
    base04: "7F97AB", base05: "C5D3DE", base06: "E4EDF4", base07: "F5FAFD",
    base08: "F2677C", base09: "3DC9E0", base0A: "E6B85C", base0B: "5CCFA0",
    base0C: "6FB7E9", base0D: "5B8DEF", base0E: "B58CF2", base0F: "C98A6B"
  };
  return Object.assign(t, over || {});
}

// ---------------------------------------------------------------------------
// Migration of stored ids (browser side): AC2
// ---------------------------------------------------------------------------

var MIGRATION_ROWS = [
  // [stored id, expected id]
  ["dracula", "clagentic-dark"], ["monokai", "clagentic-dark"], ["nord", "clagentic-dark"],
  ["one-dark", "clagentic-dark"], ["tokyo-night", "clagentic-dark"], ["rose-pine", "clagentic-dark"],
  ["everforest", "clagentic-dark"], ["catppuccin-mocha", "clagentic-dark"],
  ["gruvbox-dark", "clagentic-dark"], ["solarized-dark", "clagentic-dark"],
  ["clay", "clagentic-dark"], ["claude", "clagentic-dark"],
  ["ayu-light", "clagentic-light"], ["github-light", "clagentic-light"],
  ["solarized-light", "clagentic-light"], ["everforest-light", "clagentic-light"],
  ["one-light", "clagentic-light"], ["rose-pine-dawn", "clagentic-light"],
  ["tokyo-night-light", "clagentic-light"], ["nord-light", "clagentic-light"],
  ["catppuccin-latte", "clagentic-light"], ["gruvbox-light", "clagentic-light"],
  ["clay-light", "clagentic-light"], ["claude-light", "clagentic-light"]
];

test("migrateStoredTheme: every retired id maps to the Clagentic theme of its variant", async function () {
  var p = await prefs();
  MIGRATION_ROWS.forEach(function (row) {
    var out = p.migrateStoredTheme({ id: row[0], variant: null, brand: null, mode: null });
    assert.equal(out.id, row[1], row[0]);
    assert.equal(out.changed, true, row[0]);
  });
});

test("migrateStoredTheme: the 20 files that used to ship are all covered", async function () {
  var p = await prefs();
  var shipped = ["github-light", "solarized-light", "solarized-dark", "everforest-light", "one-light",
    "rose-pine-dawn", "rose-pine", "everforest", "tokyo-night", "tokyo-night-light", "dracula", "monokai",
    "nord-light", "catppuccin-latte", "catppuccin-mocha", "nord", "one-dark", "ayu-light",
    "gruvbox-light", "gruvbox-dark"];
  assert.equal(shipped.length, 20);
  shipped.forEach(function (id) {
    assert.ok(p.inheritedVariant(id), id + " is mapped");
  });
});

test("migrateStoredTheme: the Classic brand with no stored id maps by the stored mode", async function () {
  var p = await prefs();
  assert.equal(p.migrateStoredTheme({ id: null, brand: "classic", mode: "dark" }).id, "clagentic-dark");
  assert.equal(p.migrateStoredTheme({ id: null, brand: "classic", mode: "light" }).id, "clagentic-light");
  // No stored mode: nothing to map, the user follows the system.
  var system = p.migrateStoredTheme({ id: null, brand: "classic", mode: null });
  assert.equal(system.id, null);
});

test("migrateStoredTheme: Clagentic, custom and unknown ids are left for resolution", async function () {
  var p = await prefs();
  ["clagentic-dark", "clagentic-light", "harbor", "typo"].forEach(function (id) {
    var out = p.migrateStoredTheme({ id: id, variant: "dark" });
    assert.equal(out.id, id);
    assert.equal(out.changed, false);
  });
  assert.equal(p.inheritedVariant("constructor"), null, "prototype names are not ids");
  assert.equal(p.inheritedVariant("__proto__"), null);
});

// ---------------------------------------------------------------------------
// Fallback for an id that matches nothing: AC3
// ---------------------------------------------------------------------------

test("resolveThemeId: a custom id that is not loaded falls back to the Clagentic theme of the mode", async function () {
  var p = await prefs();
  var none = function () { return false; };
  assert.equal(p.resolveThemeId({ customId: "gone", mode: "light", systemMode: "dark", isCustom: none }), "clagentic-light");
  assert.equal(p.resolveThemeId({ customId: "gone", mode: "dark", systemMode: "light", isCustom: none }), "clagentic-dark");
  assert.equal(p.resolveThemeId({ customId: "gone", mode: null, systemMode: "light", isCustom: none }), "clagentic-light");
  assert.equal(p.resolveThemeId({ customId: null, mode: null, systemMode: "dark", isCustom: none }), "clagentic-dark");
});

test("resolveThemeId: never returns a retired id, whatever is stored", async function () {
  var p = await prefs();
  var none = function () { return false; };
  MIGRATION_ROWS.forEach(function (row) {
    var id = p.resolveThemeId({ customId: row[0], mode: null, systemMode: "dark", isCustom: none });
    assert.ok(id === "clagentic-dark" || id === "clagentic-light", row[0] + " -> " + id);
  });
});

test("resolveThemeId: a loaded custom theme wins over the mode", async function () {
  var p = await prefs();
  var id = p.resolveThemeId({ customId: "harbor", mode: "light", systemMode: "light", isCustom: function (x) { return x === "harbor"; } });
  assert.equal(id, "harbor");
});

// ---------------------------------------------------------------------------
// Follow system and cross-device preference: AC4, AC6
// ---------------------------------------------------------------------------

test("reconcileServerPrefs: the server wins, a null mode is Follow system, a bad id is dropped", async function () {
  var p = await prefs();
  assert.deepEqual(p.reconcileServerPrefs({ themeMode: null, themeId: null }), { mode: null, customId: null });
  assert.deepEqual(p.reconcileServerPrefs({ themeMode: "light", themeId: null }), { mode: "light", customId: null });
  assert.deepEqual(p.reconcileServerPrefs({ themeMode: "dark", themeId: "harbor" }), { mode: "dark", customId: "harbor" });
  assert.deepEqual(p.reconcileServerPrefs({ themeMode: "classic", themeId: "../x" }), { mode: null, customId: null });
  assert.deepEqual(p.reconcileServerPrefs(null), { mode: null, customId: null });
});

test("Follow system tracks the system setting live: the media-query listener re-applies when no mode is stored", function () {
  var src = fs.readFileSync(path.join(ROOT, "lib", "public", "modules", "theme.js"), "utf8");
  assert.match(src, /matchMedia\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(src, /var handler = function \(\) \{\s*if \(!getStoredMode\(\)\) reapply\(\);/);
  assert.match(src, /mq\.addEventListener\("change", handler\)/);
});

test("selectionKey: Follow system is selected when there is no mode and no custom theme", async function () {
  var p = await prefs();
  assert.equal(p.selectionKey({ mode: null, customId: null }), "system");
  assert.equal(p.selectionKey({ mode: "dark", customId: null }), "dark");
  assert.equal(p.selectionKey({ mode: "light", customId: "harbor" }), "custom:harbor");
});

// ---------------------------------------------------------------------------
// User-visible labels: exactly Light and Dark
// ---------------------------------------------------------------------------

test("labels: the choice offers exactly Dark, Light and Follow system on a fresh install", async function () {
  var p = await prefs();
  var labels = p.buildThemeOptions([]).map(function (o) { return o.label; });
  assert.deepEqual(labels, ["Dark", "Light", "Follow system"]);
});

test("labels: custom themes are listed by name after the three, in name order", async function () {
  var p = await prefs();
  var options = p.buildThemeOptions([
    { id: "b", name: "Zinc", swatches: [] }, { id: "a", name: "Amber", swatches: [] }
  ]);
  assert.deepEqual(options.map(function (o) { return o.label; }), ["Dark", "Light", "Follow system", "Amber", "Zinc"]);
  assert.equal(options[3].key, "custom:a");
});

test("labels: the shipped themes are named Light and Dark, never Clagentic Light or Clagentic Dark", async function () {
  var p = await prefs();
  var dark = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, "clagentic-dark.json"), "utf8"));
  var light = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, "clagentic-light.json"), "utf8"));
  assert.equal(dark.name, "Dark");
  assert.equal(light.name, "Light");
  p.buildThemeOptions([]).forEach(function (o) {
    assert.ok(!/clagentic/i.test(o.label + " " + o.description), o.key);
  });
});

test("the id rule is the same in the browser and on the server", async function () {
  var p = await prefs();
  assert.equal(p.THEME_ID_PATTERN.source, themeFiles.THEME_ID.source);
});

// ---------------------------------------------------------------------------
// Package contents: AC7
// ---------------------------------------------------------------------------

test("package contents: lib/themes holds only the two Clagentic files", function () {
  assert.deepEqual(fs.readdirSync(THEMES_DIR).sort(), ["clagentic-dark.json", "clagentic-light.json"]);
  var pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.indexOf("lib/") !== -1, "lib/ (and so lib/themes) is what ships");
});

// ---------------------------------------------------------------------------
// Custom theme files: AC4, AC5
// ---------------------------------------------------------------------------

test("listThemes: a valid custom file is listed by name under its file id", function () {
  var custom = tmpDir();
  fs.writeFileSync(path.join(custom, "harbor.json"), JSON.stringify(palette()));
  var out = themeFiles.listThemes({ bundledDir: THEMES_DIR, customDir: custom });
  assert.deepEqual(Object.keys(out.bundled).sort(), ["clagentic-dark", "clagentic-light"]);
  assert.deepEqual(Object.keys(out.custom), ["harbor"]);
  assert.equal(out.custom.harbor.name, "Harbor");
  assert.equal(out.skipped.length, 0);
});

test("listThemes: variant is derived from base00 when absent", function () {
  var custom = tmpDir();
  var light = palette({ base00: "FAFAFA" });
  delete light.variant;
  fs.writeFileSync(path.join(custom, "paper.json"), JSON.stringify(light));
  var out = themeFiles.listThemes({ bundledDir: THEMES_DIR, customDir: custom });
  assert.equal(out.custom.paper.variant, "light");
});

test("listThemes: invalid and unreadable files are skipped and the valid ones still load", function () {
  var custom = tmpDir();
  fs.writeFileSync(path.join(custom, "good.json"), JSON.stringify(palette({ name: "Good" })));
  fs.writeFileSync(path.join(custom, "notjson.json"), "{ nope");
  fs.writeFileSync(path.join(custom, "short.json"), JSON.stringify(palette({ base03: "123" })));
  var missing = palette();
  delete missing.base0F;
  fs.writeFileSync(path.join(custom, "missing.json"), JSON.stringify(missing));
  fs.writeFileSync(path.join(custom, "noname.json"), JSON.stringify(palette({ name: "" })));
  fs.writeFileSync(path.join(custom, "badvariant.json"), JSON.stringify(palette({ variant: "sepia" })));
  fs.writeFileSync(path.join(custom, "array.json"), "[]");
  fs.writeFileSync(path.join(custom, "huge.json"), JSON.stringify(palette({ name: "x".repeat(themeFiles.MAX_THEME_BYTES) })));
  fs.mkdirSync(path.join(custom, "folder.json")); // unreadable as a file
  fs.writeFileSync(path.join(custom, "bad id.json"), JSON.stringify(palette()));
  fs.writeFileSync(path.join(custom, "readme.txt"), "not a theme");
  fs.writeFileSync(path.join(custom, "clagentic-dark.json"), JSON.stringify(palette({ name: "Imposter" })));

  var out = themeFiles.listThemes({ bundledDir: THEMES_DIR, customDir: custom });
  assert.deepEqual(Object.keys(out.custom), ["good"]);
  assert.equal(out.bundled["clagentic-dark"].name, "Dark", "a custom file cannot replace a built-in theme");
  var reasons = {};
  out.skipped.forEach(function (s) { reasons[s.file] = s.reason; });
  assert.equal(reasons["notjson.json"], "unreadable");
  assert.equal(reasons["short.json"], "invalid-palette");
  assert.equal(reasons["missing.json"], "invalid-palette");
  assert.equal(reasons["noname.json"], "invalid-palette");
  assert.equal(reasons["badvariant.json"], "invalid-palette");
  assert.equal(reasons["array.json"], "invalid-palette");
  assert.equal(reasons["huge.json"], "too-large");
  assert.equal(reasons["folder.json"], "not-a-file");
  assert.equal(reasons["bad id.json"], "invalid-id");
  assert.equal(reasons["clagentic-dark.json"], "reserved-id");
  assert.equal(reasons["readme.txt"], undefined, "non-json files are ignored, not reported");
});

test("listThemes: a missing custom folder is the normal fresh-install case", function () {
  var out = themeFiles.listThemes({ bundledDir: THEMES_DIR, customDir: path.join(tmpDir(), "none") });
  assert.deepEqual(out.custom, {});
  assert.equal(out.skipped.length, 0);
});

test("normalizeTheme: copies only known fields", function () {
  var out = themeFiles.normalizeTheme(palette({ evil: "<script>", accent2: "5B8DEF" }));
  assert.equal(out.evil, undefined);
  assert.equal(out.accent2, "5B8DEF");
  assert.equal(themeFiles.normalizeTheme(palette({ accent2: "zz" })), null);
});

// ---------------------------------------------------------------------------
// Server-side preference: persistence and one-time migration (AC2, AC4)
// ---------------------------------------------------------------------------

function fakeStore(users) {
  var state = { data: { users: users }, saves: 0 };
  state.api = attachPreferences({
    loadUsers: function () { return state.data; },
    saveUsers: function (d) { state.data = d; state.saves++; }
  });
  return state;
}

test("custom theme choice is stored per user and cleared by a mode choice", function () {
  var s = fakeStore([{ id: "u1" }]);
  assert.deepEqual(s.api.setThemeId("u1", "harbor"), { ok: true, themeId: "harbor" });
  assert.equal(s.api.getThemeId("u1"), "harbor");
  s.api.setThemeId("u1", "../etc/passwd");
  assert.equal(s.api.getThemeId("u1"), null, "an illegal id is stored as none");
  s.api.setThemeId("u1", "harbor");
  s.api.setThemeMode("u1", "light");
  assert.equal(s.api.getThemeId("u1"), null, "Dark, Light or Follow system replaces a custom theme");
  assert.equal(s.api.getThemeMode("u1"), "light");
  s.api.setThemeId("u1", "harbor");
  s.api.setThemeMode("u1", null);
  assert.equal(s.api.getThemeId("u1"), null);
  assert.equal(s.api.getThemeMode("u1"), null, "a null mode is Follow system");
  assert.deepEqual(s.api.setThemeId("nobody", "x"), { error: "User not found" });
});

test("migrateAllThemePrefs: drops the retired brand once and saves only when something changed", function () {
  var s = fakeStore([
    { id: "a", themeBrand: "classic", themeMode: "dark" },
    { id: "b", themeBrand: "clagentic" },
    { id: "c", themeMode: "light", themeId: "harbor" },
    { id: "d", themeMode: "sepia", themeId: "../x" }
  ]);
  assert.deepEqual(s.api.migrateAllThemePrefs(), { changed: 3 });
  assert.equal(s.saves, 1);
  var byId = {};
  s.data.users.forEach(function (u) { byId[u.id] = u; });
  assert.ok(!("themeBrand" in byId.a));
  assert.equal(byId.a.themeMode, "dark", "the stored mode already carries the variant");
  assert.ok(!("themeBrand" in byId.b));
  assert.equal(byId.c.themeId, "harbor");
  assert.ok(!("themeMode" in byId.d) && !("themeId" in byId.d));
  // Second run: nothing to do, nothing written.
  assert.deepEqual(s.api.migrateAllThemePrefs(), { changed: 0 });
  assert.equal(s.saves, 1);
});

// ---------------------------------------------------------------------------
// PUT /api/user/theme-id
// ---------------------------------------------------------------------------

function putThemeId(body, users) {
  var listeners = {};
  var req = { method: "PUT", url: "/api/user/theme-id", on: function (e, fn) { listeners[e] = fn; } };
  var res = {
    status: null, body: "",
    writeHead: function (s) { this.status = s; },
    end: function (b) { this.body = b || ""; }
  };
  var ctx = {
    users: users,
    getMultiUserFromReq: function () { return { id: "u1" }; },
    isRequestAuthed: function () { return true; },
    projects: { forEach: function () {} },
    opts: {},
    CONFIG_DIR: os.tmpdir()
  };
  attachSettings(ctx).handleRequest(req, res, "/api/user/theme-id");
  listeners.data(JSON.stringify(body));
  listeners.end();
  return res;
}

test("PUT /api/user/theme-id: saves a legal id, accepts null to clear, refuses anything else", function () {
  var store = fakeStore([{ id: "u1" }]);
  var users = { setThemeId: store.api.setThemeId };
  var ok = putThemeId({ themeId: "harbor" }, users);
  assert.equal(ok.status, 200);
  assert.equal(store.api.getThemeId("u1"), "harbor");
  assert.equal(putThemeId({ themeId: null }, users).status, 200);
  assert.equal(store.api.getThemeId("u1"), null);
  assert.equal(putThemeId({ themeId: "../x" }, users).status, 400);
  assert.equal(putThemeId({}, users).status, 400);
});
