// message-sender-record.js - the per-message sender record the console publishes
// for any tool that reads a vendor session.
//
// A vendor transcript says what was said, not always who sent it. For every user
// message the console sends into a vendor session this module appends one line
// to a file an outside tool can find from the vendor session id alone, with no
// console running. The format is versioned and documented in
// docs/guides/architecture.md ("Integrating other tools"); change it only by
// bumping FORMAT_VERSION.
//
// Location:  <console data dir>/message-senders/<vendor>/<vendor session id>.jsonl
// Lines (JSON, one per line, appended with a single write):
//   kind "message"  one per user message the console sent
//   kind "turn"     added when a vendor reports the turn id of a message (Codex)
//
// This is not a second history writer: the entries come from the history
// entries the existing writers already build (injected-sender.js stampRecord and
// consoleTurnEntry, session-input.js recordInjected), observed at the one place
// they all pass through (sessions.js recordHistoryEntry).

var fs = require("fs");
var path = require("path");
var { isSafeSessionId } = require("./session-id");

var FORMAT_VERSION = 1;
var DIR_NAME = "message-senders";
var KIND = Object.freeze({ MESSAGE: "message", TURN: "turn" });

// A session whose vendor session id is not known yet (its first turn has not
// answered) holds its records here; a session that never gets one is bounded.
var MAX_PENDING = 100;
var PENDING_FIELD = "_senderRecordsPending";

function isoOf(ms) {
  return new Date(typeof ms === "number" && isFinite(ms) ? ms : Date.now()).toISOString();
}

// The record fields a history entry yields. vendor and vendorSessionId are filled
// in when the record is written.
function fieldsFromEntry(entry) {
  var rec = {
    formatVersion: FORMAT_VERSION,
    kind: KIND.MESSAGE,
    messageId: entry.messageId,
    initiator: entry.initiator || null,
    senderName: typeof entry.fromName === "string" && entry.fromName ? entry.fromName : null,
    senderKind: entry.senderKind || null,
    fromSession: typeof entry.fromSession === "string" && entry.fromSession ? entry.fromSession : null,
    timestamp: isoOf(entry._ts),
  };
  return rec;
}

function recordPath(baseDir, vendor, vendorSessionId) {
  if (typeof vendor !== "string" || !isSafeSessionId(vendor)) throw new Error("unsafe vendor " + JSON.stringify(String(vendor).slice(0, 32)));
  if (!isSafeSessionId(vendorSessionId)) throw new Error("unsafe vendor session id " + JSON.stringify(String(vendorSessionId).slice(0, 64)));
  return path.join(baseDir, DIR_NAME, vendor, vendorSessionId + ".jsonl");
}

// getBaseDir() is read at write time so a recorder built before the data
// directory exists still writes to it.
function createSenderRecorder(opts) {
  var getBaseDir = opts.getBaseDir;
  var log = opts.log || console;

  function append(vendor, vendorSessionId, rec) {
    var file = recordPath(getBaseDir(), vendor, vendorSessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    var out = Object.assign({}, rec, { vendor: vendor, vendorSessionId: vendorSessionId });
    // One write of one line: a reader sees whole lines, and tolerates an
    // unparsable final one.
    fs.appendFileSync(file, JSON.stringify(out) + "\n", { mode: 0o600 });
  }

  function attempt(vendor, vendorSessionId, rec) {
    try { append(vendor, vendorSessionId, rec); }
    catch (e) {
      // Publishing the record never breaks or delays the turn it describes.
      log.error("[message-sender-record] could not write the record:", e && e.message ? e.message : String(e));
    }
  }

  function vendorOf(session, defaultVendor) {
    return session.vendor || defaultVendor || null;
  }

  function pendingOf(session) {
    if (!session[PENDING_FIELD]) session[PENDING_FIELD] = [];
    return session[PENDING_FIELD];
  }

  // Called for each history entry as it is recorded. Entries that are not a
  // user message the console sent (no message id) are ignored.
  function note(session, entry, defaultVendor) {
    if (!entry || entry.type !== "user_message" || !entry.messageId) return;
    var rec = fieldsFromEntry(entry);
    var vendor = vendorOf(session, defaultVendor);
    if (vendor && session.cliSessionId) return attempt(vendor, session.cliSessionId, rec);
    var pending = pendingOf(session);
    if (pending.length >= MAX_PENDING) pending.shift();
    pending.push(rec);
  }

  // Writes what was held for a session whose vendor session id is now known.
  function flush(session, defaultVendor) {
    var pending = session[PENDING_FIELD];
    var vendor = vendorOf(session, defaultVendor);
    if (!pending || !pending.length || !vendor || !session.cliSessionId) return;
    session[PENDING_FIELD] = [];
    for (var i = 0; i < pending.length; i++) attempt(vendor, session.cliSessionId, pending[i]);
  }

  // A vendor that assigns its own id to the turn a message started (Codex)
  // reports it here; the id joins the message to the vendor transcript.
  function bindTurn(session, messageId, turnId, defaultVendor) {
    if (!messageId || !turnId) return;
    var rec = { formatVersion: FORMAT_VERSION, kind: KIND.TURN, messageId: messageId, turnId: String(turnId), timestamp: isoOf() };
    var vendor = vendorOf(session, defaultVendor);
    if (vendor && session.cliSessionId) return attempt(vendor, session.cliSessionId, rec);
    var pending = pendingOf(session);
    if (pending.length >= MAX_PENDING) pending.shift();
    pending.push(rec);
  }

  return { note: note, flush: flush, bindTurn: bindTurn };
}

module.exports = {
  FORMAT_VERSION: FORMAT_VERSION,
  DIR_NAME: DIR_NAME,
  KIND: KIND,
  recordPath: recordPath,
  createSenderRecorder: createSenderRecorder,
};
