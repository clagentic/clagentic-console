// vendor-registry.js - the agent registry as the server sent it, and the
// helpers every capability-gated control reads it through. Controls ask what
// the current agent can do (capabilityGate); nothing here or in a caller
// compares a vendor name. A control the agent cannot support is shown
// disabled with the one-line reason from the registry, never silently absent.

import { store } from './store.js';

// Names and avatars by vendor id, filled from the registry message. The two
// shipped agents are seeded only to cover the moment before that message
// arrives; the registry overrides them and adds every other agent.
export var VENDOR_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
};
export var VENDOR_AVATARS = {
  claude: "/claude-code-avatar.png",
  codex: "/codex-avatar.png",
};

function idsWhere(vendors, field) {
  return vendors.filter(function (v) { return v[field]; }).map(function (v) { return v.id; });
}

/**
 * Applies a vendor_registry message: names, avatars and the lists the picker
 * and the gated controls read.
 */
export function applyVendorRegistry(msg) {
  var vendors = Array.isArray(msg && msg.vendors) ? msg.vendors : [];
  vendors.forEach(function (v) {
    VENDOR_NAMES[v.id] = v.displayName;
    if (v.icon) VENDOR_AVATARS[v.id] = v.icon;
  });
  store.set({
    vendorRegistry: vendors,
    capabilityReasons: (msg && msg.reasons) || {},
    installedVendors: idsWhere(vendors, "installed"),
    availableVendors: idsWhere(vendors, "available"),
  });
}

/** The registry entry for an agent id, or null. */
export function vendorEntry(vendorId) {
  var vendors = store.get('vendorRegistry') || [];
  for (var i = 0; i < vendors.length; i++) {
    if (vendors[i].id === vendorId) return vendors[i];
  }
  return null;
}

/** The most preferred registered agent (the server sends them in order). */
export function defaultVendorId() {
  var vendors = store.get('vendorRegistry') || [];
  return vendors.length ? vendors[0].id : "";
}

/**
 * What an agent can do. The registry carries every agent's capabilities, so a
 * session on an agent other than the project default is gated on its own
 * agent. The capabilities the active session reported are the fallback for
 * the moment before the registry arrives.
 */
export function capabilitiesFor(vendorId) {
  var entry = vendorEntry(vendorId);
  if (entry) return entry.capabilities;
  return store.get('vendorCapabilities') || {};
}

/** What the agent the user is on (chosen or bound) can do. */
export function currentCapabilities() {
  return capabilitiesFor(store.get('currentVendor') || defaultVendorId());
}

/**
 * Whether a control gated on one capability is usable, and when it is not, the
 * one line that says why.
 * @param {string} key  a capability of the YOKE ledger
 * @returns {{enabled: boolean, reason: string}}
 */
export function capabilityGate(key) {
  var caps = currentCapabilities();
  var value = caps[key];
  var enabled = Array.isArray(value) ? value.length > 0 : value === true;
  var reasons = store.get('capabilityReasons') || {};
  return { enabled: enabled, reason: enabled ? "" : (reasons[key] || "This agent does not support this.") };
}

function escapeAttr(text) {
  return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Attribute text for a button whose use depends on a capability: a plain title
 * when usable, otherwise disabled with the reason in the title.
 * @param {string} key    capability
 * @param {string} label  what the control does
 */
export function gatedButtonAttrs(key, label) {
  var gate = capabilityGate(key);
  if (gate.enabled) return 'title="' + escapeAttr(label) + '"';
  return 'title="' + escapeAttr(label + " (unavailable): " + gate.reason) + '" disabled aria-disabled="true"';
}

/** The command that signs in to an agent, from the registry ("" if unknown). */
export function loginCommandFor(vendorId) {
  var entry = vendorEntry(vendorId);
  return entry ? entry.loginCommand : "";
}

/**
 * The picker's rows, one per registered agent.
 * @returns {Array<{id: string, displayName: string, icon: string, installed: boolean, active: boolean, title: string}>}
 */
export function pickerRows(vendors, current) {
  return (vendors || []).map(function (v) {
    return {
      id: v.id,
      displayName: v.displayName,
      icon: v.icon || "",
      installed: !!v.installed,
      active: v.id === current,
      title: v.installed ? v.displayName : v.displayName + " is not installed. " + v.installHint,
    };
  });
}
