// The one place a theme's colours become CSS variables.
//
// A theme is sixteen base16 colours (base00..base0F), an optional accent2, and
// an optional `tokens` object that names exact values for a few surface and
// state colours (TOKEN_KEYS). deriveVars() turns that into every CSS variable
// the console draws with. A token the theme names is used as written; any
// other is derived from the base colours, so a theme file with only the
// sixteen colours is fully styled.
//
// Plain script on purpose: Node loads it with require() (the server builds the
// first-paint stylesheet, the auth and setup pages, the manifest and the
// offline page from it) and the browser loads it as a script, so no copy of
// the derivation exists anywhere else. It also sets
// globalThis.ClagenticThemeCore; modules/theme-colors.js is the module-side
// handle on it.
function readBuiltin() {
  var fs = require("fs");
  var path = require("path");
  function load(id) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "themes", id + ".json"), "utf8"));
  }
  return { dark: load("clagentic-dark"), light: load("clagentic-light") };
}

(function (root, factory) {
  var core = factory();
  // Always on the global: a browser module that imports this file runs it
  // wherever the host decides (as a script, or, under Node, as CommonJS), and
  // theme-colors.js reads it from there. require() gets the same object.
  root.ClagenticThemeCore = core;
  if (typeof module === "object" && module && module.exports) {
    // Under Node the palettes come straight from the theme files. In a browser
    // the server appends them to this script (lib/theme-seed.js).
    core.builtin = readBuiltin();
    module.exports = core;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var BASE_KEYS = ["base00", "base01", "base02", "base03", "base04", "base05", "base06", "base07",
                   "base08", "base09", "base0A", "base0B", "base0C", "base0D", "base0E", "base0F"];

  // Colours a theme file may state exactly (the "tokens" object). Everything
  // else is derived.
  var TOKEN_KEYS = ["sidebar-bg", "sidebar-active", "user-bubble", "input-bg", "code-bg",
                    "border-subtle", "border-strong", "warning", "on-accent", "on-av",
                    "av0", "av1", "av2", "av3"];

  var HEX6 = /^[0-9a-fA-F]{6}$/;

  // --- Colour maths ---

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
      var s = c.toString(16);
      return (s.length < 2 ? "0" + s : s).toUpperCase();
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

  // weight is the share of hex1.
  function mix(hex1, hex2, weight) {
    var c1 = hexToRgb(hex1);
    var c2 = hexToRgb(hex2);
    return rgbToHex(
      c1.r * weight + c2.r * (1 - weight),
      c1.g * weight + c2.g * (1 - weight),
      c1.b * weight + c2.b * (1 - weight)
    );
  }

  function rgba(hex, alpha) {
    var c = hexToRgb(hex);
    return "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + alpha + ")";
  }

  function triplet(hex) {
    var c = hexToRgb(hex);
    return c.r + ", " + c.g + ", " + c.b;
  }

  // WCAG 2.x relative luminance and contrast ratio.
  function relativeLuminance(hex) {
    var c = hexToRgb(hex);
    var lin = [c.r, c.g, c.b].map(function (v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  function contrast(hexA, hexB) {
    var a = relativeLuminance(hexA);
    var b = relativeLuminance(hexB);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  // The more readable of two colours on `fill`.
  function readableOn(fill, optionA, optionB) {
    return contrast(fill, optionA) >= contrast(fill, optionB) ? optionA : optionB;
  }

  // The option that reads best on the worst of `fills`.
  function readableOnAll(fills, optionA, optionB) {
    function worst(option) {
      return Math.min.apply(null, fills.map(function (f) { return contrast(f, option); }));
    }
    return worst(optionA) >= worst(optionB) ? optionA : optionB;
  }

  // "dark" or "light" for a theme file that does not say. `base00` is six hex
  // digits with or without a leading "#".
  function inferVariant(base00) {
    var c = hexToRgb(base00);
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255 > 0.5 ? "light" : "dark";
  }

  // --- Theme shape ---

  // The "tokens" object of a theme, checked: undefined when the theme has none,
  // null when it is malformed (not an object, or a known key that is not six
  // hex digits), else a copy holding only the known keys. Unknown keys are
  // dropped so a file cannot smuggle extra properties into the page.
  function readTokens(raw) {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "object" || Array.isArray(raw)) return null;
    var out = {};
    for (var i = 0; i < TOKEN_KEYS.length; i++) {
      var v = raw[TOKEN_KEYS[i]];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string" || !HEX6.test(v)) return null;
      out[TOKEN_KEYS[i]] = v;
    }
    return out;
  }

  function baseColors(theme) {
    var b = {};
    for (var i = 0; i < BASE_KEYS.length; i++) b[BASE_KEYS[i]] = "#" + theme[BASE_KEYS[i]];
    return b;
  }

  // --- Derivation ---

  // The colours a theme either states or derives (TOKEN_KEYS), as "#RRGGBB".
  function resolveTokens(theme) {
    var b = baseColors(theme);
    var light = theme.variant === "light";
    var stated = readTokens(theme.tokens) || {};
    var sources = [b.base09, b.base0E, b.base0B, b.base0A];
    var derived = {
      "sidebar-bg":     light ? darken(b.base00, 0.03) : darken(b.base00, 0.30),
      "sidebar-active": light ? darken(b.base01, 0.06) : mix(b.base01, b.base02, 0.4),
      "user-bubble":    light ? darken(b.base01, 0.03) : mix(b.base01, b.base02, 0.3),
      "input-bg":       light ? darken(b.base00, 0.04) : mix(b.base01, b.base02, 0.5),
      "code-bg":        light ? darken(b.base00, 0.03) : darken(b.base00, 0.15),
      "border-subtle":  mix(b.base00, b.base02, 0.6),
      // A control outline has to be seen against the page, so it leans on the
      // secondary text colour rather than the decorative divider.
      "border-strong":  mix(b.base04, b.base00, 0.7),
      "warning":        b.base0A,
      "on-accent":      readableOn(b.base09, b.base00, b.base06),
      "av0":            light ? darken(sources[0], 0.2) : lighten(sources[0], 0.35),
      "av1":            light ? darken(sources[1], 0.2) : lighten(sources[1], 0.35),
      "av2":            light ? darken(sources[2], 0.2) : lighten(sources[2], 0.35),
      "av3":            light ? darken(sources[3], 0.2) : lighten(sources[3], 0.35)
    };
    // Fills first (a stated token wins over a derived one), then the colours
    // that sit on them, so a foreground is chosen against the fill that is shown.
    var out = {};
    var i;
    for (i = 0; i < TOKEN_KEYS.length; i++) {
      var k = TOKEN_KEYS[i];
      out[k] = stated[k] ? "#" + stated[k] : derived[k];
    }
    if (!stated["on-av"]) {
      out["on-av"] = readableOnAll([out.av0, out.av1, out.av2, out.av3], b.base00, b.base06);
    }
    return out;
  }

  // Every CSS variable for a theme: { "--bg": "#...", ... }.
  function deriveVars(theme) {
    var b = baseColors(theme);
    var light = theme.variant === "light";
    var t = resolveTokens(theme);
    var accent2 = theme.accent2 ? "#" + theme.accent2 : b.base0D;
    var overlay = light ? "0, 0, 0" : "255, 255, 255";
    var overlayHex = light ? "#000000" : "#FFFFFF";
    var hover = rgba(overlayHex, 0.06);

    return {
      // Surfaces
      "--bg":               b.base00,
      "--bg-alt":           b.base01,
      "--sidebar-bg":       t["sidebar-bg"],
      "--sidebar-hover":    mix(t["sidebar-bg"], t["sidebar-active"], 0.5),
      "--sidebar-active":   t["sidebar-active"],
      "--user-bubble":      t["user-bubble"],
      "--input-bg":         t["input-bg"],
      "--ask-mate-bg":      mix(b.base00, t["input-bg"], 0.6),
      "--code-bg":          t["code-bg"],
      "--filebrowser-bg":   b.base01,
      "--filebrowser-border": t["border-subtle"],
      // Text
      "--text":             b.base06,
      "--text-secondary":   b.base05,
      "--text-muted":       b.base04,
      "--text-dimmer":      b.base03,
      // Borders
      "--border":           b.base02,
      "--border-subtle":    t["border-subtle"],
      "--border-strong":    t["border-strong"],
      // Accent
      "--accent":           b.base09,
      "--accent-hover":     light ? darken(b.base09, 0.12) : lighten(b.base09, 0.12),
      "--accent-bg":        rgba(b.base09, 0.12),
      "--accent-8":         rgba(b.base09, 0.08),
      "--accent-12":        rgba(b.base09, 0.12),
      "--accent-15":        rgba(b.base09, 0.15),
      "--accent-20":        rgba(b.base09, 0.20),
      "--accent-25":        rgba(b.base09, 0.25),
      "--accent-30":        rgba(b.base09, 0.30),
      "--accent-rgb":       triplet(b.base09),
      "--on-accent":        t["on-accent"],
      // The text colour on a solid status or accent2 fill. Each fill differs per
      // theme (a pale error in Dark, a deep one in Light), so none of them can
      // share --on-accent and still meet AA on every fill.
      "--on-accent2":       readableOn(accent2, b.base00, b.base06),
      "--on-error":         readableOn(b.base08, b.base00, b.base06),
      "--on-success":       readableOn(b.base0B, b.base00, b.base06),
      "--on-warning":       readableOn(t["warning"], b.base00, b.base06),
      "--accent2":          accent2,
      "--accent2-hover":    light ? darken(accent2, 0.12) : lighten(accent2, 0.12),
      "--accent2-bg":       rgba(accent2, 0.12),
      "--accent2-8":        rgba(accent2, 0.08),
      "--accent2-12":       rgba(accent2, 0.12),
      "--accent2-15":       rgba(accent2, 0.15),
      "--accent2-20":       rgba(accent2, 0.20),
      "--accent2-25":       rgba(accent2, 0.25),
      "--accent2-30":       rgba(accent2, 0.30),
      // State
      "--error":            b.base08,
      "--error-8":          rgba(b.base08, 0.08),
      "--error-12":         rgba(b.base08, 0.12),
      "--error-15":         rgba(b.base08, 0.15),
      "--error-25":         rgba(b.base08, 0.25),
      "--success":          b.base0B,
      "--success-8":        rgba(b.base0B, 0.08),
      "--success-12":       rgba(b.base0B, 0.12),
      "--success-15":       rgba(b.base0B, 0.15),
      "--success-25":       rgba(b.base0B, 0.25),
      "--success-rgb":      triplet(b.base0B),
      "--warning":          t["warning"],
      "--warning-bg":       rgba(t["warning"], 0.12),
      "--warning-rgb":      triplet(t["warning"]),
      "--overlay-rgb":      overlay.replace(/ /g, ""),
      "--shadow-rgb":       "0,0,0",
      // Avatars
      "--av0":              t["av0"],
      "--av1":              t["av1"],
      "--av2":              t["av2"],
      "--av3":              t["av3"],
      "--on-av":            t["on-av"],
      // Code highlighting
      "--hl-comment":       b.base03,
      "--hl-keyword":       b.base0E,
      "--hl-string":        b.base0B,
      "--hl-number":        b.base09,
      "--hl-function":      b.base0D,
      "--hl-variable":      b.base08,
      "--hl-type":          b.base0A,
      "--hl-constant":      b.base09,
      "--hl-tag":           b.base08,
      "--hl-attr":          b.base0D,
      "--hl-regexp":        b.base0C,
      "--hl-meta":          b.base0F,
      "--hl-builtin":       b.base09,
      "--hl-symbol":        b.base0F,
      "--hl-addition":      b.base0B,
      "--hl-deletion":      b.base08,
      // Names the stylesheets use for a colour that already has a token above;
      // each is the same value, so a use never falls back to a literal.
      "--text-primary":     b.base06,
      "--text-dim":         b.base04,
      "--text-tertiary":    b.base03,
      "--bg-secondary":     b.base01,
      "--bg-elevated":      b.base01,
      "--bg-surface":       b.base01,
      "--bg-tertiary":      t["user-bubble"],
      "--bg-deep":          t["code-bg"],
      "--bg-dim":           t["code-bg"],
      "--bg-deeper":        t["code-bg"],
      "--hover":            hover,
      "--hover-bg":         hover,
      "--bg-hover":         hover,
      "--bg-active":        rgba(overlayHex, 0.10),
      "--surface-2":        rgba(overlayHex, 0.04),
      "--overlay-soft":     rgba(b.base09, 0.08),
      "--accent-text":      t["on-accent"],
      "--warn":             t["warning"],
      "--green":            b.base0B,
      "--border-bright":    t["border-strong"],
      "--danger":           b.base08,
      "--activity-other":   b.base0E
    };
  }

  // xterm theme for the active theme.
  function deriveTerminalTheme(theme) {
    var b = baseColors(theme);
    var light = theme.variant === "light";
    var v = deriveVars(theme);
    function bright(hex) { return light ? darken(hex, 0.1) : lighten(hex, 0.1); }
    return {
      background: v["--code-bg"],
      foreground: v["--text-secondary"],
      cursor: v["--text"],
      selectionBackground: rgba(b.base02, 0.5),
      black: light ? b.base07 : b.base00,
      red: v["--error"],
      green: v["--success"],
      yellow: v["--warning"],
      blue: v["--accent2"],
      magenta: b.base0E,
      cyan: v["--accent"],
      white: light ? b.base00 : b.base05,
      brightBlack: b.base03,
      brightRed: bright(v["--error"]),
      brightGreen: bright(v["--success"]),
      brightYellow: bright(v["--warning"]),
      brightBlue: bright(v["--accent2"]),
      brightMagenta: bright(b.base0E),
      brightCyan: bright(v["--accent"]),
      brightWhite: b.base07
    };
  }

  // Mermaid theme variables for the active theme (use with Mermaid's "base"
  // theme, the one that honours them).
  function deriveMermaidVars(theme) {
    var v = deriveVars(theme);
    return {
      darkMode: theme.variant !== "light",
      background: v["--code-bg"],
      mainBkg: v["--bg-alt"],
      primaryColor: v["--bg-alt"],
      primaryTextColor: v["--text"],
      primaryBorderColor: v["--accent"],
      secondaryColor: v["--user-bubble"],
      secondaryTextColor: v["--text"],
      tertiaryColor: v["--bg"],
      tertiaryTextColor: v["--text"],
      textColor: v["--text"],
      titleColor: v["--text"],
      lineColor: v["--text-muted"],
      nodeBorder: v["--accent"],
      clusterBkg: v["--bg"],
      clusterBorder: v["--border-strong"],
      noteBkgColor: v["--bg-alt"],
      noteTextColor: v["--text"],
      edgeLabelBackground: v["--bg-alt"]
    };
  }

  // "--name:value;" text for a vars object.
  function varsToCss(vars) {
    var text = "";
    var names = Object.keys(vars);
    for (var i = 0; i < names.length; i++) text += names[i] + ":" + vars[names[i]] + ";";
    return text;
  }

  return {
    BASE_KEYS: BASE_KEYS,
    TOKEN_KEYS: TOKEN_KEYS,
    HEX6: HEX6,
    contrast: contrast,
    inferVariant: inferVariant,
    readTokens: readTokens,
    resolveTokens: resolveTokens,
    deriveVars: deriveVars,
    deriveTerminalTheme: deriveTerminalTheme,
    deriveMermaidVars: deriveMermaidVars,
    varsToCss: varsToCss
  };
});
