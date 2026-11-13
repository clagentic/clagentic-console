// Maps the recorded sender of an injected message onto the existing
// name and avatar helpers. A sender only gains identity here when it matches a
// known mate or agent; the match changes the display name and avatar and
// nothing else, so an injected entry never reads as the operator.
//
// The avatar of a sender that names an agent comes from the shared resolver
// (agent-avatar.js): the operator's choice for that agent when there is one,
// otherwise the avatar this module always gave it.

import { mateAvatarUrl } from "./avatar.js";
import { injectedSenderName } from "./injected-label.js";
import { resolveAgentAvatar, robotAvatarUrl, senderAgentKey, systemKindOf } from "./agent-avatar.js";

// Fixed seeds keep the avatar of anonymous senders stable across renders.
var UNDECLARED_SEED = "undeclared-sender";
var UNRECORDED_SEED = "unrecorded-sender";
var AUTOMATION_SEED_PREFIX = "console-automation:";

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

// agentKey is the roster key the sender is recorded under (null when it names no
// agent); defaultAvatarUrl is what it shows when the operator chose nothing.
function identityOf(injected, name, defaultAvatarUrl, matched, size) {
  var agentKey = senderAgentKey(injected);
  var avatarUrl = agentKey ? resolveAgentAvatar(agentKey, size, defaultAvatarUrl).url : defaultAvatarUrl;
  return { name: name, avatarUrl: avatarUrl, defaultAvatarUrl: defaultAvatarUrl, agentKey: agentKey, matched: matched, systemKind: systemKindOf(injected) };
}

// injected: { senderKind, fromName, ... }; fromId: the recorded `from`;
// known: mates and agents as { id, name, agentName?, slug?, avatar fields }.
// Returns { name, avatarUrl, defaultAvatarUrl, agentKey, matched, systemKind };
// a systemKind (non-null) means draw the fixed system icon, not avatarUrl.
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
      var hitName = extracted ? injectedSenderName(injected) : (hit.name || hit.agentName || injectedSenderName(injected));
      return identityOf(injected, hitName, mateAvatarUrl(hit, size), true, size);
    }
  }
  // An extracted agent keeps its own avatar when the receiving project does not
  // list it: same id the list would give it.
  if (extracted && injected.senderAgentSlug) {
    return identityOf(injected, injectedSenderName(injected), mateAvatarUrl({ id: injected.senderAgentSlug }, size), false, size);
  }
  // The console's own automations keep one avatar each, whichever session or
  // project they run in, and never match a mate or agent by name.
  if (injected.senderKind === "automation") {
    return identityOf(injected, injectedSenderName(injected),
      mateAvatarUrl({ avatarStyle: "bottts", avatarSeed: AUTOMATION_SEED_PREFIX + (injected.fromName || "console") }, size), false, size);
  }
  // A sender that names an agent shows that agent's seeded robot, the same one
  // the roster and every other place that draws the agent start from.
  var agentKey = senderAgentKey(injected);
  if (agentKey) return identityOf(injected, injectedSenderName(injected), robotAvatarUrl(agentKey, size), false, size);
  var seed = declared
    ? (injected.fromName || fromId || UNDECLARED_SEED)
    : (injected.senderKind === "undeclared" ? UNDECLARED_SEED : UNRECORDED_SEED);
  return identityOf(injected, injectedSenderName(injected), mateAvatarUrl({ avatarStyle: "bottts", avatarSeed: seed }, size), false, size);
}
