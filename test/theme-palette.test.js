// The palette: the approved Dark and Light values are what the console shows,
// every colour is decided in one place (the theme files, through the derivation
// in lib/public/theme-core.js), the page paints the same colours before and
// after scripts run, every variable the frontend reads is defined in both
// themes and in a custom theme, and the text and boundary pairs meet WCAG AA.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var vm = require("vm");
var { pathToFileURL } = require("url");

var core = require("../lib/public/theme-core.js");
var themeFiles = require("../lib/theme-files");
var themeSeed = require("../lib/theme-seed");

var ROOT = path.join(__dirname, "..");
var PUBLIC = path.join(ROOT, "lib", "public");
var THEMES_DIR = path.join(ROOT, "lib", "themes");
var BRAND = path.join(ROOT, "docs", "brand", "BRAND.md");

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function read(file) { return fs.readFileSync(file, "utf8"); }

var FILES = {
  dark: readJson(path.join(THEMES_DIR, "clagentic-dark.json")),
  light: readJson(path.join(THEMES_DIR, "clagentic-light.json")),
};
var THEMES = {
  dark: themeFiles.listThemes({ bundledDir: THEMES_DIR, customDir: null }).bundled["clagentic-dark"],
  light: themeFiles.listThemes({ bundledDir: THEMES_DIR, customDir: null }).bundled["clagentic-light"],
};
var VARS = { dark: core.deriveVars(THEMES.dark), light: core.deriveVars(THEMES.light) };

// A theme file with only the sixteen colours (no tokens, no accent2).
function sixteen(over) {
  var t = {
    name: "Harbor", variant: "dark",
    base00: "0B1620", base01: "12202D", base02: "1F3345", base03: "4A6378",
    base04: "7F97AB", base05: "C5D3DE", base06: "E4EDF4", base07: "F5FAFD",
    base08: "F2677C", base09: "3DC9E0", base0A: "E6B85C", base0B: "5CCFA0",
    base0C: "6FB7E9", base0D: "5B8DEF", base0E: "B58CF2", base0F: "C98A6B"
  };
  return Object.assign(t, over || {});
}

function sixteenLight() {
  return sixteen({
    name: "Paper", variant: "light",
    base00: "FAF7F0", base01: "FFFFFF", base02: "D8D2C4", base03: "6B6557",
    base04: "524D41", base05: "2F2B22", base06: "1A1710", base07: "0A0904",
    base08: "A8232F", base09: "0B6B8C", base0A: "8A5A00", base0B: "1F6B3A",
    base0C: "5B3FA8", base0D: "2A55B0", base0E: "7A3CC4", base0F: "9A4A2A"
  });
}

function sourceFiles(dir, exts, out) {
  out = out || [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full, exts, out);
    if (exts.indexOf(path.extname(e.name)) !== -1 && !/\.min\.js$/.test(e.name)) out.push(full);
  });
  return out;
}

// ---------------------------------------------------------------------------
// AC1: the applied values equal docs/brand/BRAND.md
// ---------------------------------------------------------------------------

function brandSection(startHeading, endHeading) {
  var md = read(BRAND);
  var start = md.indexOf(startHeading);
  var end = md.indexOf(endHeading, start + startHeading.length);
  assert.ok(start !== -1 && end !== -1, "BRAND.md sections " + startHeading + " / " + endHeading);
  return md.slice(start, end);
}

// { "--bg": "#1C2433", ... } from the CSS-var table, and { base00: "1C2433", ... }
// from the base16 table, of one section.
function parseBrandSection(text) {
  var cssVars = {};
  text.split("\n").forEach(function (line) {
    var m = /^\|\s*`(--[a-z0-9-]+)`(?:\s+to\s+`(--[a-z0-9-]+)`)?\s*\|\s*([^|]*)\|/.exec(line);
    if (!m) return;
    var values = m[3].match(/#[0-9A-Fa-f]{6}/g) || [];
    if (!m[2]) {
      assert.equal(values.length, 1, m[1]);
      cssVars[m[1]] = values[0];
      return;
    }
    var prefix = /^(--[a-z]+)(\d+)$/.exec(m[1]);
    var last = Number(/(\d+)$/.exec(m[2])[1]);
    for (var i = Number(prefix[2]); i <= last; i++) cssVars[prefix[1] + i] = values[i - Number(prefix[2])];
  });
  var base = {};
  var re = /`(base0[0-9A-F]|accent2)`\s*\|\s*`#([0-9A-Fa-f]{6})`/g;
  var b;
  while ((b = re.exec(text))) base[b[1]] = b[2];
  return { cssVars: cssVars, base: base };
}

var BRAND_SECTIONS = {
  dark: parseBrandSection(brandSection("### Dark Theme Palette", "### Light Theme Palette")),
  light: parseBrandSection(brandSection("### Light Theme Palette", "### Chat layout")),
};

["dark", "light"].forEach(function (mode) {
  test("the " + mode + " palette: every CSS variable in BRAND.md is the value the console applies", function () {
    var brand = BRAND_SECTIONS[mode].cssVars;
    var names = Object.keys(brand);
    assert.ok(names.length >= 25, "BRAND.md table parsed: " + names.length + " variables");
    names.forEach(function (name) {
      assert.equal(String(VARS[mode][name]).toUpperCase(), brand[name].toUpperCase(), mode + " " + name);
    });
  });

  test("the " + mode + " palette: the base16 file in lib/themes equals the BRAND.md table", function () {
    var brand = BRAND_SECTIONS[mode].base;
    assert.equal(Object.keys(brand).length, 17, "sixteen colours and accent2");
    Object.keys(brand).forEach(function (key) {
      assert.equal(String(FILES[mode][key]).toUpperCase(), brand[key].toUpperCase(), mode + " " + key);
    });
  });
});

// ---------------------------------------------------------------------------
// AC2: what is painted before scripts run equals what is painted after
// ---------------------------------------------------------------------------

function parseDecls(text) {
  var out = {};
  var re = /(--[\w-]+):([^;]+);/g;
  var m;
  while ((m = re.exec(text))) out[m[1]] = m[2];
  return out;
}

function seedBlocks() {
  var css = themeSeed.firstPaintCss();
  var dark = /^:root\{([^}]*)\}/m.exec(css);
  var light = /^:root\.light-theme\{([^}]*)\}/m.exec(css);
  var media = /^@media \(prefers-color-scheme: light\)\{:root:not\(\.dark-theme\)\{([^}]*)\}\}/m.exec(css);
  assert.ok(dark && light && media, "the first-paint stylesheet has a root, a light-theme and a system-light block");
  return { dark: parseDecls(dark[1]), light: parseDecls(light[1]), media: parseDecls(media[1]) };
}

test("first paint: the stylesheet the server builds holds exactly the derived values of Dark and Light", function () {
  var b = seedBlocks();
  assert.deepEqual(b.dark, VARS.dark);
  assert.deepEqual(b.light, VARS.light);
  assert.deepEqual(b.media, VARS.light, "a light system preference with no class paints Light");
});

// Runs the first-paint script of index.html against a stored state and a
// system preference, and returns the variables the page paints with: the
// inline ones the script set, else the block of the seed stylesheet the
// script's class selects.
function firstPaint(stored, systemLight) {
  var html = read(path.join(PUBLIC, "index.html"));
  var part = html.split("</script>").filter(function (p) { return p.indexOf('"clagentic-theme"') !== -1; })[0];
  var script = part.slice(part.lastIndexOf("<script>") + "<script>".length);
  var blocks = seedBlocks();
  var inline = {};
  var classes = {};
  var meta = { content: null, setAttribute: function (k, v) { this.content = v; } };
  var root = {
    style: { setProperty: function (k, v) { inline[k] = v; } },
    classList: {
      add: function (c) { classes[c] = true; },
      remove: function (c) { delete classes[c]; }
    }
  };
  function painted() {
    var base = classes["light-theme"] ? blocks.light
      : classes["dark-theme"] ? blocks.dark
      : (systemLight ? blocks.media : blocks.dark);
    return Object.assign({}, base, inline);
  }
  vm.runInNewContext(script, {
    localStorage: { getItem: function (k) { return Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : null; } },
    document: { documentElement: root, querySelector: function () { return meta; } },
    window: { matchMedia: function () { return { matches: systemLight }; } },
    getComputedStyle: function () { return { getPropertyValue: function (n) { return painted()[n]; } }; }
  });
  return { vars: painted(), classes: Object.keys(classes), metaColor: meta.content };
}

var FIRST_PAINT_ROWS = [
  // [label, stored, system prefers light, expected mode]
  ["empty cache, dark system", {}, false, "dark"],
  ["empty cache, light system", {}, true, "light"],
  ["mode dark, light system", { "clagentic-mode": "dark" }, true, "dark"],
  ["mode light, dark system", { "clagentic-mode": "light" }, false, "light"],
  ["stale applied variant, Follow system, light system", { "clagentic-theme": "clagentic-dark", "clagentic-theme-variant": "dark" }, true, "light"],
];

FIRST_PAINT_ROWS.forEach(function (row) {
  test("first paint: " + row[0] + " paints the colours the loaded page applies", function () {
    var out = firstPaint(row[1], row[2]);
    assert.deepEqual(out.classes, [row[3] + "-theme"], "one mode class, no dark flash in Light");
    assert.deepEqual(out.vars, VARS[row[3]]);
    assert.equal(out.metaColor, VARS[row[3]]["--bg"], "the browser chrome colour is the page colour");
  });
});

test("first paint: a chosen custom theme paints from its cached variables, in its own variant", function () {
  var custom = core.deriveVars(sixteenLight());
  var out = firstPaint({
    "clagentic-theme": "paper", "clagentic-theme-custom": "paper", "clagentic-theme-migrated": "3",
    "clagentic-theme-variant": "light", "clagentic-theme-vars": JSON.stringify(custom)
  }, false);
  assert.deepEqual(out.classes, ["light-theme"]);
  assert.deepEqual(out.vars, custom);
});

test("first paint: cached variables from before the migration version are not used", function () {
  var stale = { "--bg": "#000000" };
  var out = firstPaint({
    "clagentic-theme": "paper", "clagentic-theme-custom": "paper", "clagentic-theme-migrated": "2",
    "clagentic-theme-variant": "light", "clagentic-theme-vars": JSON.stringify(stale)
  }, false);
  assert.deepEqual(out.vars, VARS.dark);
});

test("first paint: the stylesheet is linked before the script and before the app stylesheet; the script and the shell carry no colour", function () {
  var html = read(path.join(PUBLIC, "index.html"));
  var seed = html.indexOf('href="theme-seed.css"');
  var script = html.indexOf('"clagentic-theme"');
  var app = html.indexOf('href="style.css');
  assert.ok(seed !== -1 && seed < script && script < app, "theme-seed.css, then the script, then style.css");
  assert.match(html, /<meta name="theme-color">/);
  var head = html.slice(0, html.indexOf("</head>"));
  var scriptText = head.slice(script - 200, head.indexOf("</script>", script));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(scriptText), "no colour literal in the first-paint script");
});

test("first paint: the migration version the script waits for is the one theme.js writes", function () {
  var html = read(path.join(PUBLIC, "index.html"));
  var js = read(path.join(PUBLIC, "modules", "theme.js"));
  var inHtml = /"clagentic-theme-migrated"\)==="(\d+)"/.exec(html);
  var inJs = /var MIGRATION_VERSION = "(\d+)"/.exec(js);
  assert.ok(inHtml && inJs);
  assert.equal(inHtml[1], inJs[1]);
});

test("the manifest and the offline page take their colours from the Dark theme file, and the service worker is stamped", function () {
  var manifestSource = read(path.join(PUBLIC, "manifest.json"));
  assert.ok(!/color/.test(manifestSource), "the static manifest holds no colour");
  var stamped = JSON.parse(themeSeed.stampManifest(manifestSource));
  assert.equal(stamped.theme_color, VARS.dark["--bg"]);
  assert.equal(stamped.background_color, VARS.dark["--bg"]);
  assert.equal(stamped.name, "Clagentic: Console");

  var sw = read(path.join(PUBLIC, "sw.js"));
  assert.match(sw, /"__OFFLINE_PAGE_CSS__"/);
  var out = themeSeed.stampServiceWorker(sw);
  assert.ok(out.indexOf("__OFFLINE_PAGE_CSS__") === -1);
  assert.ok(out.indexOf(VARS.dark["--bg"]) !== -1 && out.indexOf(VARS.light["--bg"]) !== -1);
  assert.ok(out.indexOf(VARS.dark["--text-muted"]) !== -1 && out.indexOf(VARS.light["--text-muted"]) !== -1);
});

test("the server serves the first-paint stylesheet and the stamped manifest from the theme files", function () {
  var server = read(path.join(ROOT, "lib", "server.js"));
  assert.match(server, /urlPath === "\/theme-seed\.css"[\s\S]*themeSeed\.firstPaintCss\(\)/);
  assert.match(server, /urlPath === "\/manifest\.json"[\s\S]*themeSeed\.stampManifest/);
  assert.match(server, /themeSeed\.stampServiceWorker\(/);
  assert.match(server, /urlPath === "\/theme-core\.js"[\s\S]*themeSeed\.themeCoreScript/);
});

test("the built-in palettes come from the theme files, in the browser's script and under Node", function () {
  var sandbox = {};
  vm.runInNewContext(themeSeed.themeCoreScript(), sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.ClagenticThemeCore.builtin)), { dark: THEMES.dark, light: THEMES.light }, "served script");
  assert.deepEqual(core.builtin, { dark: FILES.dark, light: FILES.light }, "Node");
  assert.deepEqual(typeof sandbox.ClagenticThemeCore.deriveVars, "function", "the derivation is the served file's own");
  assert.match(read(path.join(PUBLIC, "modules", "theme-colors.js")), /CLAGENTIC_DARK = core\.builtin\.dark/);
});

test("a themed route that fails is logged with its route and message, then falls through", function () {
  var server = read(path.join(ROOT, "lib", "server.js"));
  var fn = server.slice(server.indexOf("function serveThemed"), server.indexOf("function serveStatic"));
  assert.match(fn, /catch \(e\) \{[^}]*console\.error\([^)]*urlPath[^)]*e\.message[^}]*return false;/);
});

test("the sign-in and setup pages take the variables of the theme files", function () {
  var pages = require("../lib/pages");
  var css = themeSeed.systemVarsCss();
  [VARS.dark["--bg"], VARS.light["--bg"], VARS.dark["--border-strong"], VARS.light["--on-accent"]].forEach(function (v) {
    assert.ok(css.indexOf(v) !== -1, v);
  });
  var login = pages.multiUserLoginPageHtml();
  assert.ok(login.indexOf("--bg:" + VARS.dark["--bg"]) !== -1);
  assert.ok(login.indexOf("--bg:" + VARS.light["--bg"]) !== -1);
  var setup = pages.setupPageHtml("https://host.example", "http://host.example", false, false);
  assert.ok(setup.indexOf("--bg:" + VARS.dark["--bg"]) !== -1);
  assert.match(setup, /color:var\(--on-accent\)/);
});

// ---------------------------------------------------------------------------
// AC3: every referenced variable is defined in both themes and in a custom theme
// ---------------------------------------------------------------------------

function referencedVars() {
  var refs = {};
  sourceFiles(PUBLIC, [".css", ".js", ".html"]).forEach(function (file) {
    var text = read(file);
    var re = /var\(\s*(--[A-Za-z0-9_-]+)/g;
    var m;
    while ((m = re.exec(text))) (refs[m[1]] = refs[m[1]] || []).push(path.relative(PUBLIC, file));
    var js = /(?:getComputedVar|getPropertyValue)\(\s*["'](--[A-Za-z0-9_-]+)["']/g;
    while ((m = js.exec(text))) (refs[m[1]] = refs[m[1]] || []).push(path.relative(PUBLIC, file));
  });
  return refs;
}

// Variables a stylesheet, a style attribute or a script declares for itself
// (a component's own scoped variable, or a layout length). A theme colour is
// never declared this way; the single-source scan below holds that.
function declaredLocally() {
  var declared = {};
  sourceFiles(PUBLIC, [".css", ".js", ".html"]).forEach(function (file) {
    var text = read(file);
    var m;
    var decl = /(?:^|[{;\s"'(])(--[A-Za-z0-9_-]+)\s*:/g;
    while ((m = decl.exec(text))) declared[m[1]] = true;
    var prop = /setProperty\(\s*["'](--[A-Za-z0-9_-]+)["']/g;
    while ((m = prop.exec(text))) declared[m[1]] = true;
  });
  return declared;
}

test("every variable the frontend reads is defined in Dark, in Light and in a custom theme", function () {
  var refs = referencedVars();
  var local = declaredLocally();
  var custom = core.deriveVars(themeFiles.normalizeTheme(sixteen()));
  var missing = [];
  Object.keys(refs).forEach(function (name) {
    var inThemes = name in VARS.dark && name in VARS.light && name in custom;
    if (!inThemes && !local[name]) missing.push(name + " (" + refs[name][0] + ")");
  });
  assert.deepEqual(missing, [], "referenced and defined nowhere");
  assert.ok(Object.keys(refs).length > 50, "the scan reads the stylesheets: " + Object.keys(refs).length);
});

test("the 24 variables that were referenced and defined nowhere are theme variables now", function () {
  var wasUndefined = ["--text-primary", "--text-dim", "--text-tertiary", "--bg-secondary", "--bg-hover",
    "--bg-active", "--bg-elevated", "--bg-surface", "--bg-tertiary", "--bg-deep", "--bg-dim", "--bg-deeper",
    "--accent-rgb", "--success-rgb", "--warning-rgb", "--accent-text", "--hover", "--hover-bg",
    "--border-bright", "--warn", "--surface-2", "--overlay-soft", "--green"];
  var custom = core.deriveVars(themeFiles.normalizeTheme(sixteen()));
  wasUndefined.forEach(function (name) {
    assert.ok(name in VARS.dark && name in VARS.light && name in custom, name);
  });
  assert.match(read(path.join(PUBLIC, "css", "base.css")), /--font-mono:/, "--font-mono is a font, declared once in base.css");
});

test("Dark, Light and a custom theme define the same set of variables, none empty", function () {
  var custom = core.deriveVars(themeFiles.normalizeTheme(sixteen()));
  var names = Object.keys(VARS.dark).sort();
  assert.deepEqual(Object.keys(VARS.light).sort(), names);
  assert.deepEqual(Object.keys(custom).sort(), names);
  [VARS.dark, VARS.light, custom].forEach(function (vars) {
    names.forEach(function (n) { assert.ok(String(vars[n]).length > 0, n); });
  });
});

// ---------------------------------------------------------------------------
// AC4: WCAG AA
// ---------------------------------------------------------------------------

var SURFACES = ["--sidebar-bg", "--bg", "--bg-alt", "--user-bubble", "--input-bg", "--code-bg", "--sidebar-active"];
// BRAND.md: the dimmest text token is used on these only.
var DIMMER_SURFACES = ["--sidebar-bg", "--bg", "--bg-alt", "--code-bg"];
var ACCENT_SURFACES = ["--sidebar-bg", "--bg", "--bg-alt", "--code-bg"];

function contrastRows() {
  var rows = [];
  ["--text", "--text-secondary", "--text-muted"].forEach(function (fg) {
    SURFACES.forEach(function (bg) { rows.push([fg, bg, 4.5]); });
  });
  DIMMER_SURFACES.forEach(function (bg) { rows.push(["--text-dimmer", bg, 4.5]); });
  ["--accent", "--accent2", "--error", "--success", "--warning"].forEach(function (fg) {
    ACCENT_SURFACES.forEach(function (bg) { rows.push([fg, bg, 4.5]); });
  });
  rows.push(["--on-accent", "--accent", 4.5]);
  ["--av0", "--av1", "--av2", "--av3"].forEach(function (bg) { rows.push(["--on-av", bg, 4.5]); });
  ["--sidebar-bg", "--bg", "--bg-alt", "--input-bg"].forEach(function (bg) { rows.push(["--border-strong", bg, 3]); });
  ["--hl-comment", "--hl-keyword", "--hl-string", "--hl-number", "--hl-function", "--hl-variable", "--hl-type",
    "--hl-constant", "--hl-tag", "--hl-attr", "--hl-regexp", "--hl-meta", "--hl-builtin", "--hl-symbol",
    "--hl-addition", "--hl-deletion"].forEach(function (fg) { rows.push([fg, "--code-bg", 4.5]); });
  return rows;
}

["dark", "light"].forEach(function (mode) {
  test("WCAG AA, " + mode + ": every text pair is 4.5:1 and every control boundary is 3:1", function () {
    var failing = [];
    contrastRows().forEach(function (row) {
      var ratio = core.contrast(VARS[mode][row[0]], VARS[mode][row[1]]);
      if (ratio < row[2]) failing.push(row[0] + " on " + row[1] + " = " + ratio.toFixed(2) + " (needs " + row[2] + ")");
    });
    assert.deepEqual(failing, []);
  });
});

// ---------------------------------------------------------------------------
// AC5: terminal, diagrams and code highlighting come from the active mode
// ---------------------------------------------------------------------------

["dark", "light"].forEach(function (mode) {
  test("terminal, " + mode + ": drawn from the mode's palette and legible on its background", function () {
    var term = core.deriveTerminalTheme(THEMES[mode]);
    assert.equal(term.background, VARS[mode]["--code-bg"]);
    assert.equal(term.foreground, VARS[mode]["--text-secondary"]);
    var failing = [];
    ["foreground", "red", "green", "yellow", "blue", "magenta", "cyan", "brightBlack", "brightRed", "brightGreen",
      "brightYellow", "brightBlue", "brightMagenta", "brightCyan"].forEach(function (k) {
      var ratio = core.contrast(term[k], term.background);
      if (ratio < 4.5) failing.push(k + " " + term[k] + " = " + ratio.toFixed(2));
    });
    assert.deepEqual(failing, []);
  });

  test("diagrams, " + mode + ": Mermaid variables come from the mode's palette and their text is legible", function () {
    var m = core.deriveMermaidVars(THEMES[mode]);
    assert.equal(m.darkMode, mode === "dark");
    assert.equal(m.primaryTextColor, VARS[mode]["--text"]);
    assert.equal(m.background, VARS[mode]["--code-bg"]);
    var text = [["primaryTextColor", "primaryColor"], ["secondaryTextColor", "secondaryColor"],
      ["tertiaryTextColor", "tertiaryColor"], ["noteTextColor", "noteBkgColor"], ["textColor", "background"]];
    text.forEach(function (p) {
      assert.ok(core.contrast(m[p[0]], m[p[1]]) >= 4.5, mode + " " + p[0] + " on " + p[1]);
    });
    assert.ok(core.contrast(m.lineColor, m.background) >= 3, "lines");
    assert.ok(core.contrast(m.nodeBorder, m.primaryColor) >= 3, "node borders");
  });
});

test("diagrams use Mermaid's base theme so the palette variables apply in Light as well as Dark", function () {
  var src = read(path.join(PUBLIC, "modules", "markdown.js"));
  assert.ok(!/theme:\s*"dark"/.test(src));
  assert.equal((src.match(/theme:\s*"base"/g) || []).length, 2);
});

test("the terminal and diagram colours are rebuilt from the active theme on every change", function () {
  var src = read(path.join(PUBLIC, "modules", "theme.js"));
  assert.match(src, /deriveTerminalTheme\(theme\)/);
  assert.match(src, /deriveMermaidVars\(theme\)/);
  assert.match(src, /setTerminalTheme\(termTheme\)/);
  assert.match(src, /updateMermaidTheme\(mermaidVars\)/);
});

// ---------------------------------------------------------------------------
// AC6: a custom theme with only the 16 colours is fully derived
// ---------------------------------------------------------------------------

var COLOUR_VALUE = /^(#[0-9A-Fa-f]{6}|rgba\(\d+, \d+, \d+, [0-9.]+\)|\d+, \d+, \d+|\d+,\d+,\d+)$/;

[["dark", sixteen], ["light", sixteenLight]].forEach(function (row) {
  test("custom theme (" + row[0] + ", sixteen colours): every variable is derived, valid and styled", function () {
    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palette-test-"));
    fs.writeFileSync(path.join(tmp, "mine.json"), JSON.stringify(row[1]()));
    var listed = themeFiles.listThemes({ bundledDir: THEMES_DIR, customDir: tmp });
    assert.deepEqual(Object.keys(listed.custom), ["mine"]);
    var vars = core.deriveVars(listed.custom.mine);
    assert.deepEqual(Object.keys(vars).sort(), Object.keys(VARS.dark).sort());
    Object.keys(vars).forEach(function (n) {
      assert.match(String(vars[n]), COLOUR_VALUE, n);
    });
    // The derived text and boundary colours stay usable, not just present.
    assert.ok(core.contrast(vars["--text"], vars["--bg"]) >= 7, "text on page");
    assert.ok(core.contrast(vars["--text-muted"], vars["--bg"]) >= 4.5, "muted text on page");
    assert.ok(core.contrast(vars["--on-accent"], vars["--accent"]) >= 4.5, "text on an accent fill");
    assert.ok(core.contrast(vars["--border-strong"], vars["--bg"]) >= 3, "control boundary on page");
    assert.ok(core.contrast(vars["--on-av"], vars["--av0"]) >= 3, "initials on an avatar");
    var term = core.deriveTerminalTheme(listed.custom.mine);
    assert.equal(term.background, vars["--code-bg"]);
    assert.equal(core.deriveMermaidVars(listed.custom.mine).darkMode, row[0] === "dark");
  });
});

test("custom theme: on-av is chosen against the stated avatar fills, not the derived ones", function () {
  [["dark", sixteen], ["light", sixteenLight]].forEach(function (row) {
    var base = row[1]();
    var derived = core.resolveTokens(themeFiles.normalizeTheme(base));
    // A fill the derived on-av would fail on: the opposite end of the range.
    var fill = row[0] === "dark" ? "0A0904" : "F5FAFD";
    var themed = themeFiles.normalizeTheme(Object.assign({}, base, { tokens: { av0: fill, av1: fill, av2: fill, av3: fill } }));
    var t = core.resolveTokens(themed);
    ["av0", "av1", "av2", "av3"].forEach(function (k) {
      assert.ok(core.contrast(t["on-av"], t[k]) >= 4.5, row[0] + " on-av on stated " + k);
    });
    assert.notEqual(t["on-av"], derived["on-av"], row[0] + ": the stated fill changed the choice");
  });
});

test("custom theme: a tokens object states exact colours, the rest stay derived, a bad value skips the file", function () {
  var bare = core.deriveVars(themeFiles.normalizeTheme(sixteen()));
  var themed = themeFiles.normalizeTheme(sixteen({ tokens: { "sidebar-bg": "112233", "warning": "FFAA00", "unknown": "zz" } }));
  assert.deepEqual(themed.tokens, { "sidebar-bg": "112233", "warning": "FFAA00" }, "unknown keys are dropped");
  var vars = core.deriveVars(themed);
  assert.equal(vars["--sidebar-bg"], "#112233");
  assert.equal(vars["--warning"], "#FFAA00");
  assert.equal(vars["--warn"], "#FFAA00", "an alias follows the token it names");
  assert.equal(vars["--user-bubble"], bare["--user-bubble"], "an unstated token is still derived");
  assert.notEqual(vars["--sidebar-hover"], bare["--sidebar-hover"], "a dependent colour follows the stated token");
  assert.equal(themeFiles.normalizeTheme(sixteen({ tokens: { "sidebar-bg": "nothex" } })), null);
  assert.equal(themeFiles.normalizeTheme(sixteen({ tokens: [] })), null);
  assert.equal(themeFiles.normalizeTheme(sixteen({ tokens: "x" })), null);
});

// ---------------------------------------------------------------------------
// AC7: a colour is declared in one place
// ---------------------------------------------------------------------------

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

var COLOUR_LITERAL = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(/;

test("single source: base.css :root declares no colour", function () {
  var css = stripComments(read(path.join(PUBLIC, "css", "base.css")));
  var root = /:root\s*\{([^}]*)\}/.exec(css);
  assert.ok(root, ":root block");
  assert.ok(!COLOUR_LITERAL.test(root[1]), "no colour literal in :root");
  var colourTokens = Object.keys(VARS.dark).filter(function (n) { return new RegExp("(^|[\\s;])" + n + "\\s*:").test(root[1]); });
  assert.deepEqual(colourTokens, [], "no theme variable is declared in :root");
});

test("single source: no stylesheet or script sets a theme variable to a literal colour", function () {
  var tokenNames = Object.keys(VARS.dark);
  var offenders = [];
  sourceFiles(PUBLIC, [".css", ".html", ".js"]).forEach(function (file) {
    var rel = path.relative(PUBLIC, file);
    if (rel === "theme-core.js") return;
    var text = stripComments(read(file));
    var decl = /(--[A-Za-z0-9_-]+)\s*:\s*([^;}]*)/g;
    var m;
    while ((m = decl.exec(text))) {
      if (tokenNames.indexOf(m[1]) !== -1 && COLOUR_LITERAL.test(m[2])) offenders.push(rel + " " + m[1] + ": " + m[2].trim());
    }
    var prop = /setProperty\(\s*["'](--[A-Za-z0-9_-]+)["']\s*,\s*["']([^"']*)["']/g;
    while ((m = prop.exec(text))) {
      if (tokenNames.indexOf(m[1]) !== -1 && COLOUR_LITERAL.test(m[2])) offenders.push(rel + " " + m[1] + ": " + m[2]);
    }
  });
  assert.deepEqual(offenders, []);
});

test("single source: no shipped script, page or manifest holds a palette value of Dark or Light", function () {
  var palette = {};
  ["dark", "light"].forEach(function (mode) {
    Object.keys(FILES[mode]).forEach(function (k) {
      var v = FILES[mode][k];
      if (/^[0-9A-Fa-f]{6}$/.test(v)) palette[v.toUpperCase()] = true;
    });
    Object.keys(FILES[mode].tokens).forEach(function (k) { palette[FILES[mode].tokens[k].toUpperCase()] = true; });
  });
  // White and black are the overlay and shadow bases of the derivation, not a
  // palette choice.
  delete palette.FFFFFF;
  delete palette["000000"];
  // Every shipped script, page and manifest is scanned. These files carry a
  // colour that only coincides with a palette value (a user's default colour,
  // the logo mark, component styles in the page body): it is not a theme token,
  // and replacing it belongs to the colour sweep, so a hit there is not a
  // second declaration of a token.
  var notTokens = ["users.js", "server-settings.js", "server-auth.js", "project-user-mention.js", "server-dm.js",
                   "server.js", "daemon.js", "mention.js", "console-logo.js", "profile.js"];
  var hold = sourceFiles(path.join(ROOT, "lib"), [".js", ".json", ".html"]).filter(function (file) {
    return file.indexOf(THEMES_DIR + path.sep) !== 0 && path.basename(file) !== "emoji-data.json" &&
      notTokens.indexOf(path.basename(file)) === -1;
  }).concat([path.join(PUBLIC, "css", "base.css")]);
  var found = [];
  hold.forEach(function (file) {
    var m;
    var re = /#([0-9A-Fa-f]{6})\b/g;
    var text = read(file);
    // The page body carries component colours (the sweep's to replace); the
    // shell is the head.
    if (path.basename(file) === "index.html") text = text.slice(0, text.indexOf("</head>"));
    while ((m = re.exec(text))) if (palette[m[1].toUpperCase()]) found.push(path.relative(ROOT, file) + " " + m[0]);
  });
  assert.deepEqual(found, []);
});

test("single source: the theme module declares no palette of its own", function () {
  var prefs = read(path.join(PUBLIC, "modules", "theme-prefs.js"));
  assert.ok(!/CLAGENTIC_(DARK|LIGHT)\s*=/.test(prefs));
  assert.ok(!/base0[0-9A-F]\s*:/.test(prefs));
});

test("single source: one derivation, used by the browser and the server", function () {
  var theme = read(path.join(PUBLIC, "modules", "theme.js"));
  assert.ok(!/function (computeVars|computeTerminalTheme|computeMermaidVars|darken|lighten|mixColors|hexToRgba?)\b/.test(theme));
  assert.ok(!/defaultExactVars/.test(theme));
  var pages = read(path.join(ROOT, "lib", "pages.js"));
  assert.ok(!/_authVarsFor|_mixColors|_hexToRgba/.test(pages), "the pages keep no derivation of their own");
  assert.match(read(path.join(PUBLIC, "modules", "theme-colors.js")), /globalThis\.ClagenticThemeCore/);
});
