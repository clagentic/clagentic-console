var fs = require("fs");
var path = require("path");

// How long (ms) to keep processed trigger files before pruning on startup.
var PROCESSED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (processed/ and expired/)
// Default grace period before an unprocessed trigger is moved to expired/.
var DEFAULT_UNPROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
var CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000; // future createdAt beyond this is ignored
var POLL_INTERVAL_MS = 30 * 1000;       // 30 s backstop scan
var WATCHER_REARM_INTERVAL_MS = 5 * 60 * 1000; // 5 min inotify rebind

/**
 * External trigger watcher — global singleton.
 *
 * Watches ~/.clagentic/external-triggers/ for JSON files dropped by external
 * processes (scripts, daemons, agents). When a valid trigger file appears,
 * either opens a new session (v1 / v2 without sessionId) or injects a message
 * into an existing session (v2 with sessionId). The file is moved to
 * processed/ on success.
 *
 * Schema v1 (all fields except * are required):
 *   { version: 1, id, projectSlug, initialPrompt, contextNote*, cwd*, createdAt* }
 *   -> always spawns a new session (backward-compatible, v1 files remain valid)
 *
 * Schema v2 (all fields except * are required):
 *   { version: 2, id, projectSlug, initialPrompt, contextNote*, cwd*, createdAt*, sessionId* }
 *   -> if sessionId present: pushMessage to the named session (mid-session inject)
 *   -> if sessionId absent:  spawnSession (same as v1)
 *   On push_message path, if sessionId is not found the trigger is NOT archived
 *   so daemon-down recovery can retry when the session reconnects.
 *
 * contextNote on the push_message path: sdk.pushMessage(session, text, images)
 * takes IMAGES as its third argument, so contextNote is never passed there
 * (it stays null). The prompt text delivered to the agent is unchanged; instead
 * a user_message entry carrying { source: "external-trigger", triggerId,
 * contextNote } is recorded in the session history and session file so the
 * agent-origin is distinguishable from operator-typed input. The entry is
 * recorded only after the push succeeds, so retries never duplicate it.
 *
 * Trigger lifecycle directories under triggersDir:
 *   (triggersDir)  — pending / retrying
 *   processed/     — delivered
 *   expired/       — never delivered within the grace period
 * A file still in the triggers dir once its age exceeds unprocessedTtlMs is
 * MOVED (never deleted) to expired/. This covers push_message triggers whose
 * session is never found, malformed JSON, schema-invalid files, and unknown
 * projectSlug. Age is the parsed trigger.createdAt when it is a valid date
 * not more than 5 minutes in the future, else the file mtime. The check runs on every scan (startup + 30 s poll).
 * processed/ and expired/ files older than 30 days are pruned.
 *
 * ctx fields:
 *   triggersDir    — absolute path to ~/.clagentic/external-triggers/
 *   getProject     — function(slug) -> project context | null
 *   unprocessedTtlMs — optional grace period before expiry (default 7 days)
 *
 * Security: triggers dir is under the user's home. Any process running as
 * the same OS user can write files. Acceptable for single-user self-hosted
 * installs. Multi-user deployments should use per-user subdirs (future work).
 *
 * Daemon-down recovery: unprocessed files that predate the current process
 * start are picked up via a startup scan (scanExisting). No file is lost
 * if the daemon is restarted while triggers are pending.
 *
 * Watcher hardening (three layers):
 *   Layer 1 — 30 s polling backstop: scanExisting() on an interval so files
 *             are never permanently missed if fs.watch silently dies.
 *   Layer 2 — 5 min periodic re-arm: close and re-open the fs.watch binding
 *             so the inotify registration is never more than 5 min stale.
 *   Layer 3 — health export: getHealth() returns watcher liveness, last-event
 *             timestamp, and poll-interval presence for external monitoring.
 */
function attachExternalTrigger(ctx) {
  var triggersDir = ctx.triggersDir;
  var getProject = ctx.getProject;

  var triggersRoot = path.dirname(path.join(triggersDir, "x"));
  var processedDir = path.join(triggersDir, "processed");
  var expiredDir = path.join(triggersDir, "expired");
  var unprocessedTtlMs = (typeof ctx.unprocessedTtlMs === "number" && ctx.unprocessedTtlMs >= 0)
    ? ctx.unprocessedTtlMs : DEFAULT_UNPROCESSED_TTL_MS;
  var watcher = null;
  var debounce = null;
  // Track IDs already dispatched this session to guard against double-fire
  // from the initial scan + watcher race.
  var dispatched = {};

  // Hardening state
  var pollInterval = null;
  var rearmTimer = null;
  var watcherLastEventMs = 0;

  // --- Directory setup ---

  function ensureDirs() {
    try { fs.mkdirSync(triggersDir, { recursive: true }); } catch (e) {}
    try { fs.mkdirSync(processedDir, { recursive: true }); } catch (e) {}
    try { fs.mkdirSync(expiredDir, { recursive: true }); } catch (e) {}
  }

  // --- Trigger file validation ---

  function validateTrigger(obj) {
    if (!obj || typeof obj !== "object") return "not an object";
    if (obj.version !== 1 && obj.version !== 2) return "unsupported version: " + obj.version;
    if (!obj.id || typeof obj.id !== "string") return "missing id";
    if (!obj.projectSlug || typeof obj.projectSlug !== "string") return "missing projectSlug";
    if (!obj.initialPrompt || typeof obj.initialPrompt !== "string") return "missing initialPrompt";
    // sessionId is optional; if present it must be a non-empty string
    if (obj.sessionId !== undefined && (typeof obj.sessionId !== "string" || !obj.sessionId)) {
      return "sessionId must be a non-empty string when present";
    }
    return null; // valid
  }

  // --- Session spawn ---

  function spawnSession(project, trigger) {
    var sm = project.sm;
    var sdk = project.sdk;
    var send = project.send;
    var onProcessingChanged = project.onProcessingChanged;
    var getLinuxUserForSession = project.getLinuxUserForSession;

    if (!sm || !sdk || !send || !onProcessingChanged || !getLinuxUserForSession) {
      console.error("[external-trigger] Project context missing required fields for slug:", trigger.projectSlug);
      return false;
    }

    var sess = sm.createSession({});
    sess.title = (trigger.contextNote || "External trigger") + " — " + trigger.id.substring(0, 12);
    if (trigger.cwd) sess.cwd = trigger.cwd;
    sm.saveSessionFile(sess);
    sm.broadcastSessionList();

    var userMsg = { type: "user_message", text: trigger.initialPrompt };
    // lr-2ea2a7: routes through the shared history-cap helper (see grep-guard test).
    sm.recordHistoryEntry(sess, userMsg, true);
    sm.appendToSessionFile(sess, userMsg);

    sess.isProcessing = true;
    onProcessingChanged();
    sess.sentToolResults = {};
    // singleTurn=false (default): session stays open for human follow-up.
    // The trigger JSON can set singleTurn:true for fire-and-forget agentic
    // dispatches (not part of v1 schema, reserved for future use).
    sess.acceptEditsAfterStart = true;

    try {
      sdk.startQuery(sess, trigger.initialPrompt, undefined, getLinuxUserForSession(sess));
    } catch (e) {
      console.error("[external-trigger] startQuery failed for trigger " + trigger.id + ":", e.message || e);
      return false;
    }

    console.log("[external-trigger] Session spawned: project=" + trigger.projectSlug + " session=" + sess.localId + " trigger=" + trigger.id);
    return true;
  }

  // --- Mid-session inject ---

  // Marks the pushed message as agent-origin in history/session file. Failure
  // here must not turn a delivered message into a retry (double delivery).
  function recordPushedMessage(sm, sess, trigger) {
    var entry = {
      type: "user_message",
      text: trigger.initialPrompt,
      source: "external-trigger",
      triggerId: trigger.id,
    };
    if (trigger.contextNote) entry.contextNote = trigger.contextNote;
    try {
      sm.recordHistoryEntry(sess, entry, true);
      sm.appendToSessionFile(sess, entry);
    } catch (e) {
      console.error("[external-trigger] Failed to record pushed message for trigger " + trigger.id + ":", e.message || e);
    }
  }

  function pushMessageToSession(project, trigger) {
    var sm = project.sm;
    var sdk = project.sdk;

    if (!sm || !sdk) {
      console.error("[external-trigger] Project context missing sm/sdk for push_message, slug:", trigger.projectSlug);
      return "error";
    }

    var found = null;
    sm.sessions.forEach(function (s) {
      if (!found && s.cliSessionId === trigger.sessionId) {
        found = s;
      }
    });

    if (!found) {
      console.warn("[external-trigger] push_message: session not found: " + trigger.sessionId + " (trigger " + trigger.id + " not archived — will retry)");
      return "not_found";
    }

    try {
      // Third argument is images, not metadata: contextNote travels via the
      // recorded history entry below.
      sdk.pushMessage(found, trigger.initialPrompt, null);
      console.log("[external-trigger] push_message delivered to session " + trigger.sessionId + " (trigger " + trigger.id + ")");
      recordPushedMessage(sm, found, trigger);
      return "ok";
    } catch (e) {
      console.error("[external-trigger] push_message failed for trigger " + trigger.id + ":", e.message || e);
      return "error";
    }
  }

  // --- Archive ---

  function archiveTrigger(triggerPath, id) {
    var dest = path.join(processedDir, id + ".json");
    try {
      fs.renameSync(triggerPath, dest);
    } catch (e) {
      // Cross-device or race — try copy+delete
      try {
        fs.copyFileSync(triggerPath, dest);
        fs.unlinkSync(triggerPath);
      } catch (e2) {
        console.error("[external-trigger] Failed to archive trigger " + id + ":", e2.message || e2);
      }
    }
  }

  // --- Expiry ---

  function triggerAgeMs(filePath, obj) {
    if (obj && typeof obj.createdAt === "string") {
      var t = Date.parse(obj.createdAt);
      // A createdAt beyond the skew tolerance is untrustworthy (bad producer
      // clock) and would otherwise dodge the TTL forever; use mtime instead.
      if (!isNaN(t) && t <= Date.now() + CLOCK_SKEW_TOLERANCE_MS) return Date.now() - t;
    }
    try { return Date.now() - fs.statSync(filePath).mtimeMs; } catch (e) { return 0; }
  }

  // Moves filePath to expired/ when past the grace period. Returns true if moved.
  function expireIfStale(filePath, obj) {
    if (triggerAgeMs(filePath, obj) <= unprocessedTtlMs) return false;
    var base = path.basename(filePath);
    try { fs.mkdirSync(expiredDir, { recursive: true }); } catch (e) {}
    var dest = path.join(expiredDir, base);
    try {
      fs.renameSync(filePath, dest);
    } catch (e) {
      try {
        fs.copyFileSync(filePath, dest);
        fs.unlinkSync(filePath);
      } catch (e2) {
        console.error("[external-trigger] Failed to expire trigger " + base + ":", e2.message || e2);
        return false;
      }
    }
    if (obj && obj.id) delete dispatched[obj.id];
    console.warn("[external-trigger] Trigger " + base + " undelivered past TTL — moved to expired/");
    return true;
  }

  // --- File handler ---

  function handleFile(filePath) {
    var base = path.basename(filePath);
    if (!base.endsWith(".json")) return;
    // Only direct children of the triggers dir are triggers; entries in
    // processed/ or expired/ are excluded by exact directory match, so a
    // top-level processed-<id>.json is still a normal trigger.
    if (path.dirname(filePath) !== triggersRoot) return;

    var raw;
    try { raw = fs.readFileSync(filePath, "utf8"); } catch (e) { return; }

    var obj;
    try { obj = JSON.parse(raw); } catch (e) {
      if (expireIfStale(filePath, null)) return;
      console.warn("[external-trigger] Malformed JSON in " + base + ":", e.message);
      return;
    }

    var err = validateTrigger(obj);
    if (err) {
      if (expireIfStale(filePath, obj)) return;
      console.warn("[external-trigger] Invalid trigger " + base + ": " + err);
      return;
    }

    // Before the dispatched guard: files held back by it (unknown project,
    // push error) must still expire.
    if (expireIfStale(filePath, obj)) return;

    var id = obj.id;
    if (dispatched[id]) return; // already handled this session
    dispatched[id] = true;

    var project = getProject(obj.projectSlug);
    if (!project) {
      console.warn("[external-trigger] Unknown projectSlug '" + obj.projectSlug + "' in trigger " + id + " — dropping");
      return;
    }

    if (obj.sessionId) {
      // v2 mid-session inject path
      var result = pushMessageToSession(project, obj);
      if (result === "ok") {
        archiveTrigger(filePath, id);
      } else if (result === "not_found") {
        // Do not archive — allow daemon-down / timing retry.
        // Clear dispatched so the watcher can re-process if the file is still present.
        delete dispatched[id];
      }
      // "error" case: leave dispatched[id] set to avoid a rapid retry loop.
    } else {
      var ok = spawnSession(project, obj);
      if (ok) {
        archiveTrigger(filePath, id);
      }
    }
  }

  // --- Watcher ---

  function onDirChange() {
    clearTimeout(debounce);
    debounce = setTimeout(function () {
      var files;
      try { files = fs.readdirSync(triggersDir); } catch (e) { return; }
      for (var i = 0; i < files.length; i++) {
        if (!files[i].endsWith(".json")) continue;
        handleFile(path.join(triggersDir, files[i]));
      }
    }, 200);
  }

  // --- Layer 2: periodic watcher re-arm ---

  function armWatcher() {
    if (watcher) {
      try { watcher.close(); } catch (e) {}
      watcher = null;
    }
    try {
      watcher = fs.watch(triggersDir, function (eventType, filename) {
        watcherLastEventMs = Date.now();
        if (filename && !filename.endsWith(".json")) return;
        onDirChange();
      });
      watcher.on("error", function (e) {
        console.error("[external-trigger] Watcher error:", e.message || e);
        stopWatcher();
      });
    } catch (e) {
      console.error("[external-trigger] Failed to arm watcher:", e.message || e);
    }
  }

  function startWatcher() {
    ensureDirs();
    pruneOldProcessed();
    scanExisting(); // pick up files dropped while daemon was down

    armWatcher();
    console.log("[external-trigger] Watching:", triggersDir);

    // Layer 1: polling backstop — catches files if fs.watch silently dies
    pollInterval = setInterval(function () {
      scanExisting();
    }, POLL_INTERVAL_MS);
    pollInterval.unref();

    // Layer 2: periodic re-arm — keeps inotify registration fresh
    rearmTimer = setInterval(function () {
      armWatcher();
      console.log("[external-trigger] Watcher re-armed");
    }, WATCHER_REARM_INTERVAL_MS);
    rearmTimer.unref();
  }

  function stopWatcher() {
    clearTimeout(debounce);
    if (watcher) {
      try { watcher.close(); } catch (e) {}
      watcher = null;
    }
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (rearmTimer) {
      clearInterval(rearmTimer);
      rearmTimer = null;
    }
  }

  // --- Startup scan (daemon-down recovery) ---

  function scanExisting() {
    var files;
    try { files = fs.readdirSync(triggersDir); } catch (e) { return; }
    for (var i = 0; i < files.length; i++) {
      if (!files[i].endsWith(".json")) continue;
      handleFile(path.join(triggersDir, files[i]));
    }
  }

  // --- Processed file pruning ---

  function pruneOldProcessed() {
    pruneDir(processedDir);
    pruneDir(expiredDir);
  }

  function pruneDir(dir) {
    var now = Date.now();
    var files;
    try { files = fs.readdirSync(dir); } catch (e) { return; }
    for (var i = 0; i < files.length; i++) {
      var fp = path.join(dir, files[i]);
      try {
        var stat = fs.statSync(fp);
        if (now - stat.mtimeMs > PROCESSED_MAX_AGE_MS) {
          fs.unlinkSync(fp);
        }
      } catch (e) {}
    }
  }

  return {
    startWatcher: startWatcher,
    stopWatcher: stopWatcher,
    // Layer 3: health export for external monitoring
    getHealth: function () {
      return {
        watcherAlive: !!watcher,
        lastEventMs: watcherLastEventMs,
        pollActive: !!pollInterval,
      };
    },
  };
}

module.exports = { attachExternalTrigger: attachExternalTrigger };
