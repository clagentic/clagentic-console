"use strict";

// Single owner of the tool-permission request lifecycle.
//
// A request is pending until exactly one transition settles it: the operator
// answers it (resolved), or the scope that owns it ends (cancelled). Every
// path that ends a request - the WS and HTTP response handlers, the turn
// boundary, query end, the abort signal, worker-side expiry, rewind, context
// clear, session deletion - calls a transition here instead of editing the
// maps itself, so these hold by construction rather than by each path
// remembering them:
//
//   - settling calls the resolver exactly once, dismisses the request's
//     notification, and records a terminal event every client can see
//     (live, or annotated on replay);
//   - a pending request is reachable by requestId from any client;
//   - ownership decides scope: a top-level request ends with its turn, a
//     sub-agent request survives parent turn boundaries and its own Task's
//     completion signal, and ends with the query that hosts it (once the
//     query is closed nothing can consume a decision).
//
// State lives on the objects that already carried it, so readers keep
// working: session.pendingPermissions (requestId -> record, pending only),
// session.subagentToolOwners (tool-use id -> owning Task id),
// session.subagentTasks (Task id -> "live" | "ending"), and the session
// manager's requestId -> session index. Only this module writes them.

var crypto = require("crypto");
var utils = require("./utils");

var CANCEL_MESSAGES = {
  aborted: "Request cancelled",
  expired: "Permission request timed out",
  turn_ended: "Session turn ended",
  query_ended: "Query ended",
  rewind: "Session rewound",
  cleared: "Context cleared",
  session_deleted: "Session deleted",
};

// What the vendor's canUseTool callback receives for each operator decision.
// Unknown decisions fail closed.
function outcomeFor(decision, record, opts) {
  switch (decision) {
    case "allow":
    case "allow_always":
    case "allow_accept_edits":
      return { behavior: "allow", updatedInput: record.toolInput };
    case "allow_clear_context":
      return { behavior: "deny", message: "User chose to clear context and restart" };
    case "deny_with_feedback":
      return { behavior: "deny", message: opts.feedback || "User provided feedback" };
    default:
      return { behavior: "deny", message: opts.denyMessage || "User denied permission" };
  }
}

// An AbortSignal relayed from a worker carries reason "expired" when the
// worker gave up waiting; a real AbortSignal never does.
function cancelReasonForAbort(signal) {
  return signal && signal.reason === "expired" ? "expired" : "aborted";
}

/**
 * @param {object} deps
 * @param {object} deps.index - requestId -> session localId, shared with the
 *   session manager so a response can find its session from the id alone.
 * @param {function(*): ?object} deps.getSession - localId -> session.
 * @param {function(object, object)} deps.sendAndRecord - record + broadcast
 *   an event to the session's clients.
 * @param {function(object)} deps.saveSessionFile - durable session meta write.
 * @param {function(): ?object} [deps.getNotificationsModule]
 * @param {function()} [deps.onProcessingChanged] - cross-project badge refresh.
 */
function createPermissionRegistry(deps) {
  var index = deps.index;
  var getSession = deps.getSession;
  var sendAndRecord = deps.sendAndRecord;
  var saveSessionFile = deps.saveSessionFile;
  var getNotificationsModule = deps.getNotificationsModule || function () { return null; };
  var onProcessingChanged = deps.onProcessingChanged || function () {};

  function pendingMap(session) {
    if (!session.pendingPermissions) session.pendingPermissions = {};
    return session.pendingPermissions;
  }

  function toolOwners(session) {
    if (!session.subagentToolOwners) session.subagentToolOwners = {};
    return session.subagentToolOwners;
  }

  function subagentTasks(session) {
    if (!session.subagentTasks) session.subagentTasks = {};
    return session.subagentTasks;
  }

  function dismissNotification(requestId) {
    var nm = getNotificationsModule();
    if (nm && typeof nm.dismissByRequestId === "function") nm.dismissByRequestId(requestId);
  }

  function ownerTaskOf(session, record) {
    if (!record || !record.toolUseId) return null;
    return toolOwners(session)[record.toolUseId] || null;
  }

  function taskOwnsPending(session, taskId) {
    var map = pendingMap(session);
    for (var id in map) {
      if (ownerTaskOf(session, map[id]) === taskId) return true;
    }
    return false;
  }

  // Ownership records outlive their Task only while a pending request still
  // points at them; otherwise they are dead weight.
  function pruneToolOwners(session, taskId) {
    var owners = toolOwners(session);
    var referenced = {};
    var map = pendingMap(session);
    for (var id in map) {
      if (map[id] && map[id].toolUseId) referenced[map[id].toolUseId] = true;
    }
    for (var toolUseId in owners) {
      if (owners[toolUseId] === taskId && !referenced[toolUseId]) delete owners[toolUseId];
    }
  }

  function finishTask(session, taskId) {
    delete subagentTasks(session)[taskId];
    pruneToolOwners(session, taskId);
  }

  function settle(session, requestId, record, outcome, event) {
    var map = pendingMap(session);
    if (map[requestId] !== record) return false;
    delete map[requestId];
    delete index[requestId];
    dismissNotification(requestId);
    if (event) sendAndRecord(session, event);
    onProcessingChanged();
    record.resolve(outcome);
    var taskId = ownerTaskOf(session, record);
    if (taskId && subagentTasks(session)[taskId] === "ending" && !taskOwnsPending(session, taskId)) {
      finishTask(session, taskId);
    }
    return true;
  }

  function cancel(session, requestId, reason, opts) {
    var record = pendingMap(session)[requestId];
    if (!record) return false;
    var event = (opts && opts.record === false) ? null : { type: "permission_cancel", requestId: requestId, reason: reason };
    return settle(session, requestId, record, { behavior: "deny", message: CANCEL_MESSAGES[reason] || "Request cancelled" }, event);
  }

  function cancelWhere(session, reason, predicate, opts) {
    var map = pendingMap(session);
    var ids = Object.keys(map);
    for (var i = 0; i < ids.length; i++) {
      if (map[ids[i]] && predicate(map[ids[i]])) cancel(session, ids[i], reason, opts);
    }
  }

  /**
   * Open a request and return its id plus the decision promise the vendor's
   * canUseTool callback awaits. The request is recorded for clients before
   * this returns.
   */
  function open(session, req, opts) {
    var requestId = crypto.randomUUID();
    var resolveDecision;
    var decision = new Promise(function (resolve) { resolveDecision = resolve; });
    var record = {
      requestId: requestId,
      toolName: req.toolName,
      toolInput: req.toolInput,
      toolUseId: req.toolUseId,
      decisionReason: req.decisionReason || "",
      vendor: req.vendor,
      query: session.queryInstance || null,
      createdAt: Date.now(),
      resolve: resolveDecision,
    };
    pendingMap(session)[requestId] = record;
    index[requestId] = session.localId;
    sendAndRecord(session, {
      type: "permission_request",
      requestId: requestId,
      toolName: record.toolName,
      toolInput: record.toolInput,
      toolUseId: record.toolUseId,
      decisionReason: record.decisionReason,
      vendor: record.vendor,
    });
    onProcessingChanged();
    var signal = opts && opts.signal;
    if (signal) {
      signal.addEventListener("abort", function () {
        cancel(session, requestId, cancelReasonForAbort(signal));
      });
    }
    return { requestId: requestId, decision: decision };
  }

  /** The pending request for requestId, or null when it is not pending. */
  function lookup(requestId, fallbackSession) {
    var localId = index[requestId];
    var session = (localId != null && getSession) ? getSession(localId) : null;
    if (!session) session = fallbackSession || null;
    var record = session && session.pendingPermissions ? session.pendingPermissions[requestId] : null;
    return record ? { session: session, record: record } : null;
  }

  /**
   * Apply an operator decision. Returns {status: "resolved", session, record}
   * or {status: "stale"} when the request is no longer pending; a stale
   * response still retires any notification that offered it.
   *
   * @param {object} [opts]
   * @param {object} [opts.session] - fallback when the index has no entry.
   * @param {string} [opts.feedback] - deny_with_feedback message.
   * @param {string} [opts.denyMessage] - override for a plain deny.
   */
  function respond(requestId, decision, opts) {
    opts = opts || {};
    var found = lookup(requestId, opts.session);
    if (!found) {
      dismissNotification(requestId);
      return { status: "stale" };
    }
    if (decision === "allow_always") grant(found.session, found.record.toolName, found.record.toolInput);
    settle(found.session, requestId, found.record, outcomeFor(decision, found.record, opts), {
      type: "permission_resolved",
      requestId: requestId,
      decision: decision,
    });
    return { status: "resolved", session: found.session, record: found.record };
  }

  /** Turn boundary: requests the turn owns end; live sub-agents keep theirs. */
  function endTurn(session) {
    var tasks = subagentTasks(session);
    cancelWhere(session, "turn_ended", function (record) {
      var taskId = ownerTaskOf(session, record);
      return !(taskId && tasks[taskId]);
    });
  }

  /**
   * Query end: the query is closed, so every request it hosted is dead,
   * sub-agent ones included. ownsSession is true when no newer query has
   * taken the session over; only then are requests opened outside any query
   * also ended, and sub-agent bookkeeping reset.
   */
  function endQuery(session, query, ownsSession) {
    cancelWhere(session, "query_ended", function (record) {
      return record.query ? record.query === query : !!ownsSession;
    });
    if (ownsSession) {
      session.subagentTasks = {};
      session.subagentToolOwners = {};
    }
  }

  /** End every request of a session (rewind, context clear, deletion). */
  function cancelSession(session, reason, opts) {
    cancelWhere(session, reason, function () { return true; }, opts);
    session.subagentTasks = {};
    session.subagentToolOwners = {};
  }

  /** A worker gave up on a request; the decision can no longer take effect. */
  function expire(session, requestId) {
    return cancel(session, requestId, "expired");
  }

  function noteSubagentTool(session, toolUseId, taskId) {
    if (toolUseId && taskId) toolOwners(session)[toolUseId] = taskId;
  }

  function taskStarted(session, taskId) {
    if (taskId) subagentTasks(session)[taskId] = "live";
  }

  // A Task's completion can arrive while its sub-agent's own request is
  // still awaiting the operator; the request keeps the Task in scope until
  // it settles.
  function taskEnded(session, taskId) {
    if (!taskId) return;
    var tasks = subagentTasks(session);
    if (tasks[taskId] && taskOwnsPending(session, taskId)) {
      tasks[taskId] = "ending";
      pruneToolOwners(session, taskId);
      return;
    }
    finishTask(session, taskId);
  }

  /** Task ids that currently own a pending request. */
  function retainedTaskIds(session) {
    var out = {};
    var map = pendingMap(session);
    for (var id in map) {
      var taskId = ownerTaskOf(session, map[id]);
      if (taskId) out[taskId] = true;
    }
    return out;
  }

  function isGranted(session, toolName, input) {
    return !!(session.allowedTools && session.allowedTools[utils.permissionGrantKey(toolName, input)]);
  }

  // Flushed immediately so the grant survives a daemon restart or a resume
  // that rebuilds the session from disk.
  function grant(session, toolName, input) {
    if (!session.allowedTools) session.allowedTools = {};
    session.allowedTools[utils.permissionGrantKey(toolName, input)] = true;
    saveSessionFile(session);
  }

  /** Wire messages re-presenting every pending request of a session. */
  function pendingRequests(session) {
    var map = pendingMap(session);
    return Object.keys(map).map(function (id) {
      var p = map[id];
      return {
        type: "permission_request_pending",
        requestId: id,
        toolName: p.toolName,
        toolInput: p.toolInput,
        toolUseId: p.toolUseId,
        decisionReason: p.decisionReason,
        mateId: p.mateId || undefined,
      };
    });
  }

  function pendingCount(session) {
    return Object.keys(pendingMap(session)).length;
  }

  /**
   * Returns a mapper for replayed history items that stamps every
   * permission_request with its authoritative permissionState, so a client
   * renders it correctly regardless of which page carries the request and
   * which carries its resolution. Stored history is never mutated.
   *
   * history[from..] is scanned for terminal events: a resolution always
   * follows its request, so any request at or after `from` finds its own.
   * A request that is neither pending nor closed in history (its process
   * died before recording an outcome) is reported cancelled/stale.
   */
  function replayAnnotator(session, history, from) {
    var closed = Object.create(null);
    for (var i = Math.max(0, from || 0); i < history.length; i++) {
      var e = history[i];
      if (!e || !e.requestId || closed[e.requestId]) continue;
      if (e.type === "permission_resolved") closed[e.requestId] = { state: "resolved", decision: e.decision || null };
      else if (e.type === "permission_cancel") closed[e.requestId] = { state: "cancelled", reason: e.reason || null };
    }
    var map = pendingMap(session);
    return function (item) {
      if (!item || item.type !== "permission_request") return item;
      var state = map[item.requestId]
        ? { state: "pending" }
        : (closed[item.requestId] || { state: "cancelled", reason: "stale" });
      return Object.assign({}, item, { permissionState: state });
    };
  }

  return {
    open: open,
    lookup: lookup,
    respond: respond,
    endTurn: endTurn,
    endQuery: endQuery,
    cancelSession: cancelSession,
    expire: expire,
    noteSubagentTool: noteSubagentTool,
    taskStarted: taskStarted,
    taskEnded: taskEnded,
    taskOwnsPending: taskOwnsPending,
    retainedTaskIds: retainedTaskIds,
    isGranted: isGranted,
    grant: grant,
    pendingRequests: pendingRequests,
    pendingCount: pendingCount,
    replayAnnotator: replayAnnotator,
  };
}

/**
 * The registry attached to a session manager. A full session manager is
 * built with one wired to the project's notification and badge hooks; a
 * lighter manager (a test double) gets one over its own transport on first
 * use.
 */
function permissionsFor(sm) {
  if (!sm.permissions) {
    if (!sm.permissionRequestIndex) sm.permissionRequestIndex = {};
    sm.permissions = createPermissionRegistry({
      index: sm.permissionRequestIndex,
      getSession: function (localId) { return sm.sessions ? sm.sessions.get(localId) : null; },
      sendAndRecord: function (session, obj) { return sm.sendAndRecord(session, obj); },
      saveSessionFile: function (session) { return sm.saveSessionFile(session); },
    });
  }
  return sm.permissions;
}

module.exports = {
  createPermissionRegistry: createPermissionRegistry,
  permissionsFor: permissionsFor,
};
