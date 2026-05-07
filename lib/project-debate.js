/**
 * Debate engine stub — debate was a Clay Mates feature.
 * Mates have been removed (lr-316f). This file is a no-op stub
 * that satisfies the project.js interface so the debate MCP
 * server registration code does not need further changes.
 */
function attachDebate() {
  function noop() {}
  function noopFalse() { return false; }

  return {
    handleDebateStart: noop,
    handleDebateHandRaise: noop,
    handleDebateComment: noop,
    handleDebateStop: noop,
    handleDebateConcludeResponse: noop,
    handleDebateConfirmBrief: noop,
    handleDebateUserFloorResponse: noop,
    restoreDebateState: noop,
    checkForDmDebateBrief: noopFalse,
    handleMcpDebateApproval: noop,
  };
}

module.exports = { attachDebate: attachDebate };
