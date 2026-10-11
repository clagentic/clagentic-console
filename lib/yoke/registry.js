// registry.js - the YOKE vendor registry. Each adapter module registers one
// descriptor; everything that needs to know which agents exist (adapter
// creation, install detection, the binary allowlist, the login command, the
// agent picker, default selection, capability gating) reads it from here, so
// adding an agent is registering one more descriptor and nothing else.

var iface = require("./interface");

var _vendors = new Map();

function UnknownVendorError(vendor) {
  var err = new Error("[YOKE] Unknown adapter vendor: " + String(vendor));
  err.code = "YOKE_UNKNOWN_VENDOR";
  err.vendor = vendor;
  return err;
}

function DisallowedBinaryError(name) {
  var err = new Error("[YOKE] Disallowed binary name: " + String(name));
  err.code = "YOKE_DISALLOWED_BINARY";
  err.binary = name;
  return err;
}

function requireString(descriptor, field) {
  if (typeof descriptor[field] !== "string" || !descriptor[field]) {
    throw new Error("[YOKE] Vendor descriptor '" + descriptor.id + "' needs a non-empty string '" + field + "'");
  }
}

function requireFunction(descriptor, field) {
  if (typeof descriptor[field] !== "function") {
    throw new Error("[YOKE] Vendor descriptor '" + descriptor.id + "' needs a function '" + field + "'");
  }
}

function requireBoolean(descriptor, field) {
  if (typeof descriptor[field] !== "boolean") {
    throw new Error("[YOKE] Vendor descriptor '" + descriptor.id + "' needs a boolean '" + field + "'");
  }
}

function requireStringList(descriptor, field) {
  var value = descriptor[field];
  if (!Array.isArray(value) || value.some(function (v) { return typeof v !== "string" || !v; })) {
    throw new Error("[YOKE] Vendor descriptor '" + descriptor.id + "' needs '" + field + "' as an array of non-empty strings");
  }
}

/**
 * A credential group is a set of variables that work together (an access key
 * id and its secret). Owning part of one would let the rest leak from the
 * daemon's environment, so every variable of every declared group must be in
 * ownedEnvNames.
 * @returns {Array<{id: string, envNames: string[]}>} a copy of the groups
 */
function validateCredentialGroups(descriptor) {
  var groups = descriptor.credentialGroups === undefined ? [] : descriptor.credentialGroups;
  if (!Array.isArray(groups)) {
    throw new Error("[YOKE] Vendor descriptor '" + descriptor.id + "' needs 'credentialGroups' as an array");
  }
  return groups.map(function (group) {
    if (!group || typeof group.id !== "string" || !group.id) {
      throw new Error("[YOKE] Vendor descriptor '" + descriptor.id + "' has a credential group without an id");
    }
    requireStringList({ id: descriptor.id, envNames: group.envNames }, "envNames");
    group.envNames.forEach(function (name) {
      if (descriptor.ownedEnvNames.indexOf(name) === -1) {
        throw new Error("[YOKE] Vendor descriptor '" + descriptor.id + "' declares credential group '" + group.id
          + "' but does not own " + name + "; a credential set is owned whole");
      }
    });
    return { id: group.id, envNames: group.envNames.slice() };
  });
}

/**
 * Registers a vendor.
 *
 * Descriptor:
 *   id               string    the vendor id sessions are bound to ("claude")
 *   displayName      string    name shown to the user ("Claude Code")
 *   icon             string    optional URL path of the avatar image
 *   priority         number    lower is preferred when choosing a default
 *   binaryNames      string[]  executables the install probe may look up; the
 *                              allowlist for lookups is the union over vendors
 *   probeInstalled   function(ctx) -> boolean, ctx.lookupBinary(name) -> boolean
 *   checkAuth        function() -> boolean
 *   installHint      string    one line telling the user how to install it
 *   loginCommand     string    the one place the login command is written
 *   osUsersSupported boolean   can run under per-user OS isolation
 *   needsRuntimeEnv  boolean   every entry point requires runtimeEnv
 *   ownedEnvNames    string[]  environment variables this agent reads for its
 *                              own endpoint and credentials
 *   credentialGroups optional {id, envNames[]}[]  variables that work as one
 *                              credential set; each must be wholly in ownedEnvNames
 *   nativeInstructionFiles string[]  project instruction files the agent reads
 *                              itself, so the console does not inject them again
 *   interruptMessage string    shown when the user stops a turn
 *   capabilities     object    the declared capabilities (interface.js ledger)
 *   createAdapter    function(opts) -> adapter
 *
 * @param {object} descriptor
 * @returns {object} the registered (frozen) descriptor, capabilities completed
 */
function register(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new Error("[YOKE] A vendor descriptor must be an object");
  }
  requireString(descriptor, "id");
  requireString(descriptor, "displayName");
  requireString(descriptor, "installHint");
  requireString(descriptor, "loginCommand");
  requireString(descriptor, "interruptMessage");
  requireStringList(descriptor, "binaryNames");
  requireStringList(descriptor, "ownedEnvNames");
  requireStringList(descriptor, "nativeInstructionFiles");
  requireFunction(descriptor, "probeInstalled");
  requireFunction(descriptor, "checkAuth");
  requireFunction(descriptor, "createAdapter");
  requireBoolean(descriptor, "osUsersSupported");
  requireBoolean(descriptor, "needsRuntimeEnv");
  if (typeof descriptor.priority !== "number") {
    throw new Error("[YOKE] Vendor descriptor '" + descriptor.id + "' needs a numeric 'priority'");
  }
  if (_vendors.has(descriptor.id)) {
    throw new Error("[YOKE] Vendor already registered: " + descriptor.id);
  }
  var credentialGroups = validateCredentialGroups(descriptor);
  iface.validateCapabilities(descriptor.capabilities, "vendor '" + descriptor.id + "'");

  var entry = Object.assign({}, descriptor, {
    credentialGroups: credentialGroups,
    icon: descriptor.icon || "",
    binaryNames: descriptor.binaryNames.slice(),
    ownedEnvNames: descriptor.ownedEnvNames.slice(),
    nativeInstructionFiles: descriptor.nativeInstructionFiles.slice(),
    capabilities: iface.completeCapabilities(descriptor.capabilities),
  });
  _vendors.set(entry.id, entry);
  return entry;
}

/** Removes a vendor. Returns whether it was registered. */
function unregister(id) {
  return _vendors.delete(id);
}

function isKnown(id) {
  return typeof id === "string" && _vendors.has(id);
}

/** The descriptor for an id, or throws the named unknown-vendor error. */
function getVendor(id) {
  if (!isKnown(id)) throw UnknownVendorError(id);
  return _vendors.get(id);
}

/** All descriptors, preferred first. */
function list() {
  return Array.from(_vendors.values()).sort(function (a, b) {
    return a.priority - b.priority || (a.id < b.id ? -1 : 1);
  });
}

function ids() {
  return list().map(function (d) { return d.id; });
}

/** The declared capabilities of a registered vendor (a copy). */
function declaredCapabilities(id) {
  return iface.completeCapabilities(getVendor(id).capabilities);
}

/**
 * Declared capabilities for a vendor name read from a session or a client. A
 * name that is not registered declares nothing: every flag off, every list
 * empty, so a control gated on it stays disabled instead of throwing.
 */
function declaredCapabilitiesOrNone(id) {
  return iface.completeCapabilities(isKnown(id) ? getVendor(id).capabilities : {});
}

function loginCommandFor(id) {
  return getVendor(id).loginCommand;
}

function displayNameFor(id) {
  return getVendor(id).displayName;
}

/** Executable names the install probe may look up. */
function binaryNames() {
  var names = [];
  list().forEach(function (d) {
    d.binaryNames.forEach(function (n) { if (names.indexOf(n) === -1) names.push(n); });
  });
  return names;
}

/** Throws the named error unless the name belongs to a registered vendor. */
function assertAllowedBinary(name) {
  if (binaryNames().indexOf(name) === -1) throw DisallowedBinaryError(name);
}

/**
 * The vendor a project starts on: the most preferred of the available ones,
 * or the most preferred registered vendor when none is available.
 * @param {string[]} availableIds
 */
function defaultVendorId(availableIds) {
  var all = ids();
  var avail = Array.isArray(availableIds) ? availableIds : [];
  for (var i = 0; i < all.length; i++) {
    if (avail.indexOf(all[i]) !== -1) return all[i];
  }
  return all[0] || null;
}

/**
 * The registry as the browser needs it: serializable, no functions.
 * @param {{installed: string[], available: string[], capabilities: ?object, probeFailures: ?object}} state
 *   probeFailures maps a vendor id to the class of an install lookup that
 *   failed, so the picker says it could not check instead of "not installed".
 *   capabilities, when given, maps a vendor id to what a live session has
 *   resolved for it; a vendor without an entry shows its declaration.
 */
function describeForClient(state) {
  var installed = (state && state.installed) || [];
  var available = (state && state.available) || [];
  var resolved = (state && state.capabilities) || {};
  var failures = (state && state.probeFailures) || {};
  return list().map(function (d) {
    var live = Object.prototype.hasOwnProperty.call(resolved, d.id) ? resolved[d.id] : d.capabilities;
    return {
      id: d.id,
      displayName: d.displayName,
      icon: d.icon,
      installHint: d.installHint,
      loginCommand: d.loginCommand,
      osUsersSupported: d.osUsersSupported,
      installed: installed.indexOf(d.id) !== -1,
      probeFailure: Object.prototype.hasOwnProperty.call(failures, d.id) ? failures[d.id] : null,
      available: available.indexOf(d.id) !== -1,
      capabilities: iface.completeCapabilities(live),
    };
  });
}

/** key -> the one line shown beside a control the agent cannot support. */
function capabilityReasons() {
  var out = {};
  iface.CAPABILITY_KEYS.forEach(function (key) { out[key] = iface.CAPABILITIES[key].reason; });
  return out;
}

module.exports = {
  register: register,
  unregister: unregister,
  isKnown: isKnown,
  get: getVendor,
  list: list,
  ids: ids,
  declaredCapabilities: declaredCapabilities,
  declaredCapabilitiesOrNone: declaredCapabilitiesOrNone,
  loginCommandFor: loginCommandFor,
  displayNameFor: displayNameFor,
  binaryNames: binaryNames,
  assertAllowedBinary: assertAllowedBinary,
  defaultVendorId: defaultVendorId,
  describeForClient: describeForClient,
  capabilityReasons: capabilityReasons,
};
