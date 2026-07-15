// memory-shed.js — in-process memory shedding response to a MemoryHigh
// watermark crossing (lr-5e70).
//
// lib/memory-limits.js's startMemoryHighWatcher detects a MemoryHigh
// crossing and fires an onCrossing callback, but on its own performs no
// in-process mitigation — the drain controller (lr-6b30) uses that same
// callback to start refusing new connections and eventually exit, which is
// the "make the daemon go away" response. This module is the other half:
// an immediate, in-process attempt to actually reduce RSS before drain's
// slower shutdown path completes, using machinery that already exists:
//   - retrimHistory() (lr-2ea2a7): re-applies the bounded in-heap history
//     tail cap to every loaded session, including the active/isProcessing
//     ones that are normally exempt from history trimming pressure.
//   - forceEvictToLimit() (lr-5e70, lib/sessions.js): drives the per-project
//     LRU-loaded-session count down to a pressure limit, well below the
//     normal LRU_HISTORY_LIMIT, evicting more aggressively than the routine
//     one-at-a-time post-load check.
//   - rebuildable caches: process-lifetime caches that exist purely as an
//     optimization and are safe to drop, because whatever reads them next
//     lazily rebuilds from source. Currently: lib/server-skills.js's
//     skillsCache (parsed skills.sh proxy responses, TTL-cached; a dropped
//     entry just re-fetches on next request).
//
// Design constraints:
//   - Never touches the actively-viewed session's history (retrimHistory
//     only trims down to the normal cap, never below it, and forceEvict
//     always skips a project's activeSessionId — same invariant every other
//     LRU/eviction path in this codebase already honors).
//   - Rate-limited to at most one shedding pass per RATE_LIMIT_MS: the
//     watermark watcher can re-fire on RSS hysteresis (strategy B), and a
//     shedding pass that is mostly I/O (disk reads for cache repopulation)
//     should not be allowed to run back-to-back.
//   - Never throws — a shedding pass must not itself crash the process that
//     is already under memory pressure.

'use strict';

// Minimum interval between shedding passes (ms). A crossing that arrives
// inside this window returns immediately with skipped=true rather than
// running a second pass.
var RATE_LIMIT_MS = 60 * 1000;

// Pressure-limit fraction applied to each project's normal LRU_HISTORY_LIMIT
// when forceEvictToLimit is driven under memory pressure — half the normal
// loaded-session ceiling, per the lr-5e70 spec.
var PRESSURE_LRU_FRACTION = 0.5;

var _lastShedAt = 0;

/**
 * Reset the internal rate-limit clock. Test-only — production code has no
 * legitimate reason to force a second pass inside the rate-limit window.
 * Set far enough in the past (not 0) so a caller-supplied `nowMs` override
 * near the Unix epoch (e.g. small test fixture values like 1000) is still
 * treated as outside the rate-limit window relative to this reset point.
 */
function _resetRateLimitForTest() {
  _lastShedAt = -Infinity;
}

/**
 * Run one memory-shedding pass across every loaded project.
 *
 * @param {object} opts
 * @param {Array<{slug: string, sm: object, send?: function(object): void}>} opts.projects
 *   Live project contexts to shed from. Each `sm` is a session manager
 *   instance (lib/sessions.js createSessionManager return value). `send`,
 *   when provided, is used to broadcast the memory_shed diagnostic to that
 *   project's connected clients (lib/project.js's ctx.send — session-
 *   independent, matches the existing settings-preflight diagnostic path).
 * @param {object} [opts.caches]
 *   Rebuildable caches to drop, keyed by name -> { drop: function(): void }.
 *   Each drop() is called inside a try/catch; failures are swallowed and
 *   that cache is omitted from cachesDropped.
 * @param {function(object): void} [opts.log]
 *   Structured log emitter. Defaults to a JSON line on stderr.
 * @param {number} [opts.nowMs] — override for testing (default Date.now()).
 * @param {number} [opts.rssBefore] — override for testing (default
 *   process.memoryUsage().rss).
 * @param {function(): number} [opts.readRssBytes] — override for testing;
 *   called once before and once after shedding to compute the before/after
 *   RSS delta reported in the log and diagnostic.
 * @returns {{
 *   skipped: boolean,
 *   reason?: string,
 *   beforeBytes?: number,
 *   afterBytes?: number,
 *   sessionsTrimmed?: number,
 *   sessionsEvicted?: number,
 *   cachesDropped?: string[]
 * }}
 */
function shedMemory(opts) {
  var o = opts || {};
  var projects = Array.isArray(o.projects) ? o.projects : [];
  var caches = o.caches || {};
  var _log = typeof o.log === 'function' ? o.log : function (event) {
    try { process.stderr.write('[memory-shed] ' + JSON.stringify(event) + '\n'); } catch (_) {}
  };
  var readRss = typeof o.readRssBytes === 'function'
    ? o.readRssBytes
    : function () { return process.memoryUsage().rss; };
  var now = typeof o.nowMs === 'number' ? o.nowMs : Date.now();

  if (now - _lastShedAt < RATE_LIMIT_MS) {
    return { skipped: true, reason: 'rate_limited' };
  }
  _lastShedAt = now;

  var beforeBytes = typeof o.rssBefore === 'number' ? o.rssBefore : readRss();

  var sessionsTrimmed = 0;
  var sessionsEvicted = 0;
  // lr-f36626: sessions force-evicted while carrying a live registered
  // background child (session.activeTaskToolIds non-empty at eviction time).
  // forceEvictToLimit only ever unloads in-heap history for these — it never
  // closes queryInstance, so the child itself is never killed — but the
  // operator still needs to know pressure reached as far as a live dispatch,
  // per lr-f36626's "never a silent orphan" requirement. Each entry carries
  // the project's send()/sendAndRecord so the per-session notification below
  // can run after the loop, once beforeBytes/afterBytes are both known.
  var liveChildReclaims = [];

  for (var pi = 0; pi < projects.length; pi++) {
    var proj = projects[pi];
    if (!proj || !proj.sm) continue;
    var sm = proj.sm;

    try {
      // 1. retrimHistory on every loaded session, including active/processing.
      // retrimHistory() is idempotent and a no-op when a session is already
      // within HISTORY_INMEM_MAX, so calling it unconditionally here is safe
      // and cheap even for sessions that never grew past the cap.
      sm.sessions.forEach(function (session) {
        if (!session._historyLoaded) return;
        var beforeLen = session.history.length;
        sm.retrimHistory(session);
        if (session.history.length < beforeLen) sessionsTrimmed++;
      });
    } catch (e) {
      // A single project's shedding step must not abort the whole pass.
    }

    try {
      // 2. Force-evict beyond the normal LRU limit down to a pressure limit,
      // still skipping the active session (forceEvictToLimit's own
      // invariant, shared with the routine LRU path). Live-child sessions
      // are only reached as a last resort within forceEvictToLimit itself
      // (pass 2) — see its header in lib/sessions.js.
      if (typeof sm.forceEvictToLimit === 'function' && typeof sm.LRU_HISTORY_LIMIT === 'number') {
        var pressureLimit = Math.max(1, Math.floor(sm.LRU_HISTORY_LIMIT * PRESSURE_LRU_FRACTION));
        var evictResult = sm.forceEvictToLimit(pressureLimit);
        sessionsEvicted += evictResult.evicted;
        for (var rci = 0; rci < evictResult.reclaimedLiveChild.length; rci++) {
          liveChildReclaims.push({
            session: evictResult.reclaimedLiveChild[rci],
            sm: sm,
            send: proj.send,
            slug: proj.slug,
          });
        }
      }
    } catch (e) {
      // Same isolation as above — one project's failure does not block others.
    }
  }

  // 3. Drop rebuildable caches.
  var cachesDropped = [];
  var cacheNames = Object.keys(caches);
  for (var ci = 0; ci < cacheNames.length; ci++) {
    var name = cacheNames[ci];
    var entry = caches[name];
    if (!entry || typeof entry.drop !== 'function') continue;
    try {
      entry.drop();
      cachesDropped.push(name);
    } catch (e) {
      // Skip — a cache that fails to drop is omitted from the report, not fatal.
    }
  }

  var afterBytes = readRss();

  var summary = {
    skipped: false,
    beforeBytes: beforeBytes,
    afterBytes: afterBytes,
    sessionsTrimmed: sessionsTrimmed,
    sessionsEvicted: sessionsEvicted,
    cachesDropped: cachesDropped,
    liveChildReclaimed: liveChildReclaims.length,
  };

  _log(Object.assign({
    event: 'memory_shed',
    timestamp: new Date(now).toISOString(),
  }, summary));

  // 4. UI diagnostic — session-independent, project-scoped broadcast (same
  // delivery path as settings-preflight's diagnostics: plain send(), not
  // sendAndRecord, since this has no session to attach to and is ephemeral).
  // Fires for every shedding pass, live-child reclaim or not — this is the
  // routine "memory pressure occurred" signal, distinct from the per-session
  // reclaim notification below.
  var deltaBytes = beforeBytes - afterBytes;
  var diagnostic = {
    type: 'diagnostic',
    severity: 'warning',
    source: 'memory',
    message: 'Memory pressure detected — shed ' + sessionsTrimmed + ' session history tail(s), evicted '
      + sessionsEvicted + ' loaded session(s), dropped ' + cachesDropped.length + ' cache(s). '
      + 'RSS ' + Math.round(beforeBytes / 1048576) + 'MB -> ' + Math.round(afterBytes / 1048576) + 'MB'
      + (deltaBytes > 0 ? ' (-' + Math.round(deltaBytes / 1048576) + 'MB)' : ''),
  };
  for (var si = 0; si < projects.length; si++) {
    var p = projects[si];
    if (p && typeof p.send === 'function') {
      try { p.send(diagnostic); } catch (e) { /* one client's send failure must not block others */ }
    }
  }

  // 5. lr-f36626: per-session notification + durable AUTO-RESUME marker for
  // every session force-evicted while a live background child was
  // registered. This is the ONLY reap-adjacent path allowed to reclaim a
  // live-child session (the idle reaper in sdk-bridge.js now refuses to —
  // see the lastActivityAt bump on subagent stream events in
  // sdk-message-processor.js), and per spec it must never do so silently:
  //   - session.pendingAutoResume=true is a durable flag (persisted via
  //     sm.saveSessionFile) so a later reconnect / session-list read can
  //     drive a console-initiated AUTO-RESUME of that session — the "durable
  //     checkpoint" is the on-disk session file itself (source of truth is
  //     already disk per lr-2ea2a7; this eviction never touched it) plus
  //     this marker recording WHY a resume is expected.
  //   - Diagnostics panel: same broadcast diagnostic path as step 4, one
  //     entry per reclaimed session, source 'memory-reclaim' so it reads
  //     distinctly from the routine pressure diagnostic above.
  //   - Inline red chat marker: sendAndRecord'd into the affected session's
  //     own history via the existing type:"error" -> addSystemMessage(...,
  //     true) render path (sys-msg.error) — zero new frontend code, and it
  //     replays correctly on reconnect like any other history entry.
  for (var li = 0; li < liveChildReclaims.length; li++) {
    var reclaim = liveChildReclaims[li];
    var rSession = reclaim.session;
    if (!rSession) continue;
    try {
      rSession.pendingAutoResume = true;
      rSession.pendingAutoResumeReason = 'memory_pressure_reclaim';
      if (reclaim.sm && typeof reclaim.sm.saveSessionFile === 'function') {
        reclaim.sm.saveSessionFile(rSession);
      }
    } catch (e) {
      // Marker persistence failing must not block the notification below —
      // the operator still needs to see the reclaim happened.
    }

    var reclaimMessage = 'Memory pressure reclaimed this session while a background task was still running. '
      + 'It will auto-resume; if it does not, resume it manually.';

    if (reclaim.send) {
      try {
        reclaim.send({
          type: 'diagnostic',
          severity: 'warning',
          source: 'memory-reclaim',
          message: (reclaim.slug ? '[' + reclaim.slug + '] ' : '') + reclaimMessage,
        });
      } catch (e) { /* one client's send failure must not block others */ }
    }

    if (reclaim.sm && typeof reclaim.sm.sendAndRecord === 'function') {
      try {
        reclaim.sm.sendAndRecord(rSession, { type: 'error', text: reclaimMessage });
      } catch (e) { /* inline marker failing must not block the rest of the pass */ }
    }
  }

  return summary;
}

module.exports = {
  shedMemory: shedMemory,
  RATE_LIMIT_MS: RATE_LIMIT_MS,
  PRESSURE_LRU_FRACTION: PRESSURE_LRU_FRACTION,
  _resetRateLimitForTest: _resetRateLimitForTest,
};
