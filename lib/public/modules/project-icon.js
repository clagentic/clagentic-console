// project-icon.js — Shared helper for rendering project icons.
//
// A project icon is either:
//   - A custom image, stored as `:slug:` in config.projects[].icon.
//     Detect with isCustomIcon(); render as <img src="/api/custom-emoji/{slug}">.
//   - A Unicode emoji (any other non-empty string).
//     Render via the existing parseEmojis() path.
//   - null / undefined / empty — caller shows an abbreviation fallback.
//
// The helpers here are DOM-free for the classification functions so they can
// be imported in Node test environments as well as the browser.

// Custom-icon sentinel pattern: :slug: where slug is [a-z0-9_-]{1,64}
var CUSTOM_ICON_RE = /^:[a-z0-9_-]{1,64}:$/;

/**
 * Returns true when iconStr is a custom-image sentinel (:slug:).
 * @param {string|null|undefined} iconStr
 * @returns {boolean}
 */
export function isCustomIcon(iconStr) {
  if (!iconStr || typeof iconStr !== "string") return false;
  return CUSTOM_ICON_RE.test(iconStr);
}

/**
 * Extract the slug from a custom-icon sentinel.
 * Returns null when iconStr is not a custom-icon sentinel.
 * @param {string|null|undefined} iconStr
 * @returns {string|null}
 */
export function customIconSlug(iconStr) {
  if (!isCustomIcon(iconStr)) return null;
  return iconStr.slice(1, -1); // strip leading and trailing ":"
}

// Minimal HTML-escape for the string-composition path (projectIconHtml).
// Mirrors escapeHtml() from utils.js without importing it, so this module
// stays DOM-free / Node-importable (see file header).
function escapeForHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build a safe HTML string for a project/folder icon, for call sites that
 * compose markup via string concatenation + innerHTML (e.g. command-palette.js)
 * rather than direct DOM-API building.
 *
 * Behaviour mirrors renderProjectIcon():
 *   - Custom icon  -> "<img src=... class="project-emoji-img">" markup.
 *     Safe to interpolate: customIconSlug() already validated the slug against
 *     CUSTOM_ICON_RE ([a-z0-9_-]{1,64}), so no raw user/icon string is ever
 *     concatenated into the returned markup.
 *   - Emoji string -> HTML-escaped text (defends against a non-sentinel icon
 *     value that isn't actually a safe emoji).
 *   - null/empty   -> fallbackHtml (caller-supplied placeholder markup, e.g.
 *     a lucide `<i data-lucide="...">` icon).
 *
 * @param {string|null|undefined} iconStr
 * @param {string} [fallbackHtml]
 * @returns {string}
 */
export function projectIconHtml(iconStr, fallbackHtml) {
  if (!iconStr) return fallbackHtml || "";
  var slug = customIconSlug(iconStr);
  if (slug) {
    // Inline onerror mirrors renderProjectIcon()'s delete-in-use fallback
    // (hide the broken image) since this string-built markup has no JS
    // event-listener wiring of its own. The handler is a fixed literal —
    // nothing from iconStr is interpolated into it.
    return '<img src="/api/custom-emoji/' + encodeURIComponent(slug) + '" alt=":' + slug + ':" class="project-emoji-img" onerror="this.style.display=&#39;none&#39;">';
  }
  return escapeForHtml(iconStr);
}

/**
 * Render a project icon into the given DOM element.
 *
 * Behaviour:
 *   - Custom icon  → replaces el content with <img src="/api/custom-emoji/{slug}"
 *                    class="project-emoji-img"> (no innerHTML: safe against XSS).
 *   - Emoji string → sets el.textContent = iconStr, then calls parseEmojis(el).
 *   - null/empty   → clears the element (caller may show an abbreviation).
 *
 * @param {string|null|undefined} iconStr  The icon value from project config.
 * @param {Element} el                     The container element to render into.
 * @param {Function} [parseEmojisFn]       parseEmojis from markdown.js (browser only).
 */
export function renderProjectIcon(iconStr, el, parseEmojisFn) {
  // Clear previous content
  el.textContent = "";

  if (!iconStr) return;

  var slug = customIconSlug(iconStr);
  if (slug) {
    var img = document.createElement("img");
    img.src = "/api/custom-emoji/" + encodeURIComponent(slug);
    img.alt = ":" + slug + ":";
    img.className = "project-emoji-img";
    // Graceful fallback: if the image 404s (deleted-in-use), show nothing
    img.addEventListener("error", function () { img.style.display = "none"; });
    el.appendChild(img);
  } else {
    el.textContent = iconStr;
    if (typeof parseEmojisFn === "function") parseEmojisFn(el);
  }
}
