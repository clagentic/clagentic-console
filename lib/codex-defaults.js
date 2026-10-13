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

function getCodexConfig(sm) {
  return {
    approval: sm && sm.codexApproval ? normalizeApprovalPolicy(sm.codexApproval) : CODEX_DEFAULTS.approval,
    sandbox: (sm && sm.codexSandbox) || CODEX_DEFAULTS.sandbox,
    webSearch: (sm && sm.codexWebSearch) || CODEX_DEFAULTS.webSearch,
  };
}

module.exports = {
  CODEX_DEFAULTS: CODEX_DEFAULTS,
  getCodexConfig: getCodexConfig,
};
