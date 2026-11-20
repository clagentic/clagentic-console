// automation-ledger.js - writes the outbound-ledger entry (lib/outbound-ledger.js)
// for a turn the console composed itself: a delivered scheduled firing and each
// loop turn. The one place both callers build the target and the entry, so a
// scheduled firing and a loop turn cannot describe the same session differently.
//
// Writing never fails the turn it describes: the turn is already started, so a
// ledger that cannot be written, or an entry that cannot be built, is logged and
// the turn goes on.

var outboundEntry = require("./outbound-entry");

function messageOf(err) {
  return err && err.message ? err.message : String(err);
}

// The target fields of the session that took the turn, as the ledger records
// them. project is { sm, getLinuxUserForSession(session) }: the project context,
// or the part of it a caller holds. runsAs is the OS user the session runs as,
// recorded now because a console id is renumbered by a restart.
function targetOf(slug, project, session) {
  var linuxUser = typeof project.getLinuxUserForSession === "function" ? project.getLinuxUserForSession(session) : null;
  return {
    project: slug,
    consoleSessionId: String(session.localId),
    sessionId: session.cliSessionId || null,
    vendor: session.vendor || (project.sm && project.sm.defaultVendor) || null,
    agent: session.agentName || null,
    name: session.sessionName || null,
    runsAs: linuxUser || outboundEntry.RUNS_AS_DAEMON,
  };
}

// args: slug, project (see targetOf), session, initiator, prompt, note,
// messageId, scheduledInput ({ id, createdBy }, for a scheduled firing).
// recorder: { record(entry) } or null (nothing is kept). clock() is ms.
function recordTurn(recorder, clock, args) {
  if (!recorder) return;
  try {
    recorder.record(outboundEntry.buildAutomationEntry({
      ts: new Date(clock()).toISOString(),
      initiator: args.initiator,
      prompt: args.prompt,
      note: args.note,
      messageId: args.messageId,
      target: targetOf(args.slug, args.project, args.session),
      scheduledInput: args.scheduledInput,
    }));
  } catch (e) {
    console.error("[automation-ledger] could not record the turn:", messageOf(e));
  }
}

module.exports = { recordTurn: recordTurn, targetOf: targetOf };
