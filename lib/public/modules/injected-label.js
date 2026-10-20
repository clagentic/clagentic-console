// Text shown for a message that another process injected into the session.
// senderKind is extracted (derived from the console's own records; fromName is
// "<agent or vendor>@<project>", always, even within the same project), declared
// (the caller named itself), undeclared (it named nobody) or unrecorded (a
// legacy entry). Never the operator's name.

export function injectedSenderName(injected) {
  if ((injected.senderKind === "declared" || injected.senderKind === "extracted" || injected.senderKind === "automation") && injected.fromName) return injected.fromName;
  if (injected.senderKind === "undeclared") return "Undeclared sender";
  return "injected (sender not recorded)";
}

// A run-now is the same schedule fired early; the label says so.
var INITIATOR_TEXT = { "scheduled-now": "scheduled · sent now" };

// "trigger · note · declared": who injected, why, and how far the name can be trusted.
// "loop · job-hunter · iteration 3": a turn the console composed itself.
export function injectedLabel(injected) {
  var parts = [];
  if (injected.initiator) parts.push(INITIATOR_TEXT[injected.initiator] || injected.initiator);
  if (injected.contextNote) parts.push(injected.contextNote);
  if (injected.senderKind === "declared" || injected.senderKind === "undeclared" || injected.senderKind === "extracted") {
    parts.push(injected.senderKind);
  }
  // A --from that names someone else is shown beside the extracted identity.
  if (injected.senderKind === "extracted" && injected.declaredName) parts.push("declared as " + injected.declaredName);
  return parts.join(" · ");
}

// The full sender session id, for hover or tap: it tells apart two sessions with
// the same agent and project, which the label does not. "" when not recorded.
export function injectedSessionNote(injected) {
  if (injected.senderKind !== "extracted" || !injected.senderSessionId) return "";
  return "session " + injected.senderSessionId;
}

// Whether the console recorded a user_message as the operator's own. Fail
// closed: only the human initiator the browser composer's entry carries, or a
// pre-initiator multi-user entry with a real user id and no sender kind, is the
// operator's. A message that names neither is attributed, never drawn as local.
function isOperatorMessage(msg) {
  if (msg.initiator) return msg.initiator === "human";
  return !msg.senderKind && typeof msg.from === "string" && msg.from !== "" && msg.from.indexOf("injected:") !== 0;
}

// The injected descriptor for a user_message, or null for one the operator typed.
export function injectedFromMessage(msg) {
  if (isOperatorMessage(msg) && !msg.senderKind) return null;
  return {
    senderKind: msg.senderKind || "unrecorded",
    fromName: msg.fromName,
    initiator: msg.initiator,
    contextNote: msg.contextNote,
    senderAgent: msg.senderAgent,
    senderAgentSlug: msg.senderAgentSlug,
    senderSessionId: msg.senderSessionId,
    declaredName: msg.declaredName,
  };
}
