// Text shown for a message that another process injected into the session.
// senderKind is declared (the caller named itself), undeclared (it named
// nobody) or unrecorded (a legacy entry). Never the operator's name.

export function injectedSenderName(injected) {
  if (injected.senderKind === "declared" && injected.fromName) return injected.fromName;
  if (injected.senderKind === "undeclared") return "Undeclared sender";
  return "injected (sender not recorded)";
}

// "trigger · note · declared": who injected, why, and how far the name can be trusted.
export function injectedLabel(injected) {
  var parts = [];
  if (injected.initiator) parts.push(injected.initiator);
  if (injected.contextNote) parts.push(injected.contextNote);
  if (injected.senderKind === "declared" || injected.senderKind === "undeclared") parts.push(injected.senderKind);
  return parts.join(" · ");
}

// The injected descriptor for a user_message, or null for one the operator typed.
export function injectedFromMessage(msg) {
  if (!msg.senderKind) return null;
  return { senderKind: msg.senderKind, fromName: msg.fromName, initiator: msg.initiator, contextNote: msg.contextNote };
}
