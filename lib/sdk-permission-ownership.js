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

// lr-f940 (N3, top-3): sm.permissionRequestIndex[requestId] -> session.localId
// is written once per permission request (sdk-bridge.js handleCanUseTool) and
// is normally deleted in exactly two places: the user-driven permission_response
// handler (project-sessions.js) and the opts.signal "abort" listener
// (sdk-bridge.js). Both turn-boundary cleanup sites that call
// partitionSubagentOwnedPermissions() (the 'result' message handler in
// sdk-message-processor.js, and processQueryStream's finally block in
// sdk-bridge.js) drop entries from session.pendingPermissions wholesale
// (everything not in keptPermissions) without ever touching
// sm.permissionRequestIndex, so the dropped requestIds' index entries persist
// for the life of the daemon. On the WORKER path this is the ONLY cleanup that
// ever runs for those entries: the worker's canUseTool bridge (yoke/adapters/
// claude.js) passes a fake `signal: { addEventListener: function() {} }` to
// the in-process canUseTool, so the abort-listener deletion path is a no-op —
// the index entry is orphaned unconditionally once the turn ends.
//
// Call this immediately after reassigning session.pendingPermissions to
// keptPermissions, passing the PRE-reassignment map, so every entry that was
// dropped (i.e. not preserved for a still-active backgrounded sub-agent) is
// swept from sm.permissionRequestIndex and its orphaned resolver is settled
// with a deny — an SDK canUseTool Promise left unresolved forever is itself a
// (smaller) leak on top of the index leak.
//
// @param {object} sm - the session manager (owns permissionRequestIndex).
// @param {object} prevPendingPermissions - session.pendingPermissions as it
//   was BEFORE this cleanup pass reassigned it to keptPermissions.
// @param {object} keptPermissions - the entries being preserved (from
//   partitionSubagentOwnedPermissions's return value).
function sweepClearedPermissionIndex(sm, prevPendingPermissions, keptPermissions) {
  // Production sm always carries permissionRequestIndex (lib/sessions.js
  // initializes it unconditionally) — this guard exists only so a caller
  // without one (e.g. a minimal test double predating this sweep) is a
  // no-op, matching its pre-existing behavior exactly rather than gaining a
  // new side effect it never asked for.
  if (!sm || !sm.permissionRequestIndex) return;
  var prevIds = Object.keys(prevPendingPermissions || {});
  for (var i = 0; i < prevIds.length; i++) {
    var pid = prevIds[i];
    if (keptPermissions && keptPermissions[pid]) continue; // still owned, not dropped
    delete sm.permissionRequestIndex[pid];
    // Settle the orphaned resolver too — an abandoned canUseTool Promise is
    // itself a (smaller) leak on top of the index leak (lr-f940).
    var droppedEntry = prevPendingPermissions[pid];
    if (droppedEntry && typeof droppedEntry.resolve === "function") {
      try { droppedEntry.resolve({ behavior: "deny", message: "Session turn ended" }); }
      catch (e) { /* resolver already settled or threw — nothing further to do */ }
    }
  }
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
  sweepClearedPermissionIndex: sweepClearedPermissionIndex,
};
