var fs = require("fs");
var path = require("path");
var config = require("./config");
var utils = require("./utils");
var users = require("./users");
var { CODEX_DEFAULTS } = require("./codex-defaults");
var { isVisibleHistoryEvent } = require("./history-visibility");

// lr-2ea2a7: hard cap on how many history entries a session may hold in the
// heap array, regardless of isProcessing state. On-disk JSONL remains the
// single source of truth for full history; the in-heap array is always a
// bounded TAIL window, never the full record, for every session including
// an actively-processing loop that runs for hours. Without this, the
// LRU_HISTORY_LIMIT isProcessing-skip (below) left a never-terminating loop
// session's heap history completely unbounded — the root cause diagnosed in
// lr-2ea2a7 (4th daemon OOM incident). Trim-to has hysteresis (trims well
// below the cap) so a session sitting exactly at the boundary doesn't
// re-trigger a trim on every single append.
var HISTORY_INMEM_MAX_DEFAULT = 1000;
var HISTORY_INMEM_TRIM_TO_DEFAULT = 800;

function createSessionManager(opts) {
  var cwd = opts.cwd;
  var send = opts.send;          // function(obj) - broadcast to all clients
  var sendTo = opts.sendTo || null; // function(ws, obj) - send to specific client
  var sendEach = opts.sendEach || null; // function(fn) - call fn(ws) for each connected client
  var sendAndRecord = null;      // set after init via setSendAndRecord
  var onSessionDone = opts.onSessionDone || function () {};

  // daemon.json knob `historyInMemMax` (lr-2ea2a7): operators may override the
  // in-heap tail cap. TRIM_TO is derived as 80% of the configured max so the
  // hysteresis gap scales with the cap instead of a fixed 200-entry offset
  // that would be meaningless (or negative) for a small custom override.
  var HISTORY_INMEM_MAX = (typeof opts.historyInMemMax === "number" && opts.historyInMemMax > 0)
    ? opts.historyInMemMax
    : HISTORY_INMEM_MAX_DEFAULT;
  var HISTORY_INMEM_TRIM_TO = (typeof opts.historyInMemMax === "number" && opts.historyInMemMax > 0)
    ? Math.max(1, Math.floor(HISTORY_INMEM_MAX * 0.8))
    : HISTORY_INMEM_TRIM_TO_DEFAULT;

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

  function buildMetaLine(session) {
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
    // Persist per-session "allow for session" tool grants (lr-8b2e) so they
    // survive daemon restart / resume-by-cliSessionId rehydration instead of
    // silently re-prompting. Only written when non-empty — grants that were
    // never given must stay absent, not round-trip as {}.
    if (session.allowedTools && Object.keys(session.allowedTools).length > 0) {
      metaObj.allowedTools = session.allowedTools;
    }
    // lr-f36626: durable AUTO-RESUME marker set by lib/memory-shed.js when a
    // session with a live background child was force-evicted under memory
    // pressure. Persisted (not just in-memory) so the marker survives a
    // daemon restart between the reclaim and the operator's next reconnect —
    // otherwise the "never a silent orphan" guarantee only holds until the
    // next process restart.
    if (session.pendingAutoResume) {
      metaObj.pendingAutoResume = true;
      if (session.pendingAutoResumeReason) metaObj.pendingAutoResumeReason = session.pendingAutoResumeReason;
    }
    return JSON.stringify(metaObj);
  }

  // Rewrite only the first (meta) line of an on-disk session file in place,
  // leaving every subsequent history line untouched. Used when a session's
  // history has not been loaded into memory (lr-79c6) — reading the whole
  // history back into memory just to rewrite a title/flag would be wasteful,
  // and serializing session.history (which is [] while unloaded) would
  // truncate the file to the meta line alone, destroying the conversation.
  // Returns true on success, false if the rewrite could not be performed
  // (e.g. no file on disk yet, or the existing line 0 is not actually a meta
  // record — see lr-f940 below) so the caller can fall back to a full write.
  function rewriteMetaLineInPlace(session) {
    var sfPath = sessionFilePath(session.cliSessionId);
    var content;
    try {
      content = fs.readFileSync(sfPath, "utf8");
    } catch (e) {
      return false;
    }
    var nl = content.indexOf("\n");
    var firstLine = nl !== -1 ? content.slice(0, nl) : content;
    // lr-f940 (N1): a session can reach its FIRST-EVER saveSessionFile() call
    // after already having buffered-appended history lines to disk via
    // appendToSessionFile (e.g. sendAndRecord calls before any save has run)
    // — in that case line 0 on disk is a history record, not a meta line, and
    // blindly overwriting it here would silently destroy that first history
    // entry. Only take the in-place path when line 0 is verifiably a meta
    // record; otherwise fall through to the full write below, which is safe
    // (it serializes the in-memory history, which is present since this can
    // only happen while _historyLoaded is true).
    var firstParsed;
    try { firstParsed = JSON.parse(firstLine); } catch (e) { return false; }
    if (!firstParsed || firstParsed.type !== "meta") return false;
    var rest = nl !== -1 ? content.slice(nl + 1) : "";
    var meta = buildMetaLine(session);
    var tmpPath = sfPath + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, meta + "\n" + rest);
    if (process.platform !== "win32") {
      try { fs.chmodSync(tmpPath, 0o600); } catch (chmodErr) {}
    }
    fs.renameSync(tmpPath, sfPath);
    session._fileModeSet = true;
    return true;
  }

  // lr-f940 (N1, top-3): has session.history changed since the last time it
  // was durably written to disk in full (either by a full saveSessionFile
  // rewrite, or by the normal doSendAndRecord + appendToSessionFile buffered
  // append path, which keeps disk in sync one entry at a time)?
  //
  // Tracked via length comparison rather than an opt-in flag callers must
  // remember to set: session._historyPersistedLength records how many
  // entries are known to be reflected on disk. doSendAndRecord increments it
  // by exactly one per durably-appended entry; a full rewrite here sets it to
  // session.history.length. ANY other direct mutation of session.history
  // (push/pop/slice/splice/reassignment — e.g. rewind trimming or fork
  // copying a new session's history wholesale) changes session.history.length
  // without updating the counter, so the mismatch is detected automatically
  // and a full rewrite still runs — no caller needs to opt in, and no
  // pre-existing "loaded session save always does a full rewrite" contract
  // (lr-79c6's own regression test) is broken by adding this fast path.
  //
  // lr-2ea2a7: _historyPersistedLength is now the ABSOLUTE persisted count
  // (how many entries exist on disk total), not the heap array length —
  // once recordHistoryEntry() starts trimming the heap tail,
  // session.history.length alone under-counts what's actually durable.
  // _historyBaseIndex (count of entries trimmed off the head) plus the
  // current heap length recovers the absolute count for comparison. A
  // session that has never been trimmed keeps _historyBaseIndex === 0, so
  // this is exactly the pre-lr-2ea2a7 comparison for every existing caller
  // and regression test (lr-79c6, lr-f940).
  function historyMatchesDisk(session) {
    return session._historyPersistedLength === (session._historyBaseIndex || 0) + session.history.length;
  }

  // lr-2ea2a7: single choke point for every session.history.push() in the
  // codebase (grep-guarded by test/session-history-cap-lr-2ea2a7.test.js —
  // no other file may call session.history.push directly). Responsible for:
  //   (a) pushing the entry when history is loaded in memory,
  //   (b) maintaining _historyPersistedLength as callers expect (callers that
  //       pair this with appendToSessionFile — the overwhelmingly common
  //       case — get the same "already durable" accounting doSendAndRecord
  //       always did; see the `persisted` param below for the rare direct
  //       push that is NOT paired with a durable append),
  //   (c) enforcing the bounded in-heap tail cap with hysteresis, advancing
  //       _historyBaseIndex by however many entries were trimmed off the head
  //       so absolute indices (messageUUIDs[].historyIndex, history_meta
  //       total/from, load_more_history before/target) stay valid.
  //
  // Only entries already durable on disk may ever be trimmed off the heap —
  // trimming is driven purely by HISTORY_INMEM_MAX against the CURRENT heap
  // length, and every heap entry at trim time was pushed here in call order,
  // so entries older than the trim point were appended (and, for the
  // doSendAndRecord path, buffer-flushed synchronously on every
  // loadSessionHistory/saveSessionFile call) before this trim ever runs.
  //
  // @param {object} session
  // @param {object} obj - the history entry to record
  // @param {boolean} [persisted=true] - whether this push is paired with a
  //   durable disk append (appendToSessionFile) in the same call. Pass false
  //   for the rare direct-to-heap push (e.g. context_preview cards) that
  //   relies on a LATER full saveSessionFile() rewrite instead — matches the
  //   pre-existing lr-f940 contract where such a push is detected via the
  //   historyMatchesDisk() length mismatch, not counted as already-durable.
  function recordHistoryEntry(session, obj, persisted) {
    if (!session._historyLoaded) return;
    session.history.push(obj);
    if (persisted !== false) {
      session._historyPersistedLength = (session._historyPersistedLength || 0) + 1;
    }
    if (session.history.length > HISTORY_INMEM_MAX) {
      var trimCount = session.history.length - HISTORY_INMEM_TRIM_TO;
      session.history.splice(0, trimCount);
      session._historyBaseIndex = (session._historyBaseIndex || 0) + trimCount;
    }
  }

  function saveSessionFile(session) {
    if (!session.cliSessionId) return;
    // Flush any pending async-append buffer before rewriting the file so that
    // lines already queued by doSendAndRecord are not double-appended once the
    // timer fires after the atomic rename completes (lr-e0de).
    flushSessionBuffer(session);
    try {
      // lr-f940 (N1, top-3): saveSessionFile() used to re-serialize the ENTIRE
      // in-memory history on every metadata-only mutation (title rename,
      // bookmark/favorite toggle, owner transfer, visibility change, agent
      // change, vendor bind) whenever the session's history happened to be
      // loaded (_historyLoaded) — the overwhelmingly common case for an
      // active/processing session, since that session is never LRU-evicted
      // (_lruEvictIfNeeded skips the active session and any isProcessing
      // session). That is an O(n) full-file rewrite (CPU + a second full
      // string in memory) for a change that only ever touches the meta line.
      //
      // The existing !_historyLoaded branch below already rewrites just the
      // meta line in place (lr-79c6) — extend the same fast path to loaded
      // sessions too, but only when history is verifiably unchanged since the
      // last durable write (historyMatchesDisk). Any direct history mutation
      // is caught automatically by the length check, so this still falls
      // through to a full rewrite whenever needed.
      if (!session._historyLoaded || historyMatchesDisk(session)) {
        if (rewriteMetaLineInPlace(session)) return;
        // No file exists yet to patch in place (e.g. never persisted) — fall
        // through to the full write below, which is safe since there is no
        // on-disk history to lose.
      }
      var meta = buildMetaLine(session);
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
      // The full rewrite above just persisted the current in-memory history
      // in full, so it now matches disk exactly (lr-f940).
      session._historyPersistedLength = session.history.length;
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

  // Flush from the batching timer/threshold (called "async" because it is
  // invoked off the hot path -- the 50ms timer or the 20-line threshold in
  // appendToSessionFile -- rather than synchronously inline with every
  // append). The write itself uses appendFileSync rather than
  // fs.promises.appendFile.
  //
  // This used to use fs.promises.appendFile. Because that write is not
  // awaited by its caller, a session-end/process-exit synchronous flush
  // (flushSessionBuffer) or a saveSessionFile() atomic rename could run
  // before the pending promise's write actually landed on disk -- appending
  // after a rename writes into a file that no longer exists at the recorded
  // path (silently lost), or interleaves with saveSessionFile's rewritten
  // content, corrupting replay order (lr-1bdb item D). Using appendFileSync
  // here removes the race outright: since Node's event loop is
  // single-threaded, a synchronous fs call cannot be interleaved with any
  // other JS (including another flush) -- every write for a given session is
  // trivially serialized in call order, with no in-flight promise that a
  // later synchronous flush could race.
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
    try {
      var afPath = sessionFilePath(session.cliSessionId);
      fs.appendFileSync(afPath, toWrite);
    } catch (e) {
      console.error("[session] Failed to async-flush session buffer:", e.message);
    }
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

  // Unload a single session's history from memory (disk file remains the
  // source of truth) and drop it from the LRU order. Shared by the
  // one-at-a-time post-load eviction (_lruEvictIfNeeded) and the
  // pressure-driven bulk eviction (forceEvictToLimit, lr-5e70).
  //
  // Note: this never touches candidate.queryInstance — an evicted session's
  // live query (if any) keeps running; only its in-heap history window is
  // dropped and reloaded lazily on next access. That is what makes force-
  // eviction of a session with a live background child (lr-f36626) safe on
  // its own — the child process is not killed here. See forceEvictToLimit's
  // header for the escalation this enables.
  function _evictSession(candidate) {
    candidate.history = [];
    candidate._historyLoaded = false;
    // _historyLoaded=false alone already forces the meta-only save path on
    // the next saveSessionFile() regardless of _historyPersistedLength;
    // reset it for clarity so a future reload starts from a clean known
    // state (lr-f940 — see loadSessionHistory, which sets it correctly).
    candidate._historyPersistedLength = 0;
    // lr-2ea2a7: reset alongside _historyPersistedLength — the next
    // loadSessionHistory() tail-load recomputes this from the disk scan;
    // a stale non-zero value here would corrupt absolute-index math
    // (historyMatchesDisk, replay from/total) before that reload happens.
    candidate._historyBaseIndex = 0;
    _lruRemove(candidate.localId);
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
      _evictSession(candidate);
      return;
    }
  }

  // lr-5e70: force-evict loaded sessions down to an arbitrary pressure limit,
  // driven by a MemoryHigh watermark crossing rather than the normal
  // post-load LRU check. Unlike _lruEvictIfNeeded (which evicts at most one
  // session per call, since it runs on every loadSessionHistory), this loops
  // until the limit is reached or no further candidate remains — a single
  // shedding pass may need to evict many sessions at once to bring memory
  // down quickly. Same exemptions as the normal LRU path: never evicts the
  // active session or an isProcessing session (skip-active-session and
  // skip-processing are both load-bearing invariants, not incidental).
  //
  // lr-f36626: a session with a live registered background child
  // (session.activeTaskToolIds non-empty) is a LAST-RESORT candidate, not an
  // exempt one — under real memory pressure the ceiling (lr-c10f6d) still
  // wins. Pass 1 below only evicts childless candidates; pass 2 falls back to
  // live-child candidates solely when pass 1 could not reach the limit alone.
  // Eviction here never kills the child (_evictSession never touches
  // queryInstance — see its header), so this is not the reap-and-orphan
  // failure mode lr-f36626 diagnosed; it only unloads in-heap history. The
  // caller (lib/memory-shed.js) uses reclaimedLiveChild to durably checkpoint
  // and notify both UI surfaces for each such session, per lr-f36626's
  // "never a silent orphan" requirement.
  //
  // @param {number} limit — target max loaded-session count after this call
  // @returns {{ evicted: number, reclaimedLiveChild: Array<object> }}
  //   reclaimedLiveChild holds the actual session objects (not just ids) that
  //   were evicted while carrying a live registered child, in eviction order.
  function forceEvictToLimit(limit) {
    var evicted = 0;
    var reclaimedLiveChild = [];
    var guard = lruOrder.length; // upper bound on loop iterations — no infinite loop

    function hasLiveChild(candidate) {
      return !!(candidate.activeTaskToolIds && Object.keys(candidate.activeTaskToolIds).length > 0);
    }

    // Pass 1: childless candidates only (the normal, non-escalated case).
    while (lruOrder.length > limit && guard-- > 0) {
      var evictedOne = false;
      for (var ei = 0; ei < lruOrder.length; ei++) {
        var candidateId = lruOrder[ei];
        if (candidateId === activeSessionId) continue;
        var candidate = sessions.get(candidateId);
        if (!candidate || candidate.isProcessing) continue;
        if (hasLiveChild(candidate)) continue; // deferred to pass 2
        _evictSession(candidate);
        evicted++;
        evictedOne = true;
        break;
      }
      if (!evictedOne) break; // no further childless candidate — stop, try pass 2
    }

    // Pass 2 (last resort): still over limit and childless candidates are
    // exhausted — fall back to live-child candidates so the memory ceiling
    // is never silently deferred to in favor of a background dispatch.
    guard = lruOrder.length;
    while (lruOrder.length > limit && guard-- > 0) {
      var evictedOne2 = false;
      for (var ej = 0; ej < lruOrder.length; ej++) {
        var candidateId2 = lruOrder[ej];
        if (candidateId2 === activeSessionId) continue;
        var candidate2 = sessions.get(candidateId2);
        if (!candidate2 || candidate2.isProcessing) continue;
        reclaimedLiveChild.push(candidate2);
        _evictSession(candidate2);
        evicted++;
        evictedOne2 = true;
        break;
      }
      if (!evictedOne2) break; // no further evictable candidate at all — stop
    }

    return { evicted: evicted, reclaimedLiveChild: reclaimedLiveChild };
  }

  // Parse every history line in a session's on-disk JSONL file (skipping the
  // meta line 0). Returns { lines: [parsedEntry, ...], messageUUIDs: [...] }
  // where messageUUIDs carries ABSOLUTE historyIndex values (position within
  // the full on-disk sequence, not any in-heap subset) — the wire contract
  // (messageUUIDs[].historyIndex, rewind/fork targeting) depends on this
  // being correct regardless of how much of `lines` a caller keeps in heap.
  // Shared by loadSessionHistory (tail-only) and loadFullSessionHistory
  // (keeps everything) so both stay consistent with the same parse pass.
  function _parseSessionFileLines(session) {
    var filePath = sessionFilePath(session.cliSessionId);
    var content;
    try { content = fs.readFileSync(filePath, "utf8"); } catch { content = ""; }
    var rawLines = content.trim().split("\n");
    var lines = [];
    var messageUUIDs = [];
    // Skip line 0 — it's the meta record, already loaded at startup.
    for (var j = 1; j < rawLines.length; j++) {
      if (!rawLines[j]) continue;
      var entry;
      try { entry = JSON.parse(rawLines[j]); } catch { continue; }
      if (entry.type === "message_uuid") {
        messageUUIDs.push({ uuid: entry.uuid, type: entry.messageType, historyIndex: lines.length });
      }
      lines.push(entry);
    }
    return { lines: lines, messageUUIDs: messageUUIDs };
  }

  // Synchronously load a session's history from disk if it has not been
  // loaded. lr-2ea2a7: loads only the TAIL (last HISTORY_INMEM_TRIM_TO
  // entries) into the heap array — on-disk JSONL, not the heap, is the
  // source of truth for full history. messageUUIDs is still reconstructed
  // in FULL (uuid + type + absolute historyIndex per entry is small — no
  // reason to cap it) by scanning every line, so rewind/fork targeting by
  // uuid keeps working for any point in the conversation, not just the tail.
  // session._historyBaseIndex records how many entries were skipped so
  // absolute-index math (historyMatchesDisk, history_meta total/from,
  // load_more_history) stays correct.
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

    var parsed = _parseSessionFileLines(session);
    var allLines = parsed.lines;
    var skipCount = Math.max(0, allLines.length - HISTORY_INMEM_TRIM_TO);
    session.history = allLines.slice(skipCount);
    session._historyBaseIndex = skipCount;
    session.messageUUIDs = parsed.messageUUIDs;
    session._historyLoaded = true;
    // lr-f940 (N1): freshly loaded from disk — history exactly matches what
    // is durably persisted, so a subsequent metadata-only save can safely
    // take the meta-only fast path until something changes history.length.
    // lr-2ea2a7: persisted length is the ABSOLUTE on-disk count, not the
    // (possibly tail-trimmed) heap length — see historyMatchesDisk().
    session._historyPersistedLength = allLines.length;

    _lruTouch(session.localId);
    _lruEvictIfNeeded();
  }

  // lr-2ea2a7: cap-exempt full materialization. Used by rewind/fork, which
  // may target ANY point in the conversation — including one older than the
  // current tail-loaded window — and need the complete history in heap to
  // trim/copy/rewrite correctly. Callers MUST pair this with retrimHistory()
  // once done (or a save/switch), so the heap does not permanently hold an
  // unbounded history after the operation completes.
  function loadFullSessionHistory(session) {
    if (!session.cliSessionId) {
      session._historyLoaded = true;
      return;
    }
    flushSessionBuffer(session);
    var parsed = _parseSessionFileLines(session);
    session.history = parsed.lines;
    session._historyBaseIndex = 0;
    session.messageUUIDs = parsed.messageUUIDs;
    session._historyLoaded = true;
    session._historyPersistedLength = parsed.lines.length;
    _lruTouch(session.localId);
  }

  // lr-2ea2a7: re-apply the bounded tail cap after a loadFullSessionHistory()
  // call (or any other operation that grew the heap array past the cap
  // outside the normal recordHistoryEntry() append path — e.g. rewind's
  // truncation or fork's wholesale copy can each still legally exceed the
  // cap if the pre-trim conversation itself was long). Idempotent / no-op
  // when history is already within bounds.
  function retrimHistory(session) {
    if (session.history.length <= HISTORY_INMEM_MAX) return;
    var trimCount = session.history.length - HISTORY_INMEM_TRIM_TO;
    session.history.splice(0, trimCount);
    session._historyBaseIndex = (session._historyBaseIndex || 0) + trimCount;
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
        // Hydrate previously-granted "allow for session" tool decisions from
        // durable state (lr-8b2e); default to {} only when none was saved so
        // grants that were never given remain empty, not re-prompted.
        // Sanitized (lr-8b2e hardening) so a malformed/injected persisted
        // record cannot silently auto-approve a tool.
        allowedTools: utils.sanitizeAllowedTools(m.allowedTools),
        isProcessing: false,
        title: m.title || "",
        createdAt: m.createdAt || Date.now(),
        lastActivity: loaded[i].mtime || m.createdAt || Date.now(),
        // History is not loaded yet; populated lazily by loadSessionHistory().
        history: [],
        _historyLoaded: false,
        // lr-2ea2a7: count of entries trimmed off the head of the in-heap
        // history array; absolute index = _historyBaseIndex + heapOffset.
        // Set for real by loadSessionHistory() once history is actually
        // loaded (tail-only load skips this many entries from disk).
        _historyBaseIndex: 0,
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
      // lr-f36626: restore the durable AUTO-RESUME marker across a daemon
      // restart — see buildMetaLine's write side for why this must persist.
      if (m.pendingAutoResume) {
        session.pendingAutoResume = true;
        session.pendingAutoResumeReason = m.pendingAutoResumeReason || null;
      }
      sessions.set(localId, session);
    }
  }

  // Load persisted sessions from disk
  loadSessions();

  // Drain all write buffers synchronously on process exit to prevent trailing
  // event loss when the daemon shuts down cleanly.
  // Named so it can be deregistered via sm.destroy() when the project is torn
  // down — avoids accumulating one listener per project open (lr-daca).
  function _onProcessExit() {
    sessions.forEach(function(session) {
      flushSessionBuffer(session);
    });
  }
  process.on("exit", _onProcessExit);

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
    var unreadMap = wsUnread || {};
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
    return [...sessions.values()].filter(function (s) {
      if (s.hidden) return false;
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
      _historyBaseIndex: 0, // lr-2ea2a7: nothing trimmed yet
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
      _historyBaseIndex: 0, // lr-2ea2a7: nothing trimmed yet
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

  // Hard cap on how many additional turn-boundary steps a page window may be
  // extended backward by when searching for visible content (lr-c24b). Each
  // step is itself bounded by HISTORY_PAGE_SIZE (see findTurnBoundary), so the
  // total worst-case scan is MAX_VISIBILITY_EXTENSIONS * HISTORY_PAGE_SIZE —
  // bounded, not unbounded (codex engrams 2026-05-27/29 flagged unbounded
  // backward scans as a structural trap for this exact pagination path).
  var MAX_VISIBILITY_EXTENSIONS = 5;

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

  // Returns true when history[from..to) contains at least one event that
  // app-messages.js will render as a new visible message (lr-c24b). A page
  // window can otherwise land entirely on invisible-yield events (todo/task
  // bookkeeping, hidden plan tools, state events, thinking deltas) and render
  // zero bubbles even though it advanced historyFrom.
  function sliceHasVisibleEvent(history, from, to) {
    for (var i = from; i < to; i++) {
      if (isVisibleHistoryEvent(history[i])) return true;
    }
    return false;
  }

  // Extend a turn-boundary-aligned page window backward, one turn boundary at
  // a time, until the slice [from, to) contains at least one visibly-rendering
  // event or from reaches 0 — capped at MAX_VISIBILITY_EXTENSIONS additional
  // steps so the scan stays bounded even for pathological all-invisible runs.
  // `to` never changes; only `from` moves backward.
  function extendWindowForVisibility(history, from, to) {
    var steps = 0;
    while (from > 0 && !sliceHasVisibleEvent(history, from, to) && steps < MAX_VISIBILITY_EXTENSIONS) {
      var next = findTurnBoundary(history, from - 1);
      if (next >= from) break; // no further progress possible — avoid an infinite loop
      from = next;
      steps++;
    }
    return from;
  }

  // fromIndex (when passed) is an ABSOLUTE index per the wire contract — no
  // current caller passes one (see call sites below), but the contract is
  // preserved for future callers. Internally this function works with the
  // heap array (session.history) using HEAP-RELATIVE offsets, translating to
  // absolute only at the boundary (history_meta.total/from and each
  // messageUUIDs-adjacent index the client already tracks) — lr-2ea2a7.
  function replayHistory(session, fromIndex, targetWs, transform) {
    // Ensure history is in memory before replaying.
    loadSessionHistory(session);

    var _send = (targetWs && sendTo) ? function (obj) { sendTo(targetWs, obj); } : send;
    var baseIndex = session._historyBaseIndex || 0;
    var heapLen = session.history.length;
    var total = baseIndex + heapLen; // absolute total per the wire contract
    var heapFrom;
    if (typeof fromIndex === "number") {
      // Caller-supplied fromIndex is absolute; translate to heap-relative and
      // clamp to the trimmed head (a caller cannot request replay from below
      // baseIndex — that range no longer exists in heap; see
      // load_more_history in project-sessions.js for the disk-backed path
      // that serves ranges below baseIndex).
      heapFrom = Math.max(0, fromIndex - baseIndex);
    } else if (heapLen <= HISTORY_PAGE_SIZE) {
      heapFrom = 0;
    } else {
      // Start from the most recent complete turn within the PAGE_SIZE window.
      // max() ensures we never go past the hard floor even if the last turn
      // start somehow lands below it.
      var hardFloor = Math.max(0, heapLen - HISTORY_PAGE_SIZE);
      var lastTurn = findLastTurnStart(session.history);
      heapFrom = Math.max(hardFloor, lastTurn);
      // Same yield guarantee as load_more_history (lr-c24b): a turn
      // dominated by invisible-yield events (todo/task bookkeeping, hidden
      // plan tools, thinking deltas) can otherwise replay zero visible
      // bubbles on initial resume.
      heapFrom = extendWindowForVisibility(session.history, heapFrom, heapLen);
    }

    _send({ type: "history_meta", total: total, from: baseIndex + heapFrom });

    for (var i = heapFrom; i < heapLen; i++) {
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
    for (var j = heapLen - 1; j >= 0; j--) {
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

    // Access check for client-initiated switches. Defer to users.canAccessSession
    // (same rules as getVisibleSessions / server-palette). Internal callers
    // (targetWs=null) bypass this gate — they operate on already-validated session
    // references.
    //
    // No-auth / single-user connections have _clayUser === null (set by
    // project-connection.js:92 as wsUser || null). In that deployment there is
    // no user identity to check — the connection is the implicit owner.  We skip
    // the gate entirely for null users so that _clayActiveSession is still
    // bound below, keeping the live-broadcast filter (doSendAndRecord /
    // doSendToSession) in sync.  Authenticated users who lack access are still
    // rejected by canAccessSession. (regression introduced by dca60a7, lr-690b)
    if (targetWs) {
      var requestingUser = targetWs._clayUser || null;
      if (requestingUser) {
        // Use { visibility: "public" } so canAccessProject passes and the
        // session-level ownership/visibility rules do the real work.
        if (!users.canAccessSession(requestingUser.id, session, { visibility: "public" })) {
          if (sendTo) sendTo(targetWs, { type: "error", error: "Access denied" });
          return;
        }
      }
      // null requestingUser = no-auth deployment; fall through to bind _clayActiveSession.
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

  // lr-0827ba (PEACHES follow-up): explicit notification that a session was
  // deleted, carrying its localId, so the client can prune any per-session
  // state it tracks (e.g. rate-limit-state.js's armed-schedule map and
  // background reset timers) instead of leaking it forever. Prior to this,
  // the only client-observable signal was a fresh session_list broadcast
  // that simply omitted the deleted id — nothing told the client WHICH id(s)
  // disappeared, so nothing could target cleanup at them.
  function broadcastSessionDeleted(localIds) {
    var ids = Array.isArray(localIds) ? localIds : [localIds];
    send({ type: "session_deleted", ids: ids });
  }

  function deleteSession(localId, targetWs) {
    var session = sessions.get(localId);
    if (!session) return;

    // Drain any pending write buffer before removing the session.
    flushSessionBuffer(session);
    delete _writeBuffers[localId];
    _lruRemove(localId);

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
    broadcastSessionDeleted(localId);

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
    broadcastSessionDeleted(ids);

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
    // lr-f940 (N1): this entry is queued for a durable append (below) that
    // saveSessionFile's flushSessionBuffer() call always drains before
    // checking historyMatchesDisk() — safe to count it as persisted now so
    // a later metadata-only save can still take the meta-only fast path.
    // lr-2ea2a7: routes through recordHistoryEntry() so this session — even
    // when isProcessing keeps it permanently exempt from LRU eviction below —
    // still has its in-heap history bounded to a tail window.
    recordHistoryEntry(session, obj, true);
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
    }
    // Notify server for cross-project unread tracking. Pass the session's
    // own localId (lr-0aa7b6) so cross-project unread can be attributed to
    // the SPECIFIC session that finished, not just "this project has an
    // unread somewhere" — localId alone is only unique within this
    // project's SessionManager (nextLocalId is a per-project counter), so
    // the receiving side must pair it with the source project's slug
    // (already known to the caller wired in server.js) to form a globally
    // unique key.
    if (obj.type === "done") onSessionDone(session.localId);
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
      // Hydrate previously-granted "allow for session" tool decisions from
      // durable state (lr-8b2e); default to {} only when none was saved.
      // Sanitized (lr-8b2e hardening) so a malformed/injected persisted
      // record cannot silently auto-approve a tool.
      allowedTools: utils.sanitizeAllowedTools(opts && opts.allowedTools),
      isProcessing: false,
      title: title,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      history: cliHistory,
      _historyLoaded: true, // caller provided history directly
      // lr-2ea2a7: resumeSession's cliHistory is caller-provided full history
      // (readCliSessionHistory / fork's forkHistory slice) with absolute
      // index 0 as its own start — no entries have been trimmed off it yet.
      _historyBaseIndex: 0,
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

  // lr-2ea2a7: read a session's FULL history straight from disk without
  // touching any in-memory session state (session.history, _historyLoaded,
  // messageUUIDs, LRU order). Used by search, which previously called
  // loadSessionHistory() and so permanently loaded full history for up to 50
  // sessions into heap on every content search — itself an unbounded-growth
  // path this fix closes, not just the isProcessing leak. For a session
  // whose history IS already loaded, disk is still queried directly (rather
  // than reading session.history) so search results are identical regardless
  // of a session's current load state — no special-casing needed here, and
  // no risk of a stale/trimmed heap view producing incomplete search hits.
  function readSessionHistoryFromDisk(session) {
    if (!session.cliSessionId) return [];
    flushSessionBuffer(session);
    return _parseSessionFileLines(session).lines;
  }

  function searchSessions(query) {
    if (!query) return [];
    var q = query.toLowerCase();
    var results = [];
    sessions.forEach(function (session) {
      var titleMatch = (session.title || "New Session").toLowerCase().indexOf(q) !== -1;
      var contentMatch = false;
      if (titleMatch) {
        // Skip content search when title already matches — avoids a disk
        // read for sessions that are guaranteed to appear in results anyway.
      } else {
        var diskHistory = readSessionHistoryFromDisk(session);
        for (var i = 0; i < diskHistory.length; i++) {
          var entry = diskHistory[i];
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

    // lr-2ea2a7: streaming disk scan — does NOT call loadSessionHistory() and
    // does NOT mutate session.history/_historyLoaded/LRU state. historyIndex
    // values below are already absolute (disk line order), matching the
    // wire contract with no translation needed.
    var history = readSessionHistoryFromDisk(session);

    var q = query.toLowerCase();
    var qLen = query.length;
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
    broadcastSessionDeleted: broadcastSessionDeleted,
    getTotalUnread: function (ws) {
      var unreadMap = (ws && ws._clayUnread) ? ws._clayUnread : {};
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
    // lr-2ea2a7: cap-exempt full materialization + re-trim, for rewind/fork
    // consumers in project-sessions.js that may target a point older than
    // the current tail-loaded window.
    loadFullSessionHistory: loadFullSessionHistory,
    retrimHistory: retrimHistory,
    // lr-2ea2a7: the single choke point every session.history.push() site
    // must route through — see the grep-guard test.
    recordHistoryEntry: recordHistoryEntry,
    HISTORY_INMEM_MAX: HISTORY_INMEM_MAX,
    HISTORY_INMEM_TRIM_TO: HISTORY_INMEM_TRIM_TO,
    LRU_HISTORY_LIMIT: LRU_HISTORY_LIMIT,
    // lr-5e70: pressure-driven bulk eviction consumed by lib/memory-shed.js
    // on a MemoryHigh watermark crossing — see forceEvictToLimit above for
    // why this is distinct from the normal one-at-a-time _lruEvictIfNeeded.
    forceEvictToLimit: forceEvictToLimit,
    flushSessionBuffer: flushSessionBuffer,
    sendAndRecord: doSendAndRecord,
    sendToSession: doSendToSession,
    findTurnBoundary: findTurnBoundary,
    findLastTurnStart: findLastTurnStart,
    extendWindowForVisibility: extendWindowForVisibility,
    replayHistory: replayHistory,
    searchSessions: searchSessions,
    searchSessionContent: searchSessionContent,
    // lr-2ea2a7: streaming disk read with no heap retention — shared by
    // search internally and exposed for other full-history-scan consumers
    // (project-filesystem.js's fs_file_history) so they don't have to call
    // loadSessionHistory()/mutate session state just to scan for a match.
    readSessionHistoryFromDisk: readSessionHistoryFromDisk,
    // lr-2ea2a7 observability: per-session heap footprint + top-5 by
    // heapEntries, consumed by project-sessions.js's process_stats handler
    // so a future incident is diagnosable without a heap snapshot.
    getHistoryStats: function () {
      var perSession = [];
      sessions.forEach(function (s) {
        perSession.push({
          id: s.localId,
          heapEntries: s.history ? s.history.length : 0,
          baseIndex: s._historyBaseIndex || 0,
          isProcessing: !!s.isProcessing,
        });
      });
      var top5 = perSession.slice().sort(function (a, b) {
        return b.heapEntries - a.heapEntries;
      }).slice(0, 5);
      return { sessions: perSession, top5: top5 };
    },
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
    // Remove the process-level exit listener registered above.
    // Must be called when the project owning this session manager is destroyed
    // so listeners do not accumulate across project open/close cycles (lr-daca).
    destroy: function() {
      process.removeListener("exit", _onProcessExit);
    },
  };
}

module.exports = { createSessionManager };
