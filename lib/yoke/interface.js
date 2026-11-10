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
//
// 0.3.0 → 0.4.0  (2026-10, breaking for descriptors)
//   Moved: perProjectRuntime, activityTokens and attestsHumanSessions leave the
//   capability ledger and become descriptor traits (TRAITS). They describe how
//   the console drives an adapter, not what a session negotiates, so they are
//   never resolved, narrowed or overridden. A descriptor that still declares
//   one as a capability is refused with a named error.
//
// 0.4.0 → 0.5.0  (2026-10, additive plus one removal)
//   Added: QueryHandle.pushMessage takes an optional third argument, the
//   initiator of the turn (lib/turn-initiator.js INITIATORS), which an adapter
//   maps to its vendor's per-turn provenance field. An adapter that has none
//   ignores it.
//   Removed: the attestsHumanSessions trait. Provenance is per turn and carried
//   by the turn itself, not declared per adapter.
//
// 0.5.0 → 0.6.0  (2026-11, additive)
//   Added: QueryHandle.runUserShellCommand(command, cwd, timeoutMs,
//   maxOutputBytes, { signal }), an optional method for a shell command the
//   person typed for themselves. It resolves with { exitCode, durationMs,
//   output, truncated, timedOut, interrupted }, and the command ends up in the
//   agent's conversation without a model turn. Nothing else changes: an adapter
//   without the method is detectable (typeof handle.runUserShellCommand !==
//   "function") and is simply offered no such command, so no existing adapter or
//   caller has to change.
//   Migration for an adapter author: implement the method only if the agent can
//   record a user-run command without answering it. An adapter may refuse a cwd
//   it cannot honour; the refusal is a resolved result (exitCode null, output
//   naming the reason), never a throw, and the command is not run elsewhere.
//   Honour signal by stopping
//   the command, and report interrupted: true only once it has stopped. Cut the
//   output at maxOutputBytes on a character boundary, counting any failure text
//   you add. Never run the command as another user than the console process.
//   In an adapter that identifies a command's notifications by turn id, match
//   every one of them (start, items, end, late end) on that id.

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
 *   0.4.0 — adapter traits split out of the capability ledger
 *   0.5.0 — per-turn initiator on pushMessage; attestsHumanSessions removed
 *   0.6.0 — optional QueryHandle.runUserShellCommand
 */
var INTERFACE_VERSION = "0.6.0";

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
 * There is no title-generation method: an adapter never starts a query to
 * title a session. A session's title is the vendor CLI's own (see
 * lib/session-ai-title.js) or the first-line title.
 *
 * Additional session management (Claude SDK specific, may vary per adapter):
 *   .getSessionInfo(sessionId, opts): Promise<object|null>
 *   .listSessions(opts)             : Promise<Array>
 *   .renameSession(sessionId, title, opts): Promise
 *   .forkSession(sessionId, opts)   : Promise<object>
 *
 * QueryHandle shape:
 *   [Symbol.asyncIterator]()  - yields SDK events (raw in Phase 3, normalized later)
 *   .pushMessage(text, images, initiator, messageId) - initiator optional, per
 *                               turn; messageId optional: the id the console
 *                               recorded for the message, which an adapter
 *                               carries to its vendor where the vendor lets a
 *                               client name a message (the Claude adapter sets
 *                               the SDK message uuid) and otherwise reports back
 *                               on the turn_start event (turnId, messageId)
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
 *   .cancelQueuedMessage(messageId) - capability queuedMessageCancel (the caller
 *                              checks the capability, not the list above); withdraws
 *                              a message pushed with that messageId that the
 *                              agent has not yet taken into a turn. Resolves
 *                              true when it was withdrawn (it will never be
 *                              delivered) and false when it was already taken
 *                              or is unknown; rejects when the agent cannot say.
 *   .runUserShellCommand(command, cwd, timeoutMs, maxOutputBytes, { signal })
 *                            - runs a shell command the person typed for
 *                              themselves, kills it at timeoutMs, keeps at most
 *                              maxOutputBytes of its output (cut on a character
 *                              boundary; the result says when it cut) and puts it
 *                              in the conversation with no model turn. signal (an
 *                              AbortSignal) interrupts it. Resolves { exitCode,
 *                              durationMs, output, truncated, timedOut,
 *                              interrupted }; interrupted is true only once the
 *                              command has stopped. An adapter may refuse a cwd it
 *                              cannot honour: the refusal is a result whose output
 *                              names the reason, not a throw. The caller has already passed
 *                              whatever gate applies; the method never asks.
 *                              Absent where the agent cannot take it (the
 *                              OS-user worker handle): test for the method.
 */
var QUERY_HANDLE_OPTIONAL_METHODS = [
  "setPermissionMode",
  "rewindFiles",
  "runUserShellCommand",
];

/**
 * Adapter methods and properties the console uses beyond ADAPTER_METHODS.
 * Optional: the console feature behind each is gated by a capability.
 *   .getSessionInfo / .listSessions / .renameSession - capabilities
 *                                         sessionList, sessionRename
 *   .forkSession(sessionId, opts)       - capability fork
 *   .rollbackThread(threadId, n, opts)  - capability rollback
 *   .shutdown()                         - trait perProjectRuntime
 *   .shutdownIfIdle(idleMs)             - idle runtime reclaim
 *   .workerScriptPath                   - OS-user isolation worker (string)
 *   .interfaceVersion                   - the INTERFACE_VERSION it was built for
 * init() resolves with { models, defaultModel, skills, slashCommands,
 * capabilities }; the capabilities member is the live session's advertised
 * capabilities, which can only narrow the declaration (resolveCapabilities).
 */
var ADAPTER_OPTIONAL_METHODS = [
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
  queuedMessageCancel: { kind: "flag", reason: "This agent cannot withdraw a message that is waiting to be delivered." },
  executionPolicy:   { kind: "flag", reason: "This agent has no approval, sandbox or web search settings." },
  toolPolicy:        { kind: "list", reason: "This agent has no tool approval policy." },
  permissionModes:   { kind: "list", reason: "This agent has no permission modes." },
  additiveSettings:  { kind: "flag", reason: "This agent cannot take an extra settings file for a session." },
};

var CAPABILITY_KEYS = Object.keys(CAPABILITIES);

/**
 * Adapter traits: booleans on the vendor descriptor describing how the console
 * drives the adapter. Unlike a capability, a trait is a fact about the adapter
 * itself, read where no session exists yet (adapter creation) or where the
 * answer must not change with a connection (shutdown, activity bookkeeping).
 * A trait is never resolved, narrowed or overridden. An absent trait is false.
 *
 *   perProjectRuntime    - the adapter's runtime belongs to one project and is
 *                          created and shut down with it
 *   activityTokens       - the adapter's tool and thinking blocks are tracked as
 *                          activity tokens by the console
 */
var TRAITS = {
  perProjectRuntime: true,
  activityTokens: true,
};

var TRAIT_KEYS = Object.keys(TRAITS);

function isTraitKey(key) {
  return Object.prototype.hasOwnProperty.call(TRAITS, key);
}

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
      if (isTraitKey(key)) {
        throw new Error("[YOKE] " + where + " names '" + key + "' as a capability; it is an adapter trait set on the descriptor");
      }
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
  TRAIT_KEYS: TRAIT_KEYS,
  isTraitKey: isTraitKey,
  validateCapabilities: validateCapabilities,
  completeCapabilities: completeCapabilities,
  DIAGNOSTIC_SEVERITIES: DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES: DIAGNOSTIC_SOURCES,
  validateAdapter: validateAdapter,
  validateQueryHandle: validateQueryHandle,
  validateDiagnosticEvent: validateDiagnosticEvent,
};
