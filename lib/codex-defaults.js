var normalizeApprovalPolicy = require("./yoke/codex-protocol").normalizeApprovalPolicy;

// lr-f7a4 — sandbox defaults to "workspace-write" (matches the Codex CLI's own
// safe default). "danger-full-access" removes all filesystem guardrails and
// must be an explicit opt-in via the UI/session setting, never the default.
//
// The approval default is "on-request". "on-failure" is not a policy of its
// own in current Codex releases (it is an alias of "on-request"), so a saved
// "on-failure" is read as the value it means.
var CODEX_DEFAULTS = {
  approval: "on-request",
  sandbox: "workspace-write",
  webSearch: "live",
};

/**
 * The Codex approval policy, sandbox and web search a session runs with and its
 * clients are shown: the session's own value, else the saved default the
 * session manager carries (project default, else server default; see
 * lib/session-settings.js), else CODEX_DEFAULTS. There is no shared "current"
 * value, so one session's pick cannot reach another session's query.
 * @param {?object} session
 * @param {?object} sm - the session manager (or a double) carrying the saved defaults.
 * @returns {{approval: string, sandbox: string, webSearch: string}}
 */
function getCodexConfig(session, sm) {
  var s = session || {};
  var d = sm || {};
  var approval = s.codexApproval || d._savedDefaultCodexApproval;
  return {
    approval: approval ? normalizeApprovalPolicy(approval) : CODEX_DEFAULTS.approval,
    sandbox: s.codexSandbox || d._savedDefaultCodexSandbox || CODEX_DEFAULTS.sandbox,
    webSearch: s.codexWebSearch || d._savedDefaultCodexWebSearch || CODEX_DEFAULTS.webSearch,
  };
}

module.exports = {
  CODEX_DEFAULTS: CODEX_DEFAULTS,
  getCodexConfig: getCodexConfig,
};
