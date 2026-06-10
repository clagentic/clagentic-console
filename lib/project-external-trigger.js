var fs = require("fs");
var path = require("path");

// How long (ms) to keep processed trigger files before pruning on startup.
var PROCESSED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
 * ctx fields:
 *   triggersDir    — absolute path to ~/.clagentic/external-triggers/
 *   getProject     — function(slug) -> project context | null
 *
 * Security: triggers dir is under the user's home. Any process running as
 * the same OS user can write files. Acceptable for single-user self-hosted
 * installs. Multi-user deployments should use per-user subdirs (future work).
 *
 * Daemon-down recovery: unprocessed files that predate the current process
 * start are picked up via a startup scan (scanExisting). No file is lost
 * if the daemon is restarted while triggers are pending.
 */
function attachExternalTrigger(ctx) {
  var triggersDir = ctx.triggersDir;
  var getProject = ctx.getProject;

  var processedDir = path.join(triggersDir, "processed");
  var watcher = null;
  var debounce = null;
  // Track IDs already dispatched this session to guard against double-fire
  // from the initial scan + watcher race.
  var dispatched = {};

  // --- Directory setup ---

  function ensureDirs() {
    try { fs.mkdirSync(triggersDir, { recursive: true }); } catch (e) {}
    try { fs.mkdirSync(processedDir, { recursive: true }); } catch (e) {}
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
    sess.history.push(userMsg);
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
      sdk.pushMessage(found, trigger.initialPrompt, null);
      console.log("[external-trigger] push_message delivered to session " + trigger.sessionId + " (trigger " + trigger.id + ")");
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

  // --- File handler ---

  function handleFile(filePath) {
    var base = path.basename(filePath);
    if (!base.endsWith(".json")) return;
    // Skip processed/ subdir entries that might bubble up
    if (filePath.indexOf(processedDir) === 0) return;

    var raw;
    try { raw = fs.readFileSync(filePath, "utf8"); } catch (e) { return; }

    var obj;
    try { obj = JSON.parse(raw); } catch (e) {
      console.warn("[external-trigger] Malformed JSON in " + base + ":", e.message);
      return;
    }

    var err = validateTrigger(obj);
    if (err) {
      console.warn("[external-trigger] Invalid trigger " + base + ": " + err);
      return;
    }

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
        var fp = path.join(triggersDir, files[i]);
        // Skip entries inside processed/ subdir
        if (fp.indexOf(processedDir) === 0) continue;
        handleFile(fp);
      }
    }, 200);
  }

  function startWatcher() {
    ensureDirs();
    pruneOldProcessed();
    scanExisting(); // pick up files dropped while daemon was down
    try {
      watcher = fs.watch(triggersDir, function (eventType, filename) {
        if (filename && !filename.endsWith(".json")) return;
        onDirChange();
      });
      watcher.on("error", function (e) {
        console.error("[external-trigger] Watcher error:", e.message || e);
        stopWatcher();
      });
      console.log("[external-trigger] Watching:", triggersDir);
    } catch (e) {
      console.error("[external-trigger] Failed to start watcher:", e.message || e);
    }
  }

  function stopWatcher() {
    clearTimeout(debounce);
    if (watcher) {
      try { watcher.close(); } catch (e) {}
      watcher = null;
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
    var now = Date.now();
    var files;
    try { files = fs.readdirSync(processedDir); } catch (e) { return; }
    for (var i = 0; i < files.length; i++) {
      var fp = path.join(processedDir, files[i]);
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
  };
}

module.exports = { attachExternalTrigger: attachExternalTrigger };

