// DOM-free export of the sticky-note text formatter used in renderMiniMarkdown.
//
// This module exists so Node-based tests can import and exercise the XSS-relevant
// escaping and auto-link logic without requiring a browser environment.
//
// The fmt() function inside renderMiniMarkdown is not independently exported from
// sticky-notes.js (it is browser-ESM with DOM deps). This module mirrors its exact
// implementation so that the regression tests call the real production logic pattern.
// Any change to fmt() in sticky-notes.js must be reflected here.

// The URL auto-link regex used in fmt(), exported for direct inspection in tests.
// Excludes whitespace, HTML special chars, and quote chars from URL matches so that
// a crafted URL like http://x.com"onmouseover="alert(1) cannot break out of the href.
export var AUTO_LINK_RE = /(https?:\/\/[^\s<>"']+)/g;

function escapeHtmlBasic(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmt(s) {
  // Split on raw URLs first (before any HTML escaping), so quote chars in the
  // surrounding text still act as natural URL terminators in AUTO_LINK_RE.
  // Non-URL segments are HTML-escaped; URL segments are escaped then wrapped in
  // an anchor (the href value is also escaped so &, <, > inside URLs are safe).
  AUTO_LINK_RE.lastIndex = 0;
  var parts = s.split(AUTO_LINK_RE);
  // split() with a capturing group produces: [text, url, text, url, ...]
  var out = "";
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Non-URL segment — HTML-escape fully.
      out += escapeHtmlBasic(parts[i]);
    } else {
      // URL segment — escape for safe embedding in href and link text.
      var safeUrl = escapeHtmlBasic(parts[i]);
      out += '<a href="' + safeUrl + '" target="_blank" rel="noopener">' + safeUrl + "</a>";
    }
  }
  return out
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/^- \[x\]/gm, '<span class="sn-check checked">✓</span>')
    .replace(/^- \[ \]/gm, '<span class="sn-check">☐</span>')
    .replace(/\n/g, "<br>");
}
