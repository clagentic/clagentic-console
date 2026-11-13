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
import { listedVendor } from "./session-vendor-state.js";

export var NEUTRAL_ASSISTANT_NAME = "Assistant";

/** The vendor the active session shows: the page's, else the session list's. */
export function activeVendorId(get) {
  return get("currentVendor") || listedVendor(get("sessionVendors"), get("activeSessionId"));
}

export var LOOP_QUEUE_PLACEHOLDER = "Message queues for the next loop iteration…";

/**
 * The composer's placeholder: the loop queue wording while queue mode is on,
 * else the vendor the page holds, else the one the session list records for the
 * active session, else a neutral wording. It never names a vendor nothing says
 * the session runs on.
 *   get  a store getter (key => value)
 */
export function composerPlaceholder(get) {
  if (get("loopQueueMode")) return LOOP_QUEUE_PLACEHOLDER;
  var id = activeVendorId(get);
  return id && VENDOR_NAMES[id] ? "Message " + VENDOR_NAMES[id] + "..." : "Message the assistant...";
}

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
