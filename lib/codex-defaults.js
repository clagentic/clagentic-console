// lr-f7a4 — sandbox defaults to "workspace-write" (matches the Codex CLI's own
// safe default). "danger-full-access" removes all filesystem guardrails and
// must be an explicit opt-in via the UI/session setting, never the default.
var CODEX_DEFAULTS = {
  approval: "on-failure",
  sandbox: "workspace-write",
  webSearch: "live",
};

function getCodexConfig(sm) {
  return {
    approval: (sm && sm.codexApproval) || CODEX_DEFAULTS.approval,
    sandbox: (sm && sm.codexSandbox) || CODEX_DEFAULTS.sandbox,
    webSearch: (sm && sm.codexWebSearch) || CODEX_DEFAULTS.webSearch,
  };
}

module.exports = {
  CODEX_DEFAULTS: CODEX_DEFAULTS,
  getCodexConfig: getCodexConfig,
};
