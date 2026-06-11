// Shared HTML escaping — importable in both browser (ESM) and Node (for tests).
//
// Encodes the five characters that can break out of HTML text and attribute
// contexts. Coerces non-string input so callers never throw on null/undefined.
//
// Character coverage:
//   &  -> &amp;   (entity ambiguity)
//   <  -> &lt;    (tag open)
//   >  -> &gt;    (tag close)
//   "  -> &quot;  (double-quoted attribute breakout)
//   '  -> &#39;   (single-quoted attribute breakout)
export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
