// session-input-ipc.js - the daemon IPC side of open-session and send-input:
// which fields of an IPC message reach lib/session-input.js. Kept out of
// daemon.js so the handler a CLI call reaches can be exercised without booting
// the daemon.

// Handles one IPC message with a session-input instance. Returns the result
// (or a Promise of it), or undefined when msg.cmd is not a session command.
function handleSessionCommand(sessionInput, msg) {
  if (msg.cmd === "open_session") {
    return sessionInput.openSession({
      projectSlug: msg.projectSlug,
      prompt: msg.prompt,
      contextNote: msg.contextNote,
      vendor: msg.vendor,
      agentName: msg.agentName,
      sessionVisibility: msg.sessionVisibility,
      initiator: msg.initiator,
    });
  }
  if (msg.cmd === "send_session_input") {
    return sessionInput.sendInput({
      projectSlug: msg.projectSlug,
      sessionId: msg.sessionId,
      prompt: msg.prompt,
      contextNote: msg.contextNote,
      initiator: msg.initiator,
    });
  }
  return undefined;
}

module.exports = { handleSessionCommand: handleSessionCommand };
