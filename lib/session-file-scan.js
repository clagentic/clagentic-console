// session-file-scan.js - a bounded reverse scan of a session's JSONL file.
// The file is read backwards in fixed-size chunks and the scan stops at the
// first (newest) entry the predicate accepts, so the memory held is the chunk
// plus the one line being assembled, never the file. Line 0 of a session file
// is its meta record and is never offered to the predicate.

var fs = require("fs");

var DEFAULT_CHUNK_BYTES = 64 * 1024;
var NEWLINE = 0x0a;

// Offers each history entry of the file at `filePath`, newest first, to
// `accept(entry)`; returns the first entry it accepts, or null when none does.
// A missing or unreadable file throws (the caller decides what that means). A
// line that is not JSON is skipped, as the full-history parse skips it.
function findNewestEntry(filePath, accept, chunkBytes) {
  var chunkSize = chunkBytes > 0 ? chunkBytes : DEFAULT_CHUNK_BYTES;
  var fd = fs.openSync(filePath, "r");
  try {
    var pos = fs.fstatSync(fd).size;
    // Bytes of a line whose start lies in an earlier chunk. Kept as bytes, not
    // text, so a multibyte character split by a chunk boundary stays intact.
    var carry = Buffer.alloc(0);
    var chunk = Buffer.alloc(chunkSize);

    function offer(lineBuf) {
      if (lineBuf.length === 0) return null;
      var entry;
      try { entry = JSON.parse(lineBuf.toString("utf8")); } catch { return null; }
      return accept(entry) ? entry : null;
    }

    while (pos > 0) {
      var n = Math.min(chunkSize, pos);
      pos -= n;
      var got = fs.readSync(fd, chunk, 0, n, pos);
      var buf = Buffer.concat([chunk.subarray(0, got), carry]);
      var end = buf.length;
      var nl = buf.lastIndexOf(NEWLINE, end - 1);
      while (nl !== -1) {
        var hit = offer(buf.subarray(nl + 1, end));
        if (hit) return hit;
        end = nl;
        nl = end > 0 ? buf.lastIndexOf(NEWLINE, end - 1) : -1;
      }
      carry = Buffer.from(buf.subarray(0, end));
    }
    // What remains is line 0: the meta record, which is not history.
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { findNewestEntry: findNewestEntry, DEFAULT_CHUNK_BYTES: DEFAULT_CHUNK_BYTES };
