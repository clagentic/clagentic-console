import { iconHtml, refreshIcons } from './icons.js';
import { setTerminalTheme } from './terminal.js';
import { updateMermaidTheme } from './markdown.js';
import {
  DARK_ID, LIGHT_ID,
  migrateStoredTheme, resolveThemeId, reconcileServerPrefs
} from './theme-prefs.js';
import {
  CLAGENTIC_DARK, CLAGENTIC_LIGHT,
  deriveVars, deriveTerminalTheme, deriveMermaidVars, inferVariant, readTokens
} from './theme-colors.js';

// Every colour here comes from a theme's palette through the one derivation in
// ../theme-core.js (see theme-colors.js). This module holds no colour value.

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
// index.html's first-paint script reads this value; change both together.
var MIGRATION_VERSION = "3";
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
  return deriveVars(getCurrentTheme())[varName] || "";
}

export function getTerminalTheme() {
  return deriveTerminalTheme(getCurrentTheme());
}

export function getMermaidThemeVars() {
  return deriveMermaidVars(getCurrentTheme());
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

  var vars = deriveVars(theme);
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

  var termTheme = deriveTerminalTheme(theme);
  try { setTerminalTheme(termTheme); } catch (e) {}

  var mermaidVars = deriveMermaidVars(theme);
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
  if (readTokens(t.tokens) === null) return false;
  if (!t.variant) {
    t.variant = inferVariant(t.base00);
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
  }
  // The cached variables belong to an earlier palette or derivation; the next
  // apply writes the current ones.
  lsRemove(STORAGE_KEY + "-vars");
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
