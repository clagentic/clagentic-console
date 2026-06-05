var fs = require("fs");
var path = require("path");
var config = require("./config");
var utils = require("./utils");
var users = require("./users");
var { CODEX_DEFAULTS } = require("./codex-defaults");

function createSessionManager(opts) {
  var cwd = opts.cwd;
  var send = opts.send;          // function(obj) - broadcast to all clients
  var sendTo = opts.sendTo || null; // function(ws, obj) - send to specific client
  var sendEach = opts.sendEach || null; // function(fn) - call fn(ws) for each connected client
  var sendAndRecord = null;      // set after init via setSendAndRecord
  var onSessionDone = opts.onSessionDone || function () {};

  // --- LRU eviction limit: max sessions with in-memory history ---
  var LRU_HISTORY_LIMIT = 50;
  // Access order for loaded sessions: most-recently-accessed localId is last.
  var lruOrder = [];

  // --- Multi-session state ---
  var nextLocalId = 1;
  var sessions = new Map();     // localId -> session object
  var activeSessionId = null;   // currently active local ID
  var slashCommands = null;     // shared across sessions (deprecated, use slashCommandsByVendor)
  var slashCommandsByVendor = {}; // vendor -> array of slash commands
  var skillNames = null;        // Claude-only skills to filter from slash menu
  var singleUserUnread = {};    // sessionLocalId -> unread count (single-user mode)
  var permissionRequestIndex = {}; // requestId -> sessionLocalId (O(1) lookup)
  var capabilitiesByVendor = null; // set by sdk-bridge after adapter init
  var defaultVendor = null;        // set by sdk-bridge
  var codexApproval = CODEX_DEFAULTS.approval;
  var codexSandbox = CODEX_DEFAULTS.sandbox;
  var codexWebSearch = CODEX_DEFAULTS.webSearch;

  // --- Session persistence (centralized in ~/.clagentic/sessions/{encoded-cwd}/) ---
  var sessionsBase = path.join(config.CONFIG_DIR, "sessions");
  var encodedCwd = utils.resolveEncodedDir(sessionsBase, cwd);
  var sessionsDir = path.join(sessionsBase, encodedCwd);
  fs.mkdirSync(sessionsDir, { recursive: true });

  function sessionFilePath(cliSessionId) {
    return path.join(sessionsDir, cliSessionId + ".jsonl");
  }

  function saveSessionFile(session) {
    if (!session.cliSessionId) return;
    try {
      var metaObj = {
        type: "meta",
        localId: session.localId,
        cliSessionId: session.cliSessionId,
        title: session.title,
        createdAt: session.createdAt,
      };
      if (session.ownerId) metaObj.ownerId = session.ownerId;
      if (session.vendor) metaObj.vendor = session.vendor;
      if (session.sessionVisibility) metaObj.sessionVisibility = session.sessionVisibility;
      if (session.bookmarked) metaObj.bookmarked = true;
      if (typeof session.favoriteOrder === "number") metaObj.favoriteOrder = session.favoriteOrder;
      if (session.lastRewindUuid) metaObj.lastRewindUuid = session.lastRewindUuid;
      if (session.agentName) metaObj.agentName = session.agentName;
      if (session.loop) metaObj.loop = session.loop;
      var meta = JSON.stringify(metaObj);
      var lines = [meta];
      for (var i = 0; i < session.history.length; i++) {
        lines.push(JSON.stringify(session.history[i]));
      }
      var sfPath = sessionFilePath(session.cliSessionId);
      // Atomic write: write to temp file then rename, so a crash mid-write
      // cannot leave a truncated/corrupted session file.
      var tmpPath = sfPath + ".tmp." + process.pid;
      fs.writeFileSync(tmpPath, lines.join("\n") + "\n");
      if (process.platform !== "win32") {
        // chmod 0o600 once at file creation; appendToSessionFile skips it
        // after _fileModeSet is true.
        try { fs.chmodSync(tmpPath, 0o600); } catch (chmodErr) {}
      }
      fs.renameSync(tmpPath, sfPath);
      // Mark that the file mode has been set so appendToSessionFile skips chmod.
      session._fileModeSet = true;
    } catch(e) {
      console.error("[session] Failed to save session file:", e.message);
    }
  }

  // --- Write buffer state for async append (Finding 1) ---
  // Per-session write buffer: localId -> { lines: string[], timer: Timeout|null }
  var _writeBuffers = {};

  // Flush all pending lines for a session synchronously.  Called on session
  // end and process exit — must be synchronous so no lines are lost.
  function flushSessionBuffer(session) {
    var buf = _writeBuffers[session.localId];
    if (!buf || buf.lines.length === 0) return;
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
    if (!session.cliSessionId) {
      buf.lines = [];
      return;
    }
    try {
      var afPath = sessionFilePath(session.cliSessionId);
      fs.appendFileSync(afPath, buf.lines.join(""));
    } catch(e) {
      console.error("[session] Failed to flush session buffer:", e.message);
    }
    buf.lines = [];
  }

  // Flush asynchronously (non-blocking hot path).
  function _flushBufferAsync(session) {
    var buf = _writeBuffers[session.localId];
    if (!buf || buf.lines.length === 0) return;
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
    if (!session.cliSessionId) {
      buf.lines = [];
      return;
    }
    var toWrite = buf.lines.join("");
    buf.lines = [];
    var afPath = sessionFilePath(session.cliSessionId);
    fs.promises.appendFile(afPath, toWrite).catch(function(e) {
      console.error("[session] Failed to async-flush session buffer:", e.message);
    });
  }

  function appendToSessionFile(session, obj) {
    if (!session.cliSessionId) return;
    session.lastActivity = Date.now();

    // Ensure a buffer entry exists for this session.
    if (!_writeBuffers[session.localId]) {
      _writeBuffers[session.localId] = { lines: [], timer: null };
    }
    var buf = _writeBuffers[session.localId];
    buf.lines.push(JSON.stringify(obj) + "\n");

    // Set file mode exactly once at first append if saveSessionFile hasn't
    // done it yet (e.g. for sessions that receive appends before their first
    // full save).
    if (!session._fileModeSet && process.platform !== "win32") {
      try { fs.chmodSync(sessionFilePath(session.cliSessionId), 0o600); } catch (chmodErr) {}
      session._fileModeSet = true;
    }

    // Flush immediately if threshold reached; otherwise arm the 50ms timer.
    if (buf.lines.length >= 20) {
      _flushBufferAsync(session);
    } else if (!buf.timer) {
      buf.timer = setTimeout(function() {
        buf.timer = null;
        _flushBufferAsync(session);
      }, 50);
    }
  }

  // --- Lazy history load and LRU eviction (Findings 2 & 3) ---

  // Remove a localId from lruOrder (helper used by eviction and delete).
  function _lruRemove(localId) {
    var idx = lruOrder.indexOf(localId);
    if (idx !== -1) lruOrder.splice(idx, 1);
  }

  // Touch a session in the LRU order: move it to the most-recently-used end.
  function _lruTouch(localId) {
    _lruRemove(localId);
    lruOrder.push(localId);
  }

  // Evict the least-recently-used loaded session if we are over the limit.
  // Never evicts the active session or one that is currently processing.
  function _lruEvictIfNeeded() {
    if (lruOrder.length <= LRU_HISTORY_LIMIT) return;
    for (var ei = 0; ei < lruOrder.length; ei++) {
      var candidateId = lruOrder[ei];
      if (candidateId === activeSessionId) continue;
      var candidate = sessions.get(candidateId);
      if (!candidate || candidate.isProcessing) continue;
      // Unload history from memory; disk file is the source of truth.
      candidate.history = [];
      candidate._historyLoaded = false;
      _lruRemove(candidateId);
      return;
    }
  }

  // Synchronously load a session's history from disk if it has not been loaded.
  // Reconstructs messageUUIDs from the history lines.
  function loadSessionHistory(session) {
    if (session._historyLoaded) {
      _lruTouch(session.localId);
      return;
    }
    if (!session.cliSessionId) {
      // Brand-new session with no file yet — history is already [] and that is correct.
      session._historyLoaded = true;
      return;
    }

    // Flush any buffered appends first so we read the full on-disk state.
    flushSessionBuffer(session);

    var filePath = sessionFilePath(session.cliSessionId);
    var content;
    try { content = fs.readFileSync(filePath, "utf8"); } catch { content = ""; }
    var lines = content.trim().split("\n");
    var history = [];
    var messageUUIDs = [];
    // Skip line 0 — it's the meta record, already loaded at startup.
    for (var j = 1; j < lines.length; j++) {
      if (!lines[j]) continue;
      var entry;
      try { entry = JSON.parse(lines[j]); } catch { continue; }
      if (entry.type === "message_uuid") {
        messageUUIDs.push({ uuid: entry.uuid, type: entry.messageType, historyIndex: history.length });
      }
      history.push(entry);
    }
    session.history = history;
    session.messageUUIDs = messageUUIDs;
    session._historyLoaded = true;

    _lruTouch(session.localId);
    _lruEvictIfNeeded();
  }

  function loadSessions() {
    var files;
    try { files = fs.readdirSync(sessionsDir); } catch { return; }

    // Clean up stale temp files from interrupted atomic writes
    for (var ti = 0; ti < files.length; ti++) {
      if (files[ti].indexOf(".tmp.") !== -1) {
        try { fs.unlinkSync(path.join(sessionsDir, files[ti])); } catch (e) {}
      }
    }

    var loaded = [];
    for (var i = 0; i < files.length; i++) {
      if (!files[i].endsWith(".jsonl")) continue;
      // Read only the first line (meta record) — history is lazy-loaded on demand.
      var fd;
      var firstLine = "";
      try {
        fd = fs.openSync(path.join(sessionsDir, files[i]), "r");
        var buf = Buffer.alloc(4096);
        var bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
        var chunk = buf.toString("utf8", 0, bytesRead);
        var nl = chunk.indexOf("\n");
        firstLine = nl !== -1 ? chunk.substring(0, nl) : chunk;
      } catch { continue; } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {}
      }

      var meta;
      try { meta = JSON.parse(firstLine); } catch { continue; }
      if (meta.type !== "meta" || !meta.cliSessionId) continue;

      var fileMtime = 0;
      try { fileMtime = fs.statSync(path.join(sessionsDir, files[i])).mtimeMs; } catch {}
      loaded.push({ meta: meta, mtime: fileMtime });
    }

    loaded.sort(function(a, b) { return a.meta.createdAt - b.meta.createdAt; });

    for (var i = 0; i < loaded.length; i++) {
      var m = loaded[i].meta;
      var localId = nextLocalId++;
      var session = {
        localId: localId,
        queryInstance: null,
        messageQueue: null,
        cliSessionId: m.cliSessionId,
        blocks: {},
        sentToolResults: {},
        pendingPermissions: {},
        pendingAskUser: {},
        isProcessing: false,
        title: m.title || "",
        createdAt: m.createdAt || Date.now(),
        lastActivity: loaded[i].mtime || m.createdAt || Date.now(),
        // History is not loaded yet; populated lazily by loadSessionHistory().
        history: [],
        _historyLoaded: false,
        messageUUIDs: [],
        lastRewindUuid: m.lastRewindUuid || null,
        // File mode already correct on disk — skip chmod on first append.
        _fileModeSet: true,
      };
      if (m.vendor) session.vendor = m.vendor;
      if (m.agentName) session.agentName = m.agentName;
      if (m.loop) session.loop = m.loop;
      if (m.ownerId) session.ownerId = m.ownerId;
      session.sessionVisibility = m.sessionVisibility || "shared";
      session.bookmarked = !!m.bookmarked;
      session.favoriteOrder = typeof m.favoriteOrder === "number" ? m.favoriteOrder : null;
      sessions.set(localId, session);
    }
  }

  // Load persisted sessions from disk
  loadSessions();

  // Drain all write buffers synchronously on process exit to prevent trailing
  // event loss when the daemon shuts down cleanly.
  process.on("exit", function() {
    sessions.forEach(function(session) {
      flushSessionBuffer(session);
    });
  });

  function getActiveSession() {
    return sessions.get(activeSessionId) || null;
  }

  var resolveLoopInfo = null; // optional callback: (loopId) => { name, source } or null

  function setResolveLoopInfo(fn) {
    resolveLoopInfo = fn;
  }

  function mapSessionForClient(s, clientActiveId, wsUnread) {
    var loop = s.loop ? Object.assign({}, s.loop) : null;
    if (loop && loop.loopId && resolveLoopInfo) {
      var info = resolveLoopInfo(loop.loopId);
      if (info) {
        if (info.name) loop.name = info.name;
        if (info.source) loop.source = info.source;
      }
    }
    var isActive = (typeof clientActiveId === "number") ? s.localId === clientActiveId : s.localId === activeSessionId;
    var unreadMap = wsUnread || singleUserUnread;
    return {
      id: s.localId,
      cliSessionId: s.cliSessionId || null,
      title: s.title || "New Session",
      active: isActive,
      isProcessing: s.isProcessing,
      lastActivity: s.lastActivity || s.createdAt || 0,
      loop: loop,
      ownerId: s.ownerId || null,
      sessionVisibility: s.sessionVisibility || "shared",
      bookmarked: !!s.bookmarked,
      favoriteOrder: typeof s.favoriteOrder === "number" ? s.favoriteOrder : null,
      unread: unreadMap[s.localId] || 0,
      vendor: s.vendor || null,
      agentName: s.agentName || null,
    };
  }

  function getVisibleSessions() {
    var multiUser = users.isMultiUser();
    return [...sessions.values()].filter(function (s) {
      if (s.hidden) return false;
      if (!multiUser) {
        return !s.ownerId;
      }
      return true;
    });
  }

  function broadcastSessionList() {
    var allVisible = getVisibleSessions();
    if (sendEach) {
      // Per-client filtering (multi-user mode)
      sendEach(function (ws, filterFn) {
        var filtered = filterFn ? allVisible.filter(filterFn) : allVisible;
        var clientActiveId = ws._clayActiveSession;
        var wsUnread = ws._clayUnread || {};
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: "session_list",
            sessions: filtered.map(function (s) { return mapSessionForClient(s, clientActiveId, wsUnread); }),
          }));
        }
      });
    } else {
      send({
        type: "session_list",
        sessions: allVisible.map(function (s) { return mapSessionForClient(s); }),
      });
    }
  }

  function createSession(sessionOpts, targetWs) {
    var localId = nextLocalId++;
    var session = {
      localId: localId,
      queryInstance: null,
      messageQueue: null,
      cliSessionId: null,
      blocks: {},
      sentToolResults: {},
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
      isProcessing: false,
      title: "",
      titleAutoGenerated: false,
      turnCount: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      history: [],
      _historyLoaded: true, // new in-memory session — nothing to load from disk
      messageUUIDs: [],
      ownerId: (sessionOpts && sessionOpts.ownerId) || null,
      sessionVisibility: (sessionOpts && sessionOpts.sessionVisibility) || "shared",
      bookmarked: false,
      favoriteOrder: null,
      vendor: (sessionOpts && sessionOpts.vendor) || null,
      agentName: (sessionOpts && sessionOpts.agentName) || null,
    };
    sessions.set(localId, session);
    switchSession(localId, targetWs);
    return session;
  }

  // Create a session without switching to it (used for mate/background sessions)
  function createSessionRaw(sessionOpts) {
    var localId = nextLocalId++;
    var session = {
      localId: localId,
      queryInstance: null,
      messageQueue: null,
      cliSessionId: null,
      blocks: {},
      sentToolResults: {},
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
      isProcessing: false,
      title: "",
      titleAutoGenerated: false,
      turnCount: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      history: [],
      _historyLoaded: true, // new in-memory session — nothing to load from disk
      messageUUIDs: [],
      ownerId: (sessionOpts && sessionOpts.ownerId) || null,
      sessionVisibility: (sessionOpts && sessionOpts.sessionVisibility) || "shared",
      bookmarked: false,
      favoriteOrder: null,
      vendor: (sessionOpts && sessionOpts.vendor) || null,
      agentName: (sessionOpts && sessionOpts.agentName) || null,
    };
    sessions.set(localId, session);
    return session;
  }

  // Initial replay payload size. Lowered from 200 to reduce client-side
  // layout work on resume — older items are loaded progressively on
  // scroll-up via the existing pagination path.
  var HISTORY_PAGE_SIZE = 100;

  // Scan backward from the END of history (hard-capped at HISTORY_PAGE_SIZE) to
  // find the most recent user_message. This ensures the initial replay window
  // always starts at a clean turn boundary rather than mid-stream, regardless of
  // how large the most recent turn is. For a session whose last user_message is
  // at index N near the end, this returns N → typically ~10-100 events replayed
  // instead of thousands.
  function findLastTurnStart(history) {
    var searchFloor = Math.max(0, history.length - HISTORY_PAGE_SIZE);
    for (var i = history.length - 1; i >= searchFloor; i--) {
      if (history[i] && history[i].type === "user_message") return i;
    }
    // No turn boundary found within the window — hard-cap at searchFloor.
    return searchFloor;
  }

  // Scan backward from targetIndex (capped at HISTORY_PAGE_SIZE below it) to find
  // the nearest user_message turn boundary. Used by load_more_history scroll-up
  // pagination to align the prepended page to a clean turn start. Falls back to
  // targetIndex if no boundary is found within the window — a partial turn at
  // the top is preferable to an unbounded backward scan.
  function findTurnBoundary(history, targetIndex) {
    var searchFloor = Math.max(0, targetIndex - HISTORY_PAGE_SIZE);
    for (var i = targetIndex; i >= searchFloor; i--) {
      if (history[i] && history[i].type === "user_message") return i;
    }
    return targetIndex;
  }

  function replayHistory(session, fromIndex, targetWs, transform) {
    // Ensure history is in memory before replaying.
    loadSessionHistory(session);

    var _send = (targetWs && sendTo) ? function (obj) { sendTo(targetWs, obj); } : send;
    var total = session.history.length;
    if (typeof fromIndex !== "number") {
      if (total <= HISTORY_PAGE_SIZE) {
        fromIndex = 0;
      } else {
        // Start from the most recent complete turn within the PAGE_SIZE window.
        // max() ensures we never go past the hard floor even if the last turn
        // start somehow lands below it.
        var hardFloor = Math.max(0, total - HISTORY_PAGE_SIZE);
        var lastTurn = findLastTurnStart(session.history);
        fromIndex = Math.max(hardFloor, lastTurn);
      }
    }

    _send({ type: "history_meta", total: total, from: fromIndex });

    for (var i = fromIndex; i < total; i++) {
      var _item = session.history[i];
      // Skip internal bookkeeping entries not meant for the UI
      if (_item && _item.type === "digest_checkpoint") continue;
      _send(transform ? transform(_item) : _item);
    }

    // Find the last result message in the full history for accurate context data
    var lastUsage = null;
    var lastModelUsage = null;
    var lastCost = null;
    var lastStreamInputTokens = null;
    for (var j = total - 1; j >= 0; j--) {
      if (session.history[j].type === "result") {
        var r = session.history[j];
        lastUsage = r.usage || null;
        lastModelUsage = r.modelUsage || null;
        lastCost = r.cost != null ? r.cost : null;
        lastStreamInputTokens = r.lastStreamInputTokens || null;
        break;
      }
    }

    _send({ type: "history_done", lastUsage: lastUsage, lastModelUsage: lastModelUsage, lastCost: lastCost, lastStreamInputTokens: lastStreamInputTokens, contextUsage: session.lastContextUsage || null });
  }

  function switchSession(localId, targetWs, transform) {
    if (!sessions.has(localId)) {
      // Only send structured error when a client ws is the initiator. Internal
      // callers (createSession, deleteSession, resumeSession, project-loop) pass
      // targetWs=null and are always trusted.
      if (targetWs && sendTo) {
        sendTo(targetWs, { type: "error", error: "Session not found" });
      }
      return;
    }
    var session = sessions.get(localId);

    // Access check for client-initiated switches. In single-user mode, sessions
    // with an ownerId are user-scoped and should not be visible without auth;
    // in multi-user mode defer to users.canAccessSession (same rules as
    // getVisibleSessions / server-palette). Internal callers (targetWs=null)
    // bypass this gate — they operate on already-validated session references.
    if (targetWs) {
      var multiUser = users.isMultiUser();
      if (multiUser) {
        var requestingUser = targetWs._clayUser || null;
        if (!requestingUser) {
          if (sendTo) sendTo(targetWs, { type: "error", error: "Access denied" });
          return;
        }
        // Use { visibility: "public" } so canAccessProject passes and the
        // session-level ownership/visibility rules do the real work.
        if (!users.canAccessSession(requestingUser.id, session, { visibility: "public" })) {
          if (sendTo) sendTo(targetWs, { type: "error", error: "Access denied" });
          return;
        }
      } else {
        // Single-user mode: sessions with an ownerId were created in a multi-user
        // context; block access to prevent cross-context leakage.
        if (session.ownerId) {
          if (sendTo) sendTo(targetWs, { type: "error", error: "Access denied" });
          return;
        }
      }
    }

    activeSessionId = localId;
    if (targetWs) {
      targetWs._clayActiveSession = localId;
      // Clear unread for this session (multi-user)
      if (targetWs._clayUnread) targetWs._clayUnread[localId] = 0;
    } else if (sendEach) {
      // No specific target: update all connected clients (server-initiated switch)
      sendEach(function (ws) {
        ws._clayActiveSession = localId;
      });
    }
    // Clear unread for single-user mode
    singleUserUnread[localId] = 0;

    // Update LRU when a session is switched to (history will be loaded in replayHistory).
    _lruTouch(localId);

    // In multi-user mode with a specific client, only send to that client
    var _send = (targetWs && sendTo) ? function (obj) { sendTo(targetWs, obj); } : send;

    var _capsByVendor = capabilitiesByVendor || {};
    var _sessionVendor = session.vendor || defaultVendor || "claude";
    var _vendorCaps = _capsByVendor[_sessionVendor] || {};
    _send({ type: "session_switched", id: localId, cliSessionId: session.cliSessionId || null, loop: session.loop || null, vendor: session.vendor || null, hasHistory: (session._historyLoaded ? session.history.length > 0 : !!session.cliSessionId), capabilities: _vendorCaps, isProcessing: !!session.isProcessing, agentName: session.agentName || null });
    // Send vendor-specific slash commands
    var _vendorCmds = slashCommandsByVendor[_sessionVendor] || slashCommands || [];
    _send({ type: "slash_commands", commands: _vendorCmds, vendor: _sessionVendor });
    broadcastSessionList();
    replayHistory(session, undefined, targetWs, transform);

    if (session.isProcessing) {
      _send({ type: "status", status: "processing" });
    }

    // Re-send any pending permission requests
    var pendingIds = Object.keys(session.pendingPermissions);
    for (var i = 0; i < pendingIds.length; i++) {
      var p = session.pendingPermissions[pendingIds[i]];
      _send({
        type: "permission_request_pending",
        requestId: p.requestId,
        toolName: p.toolName,
        toolInput: p.toolInput,
        toolUseId: p.toolUseId,
        decisionReason: p.decisionReason,
      });
    }

    // Re-send active mention indicator so returning clients restore the mate avatar state
    if (session._mentionInProgress && session._mentionActiveMateId) {
      _send({ type: "mention_processing", mateId: session._mentionActiveMateId, active: true });
    }
  }

  function cleanupMentionSessions(session) {
    if (session._mentionSessions) {
      var mateIds = Object.keys(session._mentionSessions);
      for (var mi = 0; mi < mateIds.length; mi++) {
        try { session._mentionSessions[mateIds[mi]].close(); } catch (e) {}
      }
      session._mentionSessions = {};
    }
  }

  function deleteSession(localId, targetWs) {
    var session = sessions.get(localId);
    if (!session) return;

    // Drain any pending write buffer before removing the session.
    flushSessionBuffer(session);
    delete _writeBuffers[localId];
    _lruRemove(localId);

    // Clean up unread tracking
    delete singleUserUnread[localId];

    cleanupMentionSessions(session);

    if (session.abortController) {
      try { session.abortController.abort(); } catch(e) {}
    }
    // Close SDK query to terminate the underlying claude child process
    if (session.queryInstance && typeof session.queryInstance.close === "function") {
      try { session.queryInstance.close(); } catch(e) {}
    }
    session.queryInstance = null;
    if (session.messageQueue) {
      try { session.messageQueue.end(); } catch(e) {}
    }
    if (session.worker) {
      try { session.worker.kill(); } catch(e) {}
      session.worker = null;
    }

    if (session.cliSessionId) {
      try { fs.unlinkSync(sessionFilePath(session.cliSessionId)); } catch(e) {}
    }

    sessions.delete(localId);

    if (activeSessionId === localId) {
      var remaining = [...sessions.keys()];
      if (remaining.length > 0) {
        switchSession(remaining[remaining.length - 1], targetWs);
      } else {
        createSession(null, targetWs);
      }
    } else {
      broadcastSessionList();
    }
  }

  function deleteSessionQuiet(localId) {
    var session = sessions.get(localId);
    if (!session) return;

    // Drain any pending write buffer before removing the session.
    flushSessionBuffer(session);
    delete _writeBuffers[localId];
    _lruRemove(localId);

    delete singleUserUnread[localId];
    cleanupMentionSessions(session);
    if (session.abortController) {
      try { session.abortController.abort(); } catch(e) {}
    }
    // Close SDK query to terminate the underlying claude child process
    if (session.queryInstance && typeof session.queryInstance.close === "function") {
      try { session.queryInstance.close(); } catch(e) {}
    }
    session.queryInstance = null;
    if (session.messageQueue) {
      try { session.messageQueue.end(); } catch(e) {}
    }
    if (session.worker) {
      try { session.worker.kill(); } catch(e) {}
      session.worker = null;
    }
    if (session.cliSessionId) {
      try { fs.unlinkSync(sessionFilePath(session.cliSessionId)); } catch(e) {}
    }
    sessions.delete(localId);
  }

  function deleteSessionsBulk(localIds, targetWs) {
    if (!Array.isArray(localIds) || localIds.length === 0) return;

    var seen = {};
    var ids = [];
    for (var i = 0; i < localIds.length; i++) {
      var id = localIds[i];
      if (typeof id !== "number" || seen[id] || !sessions.has(id)) continue;
      seen[id] = true;
      ids.push(id);
    }
    if (ids.length === 0) return;

    var deletedActive = false;
    for (var j = 0; j < ids.length; j++) {
      if (ids[j] === activeSessionId) deletedActive = true;
      deleteSessionQuiet(ids[j]);
    }

    if (sessions.size === 0) {
      createSession(null, targetWs);
      return;
    }

    if (deletedActive) {
      var remaining = [...sessions.keys()];
      switchSession(remaining[remaining.length - 1], targetWs);
    } else {
      broadcastSessionList();
    }
  }

  function doSendToSession(session, obj) {
    // Send to active clients without recording to history/disk (ephemeral data)
    if (sendEach) {
      var data = JSON.stringify(obj);
      sendEach(function (ws) {
        if (ws._clayActiveSession === session.localId && ws.readyState === 1) {
          ws.send(data);
        }
      });
    } else if (session.localId === activeSessionId) {
      send(obj);
    }
  }

  function doSendAndRecord(session, obj) {
    // Stamp every recorded message so history replay preserves original times
    if (!obj._ts) obj._ts = Date.now();
    // If history has not been loaded from disk yet, do not trigger a load just
    // to append — the append path writes directly to the file buffer.  History
    // will be loaded lazily on the next switchSession/replayHistory call.
    if (session._historyLoaded) {
      session.history.push(obj);
    }
    appendToSessionFile(session, obj);
    if (sendEach) {
      // Multi-user: send to clients whose active session matches this one
      var data = JSON.stringify(obj);
      var ioData = null;
      sendEach(function (ws) {
        if (ws._clayActiveSession === session.localId) {
          if (ws.readyState === 1) ws.send(data);
        } else if (session.isProcessing && !session._ioThrottle) {
          if (!ioData) ioData = JSON.stringify({ type: "session_io", id: session.localId });
          if (ws.readyState === 1) ws.send(ioData);
        }
        // Track unread: increment on "done" for clients not viewing this session
        // Only count if session has no owner (my session) or owner matches this client
        if (obj.type === "done" && ws._clayActiveSession !== session.localId) {
          var _isMySession = !session.ownerId || (ws._clayUser && ws._clayUser.id === session.ownerId);
          if (_isMySession) {
            if (!ws._clayUnread) ws._clayUnread = {};
            ws._clayUnread[session.localId] = (ws._clayUnread[session.localId] || 0) + 1;
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "session_unread", id: session.localId, count: ws._clayUnread[session.localId] }));
            }
          }
        }
      });
      if (session.isProcessing && !session._ioThrottle && ioData) {
        session._ioThrottle = true;
        setTimeout(function () { session._ioThrottle = false; }, 80);
      }
    } else if (session.localId === activeSessionId) {
      send(obj);
    } else {
      // Track unread for single-user mode on "done"
      if (obj.type === "done") {
        singleUserUnread[session.localId] = (singleUserUnread[session.localId] || 0) + 1;
        send({ type: "session_unread", id: session.localId, count: singleUserUnread[session.localId] });
      }
      if (session.isProcessing && !session._ioThrottle) {
        session._ioThrottle = true;
        send({ type: "session_io", id: session.localId });
        setTimeout(function () { session._ioThrottle = false; }, 80);
      }
    }
    // Notify server for cross-project unread tracking
    if (obj.type === "done") onSessionDone();
  }

  function resumeSession(cliSessionId, opts, targetWs) {
    // If a session with this cliSessionId already exists, just switch to it
    var existing = null;
    sessions.forEach(function (s) {
      if (s.cliSessionId === cliSessionId) existing = s;
    });
    if (existing) {
      existing.lastActivity = Date.now();
      switchSession(existing.localId, targetWs);
      return existing;
    }

    var cliHistory = (opts && opts.history) || [];
    var title = (opts && opts.title) || "Resumed session";
    var localId = nextLocalId++;
    var session = {
      localId: localId,
      queryInstance: null,
      messageQueue: null,
      cliSessionId: cliSessionId,
      blocks: {},
      sentToolResults: {},
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
      isProcessing: false,
      title: title,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      history: cliHistory,
      _historyLoaded: true, // caller provided history directly
      messageUUIDs: [],
      bookmarked: false,
      favoriteOrder: null,
    };
    if (opts && opts.vendor) session.vendor = opts.vendor;
    if (opts && opts.ownerId) session.ownerId = opts.ownerId;
    sessions.set(localId, session);
    saveSessionFile(session);
    switchSession(localId, targetWs);
    return session;
  }

  // --- Spawn initial session only if no persisted sessions ---
  if (sessions.size === 0) {
    createSession();
  } else {
    // Activate the most recently used session
    var allSessions = [...sessions.values()];
    var mostRecent = allSessions[0];
    for (var i = 1; i < allSessions.length; i++) {
      if ((allSessions[i].lastActivity || 0) > (mostRecent.lastActivity || 0)) {
        mostRecent = allSessions[i];
      }
    }
    activeSessionId = mostRecent.localId;
  }

  function searchSessions(query) {
    if (!query) return [];
    var q = query.toLowerCase();
    var results = [];
    sessions.forEach(function (session) {
      var titleMatch = (session.title || "New Session").toLowerCase().indexOf(q) !== -1;
      var contentMatch = false;
      if (titleMatch) {
        // Skip content search when title already matches — avoids loading history
        // for sessions that are guaranteed to appear in results anyway.
      } else {
        // Lazy-load history to enable content search.
        loadSessionHistory(session);
        for (var i = 0; i < session.history.length; i++) {
          var entry = session.history[i];
          if ((entry.type === "delta" || entry.type === "user_message" || entry.type === "mention_user" || entry.type === "mention_response") && entry.text) {
            if (entry.text.toLowerCase().indexOf(q) !== -1) {
              contentMatch = true;
              break;
            }
          }
        }
      }
      if (titleMatch || contentMatch) {
        results.push({
          id: session.localId,
          cliSessionId: session.cliSessionId || null,
          title: session.title || "New Session",
          active: session.localId === activeSessionId,
          isProcessing: session.isProcessing,
          lastActivity: session.lastActivity || session.createdAt || 0,
          matchType: titleMatch && contentMatch ? "both" : titleMatch ? "title" : "content",
        });
      }
    });
    return results;
  }

  function searchSessionContent(localId, query) {
    if (!query) return { hits: [], total: 0 };
    var session = sessions.get(localId);
    if (!session) return { hits: [], total: 0 };

    // Lazy-load history for the target session before searching.
    loadSessionHistory(session);

    var q = query.toLowerCase();
    var qLen = query.length;
    var history = session.history;
    var hits = [];

    // Assistant turns can consist of many streaming deltas (especially Codex,
    // where agentMessage/delta fragments arrive in small chunks). We accumulate
    // delta text per turn, scan for ALL occurrences of the query across the
    // accumulated buffer, then map each occurrence back to the historyIndex of
    // the delta that contains its starting offset. This catches multiple
    // matches within a single turn and also matches that straddle delta
    // boundaries.
    var turnBuffer = "";
    var turnSegments = []; // [{ start, end, historyIndex, ts }]

    function pushScalarHits(text, historyIndex, role, ts) {
      if (!text) return;
      var lower = text.toLowerCase();
      var from = 0;
      while (true) {
        var idx = lower.indexOf(q, from);
        if (idx === -1) break;
        var s = Math.max(0, idx - 15);
        var e = Math.min(text.length, idx + qLen + 15);
        var snippet = (s > 0 ? "…" : "") + text.substring(s, e) + (e < text.length ? "…" : "");
        hits.push({ historyIndex: historyIndex, snippet: snippet, role: role, ts: ts });
        from = idx + qLen;
      }
    }

    function flushTurn() {
      if (!turnBuffer || turnSegments.length === 0) {
        turnBuffer = "";
        turnSegments = [];
        return;
      }
      var lowerBuf = turnBuffer.toLowerCase();
      var from = 0;
      var segCursor = 0;
      while (true) {
        var idx = lowerBuf.indexOf(q, from);
        if (idx === -1) break;
        // Advance segCursor to the segment containing idx.
        while (segCursor < turnSegments.length - 1 && turnSegments[segCursor].end <= idx) {
          segCursor++;
        }
        var seg = turnSegments[segCursor];
        var s = Math.max(0, idx - 15);
        var e = Math.min(turnBuffer.length, idx + qLen + 15);
        var snippet = (s > 0 ? "…" : "") + turnBuffer.substring(s, e) + (e < turnBuffer.length ? "…" : "");
        hits.push({ historyIndex: seg.historyIndex, snippet: snippet, role: "assistant", ts: seg.ts });
        from = idx + qLen;
      }
      turnBuffer = "";
      turnSegments = [];
    }

    for (var i = 0; i < history.length; i++) {
      var entry = history[i];
      var t = entry.type;
      if (t === "user_message" || t === "mention_user") {
        flushTurn();
        pushScalarHits(entry.text, i, t === "user_message" ? "user" : "assistant", entry._ts || null);
      } else if (t === "delta" && entry.text) {
        turnSegments.push({
          start: turnBuffer.length,
          end: turnBuffer.length + entry.text.length,
          historyIndex: i,
          ts: entry._ts || null,
        });
        turnBuffer += entry.text;
      } else if (t === "mention_response" && entry.text) {
        flushTurn();
        pushScalarHits(entry.text, i, "assistant", entry._ts || null);
      }
    }
    flushTurn();
    return { hits: hits, total: history.length };
  }

  var _migrationFailedIds = {};
  function migrateSessionTitles(adapter, migrateCwd) {
    var candidates = [];
    sessions.forEach(function(s) {
      if (s.cliSessionId && s.title && s.title !== "New Session" && s.title !== "Resumed session"
          && !_migrationFailedIds[s.cliSessionId]) {
        candidates.push({ cliSessionId: s.cliSessionId, title: s.title });
      }
    });
    if (candidates.length === 0) return;
    adapter.listSessions({ dir: migrateCwd }).then(function(sdkSessions) {
      var sdkTitles = {};
      for (var i = 0; i < sdkSessions.length; i++) {
        if (sdkSessions[i].customTitle) {
          sdkTitles[sdkSessions[i].sessionId] = sdkSessions[i].customTitle;
        }
      }
      var toMigrate = candidates.filter(function(item) {
        var relayTitle = (item.title || "").trim();
        var sdkTitle = (sdkTitles[item.cliSessionId] || "").trim();
        return sdkTitle !== relayTitle;
      });
      if (toMigrate.length === 0) return;
      var migrated = 0;
      var failed = 0;
      var chain = Promise.resolve();
      for (var j = 0; j < toMigrate.length; j++) {
        (function(item) {
          chain = chain.then(function() {
            return adapter.renameSession(item.cliSessionId, item.title.trim(), { dir: migrateCwd }).then(function() {
              migrated++;
            }).catch(function(e) {
              failed++;
              _migrationFailedIds[item.cliSessionId] = true;
            });
          });
        })(toMigrate[j]);
      }
      chain.then(function() {
        if (migrated > 0) {
          console.log("[session] Migrated " + migrated + " session title(s) to SDK format");
        }
        if (failed > 0) {
          console.log("[session] Skipped " + failed + " session(s) (CLI session not found for current user)");
        }
      }).catch(function(e) {
        console.error("[session] Migration chain failed:", e.message || e);
      });
    }).catch(function() {});
  }

  return {
    get activeSessionId() { return activeSessionId; },
    get nextLocalId() { return nextLocalId; },
    // slashCommands and slashCommandsByVendor store {name, desc, type}[] (lr-1c7f).
    // Previously string[]; now enriched objects. Setters are generic pass-through.
    get slashCommands() { return slashCommands; },
    set slashCommands(v) { slashCommands = v; },
    get slashCommandsByVendor() { return slashCommandsByVendor; },
    setSlashCommandsForVendor: function(vendor, cmds) {
      slashCommandsByVendor[vendor] = cmds || [];
    },
    getSlashCommandsForVendor: function(vendor) {
      return slashCommandsByVendor[vendor] || [];
    },
    get skillNames() { return skillNames; },
    set skillNames(v) { skillNames = v; },
    get capabilitiesByVendor() { return capabilitiesByVendor; },
    set capabilitiesByVendor(v) { capabilitiesByVendor = v; },
    get defaultVendor() { return defaultVendor; },
    set defaultVendor(v) { defaultVendor = v; },
    get codexApproval() { return codexApproval; },
    set codexApproval(v) { codexApproval = v; },
    get codexSandbox() { return codexSandbox; },
    set codexSandbox(v) { codexSandbox = v; },
    get codexWebSearch() { return codexWebSearch; },
    set codexWebSearch(v) { codexWebSearch = v; },
    sessions: sessions,
    sessionsDir: sessionsDir,
    HISTORY_PAGE_SIZE: HISTORY_PAGE_SIZE,
    getActiveSession: getActiveSession,
    createSession: createSession,
    createSessionRaw: createSessionRaw,
    switchSession: switchSession,
    deleteSession: deleteSession,
    deleteSessionQuiet: deleteSessionQuiet,
    deleteSessionsBulk: deleteSessionsBulk,
    resumeSession: resumeSession,
    mapSessionForClient: mapSessionForClient,
    broadcastSessionList: broadcastSessionList,
    getTotalUnread: function (ws) {
      var unreadMap = ws && ws._clayUnread ? ws._clayUnread : singleUserUnread;
      var total = 0;
      var keys = Object.keys(unreadMap);
      for (var i = 0; i < keys.length; i++) {
        total += unreadMap[keys[i]] || 0;
      }
      return total;
    },
    saveSessionFile: saveSessionFile,
    appendToSessionFile: appendToSessionFile,
    loadSessionHistory: loadSessionHistory,
    flushSessionBuffer: flushSessionBuffer,
    sendAndRecord: doSendAndRecord,
    sendToSession: doSendToSession,
    findTurnBoundary: findTurnBoundary,
    findLastTurnStart: findLastTurnStart,
    replayHistory: replayHistory,
    searchSessions: searchSessions,
    searchSessionContent: searchSessionContent,
    setResolveLoopInfo: setResolveLoopInfo,
    migrateSessionTitles: migrateSessionTitles,
    setSessionVisibility: function (localId, visibility) {
      var session = sessions.get(localId);
      if (!session) return { error: "Session not found" };
      session.sessionVisibility = visibility;
      saveSessionFile(session);
      broadcastSessionList();
      return { ok: true };
    },
    setSessionBookmarked: function (localId, bookmarked) {
      var session = sessions.get(localId);
      if (!session) return { error: "Session not found" };
      session.bookmarked = !!bookmarked;
      if (session.bookmarked) {
        var maxOrder = -1;
        sessions.forEach(function (s) {
          if (s.bookmarked && typeof s.favoriteOrder === "number" && s.favoriteOrder > maxOrder) {
            maxOrder = s.favoriteOrder;
          }
        });
        session.favoriteOrder = maxOrder + 1;
      } else {
        session.favoriteOrder = null;
      }
      saveSessionFile(session);
      broadcastSessionList();
      return { ok: true };
    },
    reorderBookmarkedSessions: function (sourceId, targetId, insertBefore) {
      var source = sessions.get(sourceId);
      var target = sessions.get(targetId);
      if (!source || !target) return { error: "Session not found" };
      if (!source.bookmarked || !target.bookmarked) return { error: "Only favorites can be reordered" };

      var favorites = [];
      sessions.forEach(function (s) {
        if (s.bookmarked) favorites.push(s);
      });
      favorites.sort(function (a, b) {
        var ao = typeof a.favoriteOrder === "number" ? a.favoriteOrder : Number.MAX_SAFE_INTEGER;
        var bo = typeof b.favoriteOrder === "number" ? b.favoriteOrder : Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return (b.lastActivity || 0) - (a.lastActivity || 0);
      });

      var reordered = [];
      for (var i = 0; i < favorites.length; i++) {
        if (favorites[i].localId !== sourceId) reordered.push(favorites[i]);
      }

      var targetIdx = -1;
      for (var j = 0; j < reordered.length; j++) {
        if (reordered[j].localId === targetId) {
          targetIdx = j;
          break;
        }
      }
      if (targetIdx === -1) return { error: "Target favorite not found" };
      if (!insertBefore) targetIdx++;
      reordered.splice(targetIdx, 0, source);

      for (var k = 0; k < reordered.length; k++) {
        reordered[k].favoriteOrder = k;
        saveSessionFile(reordered[k]);
      }
      broadcastSessionList();
      return { ok: true };
    },
    setSessionOwner: function (localId, ownerId) {
      var session = sessions.get(localId);
      if (!session) return { error: "Session not found" };
      session.ownerId = ownerId;
      saveSessionFile(session);
      return { ok: true };
    },
    permissionRequestIndex: permissionRequestIndex,
  };
}

module.exports = { createSessionManager };
