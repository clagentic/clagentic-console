// lr-9bcd7b: Server-authoritative activity registry.
//
// Problem this replaces: session.isProcessing is written directly at ~26
// scattered call sites across roughly 8 files (sdk-message-processor.js,
// sdk-bridge.js, project-sessions.js, and others). One of those sites --
// the SDK 'result' handler -- clears it unconditionally with no check for
// a still-running backgrounded Task subagent (lr-255e close comment #8,
// residual #2). session_list ships isProcessing per session
// (lib/sessions.js mapSessionForClient) and every session/project/recent
// picker renders it, so every picker's green dot goes dark the instant a
// subagent starts, on top of the equivalent in-conversation dots bug.
//
// Design: reference-counted token registry, one per session, stored as
// plain data. isProcessing becomes DERIVED (token count > 0) instead of an
// independently written boolean. Any subsystem that starts genuine session
// activity acquires a token; it releases the SAME token on every terminal
// path (success, error, abort). The derived boolean cannot go stale because
// of a single missed clear site the way the old boolean could -- as long as
// acquire/release are balanced, and leak resistance (below) covers the case
// where they are not.
//
// Leak resistance -- four layers, PRIMARY listed first, weakest listed last.
// A design that trades "dots missing" for "dots stuck on forever" is not an
// improvement (a stuck dot destroys trust in the signal permanently), so
// the layers are ordered by how proactively they prevent that outcome:
//
//   1. PRIMARY -- generation counter. Each token is stamped with the
//      session's activity generation at acquire time. bumpGeneration(session)
//      (called by the caller on every genuine new-query/turn boundary) makes
//      every token from a prior generation invisible to isSessionActive/
//      getActiveCount immediately, with no timer and no explicit release
//      required. This is the same ownership-guard shape already proved in
//      this codebase for query/session ownership (sdk-bridge.js's
//      `session.queryInstance === myQueryInstance` checks around the
//      processQueryStream finally block) -- a stale reference from an
//      earlier generation is simply outvoted, not manually hunted down.
//   2. Explicit release on every known terminal path (tool_result,
//      task_notification, turn-boundary block_stop cleanup) -- ordinary,
//      expected cleanup, exercised directly by this module's tests and by
//      the sdk-message-processor wiring.
//   3. BACKSTOP ONLY -- staleness sweep. sweepStaleTokens(session, maxAgeMs)
//      drops any token older than maxAgeMs regardless of generation. This
//      exists purely to bound the worst case (a token whose owning
//      subsystem died without ever calling release AND without a
//      generation bump happening in between -- e.g. a session that idles
//      forever mid-turn). It is not the primary defense and must never be
//      the ONLY thing keeping the registry honest; layers 1 and 2 are
//      expected to handle the overwhelming majority of releases.
//   4. Wholesale replacement on reconnect, never merge. hydrateSnapshot()
//      always REPLACES a session's registry outright rather than merging
//      entries -- a reconnecting client must never see a union of stale
//      pre-disconnect tokens and fresh post-reconnect ones.
//
// Chattiness mitigation -- mandatory, not optional (see lr-9bcd7b spec).
// isProcessing changed ~2x/turn under the old boolean; a token registry
// changes on every tool start/stop and every subagent progress tick, which
// would be an O(sessions x clients) JSON-serialization broadcast per tool
// call if naively wired to broadcastSessionList(). The registry itself
// does NOT broadcast anything -- it is plain data. The caller (sdk-bridge.js/
// sdk-message-processor.js) is responsible for calling acquireToken/
// releaseToken and reacting ONLY to the returned `changed` flag, which is
// true exactly on a 0->1 or 1->0 transition of the derived boolean.
// Acquiring a second token while the session is already active (count >=1
// before the call) returns changed:false -- the derived boolean does not
// move, so the caller must not broadcast. This collapses volume back to
// roughly the old ~2x/turn rate (only the first acquire and the last
// release of any turn actually flip the boolean), independent of how many
// tools/subagents are concurrently active.

/**
 * Create a fresh, empty activity registry for a session.
 * @returns {{tokens: object, generation: number}}
 */
function createRegistry() {
  return {
    tokens: {},   // token -> { source, label, startedAt, generation }
    generation: 0,
  };
}

/**
 * Ensure session.activity exists, creating it if this is the first call for
 * this session. Callers should prefer this over reading session.activity
 * directly so a session created before this module existed (or a bare test
 * double) degrades to an empty registry instead of throwing.
 * @param {object} session
 * @returns {{tokens: object, generation: number}}
 */
function ensureRegistry(session) {
  if (!session.activity) session.activity = createRegistry();
  return session.activity;
}

/**
 * True if the session has at least one live (current-generation) token.
 * This is the DERIVED value that replaces session.isProcessing as a
 * server-side write target -- see the module header for why write sites
 * are being retired in favor of reading this.
 * @param {object} session
 * @returns {boolean}
 */
function isSessionActive(session) {
  return getActiveCount(session) > 0;
}

/**
 * Count of live (current-generation) tokens. Stale-generation tokens that
 * have not yet been physically swept still don't count -- generation is
 * checked at read time, not just at sweep time, so a generation bump takes
 * effect immediately even before sweepStaleTokens or the next acquire/
 * release physically deletes the entries.
 * @param {object} session
 * @returns {number}
 */
function getActiveCount(session) {
  var registry = ensureRegistry(session);
  var count = 0;
  for (var token in registry.tokens) {
    if (registry.tokens[token].generation === registry.generation) count++;
  }
  return count;
}

/**
 * Acquire a new activity token for `source` (e.g. "task", "tool",
 * "subagent"). Stamps the token with the session's CURRENT generation, so a
 * token acquired just before a generation bump is immediately treated as
 * stale by every reader without needing its own release call.
 *
 * @param {object} session
 * @param {string} token - caller-chosen unique id (e.g. a tool_use id).
 *   Acquiring the same token twice is idempotent (see double-acquire note
 *   below) -- the second call refreshes label/startedAt but does not
 *   double-count or change `changed`.
 * @param {object} [info] - { source, label }
 * @returns {{changed: boolean, activeCount: number}}
 *   changed is true only on a 0->1 transition of isSessionActive -- the
 *   mandatory chattiness invariant. Acquiring a second (or further) token
 *   while the session is already active returns changed:false.
 */
function acquireToken(session, token, info) {
  var registry = ensureRegistry(session);
  var wasActive = isSessionActive(session);
  var existed = Object.prototype.hasOwnProperty.call(registry.tokens, token)
    && registry.tokens[token].generation === registry.generation;
  registry.tokens[token] = {
    source: (info && info.source) || "unknown",
    label: (info && info.label) || "",
    startedAt: existed ? registry.tokens[token].startedAt : Date.now(),
    generation: registry.generation,
  };
  var nowActive = true; // acquiring always leaves at least one live token
  return { changed: !wasActive && nowActive, activeCount: getActiveCount(session) };
}

/**
 * Release a token. Idempotent -- releasing an already-released or
 * never-acquired token is a no-op (returns changed:false), never an error.
 * This matters because multiple terminal paths can race to release the
 * same logical unit of work (e.g. tool_result AND a later task_notification
 * for the same Task tool id) -- see sdk-message-processor.js's existing
 * lr-9d4b ownership-cleanup pattern, which this mirrors.
 *
 * @param {object} session
 * @param {string} token
 * @returns {{changed: boolean, activeCount: number}}
 *   changed is true only on a 1->0 transition of isSessionActive.
 */
function releaseToken(session, token) {
  var registry = ensureRegistry(session);
  var wasActive = isSessionActive(session);
  delete registry.tokens[token];
  var nowActive = isSessionActive(session);
  return { changed: wasActive && !nowActive, activeCount: getActiveCount(session) };
}

/**
 * PRIMARY leak-resistance layer. Bump the session's activity generation --
 * every token acquired before this call becomes invisible to
 * isSessionActive/getActiveCount immediately, with no explicit release
 * needed. Callers should invoke this at genuine new-query/turn-start
 * boundaries (the same boundary sdk-bridge.js already treats as
 * "isNewQuery" / resets activeTaskToolIds for) so a subagent or tool that
 * died silently mid-turn cannot hold the indicator on forever into an
 * unrelated later turn.
 *
 * This reuses the ownership-guard SHAPE already proved in this codebase at
 * sdk-bridge.js's `session.queryInstance === myQueryInstance` checks (a
 * stale reference is outvoted by identity/generation comparison, not
 * tracked down and manually cleared) -- see lr-8355.
 *
 * @param {object} session
 * @returns {{changed: boolean, activeCount: number}}
 *   changed is true if this bump caused a transition from active to
 *   inactive (i.e. every live token was stale-generation and got dropped).
 */
function bumpGeneration(session) {
  var registry = ensureRegistry(session);
  var wasActive = isSessionActive(session);
  registry.generation++;
  // Physically drop stale entries now rather than waiting for the next
  // sweep -- keeps registry.tokens from growing unboundedly across a very
  // long-lived session with many turns.
  for (var token in registry.tokens) {
    if (registry.tokens[token].generation !== registry.generation) {
      delete registry.tokens[token];
    }
  }
  var nowActive = isSessionActive(session);
  return { changed: wasActive && !nowActive, activeCount: getActiveCount(session) };
}

/**
 * BACKSTOP ONLY leak-resistance layer -- see module header. Drops any token
 * older than maxAgeMs regardless of generation. Never call this as the
 * primary mechanism for clearing activity; it exists solely to bound the
 * worst case where a subsystem died without releasing AND no generation
 * bump has happened since (e.g. a session idling forever mid-turn with no
 * new query started).
 *
 * @param {object} session
 * @param {number} maxAgeMs
 * @returns {{changed: boolean, activeCount: number, swept: number}}
 */
function sweepStaleTokens(session, maxAgeMs) {
  var registry = ensureRegistry(session);
  var wasActive = isSessionActive(session);
  var now = Date.now();
  var swept = 0;
  for (var token in registry.tokens) {
    if (now - registry.tokens[token].startedAt > maxAgeMs) {
      delete registry.tokens[token];
      swept++;
    }
  }
  var nowActive = isSessionActive(session);
  return { changed: wasActive && !nowActive, activeCount: getActiveCount(session), swept: swept };
}

/**
 * Wholesale-replace a session's registry (used on reconnect hydration) --
 * NEVER merge with whatever the client last saw. See module header layer 4.
 * @param {object} session
 * @param {{tokens: object, generation: number}} [snapshot] - defaults to a
 *   fresh empty registry when omitted, matching "reconnect clears activity
 *   unless the caller has a live snapshot to restore".
 */
function replaceRegistry(session, snapshot) {
  session.activity = snapshot || createRegistry();
}

/**
 * Detailed per-source breakdown of currently-live tokens, for scoping to
 * the viewing client only (ws._clayActiveSession-style filtering) rather
 * than broadcasting to every connected client -- see lr-9bcd7b spec's
 * chattiness mitigation #3.
 * @param {object} session
 * @returns {Array<{token: string, source: string, label: string, startedAt: number}>}
 */
function listActiveSources(session) {
  var registry = ensureRegistry(session);
  var out = [];
  for (var token in registry.tokens) {
    var entry = registry.tokens[token];
    if (entry.generation !== registry.generation) continue;
    out.push({ token: token, source: entry.source, label: entry.label, startedAt: entry.startedAt });
  }
  return out;
}

module.exports = {
  createRegistry: createRegistry,
  ensureRegistry: ensureRegistry,
  isSessionActive: isSessionActive,
  getActiveCount: getActiveCount,
  acquireToken: acquireToken,
  releaseToken: releaseToken,
  bumpGeneration: bumpGeneration,
  sweepStaleTokens: sweepStaleTokens,
  replaceRegistry: replaceRegistry,
  listActiveSources: listActiveSources,
};
