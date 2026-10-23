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
      to: msg.to,
      prompt: msg.prompt,
      contextNote: msg.contextNote,
      from: msg.from,
      fromSession: msg.fromSession,
      senderProject: msg.senderProject,
      senderSessionId: msg.senderSessionId,
      vendor: msg.vendor,
      agentName: msg.agentName,
      sessionName: msg.sessionName,
      sessionVisibility: msg.sessionVisibility,
      permissionMode: msg.permissionMode,
      initiator: msg.initiator,
    });
  }
  if (msg.cmd === "send_session_input") {
    return sessionInput.sendInput({
      projectSlug: msg.projectSlug,
      sessionId: msg.sessionId,
      to: msg.to,
      reply: msg.reply,
      prompt: msg.prompt,
      contextNote: msg.contextNote,
      from: msg.from,
      fromSession: msg.fromSession,
      senderProject: msg.senderProject,
      senderSessionId: msg.senderSessionId,
      initiator: msg.initiator,
    });
  }
  if (msg.cmd === "list_sessions") {
    return sessionInput.listSessions({
      projectSlug: msg.projectSlug,
      agentName: msg.agentName,
      vendor: msg.vendor,
      state: msg.state,
    });
  }
  return undefined;
}

module.exports = { handleSessionCommand: handleSessionCommand };
