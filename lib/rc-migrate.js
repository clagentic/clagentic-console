// rc-migrate.js — one-time COPY of the recent-projects file into the console
// data dir.
//
// The file used to live in the user's home as a bare-brand dotfile. It now
// lives at <console data dir>/recent-projects.json. The old file is never
// modified or deleted: a rollback to an older release must still find it.

var fs = require("fs");
var path = require("path");

var RC_FILENAME = "recent-projects.json";

/**
 * @param {object} opts
 * @param {string} opts.rcPath       Destination file.
 * @param {string[]} opts.legacyPaths  Candidates, newest first.
 * @param {object} [opts.fs]         fs-like, for tests.
 * @param {function} [opts.log]
 * @returns {{copied: boolean, from: (string|null)}}
 */
function migrateRc(opts) {
  var fsImpl = opts.fs || fs;
  var log = opts.log || console.log;
  if (fsImpl.existsSync(opts.rcPath)) return { copied: false, from: null };

  for (var i = 0; i < opts.legacyPaths.length; i++) {
    var src = opts.legacyPaths[i];
    if (!fsImpl.existsSync(src)) continue;
    try {
      fsImpl.mkdirSync(path.dirname(opts.rcPath), { recursive: true, mode: 0o700 });
      // COPYFILE_EXCL: never overwrite a file that appeared since the check.
      fsImpl.copyFileSync(src, opts.rcPath, fs.constants.COPYFILE_EXCL);
      log("[config] Copied " + src + " -> " + opts.rcPath + " (the original is left in place)");
      return { copied: true, from: src };
    } catch (e) {
      if (e.code === "EEXIST") return { copied: false, from: null };
      console.error("[config] Could not copy " + src + " to " + opts.rcPath + ":", e.message);
      return { copied: false, from: null };
    }
  }
  return { copied: false, from: null };
}

module.exports = { migrateRc: migrateRc, RC_FILENAME: RC_FILENAME };
