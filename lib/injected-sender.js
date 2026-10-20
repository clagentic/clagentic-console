// injected-sender.js - who sent an injected user_message, as the chat shows it.
//
// Input that reaches a session through session-input.js is not typed by the
// person at the browser, so its history entry names a sender instead of
// borrowing the operator's identity. The sender is recorded at injection time
// (senderFields) and completed on the way to a client (forClient) so entries
// recorded before senders existed still never render as the local user.
//
// senderKind:
//   "extracted"  derived from the console's own records for a process the console
//                started (lib/sender-ref.js); not proof against a same-user process
//                copying the reference
//   "declared"   the caller named itself with --from (self-reported, unverified)
//   "undeclared" the caller named nobody
//   "automation" a turn the console composed itself (a scheduled message, a run-now,
//                a loop iteration, a rate-limit resume); the console is the sender
//   "unrecorded" an entry that names no sender and was not typed in the browser
//                composer (a legacy entry, or one imported from elsewhere)
//   ("attested" is reserved for a caller identity the console itself verified;
//   nothing produces it yet.) Precedence: attested > extracted > declared >
//   undeclared.
//
// Fail closed: only an entry carrying the human initiator (stamped where the
// authenticated browser composer's text is recorded), or a legacy multi-user
// entry carrying a real user id in `from`, is the operator's. Everything else
// that reaches a client is attributed to a sender, never to the local user.

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

var MAX_FROM_LENGTH = 64;
// C0 controls, DEL and C1 controls: nothing a sender name needs, and they can
// disguise or break the one-line label.
var CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

// Prefix keeps a sender id from ever equalling a real user id.
var SENDER_ID_PREFIX = "injected:";

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

function senderId(initiator) {
  return SENDER_ID_PREFIX + (initiator || "unknown");
}

// Fields to store on a new injected entry. declaredName is validateFrom().from;
// extracted is lib/sender-ref.js resolve() or null. An extracted sender wins the
// display; a --from that names someone else is kept beside it as declaredName.
function senderFields(initiator, declaredName, extracted) {
  var fields = { from: senderId(initiator) };
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
  var entry = {
    type: "user_message",
    text: text,
    _ts: Date.now(),
    initiator: initiator,
    from: senderId(initiator),
    fromName: name,
    senderKind: SENDER_KIND.AUTOMATION,
  };
  if (note) entry.contextNote = note;
  return entry;
}

function isInjected(entry) {
  if (!entry || entry.type !== "user_message") return false;
  return entry.source === "external-trigger" || (!!entry.initiator && entry.initiator !== INITIATORS.HUMAN);
}

function hasUserId(entry) {
  return typeof entry.from === "string" && !!entry.from && entry.from.indexOf(SENDER_ID_PREFIX) !== 0;
}

// Whether the entry is the operator's own: the authenticated browser composer
// stamps the human initiator where it records the text. An entry from before the
// stamp existed that carries a real user id (multi-user) is also the operator's.
function isOperatorEntry(entry) {
  if (!entry || entry.type !== "user_message") return false;
  if (entry.source === "external-trigger") return false;
  if (entry.initiator) return entry.initiator === INITIATORS.HUMAN;
  return entry.senderKind === undefined && hasUserId(entry);
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
  senderFields: senderFields,
  consoleTurnEntry: consoleTurnEntry,
  AUTOMATION_NAMES: AUTOMATION_NAMES,
  isInjected: isInjected,
  isOperatorEntry: isOperatorEntry,
  forClient: forClient,
};
