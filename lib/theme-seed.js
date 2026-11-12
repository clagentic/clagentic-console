"use strict";

// What the server paints before the browser has run any script: the
// first-paint stylesheet, the manifest colours, the offline page, and the CSS
// variables of the sign-in and setup pages. All of it comes from the two
// bundled theme files (lib/themes/) through the one derivation in
// lib/public/theme-core.js, the same function the browser applies after
// load, so what is painted first is what is painted last.
//
// Dark is the default. A visitor whose system asks for light gets Light: the
// pages here are served before a stored choice can be read.

var path = require("path");
var themeFiles = require("./theme-files");
var clientFiles = require("./client-files");
var core = require("./public/theme-core.js");

var THEMES_DIR = path.join(__dirname, "themes");
var DARK_ID = "clagentic-dark";
var LIGHT_ID = "clagentic-light";

// Both are read when this module loads (daemon startup), not on first request,
// so a later install cannot change what this process serves: the script comes
// from the pinned client file set, the palettes from the files read here.
var CORE_SOURCE = (clientFiles.publicFiles.read("theme-core.js") || Buffer.alloc(0)).toString("utf8");
var PINNED_BUNDLED = themeFiles.listThemes({ bundledDir: THEMES_DIR, customDir: null }).bundled;

var cache = null;

/** The bundled themes this process loaded, by id. A copy: callers may not change the pinned set. */
function pinnedBundledThemes() {
  return Object.assign({}, PINNED_BUNDLED);
}

function bundledVars() {
  return loadBundled().vars;
}

function loadBundled() {
  if (cache) return cache;
  var listed = PINNED_BUNDLED;
  if (!listed[DARK_ID] || !listed[LIGHT_ID]) {
    throw new Error("the bundled themes " + DARK_ID + " and " + LIGHT_ID + " could not be read from " + THEMES_DIR);
  }
  cache = {
    themes: { dark: listed[DARK_ID], light: listed[LIGHT_ID] },
    vars: {
      dark: core.deriveVars(listed[DARK_ID]),
      light: core.deriveVars(listed[LIGHT_ID]),
    },
  };
  return cache;
}

// lib/public/theme-core.js as the browser receives it: the file, plus the two
// built-in palettes read from the theme files. The browser's theme code holds
// them before /api/themes answers; under Node the file reads them itself.
function themeCoreScript() {
  var t = loadBundled().themes;
  if (!CORE_SOURCE) throw new Error("theme-core.js was not part of the client files loaded at startup");
  return CORE_SOURCE +
    "\nglobalThis.ClagenticThemeCore.builtin = " + JSON.stringify({ dark: t.dark, light: t.light }) + ";\n";
}

// Variables for the pages that carry no script: dark by default, light when
// the system asks for it.
function systemVarsCss() {
  var v = bundledVars();
  return ":root{" + core.varsToCss(v.dark) + "}" +
    "@media(prefers-color-scheme:light){:root{" + core.varsToCss(v.light) + "}}";
}

// The stylesheet the app shell links before anything else. The class the
// first-paint script puts on <html> (light-theme or dark-theme) selects the
// block; with neither class, the system preference does.
function firstPaintCss() {
  var v = bundledVars();
  var dark = core.varsToCss(v.dark);
  var light = core.varsToCss(v.light);
  return ":root{" + dark + "}\n" +
    ":root.light-theme{" + light + "}\n" +
    "@media (prefers-color-scheme: light){:root:not(.dark-theme){" + light + "}}\n";
}

// manifest.json with its two colours set to the Dark page colour.
function stampManifest(source) {
  var manifest = JSON.parse(source);
  var bg = bundledVars().dark["--bg"];
  manifest.background_color = bg;
  manifest.theme_color = bg;
  return JSON.stringify(manifest, null, 2) + "\n";
}

// The style of the page the service worker shows when the shell is not cached.
function offlinePageCss() {
  var v = bundledVars();
  function body(vars) {
    return "body{background:" + vars["--bg"] + ";color:" + vars["--text-muted"] + "}";
  }
  return body(v.dark) + "@media(prefers-color-scheme:light){" + body(v.light) + "}";
}

var OFFLINE_PLACEHOLDER = /"__OFFLINE_PAGE_CSS__"/;

// sw.js with the offline page style filled in.
function stampServiceWorker(source) {
  var css = JSON.stringify(offlinePageCss());
  return source.replace(OFFLINE_PLACEHOLDER, function () { return css; });
}

module.exports = {
  pinnedBundledThemes: pinnedBundledThemes,
  themeCoreScript: themeCoreScript,
  systemVarsCss: systemVarsCss,
  firstPaintCss: firstPaintCss,
  stampManifest: stampManifest,
  offlinePageCss: offlinePageCss,
  stampServiceWorker: stampServiceWorker,
};
