"use strict";

// Single owner of every operator-prompt lifecycle: tool permissions, plan
// approval, AskUserQuestion, MCP elicitation and browser-extension commands.
// A kind (lib/prompt-kinds/) only describes its payload, how a response is
// parsed and what the vendor's callback receives; everything else is here.
//
// A prompt is pending until exactly one transition settles it: an answer
// (resolved), or the end of the scope that owns it (cancelled, with a
// reason). Every path that ends a prompt - the WS and HTTP response
// handlers, the turn boundary, query end, the abort signal, worker or Codex
// side expiry, a timeout, rewind, context clear, session deletion, daemon
// shutdown - calls a transition here, so these hold by construction:
//
//   - settling calls the resolver exactly once, dismisses the prompt's
//     notification, and records a terminal event every client can see
//     (live, or stamped on replay);
//   - a pending prompt is reachable by requestId from any client;
//   - ownership decides scope: a top-level prompt ends with its turn; a
//     prompt owned by a sub-agent (its tool-use id belongs to a Task) is kept
//     across the parent's turn and query boundaries for as long as the
//     sub-agent is tracked, so the operator can still answer it, and ends
//     only on an answer, its own abort, or the session ending. Its abort is
//     the vendor's word that the callback is gone (the adapters abort every
//     callback a closed query still had waiting); the registry never
//     decides on its own that a sub-agent is dead.
//
// State lives on the objects that already carried it, so readers keep
// working: one pending map per store on the session (pendingPermissions for
// tool and plan approvals, pendingAskUser, pendingElicitations; requestId ->
// record), session.subagentToolOwners (tool-use id -> owning Task id),
// session.activeTaskToolIds (Task id -> true while running, "ending" once it
// reported completion while still owning a pending prompt), and the session
// manager's requestId -> session index. Only this module writes them.

var crypto = require("crypto");
var utils = require("./utils");
var promptKinds = require("./prompt-kinds");

var KINDS = promptKinds.KINDS;
var STORES = promptKinds.sessionStores();

// An AbortSignal relayed from a worker or the Codex app-server carries reason
// "expired" when the other side gave up waiting; a plain abort does not.
function cancelReasonForAbort(signal) {
  return signal && signal.reason === "expired" ? "expired" : "aborted";
}

var RESOLVED_FIELDS = ["decision", "answers", "skipped", "action"];

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.keys(value).forEach(function (k) { deepFreeze(value[k]); });
  }
  return value;
}

function pick(obj, keys) {
  var out = {};
  keys.forEach(function (k) { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}

// The terminal state a recorded history event carries, including the event
// types recorded before prompts had one shape.
function terminalOf(e) {
  if (!e || typeof e.type !== "string") return null;
  switch (e.type) {
    case "prompt_resolved":
    case "permission_resolved":
    case "elicitation_resolved":
      return e.requestId ? { id: e.requestId, state: Object.assign({ state: "resolved" }, pick(e, RESOLVED_FIELDS)) } : null;
    case "prompt_cancel":
    case "permission_cancel":
      return e.requestId ? { id: e.requestId, state: { state: "cancelled", reason: e.reason || null } } : null;
    case "ask_user_answered":
      if (!e.toolId) return null;
      if (e.answers && Object.keys(e.answers).length) return { id: e.toolId, state: { state: "resolved", answers: e.answers } };
      return { id: e.toolId, state: { state: "cancelled", reason: null } };
    default:
      return null;
  }
}

// The prompt a recorded history event opens, if any. An AskUserQuestion card
// is drawn from its tool call, whose id is the prompt's id.
function openedBy(item) {
  if (!item || typeof item.type !== "string") return null;
  if (item.type === "prompt_request" || item.type === "permission_request" || item.type === "elicitation_request") {
    return item.requestId || null;
  }
  if (item.type === "tool_executing" && item.name === "AskUserQuestion") return item.id || null;
  return null;
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
function createPromptRegistry(deps) {
  var index = deps.index;
  var getSession = deps.getSession;
  var sendAndRecord = deps.sendAndRecord;
  var saveSessionFile = deps.saveSessionFile;
  var getNotificationsModule = deps.getNotificationsModule || function () { return null; };
  var onProcessingChanged = deps.onProcessingChanged || function () {};

  // Project-scope prompts (no session): requestId -> record.
  var projectPrompts = {};
  // record -> function that detaches its abort listener and timer.
  var detachers = new WeakMap();
  // Runs after every answer, whichever path delivered it; see onResolved().
  var resolutionEffects = null;

  function sessionMap(session, store) {
    if (!session[store]) session[store] = {};
    return session[store];
  }

  function toolOwners(session) {
    if (!session.subagentToolOwners) session.subagentToolOwners = {};
    return session.subagentToolOwners;
  }

  function trackedTasks(session) {
    if (!session.activeTaskToolIds) session.activeTaskToolIds = {};
    return session.activeTaskToolIds;
  }

  function entryOf(store, record) {
    return { store: store, record: record, kind: promptKinds.kindOfRecord(record, store) };
  }

  /** Every pending session prompt, across all stores. */
  function entries(session) {
    var out = [];
    STORES.forEach(function (store) {
      var map = session[store];
      if (!map) return;
      Object.keys(map).forEach(function (id) {
        if (map[id]) out.push(Object.assign({ id: id }, entryOf(store, map[id])));
      });
    });
    return out;
  }

  function findInSession(session, requestId) {
    for (var i = 0; i < STORES.length; i++) {
      var map = session[STORES[i]];
      if (map && map[requestId]) return entryOf(STORES[i], map[requestId]);
    }
    return null;
  }

  function dismissNotification(requestId) {
    var nm = getNotificationsModule();
    if (nm && typeof nm.dismissByRequestId === "function") nm.dismissByRequestId(requestId);
  }

  function ownerTaskOf(session, record) {
    if (!record || !record.toolUseId) return null;
    return toolOwners(session)[record.toolUseId] || null;
  }

  // A prompt owned by a tracked sub-agent outlives the parent's boundaries.
  function ownedByTrackedTask(session, record) {
    var taskId = ownerTaskOf(session, record);
    return !!(taskId && trackedTasks(session)[taskId]);
  }

  function taskOwnsPending(session, taskId) {
    return entries(session).some(function (e) { return ownerTaskOf(session, e.record) === taskId; });
  }

  // Ownership records outlive their Task only while a pending prompt still
  // points at them; otherwise they are dead weight.
  function pruneToolOwners(session, taskId) {
    var owners = toolOwners(session);
    var referenced = {};
    entries(session).forEach(function (e) { if (e.record.toolUseId) referenced[e.record.toolUseId] = true; });
    for (var toolUseId in owners) {
      if ((taskId === undefined || owners[toolUseId] === taskId) && !referenced[toolUseId]) delete owners[toolUseId];
    }
  }

  function finishTask(session, taskId) {
    delete trackedTasks(session)[taskId];
    pruneToolOwners(session, taskId);
  }

  // Forget every Task that no longer owns a pending prompt.
  function pruneTasks(session) {
    var tasks = trackedTasks(session);
    Object.keys(tasks).forEach(function (taskId) {
      if (!taskOwnsPending(session, taskId)) delete tasks[taskId];
    });
    pruneToolOwners(session);
  }

  function settle(session, requestId, entry, value, event) {
    var map = session ? session[entry.store] : projectPrompts;
    if (!map || map[requestId] !== entry.record) return false;
    delete map[requestId];
    if (session) delete index[requestId];
    var detach = detachers.get(entry.record);
    if (detach) detach();
    if (entry.kind.journal) {
      dismissNotification(requestId);
      if (event) sendAndRecord(session, event);
      onProcessingChanged();
    }
    entry.record.resolve(value);
    if (session) {
      var taskId = ownerTaskOf(session, entry.record);
      if (taskId && trackedTasks(session)[taskId] === "ending" && !taskOwnsPending(session, taskId)) {
        finishTask(session, taskId);
      }
    }
    return true;
  }

  function cancelEntry(session, requestId, entry, reason, opts) {
    var event = (entry.kind.journal && !(opts && opts.record === false))
      ? { type: "prompt_cancel", requestId: requestId, kind: entry.kind.name, reason: reason }
      : null;
    return settle(session, requestId, entry, entry.kind.cancelled(reason), event);
  }

  function cancelWhere(session, reason, predicate, opts) {
    entries(session).forEach(function (e) {
      if (predicate(e.record)) cancelEntry(session, e.id, e, reason, opts);
    });
  }

  function newRequestId(session, kind, toolUseId) {
    if (kind.idFromToolUse && toolUseId && !findInSession(session, toolUseId)) return toolUseId;
    return crypto.randomUUID();
  }

  /**
   * Open a prompt. Returns its id and the promise the vendor's callback
   * awaits; a journalled prompt is recorded for clients before this returns.
   *
   * @param {?object} session - null for a project-scope kind.
   * @param {string} kindName - a key of lib/prompt-kinds.
   * @param {object} req - the kind's request payload.
   * @param {object} [opts]
   * @param {string} [opts.toolUseId] - the tool call this prompt gates;
   *   decides sub-agent ownership.
   * @param {AbortSignal} [opts.signal] - ends the prompt (aborted, or
   *   expired when the signal's reason is "expired").
   * @param {number} [opts.timeoutMs] - ends the prompt as expired.
   * @param {object} [opts.notification] - permission_request notification
   *   payload (title, body, slug, ...); dismissed when the prompt settles.
   * @returns {{requestId: string, answer: Promise<*>, pending: boolean}}
   *   pending is false when the prompt ended before open() returned (its
   *   signal was already aborted); nothing should announce such a prompt.
   */
  function open(session, kindName, req, opts) {
    opts = opts || {};
    var kind = KINDS[kindName];
    if (!kind) throw new Error("unknown prompt kind: " + kindName);
    var scoped = kind.scope === "session";
    var requestId = scoped ? newRequestId(session, kind, opts.toolUseId) : crypto.randomUUID();
    var resolveAnswer;
    var answer = new Promise(function (resolve) { resolveAnswer = resolve; });
    var record = Object.assign({
      requestId: requestId,
      kind: kind.name,
      toolUseId: opts.toolUseId || undefined,
      createdAt: Date.now(),
      resolve: resolveAnswer,
    }, kind.fields(req || {}));
    var entry = { store: kind.store, record: record, kind: kind };
    var owner = scoped ? session : null;

    if (scoped) {
      record.query = session.queryInstance || null;
      sessionMap(session, kind.store)[requestId] = record;
      index[requestId] = session.localId;
    } else {
      projectPrompts[requestId] = record;
    }
    if (kind.journal) {
      sendAndRecord(session, Object.assign({
        type: "prompt_request",
        requestId: requestId,
        kind: kind.name,
        toolUseId: record.toolUseId,
      }, kind.requestFields(record)));
      onProcessingChanged();
    }

    var signal = opts.signal;
    if (signal && signal.aborted) {
      cancelEntry(owner, requestId, entry, cancelReasonForAbort(signal));
      return { requestId: requestId, answer: answer, pending: false };
    }
    var cleanups = [];
    if (signal && typeof signal.addEventListener === "function") {
      var onAbort = function () { cancelEntry(owner, requestId, entry, cancelReasonForAbort(signal)); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (typeof signal.removeEventListener === "function") {
        cleanups.push(function () { signal.removeEventListener("abort", onAbort); });
      }
    }
    var timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : kind.defaultTimeoutMs;
    if (timeoutMs) {
      var timer = setTimeout(function () { cancelEntry(owner, requestId, entry, "expired"); }, timeoutMs);
      cleanups.push(function () { clearTimeout(timer); });
    }
    if (cleanups.length) {
      detachers.set(record, function () { cleanups.forEach(function (fn) { fn(); }); });
    }

    if (kind.journal && opts.notification) {
      var nm = getNotificationsModule();
      if (nm && typeof nm.notify === "function") {
        nm.notify("permission_request", Object.assign({}, opts.notification, { requestId: requestId, kind: kind.name }));
      }
    }
    return { requestId: requestId, answer: answer, pending: true };
  }

  // The pending entry for requestId (its live record and kind adapter), or
  // null. Internal: the record carries the resolver.
  function find(requestId, fallbackSession) {
    if (!requestId) return null;
    if (projectPrompts[requestId]) return Object.assign({ session: null }, entryOf(null, projectPrompts[requestId]));
    var localId = index[requestId];
    var session = (localId != null && getSession) ? getSession(localId) : null;
    var entry = session ? findInSession(session, requestId) : null;
    if (!entry && fallbackSession) {
      session = fallbackSession;
      entry = findInSession(session, requestId);
    }
    return entry ? Object.assign({ session: session }, entry) : null;
  }

  // What callers outside the registry may see of a prompt: a frozen copy of
  // its request, never the record or its resolver, so nothing can settle or
  // alter a prompt except through a transition here.
  function publicView(requestId, entry) {
    return Object.freeze({
      requestId: requestId,
      kind: entry.kind.name,
      toolUseId: entry.record.toolUseId,
      createdAt: entry.record.createdAt,
      request: deepFreeze(structuredClone(entry.kind.requestFields(entry.record))),
    });
  }

  /**
   * The pending prompt for requestId, or null when it is not pending.
   * @returns {?{session: ?object, prompt: object}} prompt is a frozen view.
   */
  function lookup(requestId, fallbackSession) {
    var found = find(requestId, fallbackSession);
    return found ? Object.freeze({ session: found.session, prompt: publicView(requestId, found) }) : null;
  }

  /**
   * Apply an answer. Returns {status: "resolved", session, prompt, kind,
   * response} or {status: "stale"} when the prompt is not pending (or is
   * not one of opts.kinds); a stale answer still retires any notification
   * that offered it. The resolution effects (onResolved) have run by the
   * time this returns, whichever path called it.
   *
   * @param {string} requestId
   * @param {object} msg - the kind's response fields (decision, answers,
   *   action, result, ...); parsed and validated by the kind.
   * @param {object} [opts]
   * @param {object} [opts.session] - fallback when the index has no entry.
   * @param {string[]} [opts.kinds] - only answer prompts of these kinds.
   * @param {string} [opts.denyMessage] - override for a plain deny.
   * @param {?object} [opts.responder] - the connection that answered, if
   *   any; handed to the resolution effects.
   */
  function respond(requestId, msg, opts) {
    opts = opts || {};
    var found = find(requestId, opts.session);
    if (!found) {
      dismissNotification(requestId);
      return { status: "stale" };
    }
    if (opts.kinds && opts.kinds.indexOf(found.kind.name) === -1) return { status: "stale" };
    var kind = found.kind;
    var response = kind.parse(msg || {}, found.record);
    if (kind.grantsSession(response)) grant(found.session, found.record.toolName, found.record.toolInput);
    var event = kind.journal
      ? Object.assign({ type: "prompt_resolved", requestId: requestId, kind: kind.name }, kind.resolvedFields(response))
      : null;
    var prompt = publicView(requestId, found);
    settle(found.session, requestId, found, kind.outcome(found.record, response, opts), event);
    var outcome = { status: "resolved", session: found.session, prompt: prompt, kind: kind.name, response: response };
    if (resolutionEffects) resolutionEffects(outcome, opts.responder || null);
    return outcome;
  }

  /**
   * Install the session side effects of an answer (a plan decision's
   * permission mode, fresh session or feedback message). They run inside
   * respond(), so every path that answers a prompt - the WS card, the push
   * notification's HTTP route, an older client's alias message - applies
   * them; no path can settle a prompt and skip them. One installer per
   * registry: a later call replaces the earlier one.
   *
   * @param {function(object, ?object)} fn - (outcome, responder)
   */
  function onResolved(fn) {
    resolutionEffects = typeof fn === "function" ? fn : null;
  }

  /** Turn boundary: prompts the turn owns end; tracked sub-agents keep theirs. */
  function endTurn(session) {
    cancelWhere(session, "turn_ended", function (record) {
      return !ownedByTrackedTask(session, record);
    });
  }

  /**
   * Query end. A prompt opened by this query ends unless a tracked
   * sub-agent owns it: the operator must still be able to answer a
   * backgrounded sub-agent after its parent's query closes. ownsSession is
   * true when no newer query has taken the session over; only then are
   * prompts opened outside any query also ended, and Tasks that own nothing
   * forgotten.
   */
  function endQuery(session, query, ownsSession) {
    cancelWhere(session, "query_ended", function (record) {
      var ours = record.query ? record.query === query : !!ownsSession;
      return ours && !ownedByTrackedTask(session, record);
    });
    if (ownsSession) pruneTasks(session);
  }

  /** A new query starts: Tasks of earlier queries that own nothing are gone. */
  function beginQuery(session) {
    pruneTasks(session);
  }

  /** End every prompt of a session (rewind, context clear, deletion). */
  function cancelSession(session, reason, opts) {
    cancelWhere(session, reason, function () { return true; }, opts);
    session.activeTaskToolIds = {};
    session.subagentToolOwners = {};
  }

  /**
   * The daemon is going away: no resolver survives it, so every pending
   * prompt ends now, recorded, instead of being found unanswerable later.
   */
  function shutdown() {
    var localIds = new Set();
    Object.keys(index).forEach(function (id) { localIds.add(index[id]); });
    localIds.forEach(function (localId) {
      var session = getSession ? getSession(localId) : null;
      if (session) cancelWhere(session, "shutdown", function () { return true; });
    });
    Object.keys(projectPrompts).forEach(function (id) {
      var record = projectPrompts[id];
      if (record) cancelEntry(null, id, entryOf(null, record), "shutdown");
    });
  }

  function noteSubagentTool(session, toolUseId, taskId) {
    if (toolUseId && taskId) toolOwners(session)[toolUseId] = taskId;
  }

  function taskStarted(session, taskId) {
    if (taskId) trackedTasks(session)[taskId] = true;
  }

  /** Whether a Task is tracked (running, or ending with a pending prompt). */
  function isTaskTracked(session, taskId) {
    return !!(taskId && session.activeTaskToolIds && session.activeTaskToolIds[taskId]);
  }

  // A Task's completion can arrive while its sub-agent's own prompt is still
  // awaiting the operator; the prompt keeps the Task in scope until it
  // settles.
  function taskEnded(session, taskId) {
    if (!taskId) return;
    var tasks = trackedTasks(session);
    if (tasks[taskId] && taskOwnsPending(session, taskId)) {
      tasks[taskId] = "ending";
      pruneToolOwners(session, taskId);
      return;
    }
    finishTask(session, taskId);
  }

  /** Ids of every tracked Task. */
  function trackedTaskIds(session) {
    var out = {};
    Object.keys(trackedTasks(session)).forEach(function (taskId) { out[taskId] = true; });
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

  /** Wire messages re-presenting every pending prompt of a session. */
  function pendingMessages(session) {
    return entries(session).filter(function (e) { return e.kind.journal; }).map(function (e) {
      return Object.assign({
        type: "prompt_pending",
        requestId: e.id,
        kind: e.kind.name,
        toolUseId: e.record.toolUseId,
      }, e.kind.requestFields(e.record));
    });
  }

  /** Prompts of a session awaiting the operator. */
  function pendingCount(session) {
    return entries(session).filter(function (e) { return e.kind.journal; }).length;
  }

  /**
   * Returns a mapper for replayed history items that stamps every item
   * opening a prompt with its authoritative promptState, so a client renders
   * it correctly regardless of which page carries the request and which its
   * outcome. Stored history is never mutated.
   *
   * history[from..] is scanned for terminal events: an outcome always
   * follows its request, so any request at or after `from` finds its own.
   * A prompt that is neither pending nor closed in history (its process died
   * before recording an outcome) is reported cancelled/stale.
   */
  function replayAnnotator(session, history, from) {
    var start = Math.max(0, from || 0);
    var closed = Object.create(null);
    for (var i = start; i < history.length; i++) {
      var t = terminalOf(history[i]);
      if (t && !closed[t.id]) closed[t.id] = t.state;
    }
    // An AskUserQuestion card is recorded at its tool call, a moment before
    // the vendor opens its prompt; until its turn has ended, an unopened one
    // may still open and is left unstamped rather than called stale.
    var askBeforeTurnEnd = new WeakSet();
    var turnEnded = false;
    for (var j = history.length - 1; j >= start; j--) {
      var e = history[j];
      if (!e) continue;
      if (e.type === "result" || e.type === "done") turnEnded = true;
      else if (turnEnded && e.type === "tool_executing" && e.name === "AskUserQuestion") askBeforeTurnEnd.add(e);
    }
    return function (item) {
      var id = openedBy(item);
      if (!id) return item;
      var state = findInSession(session, id) ? { state: "pending" } : closed[id];
      if (!state) {
        var mayStillOpen = item.type === "tool_executing" && !askBeforeTurnEnd.has(item);
        if (mayStillOpen) return item;
        state = { state: "cancelled", reason: "stale" };
      }
      return Object.assign({}, item, { promptState: state });
    };
  }

  return {
    open: open,
    lookup: lookup,
    respond: respond,
    onResolved: onResolved,
    endTurn: endTurn,
    endQuery: endQuery,
    beginQuery: beginQuery,
    cancelSession: cancelSession,
    shutdown: shutdown,
    noteSubagentTool: noteSubagentTool,
    taskStarted: taskStarted,
    taskEnded: taskEnded,
    isTaskTracked: isTaskTracked,
    taskOwnsPending: taskOwnsPending,
    trackedTaskIds: trackedTaskIds,
    isGranted: isGranted,
    grant: grant,
    pendingMessages: pendingMessages,
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
function promptsFor(sm) {
  if (!sm.prompts) {
    if (!sm.permissionRequestIndex) sm.permissionRequestIndex = {};
    sm.prompts = createPromptRegistry({
      index: sm.permissionRequestIndex,
      getSession: function (localId) { return sm.sessions ? sm.sessions.get(localId) : null; },
      sendAndRecord: function (session, obj) { return sm.sendAndRecord(session, obj); },
      saveSessionFile: function (session) { return sm.saveSessionFile(session); },
    });
  }
  return sm.prompts;
}

module.exports = {
  createPromptRegistry: createPromptRegistry,
  promptsFor: promptsFor,
};
