// Shared relative-time formatter — importable in both browser (ESM) and
// Node (for tests), same pattern as escape-html.js.
//
// Consolidates the four near-duplicate "Xm ago" / "Xh ago" formatters that
// existed across filebrowser.js, app-home-hub.js, command-palette.js, and
// sidebar-sessions.js (lr-2f75) into one implementation.
//
// Accepts either a Date-parseable value (ISO string) or an epoch-ms number,
// matching every prior caller's input shape.
export function relativeTime(ts) {
  if (!ts) return "";
  var t = typeof ts === "number" ? ts : new Date(ts).getTime();
  var diff = Date.now() - t;
  if (diff < 0) diff = 0;
  var sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  var min = Math.floor(sec / 60);
  if (min < 60) return min + "m ago";
  var hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  var days = Math.floor(hr / 24);
  if (days < 7) return days + "d ago";
  if (days < 30) return Math.floor(days / 7) + "w ago";
  var d = new Date(t);
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
}
