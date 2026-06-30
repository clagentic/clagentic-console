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
