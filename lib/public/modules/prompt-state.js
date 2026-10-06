// prompt-state.js - client copy of the server's operator-prompt state.
//
// The server owns every prompt's lifecycle (lib/prompt-registry.js); this
// store only mirrors what the server has said about each requestId, from
// whichever message said it first: a live event, a replayed request stamped
// with promptState, or the pending snapshot sent on connect. Terminal states
// are final on the server, so they are final here too - a later "pending"
// can never reopen a settled prompt, which is what makes card rendering
// independent of message order (paged history delivers outcomes before the
// requests they close).
//
// Deliberately free of imports so it can be exercised without the rest of the
// frontend module graph.

/**
 * @typedef {{state: "pending"|"resolved"|"cancelled", decision?: ?string,
 *   answers?: ?object, skipped?: boolean, action?: ?string,
 *   reason?: ?string}} PromptState
 */

var OUTCOME_FIELDS = ["decision", "answers", "skipped", "action"];

export function isTerminal(st) {
  return !!st && (st.state === "resolved" || st.state === "cancelled");
}

function normalizeState(next) {
  var out = { state: next.state, reason: next.reason || null };
  OUTCOME_FIELDS.forEach(function (k) { out[k] = next[k] === undefined ? null : next[k]; });
  return out;
}

export function createPromptStates() {
  var states = Object.create(null);

  return {
    /**
     * Merge what the server said about requestId; returns the effective state.
     * @param {string} requestId
     * @param {PromptState} next
     * @returns {?PromptState}
     */
    apply: function (requestId, next) {
      var cur = states[requestId];
      if (!next || isTerminal(cur)) return cur || null;
      if (isTerminal(next) || !cur) states[requestId] = normalizeState(next);
      return states[requestId];
    },

    /** @returns {?PromptState} */
    get: function (requestId) {
      return states[requestId] || null;
    },

    clear: function () {
      states = Object.create(null);
    },
  };
}

function pick(msg, keys) {
  var out = {};
  keys.forEach(function (k) { if (msg[k] !== undefined) out[k] = msg[k]; });
  return out;
}

function toolApprovalKind(toolName) {
  return toolName === "ExitPlanMode" ? "plan" : "permission";
}

/**
 * One prompt event in the single client shape, or null for a message that
 * is not about a prompt. Accepts the prompt_* messages and the per-kind
 * messages recorded in history before prompts had one shape (and the
 * AskUserQuestion tool call, which draws that prompt's card).
 *
 * @returns {?{phase: "request"|"pending"|"resolved"|"cancel", requestId: string,
 *   kind: ?string, fields: object, serverState: ?PromptState}}
 */
export function normalizePromptMessage(msg) {
  if (!msg || typeof msg.type !== "string") return null;
  switch (msg.type) {
    case "prompt_request":
    case "prompt_pending":
      return {
        phase: msg.type === "prompt_pending" ? "pending" : "request",
        requestId: msg.requestId,
        kind: msg.kind,
        fields: msg,
        serverState: msg.promptState || null,
      };
    case "permission_request":
    case "permission_request_pending":
      return {
        phase: msg.type === "permission_request_pending" ? "pending" : "request",
        requestId: msg.requestId,
        kind: toolApprovalKind(msg.toolName),
        fields: msg,
        serverState: msg.promptState || msg.permissionState || null,
      };
    case "elicitation_request":
      return { phase: "request", requestId: msg.requestId, kind: "elicitation", fields: msg, serverState: msg.promptState || null };
    case "tool_executing":
      if (msg.name !== "AskUserQuestion" || !msg.input || !msg.input.questions) return null;
      return {
        phase: "request",
        requestId: msg.id,
        kind: "ask_user",
        fields: { input: msg.input, toolUseId: msg.id },
        serverState: msg.promptState || null,
      };
    case "prompt_resolved":
    case "permission_resolved":
    case "elicitation_resolved":
      return {
        phase: "resolved",
        requestId: msg.requestId,
        kind: msg.kind || null,
        fields: pick(msg, OUTCOME_FIELDS),
        serverState: null,
      };
    case "ask_user_answered":
      if (msg.answers && Object.keys(msg.answers).length) {
        return { phase: "resolved", requestId: msg.toolId, kind: "ask_user", fields: { answers: msg.answers }, serverState: null };
      }
      return { phase: "cancel", requestId: msg.toolId, kind: "ask_user", fields: { reason: null }, serverState: null };
    case "prompt_cancel":
    case "permission_cancel":
      return { phase: "cancel", requestId: msg.requestId, kind: msg.kind || null, fields: { reason: msg.reason || null }, serverState: null };
    default:
      return null;
  }
}
