// Pure rules for which theme the console shows. No DOM and no imports, so the
// same code runs in the browser (theme.js) and under node:test.
//
// The console ships two themes, Clagentic Dark and Clagentic Light. A user can
// also pick a custom theme file from the console's themes folder. Anything
// else, including every theme the console shipped before it kept only its own
// two, is never applied: it migrates once, or falls back to the Clagentic
// theme of the user's mode.

export var DARK_ID = "clagentic-dark";
export var LIGHT_ID = "clagentic-light";

// Copies of lib/themes/clagentic-dark.json and clagentic-light.json, so the
// theme module has a palette to hand before /api/themes answers and when it
// cannot be reached. This is the only copy of the palettes outside the files;
// a test holds it equal to them and no page is painted from it (the first-paint
// stylesheet is built from the files by the server).
export var CLAGENTIC_DARK = {
  name: "Dark", variant: "dark",
  base00: "1C2433", base01: "242E40", base02: "364257", base03: "8E9DB3",
  base04: "A7B5C8", base05: "C5D0DE", base06: "EAF0F8", base07: "F5F9FF",
  base08: "FF8094", base09: "00CFFF", base0A: "7BA7F7", base0B: "29D9A8",
  base0C: "A78BFA", base0D: "7BA7F7", base0E: "C084FC", base0F: "818CF8",
  accent2: "7BA7F7",
  tokens: {
    "sidebar-bg": "141B28", "sidebar-active": "263245", "user-bubble": "2E3A4F",
    "input-bg": "374359", "code-bg": "101722",
    "border-subtle": "2A3548", "border-strong": "8294AE",
    "warning": "F59E0B", "on-accent": "0B1220", "on-av": "0B1220",
    "av0": "7FD8F0", "av1": "B9A3F5", "av2": "7FE0C2", "av3": "F2C879"
  }
};

export var CLAGENTIC_LIGHT = {
  name: "Light", variant: "light",
  base00: "F1F4F9", base01: "FFFFFF", base02: "CBD5E3", base03: "566680",
  base04: "4A5B72", base05: "2B3A4F", base06: "0F1724", base07: "060A12",
  base08: "B3122D", base09: "006D94", base0A: "2D5EB8", base0B: "0A6B4A",
  base0C: "6128B8", base0D: "2D5EB8", base0E: "7C3AED", base0F: "4F46E5",
  accent2: "2D5EB8",
  tokens: {
    "sidebar-bg": "E2E8F1", "sidebar-active": "D3DEEE", "user-bubble": "D9E6F7",
    "input-bg": "FFFFFF", "code-bg": "E9EEF5",
    "border-subtle": "DDE4EE", "border-strong": "73849C",
    "warning": "8A5300", "on-accent": "FFFFFF", "on-av": "FFFFFF",
    "av0": "0B6E8A", "av1": "6A3FC4", "av2": "0D7A55", "av3": "9A5B00"
  }
};

// Same rule as isValidThemeId in lib/theme-files.js; a test holds them together.
export var THEME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidThemeId(id) {
  return typeof id === "string" && THEME_ID_PATTERN.test(id);
}

// Ids stored by earlier builds: the 20 themes that used to ship in
// lib/themes/, plus the clay and claude ids older versions stored. The value
// is the variant they map to.
var INHERITED_VARIANT = {
  "dracula": "dark", "monokai": "dark", "nord": "dark", "one-dark": "dark",
  "tokyo-night": "dark", "rose-pine": "dark", "everforest": "dark",
  "catppuccin-mocha": "dark", "gruvbox-dark": "dark", "solarized-dark": "dark",
  "clay": "dark", "claude": "dark",
  "ayu-light": "light", "github-light": "light", "solarized-light": "light",
  "everforest-light": "light", "one-light": "light", "rose-pine-dawn": "light",
  "tokyo-night-light": "light", "nord-light": "light", "catppuccin-latte": "light",
  "gruvbox-light": "light", "clay-light": "light", "claude-light": "light"
};

/** "dark" or "light" when `id` is a retired inherited theme id, else null. */
export function inheritedVariant(id) {
  if (typeof id !== "string") return null;
  return Object.prototype.hasOwnProperty.call(INHERITED_VARIANT, id) ? INHERITED_VARIANT[id] : null;
}

export function clagenticIdForVariant(variant) {
  return variant === "light" ? LIGHT_ID : DARK_ID;
}

/**
 * The one-time browser migration of stored theme state.
 *   in:  { id, variant, brand, mode }  raw stored values, each a string or null
 *   out: { id, variant, changed }
 * An inherited id maps to the Clagentic theme of its variant (dark ones and
 * the Classic dark theme to Clagentic Dark, light ones to Clagentic Light;
 * clay and claude by their variant). With no stored id, the Classic brand
 * maps by the stored mode. A Clagentic id, a custom id or an id that matches
 * nothing is returned as it is: later resolution applies the custom theme if
 * it exists and the Clagentic theme of the mode if it does not.
 */
export function migrateStoredTheme(stored) {
  var id = stored && stored.id ? stored.id : null;
  var inherited = inheritedVariant(id);
  if (inherited) {
    return { id: clagenticIdForVariant(inherited), variant: inherited, changed: true };
  }
  if (!id && stored && stored.brand === "classic" && (stored.mode === "light" || stored.mode === "dark")) {
    return { id: clagenticIdForVariant(stored.mode), variant: stored.mode, changed: true };
  }
  var variant = stored && (stored.variant === "light" || stored.variant === "dark") ? stored.variant : null;
  return { id: id, variant: variant, changed: false };
}

/**
 * The theme id to apply.
 *   customId     the user's chosen custom theme, or null
 *   mode         "light", "dark", or null to follow the system
 *   systemMode   "light" or "dark", what the system asks for now
 *   isCustom     function(id) true when that custom theme is loaded and valid
 * A custom theme that is not loaded falls back to the Clagentic theme of the
 * mode; nothing else is ever returned.
 */
export function resolveThemeId(args) {
  if (args.customId && args.isCustom && args.isCustom(args.customId)) return args.customId;
  var mode = args.mode === "light" || args.mode === "dark" ? args.mode : args.systemMode;
  return clagenticIdForVariant(mode);
}

/**
 * Normalises what the server reports into the local preference. The server is
 * authoritative once the profile loads, so a choice made on another device
 * (including Follow system, which is a null mode) wins.
 */
export function reconcileServerPrefs(server) {
  var mode = server && (server.themeMode === "light" || server.themeMode === "dark") ? server.themeMode : null;
  var customId = server && isValidThemeId(server.themeId) ? server.themeId : null;
  return { mode: mode, customId: customId };
}

/** The option key that is selected: "dark", "light", "system" or "custom:<id>". */
export function selectionKey(selection) {
  if (selection.customId) return "custom:" + selection.customId;
  return selection.mode === "light" || selection.mode === "dark" ? selection.mode : "system";
}

/**
 * The options Appearance offers: Dark, Light, Follow system, then one per
 * custom theme in name order. `customThemes` is [{ id, name, variant, swatches }].
 */
export function buildThemeOptions(customThemes) {
  var options = [
    { key: "dark", kind: "mode", mode: "dark", label: "Dark", description: "Dark theme", icon: "moon" },
    { key: "light", kind: "mode", mode: "light", label: "Light", description: "Light theme", icon: "sun" },
    { key: "system", kind: "mode", mode: null, label: "Follow system", description: "Match the system setting, including when it changes", icon: "monitor" }
  ];
  var sorted = (customThemes || []).slice().sort(function (a, b) {
    return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  for (var i = 0; i < sorted.length; i++) {
    options.push({
      key: "custom:" + sorted[i].id, kind: "custom", id: sorted[i].id,
      label: sorted[i].name, description: "Custom theme", icon: "palette",
      swatches: sorted[i].swatches || []
    });
  }
  return options;
}
