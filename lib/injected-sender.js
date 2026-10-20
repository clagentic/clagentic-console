// injected-sender.js - who sent an injected user_message, as the chat shows it.
//
// Input that reaches a session through session-input.js is not typed by the
// person at the browser, so its history entry names a sender instead of
// borrowing the operator's identity. The sender is recorded at injection time
// (senderFields) and completed on the way to a client (forClient) so an injected
// entry never renders as the local user.
//
// senderKind:
//   "extracted"  derived from the console's own records for a process the console
//                started (lib/sender-ref.js); not proof against a same-user process
//                copying the reference
//   "declared"   the caller named itself with --from (self-reported, unverified)
//   "undeclared" the caller named nobody
//   "automation" a turn the console composed itself (a scheduled message, a run-now,
//                a loop iteration, a rate-limit resume); the console is the sender
//   "unrecorded" a new entry (marked, see below) that names no initiator, or an
//                injected entry that names no usable sender
//   ("attested" is reserved for a caller identity the console itself verified;
//   nothing produces it yet.) Precedence: attested > extracted > declared >
//   undeclared.
//
// Record-format marker. Every user_message recorded from this format on carries
// `entryFormat: 1` (stampRecord, called by each writer) and ALWAYS an initiator,
// the human one included. The marker is what tells a new entry that lost its
// initiator (a defect: fail closed, never the operator) from a legacy entry that
// predates initiators (the console cannot tell a legacy typed turn from a legacy
// automated one, so it renders exactly as it always did). Additive field: older
// readers ignore it.
//
//   marked   + initiator human   operator
//   marked   + other initiator   the automation or sender it names
//   marked   + no initiator      not the operator; "sender not recorded"
//   unmarked (legacy)            as before: operator, unless it is injected
//                                (source external-trigger or a non-human
//                                initiator), in which case the sender path

var crypto = require("crypto");
var { INITIATORS } = require("./turn-initiator");

var SENDER_KIND = Object.freeze({
  EXTRACTED: "extracted",
  DECLARED: "declared",
  UNDECLARED: "undeclared",
  AUTOMATION: "automation",
  UNRECORDED: "unrecorded",
});

// Sender names of the console's own automations. Run-now shares the scheduled
// name, so the same schedule keeps one avatar whichever way it fired.
var AUTOMATION_NAMES = Object.freeze({
  [INITIATORS.SCHEDULED]: "Scheduled message",
  [INITIATORS.SCHEDULED_NOW]: "Scheduled message",
  [INITIATORS.LOOP]: "Loop",
});

var RECORD_FORMAT_FIELD = "entryFormat";
var RECORD_FORMAT = 1;

var MAX_FROM_LENGTH = 64;
// Vendor session ids are uuids or short opaque ids; this bounds a declared one.
var MAX_FROM_SESSION_LENGTH = 128;
// C0 controls, DEL and C1 controls: nothing a sender name needs, and they can
// disguise or break the one-line label.
var CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

// Prefix keeps a sender id from ever equalling a real user id.
var SENDER_ID_PREFIX = "injected:";

var MESSAGE_ID_FIELD = "messageId";

// The id one message carries from the console to the vendor and into the
// published per-message sender record (lib/message-sender-record.js).
function newMessageId() {
  return crypto.randomUUID();
}

// Marks a new user_message as recorded in the current format and gives it its
// message id (kept when the writer already minted one, because the same id must
// reach the vendor with the turn). Returns the entry.
function stampRecord(entry) {
  entry[RECORD_FORMAT_FIELD] = RECORD_FORMAT;
  if (!entry[MESSAGE_ID_FIELD]) entry[MESSAGE_ID_FIELD] = newMessageId();
  return entry;
}

function isMarked(entry) {
  return typeof entry[RECORD_FORMAT_FIELD] === "number" && entry[RECORD_FORMAT_FIELD] >= RECORD_FORMAT;
}

// Returns { from } (absent when the caller named nobody) or { error }.
function validateFrom(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return { error: "from must be a string" };
  var name = raw.trim();
  if (!name) return {};
  if (name.length > MAX_FROM_LENGTH) return { error: "from is longer than " + MAX_FROM_LENGTH + " characters" };
  if (CONTROL_CHARS.test(name)) return { error: "from contains control characters" };
  return { from: name };
}

// Returns { fromSession } (absent when the caller named none) or { error }. The
// id is the sending session's own id at its vendor (the vendor's field is
// fromSession), written by the sender: a navigation target, never authority.
function validateFromSession(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return { error: "fromSession must be a string" };
  var id = raw.trim();
  if (!id) return {};
  if (id.length > MAX_FROM_SESSION_LENGTH) return { error: "fromSession is longer than " + MAX_FROM_SESSION_LENGTH + " characters" };
  if (CONTROL_CHARS.test(id)) return { error: "fromSession contains control characters" };
  return { fromSession: id };
}

function senderId(initiator) {
  return SENDER_ID_PREFIX + (initiator || "unknown");
}

// Fields to store on a new injected entry. declaredName is validateFrom().from;
// extracted is lib/sender-ref.js resolve() or null; declaredSession is
// validateFromSession().fromSession. An extracted sender wins the display; a
// --from that names someone else is kept beside it as declaredName. fromSession
// is the sending session's vendor session id: the console's own record of an
// extracted sender when it has one, else what the caller declared.
function senderFields(initiator, declaredName, extracted, declaredSession) {
  var fields = { from: senderId(initiator) };
  if (extracted && extracted.cliSessionId && extracted.vendor) fields.fromSession = extracted.cliSessionId;
  else if (declaredSession) fields.fromSession = declaredSession;
  if (extracted) {
    fields.senderKind = SENDER_KIND.EXTRACTED;
    fields.fromName = extracted.name;
    fields.senderProject = extracted.project;
    fields.senderSessionId = extracted.sessionId;
    if (extracted.agent) fields.senderAgent = extracted.agent;
    if (extracted.agentSlug) fields.senderAgentSlug = extracted.agentSlug;
    if (extracted.vendor) fields.senderVendor = extracted.vendor;
    // Optional history field, and recorded only together with the vendor: a
    // vendor session id means nothing without the vendor that issued it, and
    // --reply routes by the pair. Absent when the sender had no vendor session id
    // yet, and on entries recorded before it existed.
    if (extracted.cliSessionId && extracted.vendor) fields.senderCliSessionId = extracted.cliSessionId;
    var lower = String(declaredName || "").toLowerCase();
    if (declaredName && lower !== extracted.name.toLowerCase()
      && lower !== String(extracted.agent || extracted.vendor || "").toLowerCase()) {
      fields.declaredName = declaredName;
    }
  } else if (declaredName) {
    fields.fromName = declaredName;
    fields.senderKind = SENDER_KIND.DECLARED;
  } else {
    fields.senderKind = SENDER_KIND.UNDECLARED;
  }
  return fields;
}

// The history entry for a turn the console composed itself. `initiator` is the
// same value the caller passes to startQuery, so the entry and the vendor's
// origin stamp (turn-initiator.js) cannot name different sources. `note` is the
// automation's own detail (the schedule or loop name, the iteration).
function consoleTurnEntry(initiator, text, note) {
  var name = Object.prototype.hasOwnProperty.call(AUTOMATION_NAMES, initiator) ? AUTOMATION_NAMES[initiator] : null;
  if (!name) throw new Error("not a console automation initiator: " + String(initiator));
  var entry = stampRecord({
    type: "user_message",
    text: text,
    _ts: Date.now(),
    initiator: initiator,
    from: senderId(initiator),
    fromName: name,
    senderKind: SENDER_KIND.AUTOMATION,
  });
  if (note) entry.contextNote = note;
  return entry;
}

function isInjected(entry) {
  if (!entry || entry.type !== "user_message") return false;
  return entry.source === "external-trigger" || (!!entry.initiator && entry.initiator !== INITIATORS.HUMAN);
}

// Whether the entry is the operator's own, by the table at the top of the file.
function isOperatorEntry(entry) {
  if (!entry || entry.type !== "user_message") return false;
  if (entry.source === "external-trigger") return false;
  if (isMarked(entry)) return entry.initiator === INITIATORS.HUMAN;
  return !isInjected(entry);
}

// The entry as a client should receive it. Every user message that is not the
// operator's leaves with a sender id that is not a user's and a senderKind,
// whatever was stored, so the client cannot fall back to drawing it as the local
// user. Operator entries and other entry types are returned untouched.
function forClient(entry) {
  if (!entry || entry.type !== "user_message" || isOperatorEntry(entry)) return entry;
  var out = {};
  for (var k in entry) out[k] = entry[k];
  out.from = senderId(entry.initiator);
  var known = out.senderKind === SENDER_KIND.DECLARED || out.senderKind === SENDER_KIND.UNDECLARED
    || (out.senderKind === SENDER_KIND.AUTOMATION && Object.prototype.hasOwnProperty.call(AUTOMATION_NAMES, out.initiator)
      && typeof out.fromName === "string" && !!out.fromName)
    || (out.senderKind === SENDER_KIND.EXTRACTED && typeof out.fromName === "string" && !!out.fromName);
  if (!known) {
    out.senderKind = SENDER_KIND.UNRECORDED;
    delete out.fromName;
  }
  return out;
}

module.exports = {
  SENDER_KIND: SENDER_KIND,
  MAX_FROM_LENGTH: MAX_FROM_LENGTH,
  validateFrom: validateFrom,
  validateFromSession: validateFromSession,
  MAX_FROM_SESSION_LENGTH: MAX_FROM_SESSION_LENGTH,
  newMessageId: newMessageId,
  MESSAGE_ID_FIELD: MESSAGE_ID_FIELD,
  senderFields: senderFields,
  stampRecord: stampRecord,
  RECORD_FORMAT_FIELD: RECORD_FORMAT_FIELD,
  consoleTurnEntry: consoleTurnEntry,
  AUTOMATION_NAMES: AUTOMATION_NAMES,
  isInjected: isInjected,
  isOperatorEntry: isOperatorEntry,
  forClient: forClient,
};
