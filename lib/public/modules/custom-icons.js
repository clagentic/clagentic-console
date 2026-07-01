// custom-icons.js — Shared client-side helper for the global custom-icon
// namespace (lr-a68f). Extracted from emoji-picker.js (lr-d1d9) so the emoji
// picker's "Custom" panel and the Server Settings > Custom Icons management
// surface share one implementation of slugify/list-fetch/upload/delete
// instead of maintaining two copies that can drift.
//
// DOM-free: safe to import from both browser modules and Node test files.

/**
 * Derive a slug candidate from an uploaded filename: strip extension,
 * lowercase, collapse anything outside [a-z0-9_-] into a single dash,
 * trim leading/trailing dashes, cap at 64 chars. Falls back to "custom"
 * if the result would be empty (e.g. an all-symbol filename).
 *
 * Mirrors the server's SLUG_RE (^[a-z0-9_-]{1,64}$) — the caller must still
 * validate the final (possibly user-edited) slug against that pattern
 * before uploading, since this is only a best-effort starting suggestion.
 *
 * @param {string} filename
 * @returns {string}
 */
export function slugifyFilename(filename) {
  var base = String(filename || "").replace(/\.[^.]+$/, "").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || "custom";
}

/**
 * Fetch the full list of custom-icon uploads.
 * Resolves to [] on any network/parse error rather than rejecting, so
 * callers can render an empty state without a try/catch at every call site.
 *
 * @returns {Promise<Array<{slug: string, url: string, size?: number, ext?: string}>>}
 */
export function fetchCustomIconList() {
  return fetch("/api/custom-emoji")
    .then(function (r) { return r.json(); })
    .then(function (data) { return Array.isArray(data) ? data : []; })
    .catch(function () { return []; });
}

/**
 * Upload a File/Blob as a new (or replacement) custom icon under the given
 * slug. Caller is responsible for slug validation/confirmation UX (e.g. the
 * duplicate-overwrite confirm dialog in emoji-picker.js) before calling this.
 *
 * @param {string} slug
 * @param {File|Blob} file
 * @returns {Promise<{ok: boolean, slug?: string, url?: string, error?: string}>}
 */
export function uploadCustomIcon(slug, file) {
  return new Promise(function (resolve) {
    var reader = new FileReader();
    reader.onload = function (ev) {
      fetch("/api/custom-emoji/" + encodeURIComponent(slug), {
        method: "POST",
        body: ev.target.result,
      }).then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (body) {
            resolve({ ok: false, error: (body && body.error) || "Upload failed" });
          });
        }
        return r.json().then(function (body) { resolve(Object.assign({ ok: true }, body)); });
      }).catch(function () {
        resolve({ ok: false, error: "Upload failed" });
      });
    };
    reader.onerror = function () { resolve({ ok: false, error: "Failed to read file" }); };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Delete a custom icon by slug.
 * @param {string} slug
 * @returns {Promise<{ok: boolean}>}
 */
export function deleteCustomIcon(slug) {
  return fetch("/api/custom-emoji/" + encodeURIComponent(slug), { method: "DELETE" })
    .then(function () { return { ok: true }; })
    .catch(function () { return { ok: false }; });
}
