// Pure rules for the conversation width. No DOM and no imports, so the same code
// runs in the browser (chat-width.js) and under node:test.
//
// The server keeps the same list in lib/chat-width.js; a test holds them
// together. The pixel size of each step lives in css/base.css
// (--chat-width-*), not here.

export var DEFAULT_WIDTH = "comfortable";

// Label and description are what Appearance shows for each step.
export var WIDTH_OPTIONS = [
  { key: "compact", label: "Compact", description: "A narrow column, 640 px" },
  { key: "comfortable", label: "Comfortable", description: "The default, 820 px" },
  { key: "wide", label: "Wide", description: "A wider column, 1040 px" },
  { key: "full", label: "Full", description: "The whole pane. A phone is always full width" }
];

export function isChatWidth(value) {
  for (var i = 0; i < WIDTH_OPTIONS.length; i++) {
    if (WIDTH_OPTIONS[i].key === value) return true;
  }
  return false;
}

/** The step to apply: the value itself when valid, else the default. */
export function normalizeWidth(value) {
  return isChatWidth(value) ? value : DEFAULT_WIDTH;
}

// The retired bubble/channel choice, mapped once onto the closest step.
var LEGACY_LAYOUT_WIDTH = { bubble: "comfortable", channel: "full" };

/** The step a retired layout value maps to, or null when it is not one. */
export function widthFromLegacyLayout(layout) {
  if (typeof layout !== "string") return null;
  return Object.prototype.hasOwnProperty.call(LEGACY_LAYOUT_WIDTH, layout) ? LEGACY_LAYOUT_WIDTH[layout] : null;
}

/**
 * The step the page starts on, from what this browser stored.
 *   stored  { width, legacy }: the saved step and the retired layout value,
 *           each a string or null
 * Returns { width, migrated }. A valid saved step wins; else the retired layout
 * maps once (migrated true, so the caller drops the old key); else the default.
 */
export function resolveStoredWidth(stored) {
  var s = stored || {};
  if (isChatWidth(s.width)) return { width: s.width, migrated: false };
  var mapped = widthFromLegacyLayout(s.legacy);
  if (mapped) return { width: mapped, migrated: true };
  return { width: DEFAULT_WIDTH, migrated: s.legacy != null };
}
