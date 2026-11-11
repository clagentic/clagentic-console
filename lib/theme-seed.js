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
var core = require("./public/theme-core.js");

var THEMES_DIR = path.join(__dirname, "themes");
var DARK_ID = "clagentic-dark";
var LIGHT_ID = "clagentic-light";

var cache = null;

function bundledVars() {
  if (cache) return cache;
  var listed = themeFiles.listThemes({ bundledDir: THEMES_DIR, customDir: null }).bundled;
  if (!listed[DARK_ID] || !listed[LIGHT_ID]) {
    throw new Error("the bundled themes " + DARK_ID + " and " + LIGHT_ID + " could not be read from " + THEMES_DIR);
  }
  cache = {
    dark: core.deriveVars(listed[DARK_ID]),
    light: core.deriveVars(listed[LIGHT_ID]),
  };
  return cache;
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
  systemVarsCss: systemVarsCss,
  firstPaintCss: firstPaintCss,
  stampManifest: stampManifest,
  offlinePageCss: offlinePageCss,
  stampServiceWorker: stampServiceWorker,
};
