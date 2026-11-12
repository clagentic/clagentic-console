// assistant-identity.js - who the assistant's messages are shown as.
//
// A session cast as a named agent shows that agent's name and its avatar from
// the shared resolver (agent-avatar.js: the operator's roster choice, else the
// seeded robot). A session with no agent shows the vendor that runs it. The
// agent key is the name exactly as the roster records it.
//
// A header never names a vendor the session did not run on: with no vendor
// known at all it shows a neutral "Assistant" with no vendor avatar.

import { VENDOR_AVATARS, VENDOR_NAMES } from "./vendor-registry.js";

export var NEUTRAL_ASSISTANT_NAME = "Assistant";

/**
 * { name, agentKey, avatarUrl } for the assistant of a session.
 *   vendor        the page's current vendor id (claude, codex, ...), or null
 *   agentName     the named agent the session is cast as, or null
 *   listedVendor  the vendor the session list records for the session, used
 *                 when the page holds none
 * agentKey is null for a vendor identity, which has no roster entry.
 * avatarUrl is null for the neutral identity: the caller draws a plain avatar.
 */
export function assistantIdentity(vendor, agentName, listedVendor) {
  var name = typeof agentName === "string" ? agentName.trim() : "";
  if (name) return { name: name, agentKey: agentName, avatarUrl: null };
  var id = vendor || listedVendor;
  if (!id || !VENDOR_NAMES[id]) return { name: NEUTRAL_ASSISTANT_NAME, agentKey: null, avatarUrl: null };
  return {
    name: VENDOR_NAMES[id],
    agentKey: null,
    avatarUrl: VENDOR_AVATARS[id] || null,
  };
}
