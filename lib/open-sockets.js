"use strict";

// Open browser sockets per project, for the activity diagnostics. A tab holds
// one socket, so a project showing more sockets than tabs is the sign of an
// orphaned connection. The count is the daemon's own and holds no connection
// detail: only the project slug and a number.

var counts = new Map();

function opened(slug) {
  counts.set(slug, (counts.get(slug) || 0) + 1);
}

function closed(slug) {
  var n = (counts.get(slug) || 0) - 1;
  if (n > 0) counts.set(slug, n);
  else counts.delete(slug);
}

// { slug: openSocketCount } for every project with at least one open socket.
function snapshot() {
  var out = {};
  counts.forEach(function (n, slug) { out[slug] = n; });
  return out;
}

module.exports = { opened: opened, closed: closed, snapshot: snapshot };
