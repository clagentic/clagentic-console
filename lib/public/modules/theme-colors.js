// The browser's handle on the colour derivation. The derivation itself is
// ../theme-core.js, a plain script the server also loads, so there is one copy.
// Importing it here runs it and leaves it on globalThis.ClagenticThemeCore.
import "../theme-core.js";

var core = globalThis.ClagenticThemeCore;
if (!core) throw new Error("theme-core.js did not load");

export var deriveVars = core.deriveVars;
export var deriveTerminalTheme = core.deriveTerminalTheme;
export var deriveMermaidVars = core.deriveMermaidVars;
export var inferVariant = core.inferVariant;
export var readTokens = core.readTokens;
