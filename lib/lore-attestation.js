// lr-f7c100 — declare human presence to LORE for a Codex session the
// operator is driving through the console.
//
// THE PRINCIPLE (operator, lore lr-df5939): a session mints iff a human is
// in it — nothing else, no launcher special-casing. The Console is the
// component that KNOWS a human is present (a person is typing into it), so
// the Console is the correct declarer.
//
// Claude (SDK) console sessions are already covered by LORE's own pulse
// hook (lore PR #1897) — Claude Code's Stop-hook lifecycle fires for an
// SDK-driven query exactly as it does for the `claude` CLI, so no console
// code is needed on that path. Codex sessions have no equivalent hook
// (Codex is a separate app-server protocol the console drives directly),
// so the console itself must call the declarer for Codex.
//
// FAIL-OPEN is load-bearing: a host without LORE installed, or any failure
// of the `lore` CLI, must never affect session create. This call is fired
// and forgotten — its result is never awaited by session-create/message
// dispatch, and any error is swallowed after a best-effort log line.
var { execFile } = require("child_process");

// Bounded so a hung/missing `lore` binary can never accumulate indefinitely
// under load — this is advisory telemetry, not something callers wait on.
var ATTEST_TIMEOUT_MS = 5000;

/**
 * Declare that a human is driving the given vendor session id, via LORE's
 * platform-agnostic attestation verb (`lore session attest-human <sid>`).
 *
 * Never throws, never returns a promise the caller needs to await for
 * correctness — session create/message dispatch must proceed identically
 * whether this succeeds, fails, or LORE is entirely absent from the host.
 *
 * @param {string} sessionId - the vendor's own session id (e.g. the Codex
 *   rollout/thread id) that LORE keys attestation on for that platform.
 */
function attestHumanSession(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return;
  try {
    execFile("lore", ["session", "attest-human", sessionId], { timeout: ATTEST_TIMEOUT_MS }, function (err) {
      if (err) {
        // ENOENT (lore not installed) is the expected fail-open case on a
        // host without LORE — log at a lower severity than an actual CLI
        // failure so normal operation isn't noisy on hosts that never run it.
        if (err.code === "ENOENT") {
          console.log("[lore-attestation] lore CLI not found — skipping human-presence attestation (fail-open)");
        } else {
          console.error("[lore-attestation] attest-human failed for session " + sessionId + ":", err.message);
        }
      }
    });
  } catch (e) {
    // Defensive: execFile itself should not throw synchronously, but this is
    // a fail-open surface — no error here may ever propagate to the caller.
    console.error("[lore-attestation] Unexpected error invoking lore CLI:", e.message);
  }
}

module.exports = { attestHumanSession: attestHumanSession };
