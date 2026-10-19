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
//   "unrecorded" a legacy entry from before senders were recorded
//   ("attested" is reserved for a caller identity the console itself verified;
//   nothing produces it yet.) Precedence: attested > extracted > declared >
//   undeclared.

var SENDER_KIND = Object.freeze({
  EXTRACTED: "extracted",
  DECLARED: "declared",
  UNDECLARED: "undeclared",
  UNRECORDED: "unrecorded",
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

function isInjected(entry) {
  if (!entry || entry.type !== "user_message") return false;
  return entry.source === "external-trigger" || (!!entry.initiator && entry.initiator !== "human");
}

// The entry as a client should receive it. Anything injected leaves with a
// sender id that is not a user's and a senderKind, whatever was stored, so the
// client cannot fall back to drawing it as the local user. Other entries are
// returned untouched.
function forClient(entry) {
  if (!isInjected(entry)) return entry;
  var out = {};
  for (var k in entry) out[k] = entry[k];
  out.from = senderId(entry.initiator);
  var known = out.senderKind === SENDER_KIND.DECLARED || out.senderKind === SENDER_KIND.UNDECLARED
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
  isInjected: isInjected,
  forClient: forClient,
};
