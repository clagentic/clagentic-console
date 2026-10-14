// cli-transcript-title.js - reads the title the Claude Code CLI wrote for a
// session into its own transcript.
//
// The CLI appends a record of this shape to <claudeDir>/projects/<cwd>/<id>.jsonl
// each time it titles the session, and the last one wins:
//
//   {"type":"ai-title","aiTitle":"...","sessionId":"<id>"}
//
// The SDK message stream does not carry it (sdk.d.ts has no message for it), so
// the transcript is the only source. Nothing here writes to the transcript.

var fs = require("fs");
var path = require("path");
var utils = require("./utils");
var { isSafeSessionId, sessionPathWithin } = require("./session-id");

// A transcript can be large and the record is normally near its end, so the
// file is read backwards in chunks and the scan stops at the first match.
var CHUNK_BYTES = 64 * 1024;
var MAX_SCAN_BYTES = 16 * 1024 * 1024;
var MAX_TITLE_CHARS = 100;

var NEWLINE = 0x0a;

function normalize(title) {
  if (typeof title !== "string") return null;
  var t = title.replace(/\s+/g, " ").trim();
  return t ? t.substring(0, MAX_TITLE_CHARS) : null;
}

function aiTitleOfLine(line, sessionId) {
  if (line.indexOf('"ai-title"') === -1) return null;
  var obj;
  try { obj = JSON.parse(line); } catch (e) { return null; }
  if (!obj || obj.type !== "ai-title") return null;
  // A record naming another session is not this session's title.
  if (obj.sessionId && obj.sessionId !== sessionId) return null;
  return normalize(obj.aiTitle);
}

// Resolves the latest ai-title in the transcript at filePath for sessionId, or
// null when there is none or the file cannot be read.
function readLatestAiTitle(filePath, sessionId) {
  return fs.promises.open(filePath, "r").then(function (fh) {
    function scan() {
      return fh.stat().then(function (st) {
        var pos = st.size;
        var scanned = 0;
        var carry = Buffer.alloc(0);

        function step() {
          if (pos <= 0 || scanned >= MAX_SCAN_BYTES) {
            // pos === 0: carry is the first line of the file.
            return Promise.resolve(pos <= 0 && carry.length ? aiTitleOfLine(carry.toString("utf8"), sessionId) : null);
          }
          var len = Math.min(CHUNK_BYTES, pos);
          pos -= len;
          scanned += len;
          var chunk = Buffer.alloc(len);
          return fh.read(chunk, 0, len, pos).then(function () {
            var buf = Buffer.concat([chunk, carry]);
            // Lines are split on bytes so a multibyte character cut by the
            // chunk edge is never decoded half-way.
            var end = buf.length;
            var found = null;
            for (var i = buf.length - 1; i >= 0 && found === null; i--) {
              if (buf[i] === NEWLINE) {
                if (end > i + 1) found = aiTitleOfLine(buf.toString("utf8", i + 1, end), sessionId);
                end = i;
              }
            }
            if (found !== null) return found;
            carry = buf.subarray(0, end);
            return step();
          });
        }
        return step();
      });
    }
    return scan().then(
      function (v) { return fh.close().then(function () { return v; }); },
      function (e) { return fh.close().then(function () { throw e; }); }
    );
  }).catch(function () { return null; });
}

// Finds <claudeDir>/projects/*/<sessionId>.jsonl. The directory named for a
// cwd in cwds is tried first; any other project directory is searched after,
// because the CLI names the directory for the cwd the query ran in.
// Resolves the path or null.
function findTranscript(claudeDir, cwds, sessionId) {
  if (!isSafeSessionId(sessionId)) return Promise.resolve(null);
  var projectsDir = path.join(claudeDir, "projects");

  function exists(p) {
    return fs.promises.stat(p).then(function (st) { return st.isFile(); }, function () { return false; });
  }

  var tried = {};
  var candidates = [];
  (cwds || []).forEach(function (c) {
    if (typeof c !== "string" || !c) return;
    var dir = path.join(projectsDir, utils.encodeCwd(c));
    if (!tried[dir]) { tried[dir] = true; candidates.push(dir); }
  });

  function tryDirs(i) {
    if (i >= candidates.length) return Promise.resolve(null);
    var p = sessionPathWithin(candidates[i], sessionId, ".jsonl");
    return exists(p).then(function (ok) { return ok ? p : tryDirs(i + 1); });
  }

  return tryDirs(0).then(function (hit) {
    if (hit) return hit;
    return fs.promises.readdir(projectsDir).then(function (names) {
      function next(i) {
        if (i >= names.length) return Promise.resolve(null);
        var dir = path.join(projectsDir, names[i]);
        if (tried[dir]) return next(i + 1);
        var p = sessionPathWithin(dir, sessionId, ".jsonl");
        return exists(p).then(function (ok) { return ok ? p : next(i + 1); });
      }
      return next(0);
    }, function () { return null; });
  });
}

module.exports = {
  readLatestAiTitle: readLatestAiTitle,
  findTranscript: findTranscript,
};
