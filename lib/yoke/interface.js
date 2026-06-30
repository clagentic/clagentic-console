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

/**
 * YOKE contract version. Bumped on every additive or breaking change.
 * Adapters MAY expose this via an `interfaceVersion` property; consumers
 * SHOULD treat unknown versions as forward-compatible if they only use
 * previously documented shapes.
 *
 * History:
 *   0.1.0 — initial contract (Adapter + QueryHandle shapes)
 *   0.2.0 — added 'diagnostic' event type (lr-8c43)
 */
var INTERFACE_VERSION = "0.2.0";

var TOOL_POLICIES = ["ask", "allow-all"];

/**
 * Validate that an adapter object implements all required methods.
 * Throws if any are missing. Development-time safety net only.
 *
 * Adapter shape:
 *   .vendor           : string          - e.g. "claude", "opencode", "codex"
 *   .init(opts)       : Promise<InitResult>
 *   .supportedModels(): Promise<string[]>
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
 *   .setEffort(effort)
 *   .setToolPolicy(policy)    - "ask" | "allow-all"
 *   .stopTask(taskId)
 *   .getContextUsage()        - Promise<object|null>
 *   .abort()
 *   .close()
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
];

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
  DIAGNOSTIC_SEVERITIES: DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES: DIAGNOSTIC_SOURCES,
  validateAdapter: validateAdapter,
  validateQueryHandle: validateQueryHandle,
  validateDiagnosticEvent: validateDiagnosticEvent,
};
