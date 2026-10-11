// YOKE Interface Definition
// -------------------------
// This file defines the contract that every adapter must implement.
// It does NOT contain runtime logic; it is the authoritative reference
// for Phase 3 and beyond.
//
// Adapter objects must satisfy two shapes:
//   1. Adapter (returned by createAdapter)
//   2. QueryHandle (returned by adapter.createQuery)
//
// Migration log
// -------------
// 0.1.0 → 0.2.0  (lr-8c43, 2026-06-30, additive/backward-compatible)
//   Added: 'diagnostic' event type (DIAGNOSTIC_SEVERITIES, DIAGNOSTIC_SOURCES,
//   validateDiagnosticEvent). Existing consumers are unaffected — no existing
//   shape was narrowed or removed.
//
// 0.2.0 → 0.3.0  (2026-10, additive plus one tightening)
//   Added: the capability ledger (CAPABILITIES, resolveCapabilities), the
//   vendor registry that carries each adapter's declaration (registry.js), and
//   the optional adapter / query-handle surface the console already consumed
//   off-contract (ADAPTER_OPTIONAL_METHODS, QUERY_HANDLE_OPTIONAL_METHODS).
//   Removed from the contract: nothing.
//   Tightened: endInput joins QUERY_HANDLE_METHODS, since the console ends the
//   input of every query it finishes and both shipped adapters implement it.

/**
 * YOKE contract version. Bumped on every additive or breaking change.
 * Adapters MAY expose this via an `interfaceVersion` property; consumers
 * SHOULD treat unknown versions as forward-compatible if they only use
 * previously documented shapes.
 *
 * History:
 *   0.1.0 — initial contract (Adapter + QueryHandle shapes)
 *   0.2.0 — added 'diagnostic' event type (lr-8c43)
 *   0.3.0 — capability ledger, vendor registry, reconciled method lists
 */
var INTERFACE_VERSION = "0.3.0";

var TOOL_POLICIES = ["ask", "allow-all"];

/**
 * Validate that an adapter object implements all required methods.
 * Throws if any are missing. Development-time safety net only.
 *
 * Adapter shape:
 *   .vendor           : string          - e.g. "claude", "opencode", "codex"
 *   .init(opts)       : Promise<InitResult>
 *   .supportedModels(opts): Promise<string[]> - opts.runtimeEnv (the Settings
 *     overlay, or null for none) is required by an adapter that keeps a server
 *     per environment (Codex); the list is that server's own
 *   .createToolServer(def): ToolServer (opaque)
 *   .createQuery(opts): QueryHandle
 *
 * Lightweight utilities:
 *   .generateTitle(messages, opts) : Promise<string> - generate a short session title
 *     messages: string[] - user messages to derive the title from
 *     opts: { cwd }
 *     Returns a short (3-8 word) title string.
 *
 * Additional session management (Claude SDK specific, may vary per adapter):
 *   .getSessionInfo(sessionId, opts): Promise<object|null>
 *   .listSessions(opts)             : Promise<Array>
 *   .renameSession(sessionId, title, opts): Promise
 *   .forkSession(sessionId, opts)   : Promise<object>
 *
 * QueryHandle shape:
 *   [Symbol.asyncIterator]()  - yields SDK events (raw in Phase 3, normalized later)
 *   .pushMessage(text, images)
 *   .setModel(model)
 *   .setEffort(effort)        - Promise; settles once the running query has
 *                               taken the change and rejects (with a message
 *                               fit to show the operator) when it did not. The
 *                               Claude SDK's Query has no setEffort: the Claude
 *                               adapter applies it through applyFlagSettings
 *                               ({effortLevel}); Codex reads it on the next turn.
 *   .setToolPolicy(policy)    - "ask" | "allow-all"
 *   .stopTask(taskId)
 *   .getContextUsage()        - Promise<object|null>
 *   .abort()
 *   .close()
 *   .endInput()               - no more messages will be pushed to this query
 *
 * Each adapter also registers a vendor descriptor with registry.js (from a
 * small adapters/<name>-vendor.js module, so listing the agents does not load
 * the adapter): its id, display metadata, install probe, login command, environment needs
 * and its declared capabilities (CAPABILITIES below). The adapter factory is
 * part of that descriptor; nothing else in the console names a vendor.
 */

var ADAPTER_METHODS = [
  "init",
  "supportedModels",
  "createToolServer",
  "createQuery",
];

var QUERY_HANDLE_METHODS = [
  "pushMessage",
  "setModel",
  "setEffort",
  "setToolPolicy",
  "stopTask",
  "getContextUsage",
  "abort",
  "close",
  "endInput",
];

/**
 * Methods the console calls on a query handle only when the adapter's
 * declared capabilities say it can use them. A caller checks the capability
 * (or the method) first; absence is not an error.
 *   .setPermissionMode(mode) - capability permissionModes
 *   .rewindFiles(uuid, opts) - capability rewind
 */
var QUERY_HANDLE_OPTIONAL_METHODS = [
  "setPermissionMode",
  "rewindFiles",
];

/**
 * Adapter methods and properties the console uses beyond ADAPTER_METHODS.
 * Optional: the console feature behind each is gated by a capability.
 *   .generateTitle(messages, opts)      - session titles
 *   .getSessionInfo / .listSessions / .renameSession - capabilities
 *                                         sessionList, sessionRename
 *   .forkSession(sessionId, opts)       - capability fork
 *   .rollbackThread(threadId, n, opts)  - capability rollback
 *   .shutdown()                         - capability perProjectRuntime
 *   .shutdownIfIdle(idleMs)             - idle runtime reclaim
 *   .workerScriptPath                   - OS-user isolation worker (string)
 *   .interfaceVersion                   - the INTERFACE_VERSION it was built for
 * init() resolves with { models, defaultModel, skills, slashCommands,
 * capabilities }; the capabilities member is the live session's advertised
 * capabilities, which can only narrow the declaration (resolveCapabilities).
 */
var ADAPTER_OPTIONAL_METHODS = [
  "generateTitle",
  "getSessionInfo",
  "listSessions",
  "renameSession",
  "forkSession",
  "rollbackThread",
  "shutdown",
  "shutdownIfIdle",
];

/**
 * The capability ledger: the one list of what an agent can do, and so the one
 * list the UI gates on. A control is shown, disabled or hidden from these keys,
 * never from a vendor name. Every key is declared by every adapter (an absent
 * flag is false, an absent list is empty).
 *
 *   kind "flag" - boolean
 *   kind "list" - array of strings; narrowing intersects, overriding replaces
 *   reason      - the one line shown beside a control that is disabled
 *                 because the agent lacks the capability
 */
var CAPABILITIES = {
  thinking:          { kind: "flag", reason: "This agent has no extended thinking control." },
  betas:             { kind: "flag", reason: "This agent has no beta feature switches." },
  effort:            { kind: "flag", reason: "This agent does not take a reasoning effort setting." },
  rewind:            { kind: "flag", reason: "This agent cannot rewind file changes to an earlier message." },
  fork:              { kind: "flag", reason: "This agent cannot fork a conversation at a message." },
  rollback:          { kind: "flag", reason: "This agent cannot roll a conversation back." },
  sessionResume:     { kind: "flag", reason: "This agent cannot resume a previous session." },
  sessionList:       { kind: "flag", reason: "This agent cannot list its own sessions." },
  sessionRename:     { kind: "flag", reason: "This agent cannot rename its own sessions." },
  sessionArchive:    { kind: "flag", reason: "This agent cannot archive its own sessions." },
  promptSuggestions: { kind: "flag", reason: "This agent does not suggest follow-up prompts." },
  elicitation:       { kind: "flag", reason: "This agent cannot ask for structured input mid-turn." },
  fileCheckpointing: { kind: "flag", reason: "This agent does not checkpoint file changes." },
  contextCompacting: { kind: "flag", reason: "This agent cannot compact its context." },
  mcpPanel:          { kind: "flag", reason: "This agent does not use the MCP servers managed here." },
  backgroundTasks:   { kind: "flag", reason: "This agent has no background tasks." },
  steering:          { kind: "flag", reason: "This agent cannot take a message while it is working." },
  agentInjection:    { kind: "flag", reason: "This agent cannot take on a named agent identity." },
  executionPolicy:   { kind: "flag", reason: "This agent has no approval, sandbox or web search settings." },
  perProjectRuntime: { kind: "flag", reason: "This agent shares one runtime across projects." },
  activityTokens:    { kind: "flag", reason: "This agent reports activity through the shared turn state." },
  attestsHumanSessions: { kind: "flag", reason: "This agent's sessions are attested elsewhere." },
  toolPolicy:        { kind: "list", reason: "This agent has no tool approval policy." },
  permissionModes:   { kind: "list", reason: "This agent has no permission modes." },
};

var CAPABILITY_KEYS = Object.keys(CAPABILITIES);

function isCapabilityKey(key) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, key);
}

/**
 * Checks a capability object (a declaration, an override or an advertisement)
 * and throws a named error for a key outside the ledger or a value of the
 * wrong kind. Keys it does not carry are simply absent.
 *
 * @param {object} caps
 * @param {string} where  what is being checked, for the message
 * @param {{ignoreUnknown: boolean}} [options]  skip keys outside the ledger
 *   (a live session may advertise more than the ledger names)
 */
function validateCapabilities(caps, where, options) {
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    throw new Error("[YOKE] " + where + " capabilities must be an object");
  }
  var ignoreUnknown = !!(options && options.ignoreUnknown);
  Object.keys(caps).forEach(function (key) {
    if (!isCapabilityKey(key)) {
      if (ignoreUnknown) return;
      throw new Error("[YOKE] " + where + " names an unknown capability: " + key);
    }
    var kind = CAPABILITIES[key].kind;
    var value = caps[key];
    if (kind === "flag" && typeof value !== "boolean") {
      throw new Error("[YOKE] " + where + " capability '" + key + "' must be a boolean");
    }
    if (kind === "list" && (!Array.isArray(value) || value.some(function (v) { return typeof v !== "string"; }))) {
      throw new Error("[YOKE] " + where + " capability '" + key + "' must be an array of strings");
    }
  });
}

/**
 * A declaration with every ledger key present: absent flags are false, absent
 * lists are empty. The result is a copy.
 */
function completeCapabilities(caps) {
  var out = {};
  CAPABILITY_KEYS.forEach(function (key) {
    var has = caps && Object.prototype.hasOwnProperty.call(caps, key);
    if (CAPABILITIES[key].kind === "list") out[key] = has ? caps[key].slice() : [];
    else out[key] = has ? !!caps[key] : false;
  });
  return out;
}

/**
 * 'diagnostic' event type — vendor-agnostic signal for CLI-surfaced warnings,
 * validation failures, deprecations, and load errors that adapters capture
 * and route to the Console UI.
 *
 * Shape:
 *   {
 *     type      : "diagnostic"           - discriminant
 *     severity  : "info"|"warning"|"error"
 *     source    : string                 - e.g. "settings", "mcp", "cli", "hook"
 *     message   : string                 - human-readable description
 *     actionable: {                      - OPTIONAL
 *       label : string                   - short button/link label
 *       action: string                   - opaque action key for the UI
 *     }
 *   }
 *
 * Constraints:
 *   - severity, source, and message are REQUIRED.
 *   - actionable is OPTIONAL; if present, both label and action are required.
 *   - source is a free-form string; the DIAGNOSTIC_SOURCES list documents
 *     well-known values but adapters MAY emit other source strings.
 *   - This event is yield-able from a QueryHandle's asyncIterator. Consumers
 *     that do not recognize "diagnostic" must ignore it gracefully.
 */

/** Allowed severity levels for a diagnostic event. */
var DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"];

/**
 * Well-known source identifiers for diagnostic events.
 * Adapters SHOULD use these where applicable; other source strings are allowed.
 */
var DIAGNOSTIC_SOURCES = ["settings", "mcp", "cli", "hook"];

/**
 * Validate a diagnostic event object against the contract.
 * Throws a descriptive Error if any required field is missing or has an
 * invalid type/value.
 *
 * @param {object} event - The object to validate.
 */
function validateDiagnosticEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("[YOKE] diagnostic event must be a non-null object");
  }
  if (event.type !== "diagnostic") {
    throw new Error("[YOKE] diagnostic event must have type === 'diagnostic', got: " + event.type);
  }
  if (DIAGNOSTIC_SEVERITIES.indexOf(event.severity) === -1) {
    throw new Error(
      "[YOKE] diagnostic event severity must be one of [" +
        DIAGNOSTIC_SEVERITIES.join(", ") +
        "], got: " + event.severity
    );
  }
  if (typeof event.source !== "string" || !event.source) {
    throw new Error("[YOKE] diagnostic event source must be a non-empty string");
  }
  if (typeof event.message !== "string" || !event.message) {
    throw new Error("[YOKE] diagnostic event message must be a non-empty string");
  }
  if (event.actionable !== undefined) {
    var a = event.actionable;
    if (!a || typeof a !== "object") {
      throw new Error("[YOKE] diagnostic event actionable must be an object when present");
    }
    if (typeof a.label !== "string" || !a.label) {
      throw new Error("[YOKE] diagnostic event actionable.label must be a non-empty string");
    }
    if (typeof a.action !== "string" || !a.action) {
      throw new Error("[YOKE] diagnostic event actionable.action must be a non-empty string");
    }
  }
}

function validateAdapter(adapter) {
  if (!adapter) throw new Error("[YOKE] Adapter is null or undefined");
  if (typeof adapter.vendor !== "string" || !adapter.vendor) {
    throw new Error("[YOKE] Adapter must have a non-empty 'vendor' string property");
  }
  for (var i = 0; i < ADAPTER_METHODS.length; i++) {
    var m = ADAPTER_METHODS[i];
    if (typeof adapter[m] !== "function") {
      throw new Error("[YOKE] Adapter '" + adapter.vendor + "' missing required method: " + m);
    }
  }
}

function validateQueryHandle(handle) {
  if (!handle) throw new Error("[YOKE] QueryHandle is null or undefined");
  if (typeof handle[Symbol.asyncIterator] !== "function") {
    throw new Error("[YOKE] QueryHandle must implement Symbol.asyncIterator");
  }
  for (var i = 0; i < QUERY_HANDLE_METHODS.length; i++) {
    var m = QUERY_HANDLE_METHODS[i];
    if (typeof handle[m] !== "function") {
      throw new Error("[YOKE] QueryHandle missing required method: " + m);
    }
  }
}

module.exports = {
  INTERFACE_VERSION: INTERFACE_VERSION,
  TOOL_POLICIES: TOOL_POLICIES,
  ADAPTER_METHODS: ADAPTER_METHODS,
  QUERY_HANDLE_METHODS: QUERY_HANDLE_METHODS,
  QUERY_HANDLE_OPTIONAL_METHODS: QUERY_HANDLE_OPTIONAL_METHODS,
  ADAPTER_OPTIONAL_METHODS: ADAPTER_OPTIONAL_METHODS,
  CAPABILITIES: CAPABILITIES,
  CAPABILITY_KEYS: CAPABILITY_KEYS,
  isCapabilityKey: isCapabilityKey,
  validateCapabilities: validateCapabilities,
  completeCapabilities: completeCapabilities,
  DIAGNOSTIC_SEVERITIES: DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES: DIAGNOSTIC_SOURCES,
  validateAdapter: validateAdapter,
  validateQueryHandle: validateQueryHandle,
  validateDiagnosticEvent: validateDiagnosticEvent,
};
