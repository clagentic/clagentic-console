// DOM-free export of the sticky-note text formatter used in renderMiniMarkdown.
//
// This module exists so Node-based tests can import and exercise the XSS-relevant
// escaping and auto-link logic without requiring a browser environment.
//
// The fmt() function inside renderMiniMarkdown is not independently exported from
// sticky-notes.js (it is browser-ESM with DOM deps). This module mirrors its exact
// implementation so that the regression tests call the real production logic pattern.
// Any change to fmt() in sticky-notes.js must be reflected here.
export function fmt(s) {
  var escaped = s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/^- \[x\]/gm, '<span class="sn-check checked">✓</span>')
    .replace(/^- \[ \]/gm, '<span class="sn-check">☐</span>')
    .replace(/\n/g, "<br>");
}

// The URL auto-link regex used in fmt(), exported for direct inspection in tests.
export var AUTO_LINK_RE = /(https?:\/\/[^\s<>"']+)/g;
