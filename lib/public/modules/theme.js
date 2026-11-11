import { iconHtml, refreshIcons } from './icons.js';
import { setTerminalTheme } from './terminal.js';
import { updateMermaidTheme } from './markdown.js';
import {
  CLAGENTIC_DARK, CLAGENTIC_LIGHT, DARK_ID, LIGHT_ID,
  migrateStoredTheme, resolveThemeId, reconcileServerPrefs
} from './theme-prefs.js';

// --- Color utilities ---

function hexToRgb(hex) {
  var h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16)
  };
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map(function (v) {
    var c = Math.max(0, Math.min(255, Math.round(v)));
    return c.toString(16).padStart(2, "0");
  }).join("");
}

function darken(hex, amount) {
  var c = hexToRgb(hex);
  var f = 1 - amount;
  return rgbToHex(c.r * f, c.g * f, c.b * f);
}

function lighten(hex, amount) {
  var c = hexToRgb(hex);
  return rgbToHex(
    c.r + (255 - c.r) * amount,
    c.g + (255 - c.g) * amount,
    c.b + (255 - c.b) * amount
  );
}

function mixColors(hex1, hex2, weight) {
  var c1 = hexToRgb(hex1);
  var c2 = hexToRgb(hex2);
  var w = weight;
  return rgbToHex(
    c1.r * w + c2.r * (1 - w),
    c1.g * w + c2.g * (1 - w),
    c1.b * w + c2.b * (1 - w)
  );
}

function hexToRgba(hex, alpha) {
  var c = hexToRgb(hex);
  return "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + alpha + ")";
}

function luminance(hex) {
  var c = hexToRgb(hex);
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}

// --- Clagentic Dark default: exact CSS values for initial render (before API loads) ---
var defaultExactVars = {
  "--bg": "#060810",
  "--bg-alt": "#111827",
  "--text": "#E0EAF4",
  "--text-secondary": "#C8D4E0",
  "--text-muted": "#7A8FA6",
  "--text-dimmer": "#3D5068",
  "--accent": "#00CFFF",
  "--accent-hover": "#33D8FF",
  "--accent-bg": "rgba(0, 207, 255, 0.12)",
  "--code-bg": "#05070E",
  "--border": "#1E2E48",
  "--border-subtle": "#101726",
  "--input-bg": "#172338",
  "--user-bubble": "#151F31",
  "--error": "#FF4D6A",
  "--success": "#29D9A8",
  "--warning": "#4A7FE8",
  "--sidebar-bg": "#04060B",
  "--sidebar-hover": "#0A0E19",
  "--sidebar-active": "#162134",
  "--filebrowser-bg": "#09090D",
  "--filebrowser-border": "#121B2C",
  "--accent-8": "rgba(0, 207, 255, 0.08)",
  "--accent-12": "rgba(0, 207, 255, 0.12)",
  "--accent-15": "rgba(0, 207, 255, 0.15)",
  "--accent-20": "rgba(0, 207, 255, 0.20)",
  "--accent-25": "rgba(0, 207, 255, 0.25)",
  "--accent-30": "rgba(0, 207, 255, 0.30)",
  "--accent2": "#4A7FE8",
  "--accent2-hover": "#6B97F0",
  "--accent2-bg": "rgba(74, 127, 232, 0.12)",
  "--accent2-8": "rgba(74, 127, 232, 0.08)",
  "--accent2-12": "rgba(74, 127, 232, 0.12)",
  "--accent2-15": "rgba(74, 127, 232, 0.15)",
  "--accent2-20": "rgba(74, 127, 232, 0.20)",
  "--accent2-25": "rgba(74, 127, 232, 0.25)",
  "--accent2-30": "rgba(74, 127, 232, 0.30)",
  "--error-8": "rgba(255, 77, 106, 0.08)",
  "--error-12": "rgba(255, 77, 106, 0.12)",
  "--error-15": "rgba(255, 77, 106, 0.15)",
  "--error-25": "rgba(255, 77, 106, 0.25)",
  "--success-8": "rgba(41, 217, 168, 0.08)",
  "--success-12": "rgba(41, 217, 168, 0.12)",
  "--success-15": "rgba(41, 217, 168, 0.15)",
  "--success-25": "rgba(41, 217, 168, 0.25)",
  "--warning-bg": "rgba(74, 127, 232, 0.12)",
  "--overlay-rgb": "255,255,255",
  "--shadow-rgb": "0,0,0",
  "--hl-comment": "#3D5068",
  "--hl-keyword": "#A855F7",
  "--hl-string": "#29D9A8",
  "--hl-number": "#00CFFF",
  "--hl-function": "#4A7FE8",
  "--hl-variable": "#FF4D6A",
  "--hl-type": "#4A7FE8",
  "--hl-constant": "#00CFFF",
  "--hl-tag": "#FF4D6A",
  "--hl-attr": "#4A7FE8",
  "--hl-regexp": "#7B3FE4",
  "--hl-meta": "#6366F1",
  "--hl-builtin": "#00CFFF",
  "--hl-symbol": "#6366F1",
  "--hl-addition": "#29D9A8",
  "--hl-deletion": "#FF4D6A"
};

// --- Compute CSS variables from a base16 palette ---
function computeVars(theme) {
  var b = {};
  var keys = ["base00","base01","base02","base03","base04","base05","base06","base07",
              "base08","base09","base0A","base0B","base0C","base0D","base0E","base0F"];
  for (var i = 0; i < keys.length; i++) {
    b[keys[i]] = "#" + theme[keys[i]];
  }

  var isLight = theme.variant === "light";
  var accent2 = theme.accent2 ? "#" + theme.accent2 : b.base0D;

  return {
    "--bg":             b.base00,
    "--bg-alt":         b.base01,
    "--text":           b.base06,
    "--text-secondary": b.base05,
    "--text-muted":     b.base04,
    "--text-dimmer":    b.base03,
    "--accent":         b.base09,
    "--accent-hover":   isLight ? darken(b.base09, 0.12) : lighten(b.base09, 0.12),
    "--accent-bg":      hexToRgba(b.base09, 0.12),
    "--code-bg":        isLight ? darken(b.base00, 0.03) : darken(b.base00, 0.15),
    "--border":         b.base02,
    "--border-subtle":  mixColors(b.base00, b.base02, 0.6),
    "--input-bg":       isLight ? darken(b.base00, 0.04) : mixColors(b.base01, b.base02, 0.5),
    "--ask-mate-bg":    isLight ? mixColors("#ffffff", darken(b.base00, 0.04), 0.6) : mixColors(b.base00, mixColors(b.base01, b.base02, 0.5), 0.6),
    "--user-bubble":    isLight ? darken(b.base01, 0.03) : mixColors(b.base01, b.base02, 0.3),
    "--error":          b.base08,
    "--success":        b.base0B,
    "--warning":        b.base0A,
    "--sidebar-bg":     isLight ? darken(b.base00, 0.03) : darken(b.base00, 0.30),
    "--sidebar-hover":  isLight ? darken(b.base00, 0.07) : mixColors(b.base00, b.base01, 0.4),
    "--sidebar-active": isLight ? darken(b.base01, 0.06) : mixColors(b.base01, b.base02, 0.4),
    "--filebrowser-bg": isLight ? lighten(b.base00, 0.03) : lighten(b.base00, 0.04),
    "--filebrowser-border": isLight ? darken(b.base00, 0.08) : mixColors(b.base02, b.base00, 0.5),
    "--accent-8":       hexToRgba(b.base09, 0.08),
    "--accent-12":      hexToRgba(b.base09, 0.12),
    "--accent-15":      hexToRgba(b.base09, 0.15),
    "--accent-20":      hexToRgba(b.base09, 0.20),
    "--accent-25":      hexToRgba(b.base09, 0.25),
    "--accent-30":      hexToRgba(b.base09, 0.30),
    "--accent2":        accent2,
    "--accent2-hover":  isLight ? darken(accent2, 0.12) : lighten(accent2, 0.12),
    "--accent2-bg":     hexToRgba(accent2, 0.12),
    "--accent2-8":      hexToRgba(accent2, 0.08),
    "--accent2-12":     hexToRgba(accent2, 0.12),
    "--accent2-15":     hexToRgba(accent2, 0.15),
    "--accent2-20":     hexToRgba(accent2, 0.20),
    "--accent2-25":     hexToRgba(accent2, 0.25),
    "--accent2-30":     hexToRgba(accent2, 0.30),
    "--error-8":        hexToRgba(b.base08, 0.08),
    "--error-12":       hexToRgba(b.base08, 0.12),
    "--error-15":       hexToRgba(b.base08, 0.15),
    "--error-25":       hexToRgba(b.base08, 0.25),
    "--success-8":      hexToRgba(b.base0B, 0.08),
    "--success-12":     hexToRgba(b.base0B, 0.12),
    "--success-15":     hexToRgba(b.base0B, 0.15),
    "--success-25":     hexToRgba(b.base0B, 0.25),
    "--warning-bg":     hexToRgba(b.base0A, 0.12),
    "--overlay-rgb":    isLight ? "0,0,0" : "255,255,255",
    "--shadow-rgb":     "0,0,0",
    "--hl-comment":     b.base03,
    "--hl-keyword":     b.base0E,
    "--hl-string":      b.base0B,
    "--hl-number":      b.base09,
    "--hl-function":    b.base0D,
    "--hl-variable":    b.base08,
    "--hl-type":        b.base0A,
    "--hl-constant":    b.base09,
    "--hl-tag":         b.base08,
    "--hl-attr":        b.base0D,
    "--hl-regexp":      b.base0C,
    "--hl-meta":        b.base0F,
    "--hl-builtin":     b.base09,
    "--hl-symbol":      b.base0F,
    "--hl-addition":    b.base0B,
    "--hl-deletion":    b.base08
  };
}

function computeTerminalTheme(theme) {
  var b = {};
  var keys = ["base00","base01","base02","base03","base04","base05","base06","base07",
              "base08","base09","base0A","base0B","base0C","base0D","base0E","base0F"];
  for (var i = 0; i < keys.length; i++) {
    b[keys[i]] = "#" + theme[keys[i]];
  }

  var isLight = theme.variant === "light";
  return {
    background: isLight ? darken(b.base00, 0.03) : darken(b.base00, 0.15),
    foreground: b.base05,
    cursor: b.base06,
    selectionBackground: hexToRgba(b.base02, 0.5),
    black: isLight ? b.base07 : b.base00,
    red: b.base08,
    green: b.base0B,
    yellow: b.base0A,
    blue: b.base0D,
    magenta: b.base0E,
    cyan: b.base0C,
    white: isLight ? b.base00 : b.base05,
    brightBlack: b.base03,
    brightRed: isLight ? darken(b.base08, 0.1) : lighten(b.base08, 0.1),
    brightGreen: isLight ? darken(b.base0B, 0.1) : lighten(b.base0B, 0.1),
    brightYellow: isLight ? darken(b.base0A, 0.1) : lighten(b.base0A, 0.1),
    brightBlue: isLight ? darken(b.base0D, 0.1) : lighten(b.base0D, 0.1),
    brightMagenta: isLight ? darken(b.base0E, 0.1) : lighten(b.base0E, 0.1),
    brightCyan: isLight ? darken(b.base0C, 0.1) : lighten(b.base0C, 0.1),
    brightWhite: b.base07
  };
}

function computeMermaidVars(theme) {
  var vars = currentThemeId === "clagentic-dark" && !themesLoaded ? defaultExactVars : computeVars(theme);
  var isLight = theme.variant === "light";
  return {
    darkMode: !isLight,
    background: vars["--code-bg"],
    primaryColor: vars["--accent"],
    primaryTextColor: vars["--text"],
    primaryBorderColor: vars["--border"],
    lineColor: vars["--text-muted"],
    secondaryColor: vars["--bg-alt"],
    tertiaryColor: vars["--bg"]
  };
}

// --- State ---
// All themes loaded from server: bundled + custom, keyed by id
// The two Clagentic themes are always present, so there is always something
// to apply; /api/themes then adds the custom themes from the console's themes
// folder (<console home>/themes/). Prototype-less so an id such as
// "constructor" is never a hit.
var themes = Object.create(null);
themes[DARK_ID] = CLAGENTIC_DARK;
themes[LIGHT_ID] = CLAGENTIC_LIGHT;
var customSet = Object.create(null);   // ids that came from the custom themes folder
var themesLoaded = false;
var currentThemeId = DARK_ID;
var changeCallbacks = [];
var STORAGE_KEY = "clagentic-theme";               // id last applied; pairs with -vars and -variant (first-paint cache)
var MODE_KEY = "clagentic-mode";                   // "light" | "dark"; absent follows the system
var CUSTOM_KEY = "clagentic-theme-custom";         // id of the chosen custom theme; absent when none
var MIGRATED_KEY = "clagentic-theme-migrated";     // set once the retired-theme migration has run
var MIGRATION_VERSION = "2";
var WIDE_KEY = "clagentic-wide-view";   // cached from server, "bubble" | "channel"
// Keys earlier builds wrote for themes the console no longer has. The
// migration reads the brand, then removes all of these.
var LEGACY_BRAND_KEY = "clagentic-brand";
var LEGACY_KEYS = ["clagentic-brand", "clagentic-skin", "clay-theme", "clay-theme-vars", "clay-theme-variant"];

// --- Helpers ---

// Storage can be unavailable (private mode, quota); a theme choice then lasts
// for the page only, which is the right degradation.
function lsGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}

function lsRemove(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}

function getTheme(id) {
  return themes[id] || null;
}

function isCustom(id) {
  return !!customSet[id];
}

// Best effort: the choice is already applied here, and the next profile load
// reconciles with the server.
function putPref(path, payload) {
  fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(function () {});
}

function getStoredMode() {
  var m = lsGet(MODE_KEY);
  return m === "light" || m === "dark" ? m : null;
}

// The theme id to apply now: the chosen custom theme when it is loaded, else
// the Clagentic theme of the user's mode.
function pickThemeId() {
  return resolveThemeId({
    customId: lsGet(CUSTOM_KEY),
    mode: getStoredMode(),
    systemMode: getSystemMode(),
    isCustom: isCustom
  });
}

// Re-applies the right theme once the theme list is known.
function reapply() {
  if (themesLoaded) applyTheme(pickThemeId());
}

// --- Public API ---

export function getCurrentTheme() {
  return getTheme(currentThemeId) || CLAGENTIC_DARK;
}

export function getThemeId() {
  return currentThemeId;
}

export function getThemeColor(baseKey) {
  var theme = getCurrentTheme();
  return "#" + (theme[baseKey] || "000000");
}

export function getComputedVar(varName) {
  if (currentThemeId === "clagentic-dark" && !themesLoaded) return defaultExactVars[varName] || "";
  var theme = getCurrentTheme();
  var vars = computeVars(theme);
  return vars[varName] || "";
}

export function getTerminalTheme() {
  return computeTerminalTheme(getCurrentTheme());
}

export function getMermaidThemeVars() {
  return computeMermaidVars(getCurrentTheme());
}

// Returns a function that removes the listener again.
export function onThemeChange(fn) {
  changeCallbacks.push(fn);
  return function () {
    var at = changeCallbacks.indexOf(fn);
    if (at !== -1) changeCallbacks.splice(at, 1);
  };
}

export function getThemes() {
  // Return a copy
  var all = {};
  var k;
  for (k in themes) all[k] = themes[k];
  return all;
}

// The custom themes the user can pick: [{ id, name, variant, swatches }].
export function getCustomThemes() {
  var list = [];
  for (var id in customSet) {
    var t = themes[id];
    if (!t) continue;
    list.push({
      id: id, name: t.name, variant: t.variant,
      swatches: ["base00", "base01", "base09", "base0B", "base0D"].map(function (k) { return "#" + t[k]; })
    });
  }
  return list;
}

// What is chosen now: mode is "light", "dark" or null (follow the system);
// customId is the chosen custom theme when it is loaded, else null.
export function getThemeSelection() {
  var customId = lsGet(CUSTOM_KEY);
  return { mode: getStoredMode(), customId: customId && isCustom(customId) ? customId : null };
}

// Applies a theme by id. An id that is not loaded is never drawn: the
// Clagentic theme of the user's mode is applied instead.
export function applyTheme(themeId) {
  var theme = getTheme(themeId);
  if (!theme) {
    themeId = pickThemeId();
    theme = getTheme(themeId);
  }
  currentThemeId = themeId;

  var vars = (themeId === DARK_ID && !themesLoaded) ? defaultExactVars : computeVars(theme);
  var root = document.documentElement;
  var varNames = Object.keys(vars);
  for (var i = 0; i < varNames.length; i++) {
    root.style.setProperty(varNames[i], vars[varNames[i]]);
  }

  var isLight = theme.variant === "light";
  root.classList.toggle("light-theme", isLight);
  root.classList.toggle("dark-theme", !isLight);

  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", vars["--bg"]);

  try { updateMascotSvgs(vars, isLight); } catch (e) {}

  var termTheme = computeTerminalTheme(theme);
  try { setTerminalTheme(termTheme); } catch (e) {}

  var mermaidVars = computeMermaidVars(theme);
  try { updateMermaidTheme(mermaidVars); } catch (e) {}

  lsSet(STORAGE_KEY, themeId);
  lsSet(STORAGE_KEY + "-vars", JSON.stringify(vars));
  lsSet(STORAGE_KEY + "-variant", theme.variant || "dark");

  updateToggleIcon();

  for (var j = 0; j < changeCallbacks.length; j++) {
    try { changeCallbacks[j](themeId, vars); } catch (e) {}
  }
}

// --- Favicon update on theme change ---
function updateMascotSvgs(vars, isLight) {
  var faviconEl = document.querySelector('link[rel="icon"][type="image/png"]');
  if (faviconEl) faviconEl.setAttribute("href", "favicon-banded.png");
}

// --- Theme loading from server ---
function loadThemes() {
  return fetch("/api/themes").then(function (res) {
    if (!res.ok) throw new Error("fetch failed");
    return res.json();
  }).then(function (data) {
    if (!data) return;
    var bundled = data.bundled || {};
    var custom = data.custom || {};
    var id;

    // The console's own themes first
    for (id in bundled) {
      if (validateTheme(bundled[id])) {
        themes[id] = bundled[id];
      }
    }
    // Custom themes add to them and never replace one of the console's own
    for (id in custom) {
      if (themes[id] && !customSet[id]) continue;
      if (validateTheme(custom[id])) {
        themes[id] = custom[id];
        customSet[id] = true;
      }
    }

    themesLoaded = true;

    // Apply the right theme now that the custom list is known, and tell the
    // listeners (Appearance lists the custom themes on this signal).
    applyTheme(pickThemeId());
  }).catch(function () {
    // API unavailable: the two Clagentic themes are built in, so a later
    // apply still works, and a custom choice stays stored for the next load.
    // What the first-paint script drew stays on screen meanwhile.
    themesLoaded = true;
  });
}

function validateTheme(t) {
  if (!t || typeof t !== "object") return false;
  if (!t.name || typeof t.name !== "string") return false;
  var keys = ["base00","base01","base02","base03","base04","base05","base06","base07",
              "base08","base09","base0A","base0B","base0C","base0D","base0E","base0F"];
  for (var i = 0; i < keys.length; i++) {
    if (!t[keys[i]] || !/^[0-9a-fA-F]{6}$/.test(t[keys[i]])) return false;
  }
  if (t.variant && t.variant !== "dark" && t.variant !== "light") return false;
  if (!t.variant) {
    t.variant = luminance("#" + t.base00) > 0.5 ? "light" : "dark";
  }
  return true;
}

// --- Light / Dark mode toggle ---

// Returns the system preferred mode
function getSystemMode() {
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

// Choose Dark ("dark"), Light ("light") or Follow system (null). Any of the
// three replaces a custom theme. Saved on the server so the choice reaches the
// user's other devices.
export function setThemeMode(mode) {
  var val = mode === "light" || mode === "dark" ? mode : null;
  if (val) lsSet(MODE_KEY, val); else lsRemove(MODE_KEY);
  lsRemove(CUSTOM_KEY);
  applyTheme(pickThemeId());
  putPref("/api/user/theme-mode", { themeMode: val });
}

// Choose a custom theme by id. Returns false when no such custom theme is
// loaded. Saved on the server, like the mode.
export function setCustomTheme(id) {
  if (!isCustom(id)) return false;
  lsSet(CUSTOM_KEY, id);
  applyTheme(id);
  putPref("/api/user/theme-id", { themeId: id });
  return true;
}

// --- Wide view ---

export function isWideView() {
  try {
    var v = localStorage.getItem(WIDE_KEY);
    return v === null ? true : v !== "bubble"; // default: Channel (wide)
  } catch (e) { return true; }
}

export function getChatLayout() {
  try {
    var v = localStorage.getItem(WIDE_KEY);
    return v === "bubble" ? "bubble" : "channel";
  } catch (e) { return "channel"; }
}

export function setChatLayout(layout) {
  var val = (layout === "bubble") ? "bubble" : "channel";
  try { localStorage.setItem(WIDE_KEY, val); } catch (e) {}
  document.body.classList.toggle("wide-view", val === "channel");
}

export function setWideView(enabled) {
  setChatLayout(enabled ? "channel" : "bubble");
}

// Toggle between light and dark, from whatever is showing now (a custom theme
// counts by its variant). The toggle is an explicit Dark or Light choice.
export function toggleDarkMode() {
  setThemeMode(getCurrentTheme().variant === "light" ? "dark" : "light");
}

// Update all theme toggle checkboxes
function updateToggleIcon() {
  var isLight = getCurrentTheme().variant === "light";
  // Legacy top-bar toggle (may not exist)
  var checkbox = document.getElementById("theme-toggle-check");
  if (checkbox) checkbox.checked = isLight;
  // User settings toggle
  var usToggle = document.getElementById("us-theme-toggle");
  if (usToggle) usToggle.checked = isLight;
  // User island toggle
  var islandToggle = document.getElementById("user-theme-toggle-btn");
  if (islandToggle) {
    islandToggle.classList.remove("theme-toggle-light", "theme-toggle-dark");
    islandToggle.classList.add(isLight ? "theme-toggle-light" : "theme-toggle-dark");
    islandToggle.innerHTML = iconHtml(isLight ? "moon" : "sun");
    islandToggle.title = isLight ? "Switch to dark mode" : "Switch to light mode";
    islandToggle.setAttribute("aria-label", islandToggle.title);
  }
  refreshIcons();
}

// Apply the theme preferences the server holds for this user (themeMode,
// themeId from /api/profile). Call it after the profile loads. The server is
// authoritative, so a choice made on another device wins, including Follow
// system (a null mode) and a custom theme.
export function applyServerThemePrefs(server) {
  var prefs = reconcileServerPrefs(server);
  var changed = false;
  if (prefs.mode !== getStoredMode()) {
    if (prefs.mode) lsSet(MODE_KEY, prefs.mode); else lsRemove(MODE_KEY);
    changed = true;
  }
  var localCustom = lsGet(CUSTOM_KEY);
  if (prefs.customId !== localCustom) {
    if (prefs.customId) lsSet(CUSTOM_KEY, prefs.customId); else lsRemove(CUSTOM_KEY);
    changed = true;
  }
  // Before the theme list loads a custom id cannot be checked; loadThemes
  // applies the right theme as soon as it can.
  if (changed) reapply();
}

// One-time move off the retired themes. Maps the stored theme id (and the
// Classic brand) to the Clagentic theme of the same variant, drops the keys
// that only the retired themes used, and records that it ran, so it never
// runs twice. index.html's first-paint script skips the old cached palette
// until this has run.
function runThemeMigration() {
  if (lsGet(MIGRATED_KEY) === MIGRATION_VERSION) return;
  var migrated = migrateStoredTheme({
    id: lsGet(STORAGE_KEY),
    variant: lsGet(STORAGE_KEY + "-variant"),
    brand: lsGet(LEGACY_BRAND_KEY),
    mode: getStoredMode()
  });
  if (migrated.changed) {
    lsSet(STORAGE_KEY, migrated.id);
    lsSet(STORAGE_KEY + "-variant", migrated.variant);
    // The cached variables belong to the retired palette; the next apply
    // writes the Clagentic ones.
    lsRemove(STORAGE_KEY + "-vars");
  }
  for (var i = 0; i < LEGACY_KEYS.length; i++) lsRemove(LEGACY_KEYS[i]);
  lsSet(MIGRATED_KEY, MIGRATION_VERSION);
}

// --- Init ---
export function initTheme() {
  runThemeMigration();

  // Until the theme list loads only the two Clagentic themes are known, so
  // start from the one that matches the user's mode.
  currentThemeId = pickThemeId();

  // Apply wide view state from localStorage
  document.body.classList.toggle("wide-view", isWideView());

  // Load all themes from server, then apply properly
  loadThemes();

  // The Appearance choice is built by theme-choice.js (user-settings.js and
  // the phone More sheet); the toggle here is the user island button.

  // Follow system: with no Dark or Light choice and no custom theme, track the
  // system setting, including a change while the console is open.
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var handler = function () {
      if (!getStoredMode()) reapply();
    };
    if (mq.addEventListener) {
      mq.addEventListener("change", handler);
    } else if (mq.addListener) {
      mq.addListener(handler);
    }
  }

  // Set initial toggle icon
  updateToggleIcon();

  var islandToggle = document.getElementById("user-theme-toggle-btn");
  if (islandToggle && !islandToggle._clagenticThemeBound) {
    islandToggle._clagenticThemeBound = true;
    islandToggle.addEventListener("click", function () {
      toggleDarkMode();
    });
  }
}
