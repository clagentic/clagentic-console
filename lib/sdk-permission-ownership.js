// lr-9d4b: Shared keep-vs-clear decision for session.pendingPermissions /
// activeTaskToolIds / taskIdMap at turn-boundary cleanup sites.
//
// Two call sites reset this same state at the end of a turn:
//   - sdk-message-processor.js: the 'result' message handler
//   - sdk-bridge.js: processQueryStream's finally block (normal, non-
//     superseded completion)
// Both used to unconditionally wipe session.pendingPermissions, which
// destroys a backgrounded sub-agent's still-open permission resolver if the
// sub-agent's own tool call (e.g. Bash) is still awaiting the operator's
// approval when the parent turn ends. The permission card stays on the UI,
// but the resolver is gone, so the sub-agent's canUseTool Promise (no
// timeout on the in-process path) hangs forever (lr-9d4b root cause).
//
// This module computes which entries are owned by a still-active
// backgrounded sub-agent (via session.subagentToolOwners, recorded in
// processSubagentMessage) so both cleanup sites can preserve them instead of
// wiping them, mirroring the existing _keepAskUser preservation pattern for
// session.pendingAskUser (mcp-mode entries survive the same cleanup sites).

/**
 * Partition session.pendingPermissions into entries to keep (owned by a
 * still-active backgrounded sub-agent) vs. the rest (top-level, or a
 * sub-agent whose owning Task has already finished) — the latter are
 * cleared exactly as before.
 *
 * @param {object} session - session object with pendingPermissions,
 *   subagentToolOwners, activeTaskToolIds.
 * @returns {{keptPermissions: object, preservedTaskIds: object}}
 *   keptPermissions: requestId -> pending entry, to become the new
 *     session.pendingPermissions.
 *   preservedTaskIds: Task tool-use id -> true, for the caller to also keep
 *     the corresponding activeTaskToolIds/taskIdMap entries (the sub-agent's
 *     bookkeeping must survive alongside its pending permission).
 */
function partitionSubagentOwnedPermissions(session) {
  var keptPermissions = {};
  var pendingPermissions = session.pendingPermissions || {};
  var subagentToolOwners = session.subagentToolOwners || {};
  var activeTaskToolIds = session.activeTaskToolIds || {};

  var permissionIds = Object.keys(pendingPermissions);
  for (var i = 0; i < permissionIds.length; i++) {
    var pid = permissionIds[i];
    var pentry = pendingPermissions[pid];
    var owningTaskId = pentry && pentry.toolUseId ? subagentToolOwners[pentry.toolUseId] : null;
    if (owningTaskId && activeTaskToolIds[owningTaskId]) {
      keptPermissions[pid] = pentry;
    }
  }

  var preservedTaskIds = {};
  for (var kpid in keptPermissions) {
    var kpTaskId = subagentToolOwners[keptPermissions[kpid].toolUseId];
    preservedTaskIds[kpTaskId] = true;
  }

  return { keptPermissions: keptPermissions, preservedTaskIds: preservedTaskIds };
}

/**
 * Apply the partition result to activeTaskToolIds/taskIdMap, keeping only
 * entries for Task ids whose permission was just preserved.
 *
 * @param {object} session
 * @param {object} preservedTaskIds - from partitionSubagentOwnedPermissions.
 */
function retainPreservedTaskBookkeeping(session, preservedTaskIds) {
  var nextActiveTaskToolIds = {};
  for (var atk in (session.activeTaskToolIds || {})) {
    if (preservedTaskIds[atk]) nextActiveTaskToolIds[atk] = session.activeTaskToolIds[atk];
  }
  session.activeTaskToolIds = nextActiveTaskToolIds;

  var nextTaskIdMap = {};
  for (var tik in (session.taskIdMap || {})) {
    if (preservedTaskIds[tik]) nextTaskIdMap[tik] = session.taskIdMap[tik];
  }
  session.taskIdMap = nextTaskIdMap;
}

module.exports = {
  partitionSubagentOwnedPermissions: partitionSubagentOwnedPermissions,
  retainPreservedTaskBookkeeping: retainPreservedTaskBookkeeping,
};
