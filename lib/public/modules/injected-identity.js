// Maps the recorded sender of an injected message onto the existing
// name and avatar helpers. A sender only gains identity here when it matches a
// known mate or agent; the match changes the display name and avatar and
// nothing else, so an injected entry never reads as the operator.

import { mateAvatarUrl } from "./avatar.js";
import { injectedSenderName } from "./injected-label.js";

// Fixed seeds keep the avatar of anonymous senders stable across renders.
var UNDECLARED_SEED = "undeclared-sender";
var UNRECORDED_SEED = "unrecorded-sender";

function norm(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function findKnownIdentity(known, fromId, fromName) {
  var keys = [norm(fromId), norm(fromName)].filter(Boolean);
  if (!keys.length || !Array.isArray(known)) return null;
  for (var i = 0; i < known.length; i++) {
    var entry = known[i];
    if (!entry) continue;
    var names = [entry.id, entry.agentName, entry.name, entry.slug].map(norm);
    for (var k = 0; k < keys.length; k++) {
      if (names.indexOf(keys[k]) !== -1) return entry;
    }
  }
  return null;
}

// injected: { senderKind, fromName, ... }; fromId: the recorded `from`;
// known: mates and agents as { id, name, agentName?, slug?, avatar fields }.
// Returns { name, avatarUrl, matched }.
export function resolveInjectedIdentity(injected, fromId, known, size) {
  var extracted = injected.senderKind === "extracted";
  var declared = injected.senderKind === "declared" || extracted;
  if (declared) {
    // An extracted sender is matched on its agent name; its fromName is the
    // "<agent>@<project>" label, which names no agent by itself.
    var hit = extracted
      ? findKnownIdentity(known, undefined, injected.senderAgent)
      : findKnownIdentity(known, fromId, injected.fromName);
    if (hit) {
      return {
        name: extracted ? injectedSenderName(injected) : (hit.name || hit.agentName || injectedSenderName(injected)),
        avatarUrl: mateAvatarUrl(hit, size),
        matched: true,
      };
    }
  }
  // An extracted agent keeps its own avatar when the receiving project does not
  // list it: same id the list would give it.
  if (extracted && injected.senderAgentSlug) {
    return {
      name: injectedSenderName(injected),
      avatarUrl: mateAvatarUrl({ id: injected.senderAgentSlug }, size),
      matched: false,
    };
  }
  var seed = declared
    ? (injected.fromName || fromId || UNDECLARED_SEED)
    : (injected.senderKind === "undeclared" ? UNDECLARED_SEED : UNRECORDED_SEED);
  return {
    name: injectedSenderName(injected),
    avatarUrl: mateAvatarUrl({ avatarStyle: "bottts", avatarSeed: seed }, size),
    matched: false,
  };
}
