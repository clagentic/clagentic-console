// outbound-ledger.js - the sender-side record of what a session sent out.
//
// Every open-session and send-input request (CLI verb or file drop) leaves one
// line here, written by the sender: the delivery, or the refusal or failure.
// The target's own history holds a delivered prompt too, but nothing there lists
// what one sender sent, and a refused request leaves no trace at all.
//
// Location: <console data dir>/outbound/   (0700; files 0600)
//   sessions/<project>/<sender>.jsonl       a sender the console identified from its
//                                           own records (senderKind "extracted")
//   unattributed/declared/<name>.jsonl      a sender that only named itself (--from)
//   unattributed/undeclared/undeclared.jsonl   a sender that named nobody
// Unattributed lines are self-reported and unverified; they are kept apart so a
// reader never mistakes one for an identified sender.
//
// One JSON object per line, appended with a single write; a reader skips a line
// it cannot parse. The line holds the full prompt text, so the files are as
// private as the session history and are removed after the retention period
// (default 30 days, daemon.json "outboundRetentionDays"; 0 turns the ledger off).
//
// Writing never fails the request it describes: record() logs and returns.

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

var FORMAT_VERSION = 1;
var DIR_NAME = "outbound";
var DEFAULT_RETENTION_DAYS = 30;
var MAX_RETENTION_DAYS = 3650;
var DAY_MS = 24 * 60 * 60 * 1000;
var PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

var SENDER_DIR = "sessions";
var UNATTRIBUTED_DIR = "unattributed";

// The retention in days a configured value means. A missing value is the
// default; anything that is not a whole number of days from 0 to 3650 is the
// default too, and { invalid: true } says so, so a typo is not silently kept.
function retentionDaysFrom(raw) {
  if (raw === undefined || raw === null) return { days: DEFAULT_RETENTION_DAYS };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= MAX_RETENTION_DAYS) return { days: raw };
  return { days: DEFAULT_RETENTION_DAYS, invalid: true };
}

// A name that is safe as one path component. A value that is not a plain id is
// replaced by a hash of itself, so two different values never share a file and
// nothing a sender chose can name a path.
function segment(raw) {
  var s = String(raw);
  if (/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(s)) return s;
  return "x-" + crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// The file an entry belongs in, relative to the ledger root.
function relativePathFor(entry) {
  var sender = entry.sender || {};
  if (sender.attribution === "extracted" && sender.project && (sender.cliSessionId || sender.sessionId)) {
    // The vendor session id survives a daemon restart; the console id is
    // renumbered, so it names a sender only until the vendor has named it.
    var key = sender.cliSessionId ? segment(sender.cliSessionId) : "console-" + segment(sender.sessionId);
    return path.join(SENDER_DIR, segment(sender.project), key + ".jsonl");
  }
  if (sender.kind === "declared" && sender.name) {
    return path.join(UNATTRIBUTED_DIR, "declared", segment(sender.name) + ".jsonl");
  }
  return path.join(UNATTRIBUTED_DIR, "undeclared", "undeclared.jsonl");
}

function parseLines(text) {
  var out = [];
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try {
      var obj = JSON.parse(lines[i]);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push({ line: lines[i], entry: obj });
    } catch (e) {
      // A torn final line after a crash, or a damaged one: not readable, skipped.
    }
  }
  return out;
}

function tsOf(entry) {
  var ms = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
  return isFinite(ms) ? ms : null;
}

function errorText(e) {
  return e && e.message ? e.message : String(e);
}

// A ledger path that is not there holds no entries; any other failure to read
// it (permissions, a file where a directory belongs, I/O) is an error the
// reader must report, never an empty list that looks like "nothing was sent".
function isAbsent(e) {
  return !!e && e.code === "ENOENT";
}

function unreadable(file, e) {
  var err = new Error("the outbound ledger cannot be read: " + file + " (" + ((e && e.code) || errorText(e)) + ")");
  err.code = (e && e.code) || "EIO";
  err.path = file;
  return err;
}

// opts:
//   getBaseDir()        the console data directory (read at use)
//   getRetentionDays()  the configured value, or undefined (read at use, so a
//                       change in daemon.json applies without a restart)
//   now()               ms clock (default Date.now), for tests
//   log                 console-like (default console)
function createOutboundLedger(opts) {
  var getBaseDir = opts.getBaseDir;
  var getRetentionDays = opts.getRetentionDays || function () { return undefined; };
  var now = opts.now || Date.now;
  var log = opts.log || console;
  var timer = null;
  var warnedInvalid = null;

  function root() {
    return path.join(getBaseDir(), DIR_NAME);
  }

  function retentionDays() {
    var raw = getRetentionDays();
    var r = retentionDaysFrom(raw);
    if (r.invalid && warnedInvalid !== JSON.stringify(raw)) {
      warnedInvalid = JSON.stringify(raw);
      log.warn("[outbound-ledger] outboundRetentionDays must be a whole number of days from 0 to " + MAX_RETENTION_DAYS + "; using " + DEFAULT_RETENTION_DAYS);
    }
    return r.days;
  }

  // Appends one entry. Never throws: the request it describes is already
  // decided, and a ledger that cannot be written must not change that.
  function record(entry) {
    try {
      if (retentionDays() === 0) return false;
      var file = path.join(root(), relativePathFor(entry));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
      return true;
    } catch (e) {
      log.error("[outbound-ledger] could not write the entry:", errorText(e));
      return false;
    }
  }

  // The ledger files under a subdirectory: [{ file, dir }] (dir is the
  // component under it, the project or the unattributed kind). A directory that
  // is absent has none; one that cannot be read throws (see unreadable()).
  function filesUnder(sub, onlyDir) {
    var base = path.join(root(), sub);
    var dirs;
    try { dirs = fs.readdirSync(base); } catch (e) {
      if (isAbsent(e)) return [];
      throw unreadable(base, e);
    }
    var out = [];
    dirs.forEach(function (d) {
      if (onlyDir !== undefined && d !== onlyDir) return;
      var names;
      // Absent here means a prune removed the directory after the listing above.
      try { names = fs.readdirSync(path.join(base, d)); } catch (e) {
        if (isAbsent(e)) return;
        throw unreadable(path.join(base, d), e);
      }
      names.forEach(function (n) {
        if (n.endsWith(".jsonl")) out.push({ file: path.join(base, d, n), dir: d });
      });
    });
    return out;
  }

  // Entries at or after sinceMs and within the retention, oldest first.
  // A file last written before the cut-off holds nothing newer and is not read.
  // Throws (see unreadable()) when a file that exists cannot be read.
  function readFiles(files, sinceMs) {
    var days = retentionDays();
    if (days === 0) return [];
    var cutoff = Math.max(typeof sinceMs === "number" ? sinceMs : 0, now() - days * DAY_MS);
    var out = [];
    files.forEach(function (f) {
      var text;
      try {
        if (fs.statSync(f.file).mtimeMs < cutoff) return;
        text = fs.readFileSync(f.file, "utf8");
      } catch (e) {
        // Absent: pruned between the listing and this read.
        if (isAbsent(e)) return;
        log.error("[outbound-ledger] could not read " + path.basename(f.file) + ":", errorText(e));
        throw unreadable(f.file, e);
      }
      parseLines(text).forEach(function (l) {
        var ts = tsOf(l.entry);
        if (ts !== null && ts >= cutoff) out.push(l.entry);
      });
    });
    out.sort(function (a, b) { return tsOf(a) - tsOf(b); });
    return out;
  }

  // Entries of identified senders, optionally of one project.
  function readAttributed(query) {
    query = query || {};
    var only = query.project === undefined ? undefined : segment(query.project);
    return readFiles(filesUnder(SENDER_DIR, only), query.sinceMs);
  }

  // Entries of senders that only named themselves, or nobody.
  function readUnattributed(query) {
    query = query || {};
    return readFiles(filesUnder(UNATTRIBUTED_DIR), query.sinceMs);
  }

  // Rewrites a file without its expired lines, through a temporary file and a
  // rename; removes it when nothing is left. Returns the number of lines dropped.
  function pruneFile(file, cutoff) {
    var text = fs.readFileSync(file, "utf8");
    var all = text.split("\n").filter(function (l) { return l; });
    var kept = parseLines(text).filter(function (l) {
      var ts = tsOf(l.entry);
      return ts !== null && ts >= cutoff;
    });
    if (kept.length === all.length) return 0;
    if (!kept.length) {
      fs.unlinkSync(file);
      return all.length;
    }
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, kept.map(function (l) { return l.line; }).join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return all.length - kept.length;
  }

  // ENOTEMPTY (a file is still there) and ENOENT (already gone) are expected;
  // anything else is logged once per path and errno.
  var warnedRmdir = {};
  function removeIfEmpty(dir) {
    try { fs.rmdirSync(dir); } catch (e) {
      if (e && (e.code === "ENOTEMPTY" || e.code === "ENOENT")) return;
      var key = dir + "|" + (e && e.code);
      if (warnedRmdir[key]) return;
      warnedRmdir[key] = true;
      log.error("[outbound-ledger] could not remove the directory " + dir + " (" + ((e && e.code) || errorText(e)) + ")");
    }
  }

  // Removes every entry older than the retention. Synchronous end to end, so no
  // append interleaves with a rewrite. Returns { files, removed }.
  function prune() {
    var cutoff = now() - retentionDays() * DAY_MS;
    var removed = 0;
    var files = 0;
    [SENDER_DIR, UNATTRIBUTED_DIR].forEach(function (sub) {
      filesUnder(sub).forEach(function (f) {
        try {
          var n = pruneFile(f.file, cutoff);
          if (n) { removed += n; files++; }
          // An emptied directory is removed; one still holding files is left.
          removeIfEmpty(path.dirname(f.file));
        } catch (e) {
          log.error("[outbound-ledger] could not prune " + path.basename(f.file) + ":", errorText(e));
        }
      });
    });
    if (removed) log.log("[outbound-ledger] pruned " + removed + " expired entr" + (removed === 1 ? "y" : "ies") + " from " + files + " file(s)");
    return { files: files, removed: removed };
  }

  // Prunes now and then every few hours. The timer never keeps the process up.
  function start() {
    try { prune(); } catch (e) { log.error("[outbound-ledger] prune failed:", errorText(e)); }
    if (timer) return;
    timer = setInterval(function () {
      try { prune(); } catch (e) { log.error("[outbound-ledger] prune failed:", errorText(e)); }
    }, PRUNE_INTERVAL_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    record: record,
    readAttributed: readAttributed,
    readUnattributed: readUnattributed,
    prune: prune,
    start: start,
    stop: stop,
    retentionDays: retentionDays,
  };
}

module.exports = {
  FORMAT_VERSION: FORMAT_VERSION,
  DIR_NAME: DIR_NAME,
  DEFAULT_RETENTION_DAYS: DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS: MAX_RETENTION_DAYS,
  retentionDaysFrom: retentionDaysFrom,
  segment: segment,
  relativePathFor: relativePathFor,
  createOutboundLedger: createOutboundLedger,
};
