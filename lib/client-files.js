"use strict";

// client-files.js — the browser client file set this process loaded at startup.
//
// The server used to read lib/public from the install directory on every
// request. After an npm install without a restart, the running (old) server then
// handed out the NEW client, which can need a server route the old build lacks
// and fails at boot. The set is therefore read once, when this module is first
// required (daemon startup, before any later install), and served from memory
// from then on, so a process only ever serves the client of the build it runs.
//
// The restart-to-update path is unaffected: it is an in-band offer the loaded
// client already holds, and a restart loads the new set.

var fs = require("fs");
var path = require("path");

var PUBLIC_DIR = path.join(__dirname, "public");

/** Key for a file below `root`: posix separators, no leading slash. */
function keyFor(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function walk(root, dir, into) {
  var names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return;
  }
  for (var i = 0; i < names.length; i++) {
    var full = path.join(dir, names[i]);
    var stat;
    try {
      stat = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (stat.isDirectory()) {
      walk(root, full, into);
    } else if (stat.isFile()) {
      try {
        into.set(keyFor(root, full), fs.readFileSync(full));
      } catch (e) {
        // A file that cannot be read now could not have been served before.
      }
    }
  }
}

/**
 * Reads every file below `root` into memory. The returned set is immutable in
 * use: `read` hands back the captured bytes whatever the disk holds later.
 */
function capture(root) {
  var files = new Map();
  walk(root, root, files);
  var bytes = 0;
  files.forEach(function (buf) { bytes += buf.length; });
  return {
    root: root,
    count: files.size,
    bytes: bytes,
    /** The captured bytes for a path relative to the root, or null. */
    read: function (relPath) {
      var buf = files.get(relPath);
      return buf === undefined ? null : buf;
    },
    keys: function () { return Array.from(files.keys()); },
  };
}

var publicFiles = capture(PUBLIC_DIR);

module.exports = {
  capture: capture,
  publicFiles: publicFiles,
};
