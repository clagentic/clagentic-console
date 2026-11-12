// assistant-identity.js - who the assistant's messages are shown as.
//
// A session cast as a named agent shows that agent's name and its avatar from
// the shared resolver (agent-avatar.js: the operator's roster choice, else the
// seeded robot). A session with no agent shows the vendor, as it always has.
// The agent key is the name exactly as the roster records it.

import { VENDOR_AVATARS, VENDOR_NAMES } from "./vendor-registry.js";

/**
 * { name, agentKey, avatarUrl } for the assistant of a session.
 *   vendor     the session's vendor id (claude, codex, ...)
 *   agentName  the named agent the session is cast as, or null
 * agentKey is null for a vendor identity, which has no roster entry.
 */
export function assistantIdentity(vendor, agentName) {
  var name = typeof agentName === "string" ? agentName.trim() : "";
  if (name) return { name: name, agentKey: agentName, avatarUrl: null };
  var id = vendor || "claude";
  return {
    name: VENDOR_NAMES[id] || VENDOR_NAMES.claude,
    agentKey: null,
    avatarUrl: VENDOR_AVATARS[id] || VENDOR_AVATARS.claude,
  };
}
