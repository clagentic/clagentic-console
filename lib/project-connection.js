var fs = require("fs");
var path = require("path");
var usersModule = require("./users");
var userPresence = require("./user-presence");
var { getCodexConfig } = require("./codex-defaults");
// detectLite is cached per-project in project.js and passed via ctx.liteStatus.
// This import is retained only for backward compat if ctx.liteStatus is absent.
var { detectLite } = require("./lite-detect");

/**
 * Attach connection/disconnection handlers to a project context.
 *
 * ctx fields:
 *   cwd, slug, isMate, osUsers, debug, dangerouslySkipPermissions,
 *   currentVersion, lanHost, sm, tm, nm, clients, send, sendTo,
 *   opts, loopState, loopRegistry, _loop, pushModule,
 *   hydrateImageRefs, broadcastClientCount, broadcastPresence,
 *   getProjectList, getHubSchedules, loadContextSources,
 *   handleMessage, handleDisconnection,
 *   stopFileWatch, stopAllDirWatches,
 *   getProjectOwnerId, setProjectOwnerId, getLatestVersion,
 *   getTitle, getProject
 */
function attachConnection(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var osUsers = ctx.osUsers;
  var debug = ctx.debug;
  var dangerouslySkipPermissions = ctx.dangerouslySkipPermissions;
  var dangerouslySkipPermissionsConfigured = ctx.dangerouslySkipPermissionsConfigured || false;
  var currentVersion = ctx.currentVersion;
  var lanHost = ctx.lanHost;
  var sm = ctx.sm;
  var tm = ctx.tm;
  var nm = ctx.nm;
  var clients = ctx.clients;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var opts = ctx.opts;
  var _loop = ctx._loop;
  var _mcp = ctx._mcp;
  var _notifications = ctx._notifications;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var broadcastClientCount = ctx.broadcastClientCount;
  var broadcastPresence = ctx.broadcastPresence;
  var getProjectList = ctx.getProjectList;
  var getHubSchedules = ctx.getHubSchedules;
  var loadContextSources = ctx.loadContextSources;
  var stopFileWatch = ctx.stopFileWatch;
  var stopAllDirWatches = ctx.stopAllDirWatches;
  var getProjectOwnerId = ctx.getProjectOwnerId;
  var setProjectOwnerId = ctx.setProjectOwnerId;
  var getLatestVersion = ctx.getLatestVersion;
  var getTitle = ctx.getTitle;
  var getProject = ctx.getProject;
  var warmup = ctx.warmup;

  // Adapters are initialized lazily: the first websocket connection into
  // this project triggers warmup. Without this guard we would either keep
  // the old eager behavior (30+ Codex processes at daemon start) or run
  // warmup once per reconnect.
  var _warmedUp = false;

  function findRestoredActiveSession(ws, wsUser, allSessions) {
    var active = null;
    var presenceKey = wsUser ? wsUser.id : "_default";
    var storedPresence = userPresence.getPresence(slug, presenceKey);
    if (storedPresence && storedPresence.sessionId) {
      if (sm.sessions.has(storedPresence.sessionId)) {
        active = sm.sessions.get(storedPresence.sessionId);
      } else {
        sm.sessions.forEach(function (s) {
          if (s.cliSessionId && s.cliSessionId === storedPresence.sessionId) active = s;
        });
      }
      if (active && wsUser) {
        if (!usersModule.canAccessSession(wsUser.id, active, { visibility: "public" })) active = null;
      }
    }
    if (!active && allSessions.length > 0) {
      active = allSessions[0];
      for (var fi = 1; fi < allSessions.length; fi++) {
        if ((allSessions[fi].lastActivity || 0) > (active.lastActivity || 0)) {
          active = allSessions[fi];
        }
      }
    }
    return { active: active, storedPresence: storedPresence };
  }

  function handleConnection(ws, wsUser, handleMessage, handleDisconnection) {
    ws._clayUser = wsUser || null;
    clients.add(ws);
    broadcastClientCount();

    if (!_warmedUp) {
      _warmedUp = true;
      if (typeof warmup === "function") {
        try { warmup(); }
        catch (e) { console.error("[project-connection] warmup failed for " + slug + ":", e && e.message ? e.message : e); }
      }
    }

    var loopState = _loop.loopState;
    var loopRegistry = _loop.loopRegistry;

    // Resume loop if server restarted mid-execution (deferred so client gets initial state first)
    if (loopState._needsResume) {
      delete loopState._needsResume;
      setTimeout(function() { _loop.resumeLoop(); }, 500);
    }

    var projectOwnerId = getProjectOwnerId();

    // Send cached state
    var _userId = ws._clayUser ? ws._clayUser.id : null;
    var _filteredProjects = getProjectList(_userId);
    var title = getTitle();
    var project = getProject();
    var ownerLocked = !!(osUsers && osUsers.length > 0 && /^\/home\/[^/]+\//.test(cwd));
    var allSessions = [].concat(Array.from(sm.sessions.values())).filter(function (s) { return !s.hidden; });
    if (wsUser) {
      allSessions = allSessions.filter(function (s) {
        return usersModule.canAccessSession(wsUser.id, s, { visibility: "public" });
      });
    }
    var restoredState = findRestoredActiveSession(ws, wsUser, allSessions);
    var restoredActive = restoredState.active;
    var initialVendor = (restoredActive && restoredActive.vendor) || sm.defaultVendor || "claude";
    var initialModels = (sm.modelsByVendor && sm.modelsByVendor[initialVendor]) || sm.availableModels || [];
    // Use the liteStatus cached at project-context creation time (project.js) to
    // avoid a synchronous execFileSync("which",...) on every WS connect.
    var _liteStatus = ctx.liteStatus || detectLite();
    var infoMsg = { type: "info", cwd: cwd, slug: slug, project: title || project, version: currentVersion, debug: !!debug, dangerouslySkipPermissions: dangerouslySkipPermissions, osUsers: osUsers, lanHost: lanHost, projectCount: _filteredProjects.length, projects: _filteredProjects, projectOwnerId: projectOwnerId, ownerLocked: ownerLocked, liteInstalled: _liteStatus.installed, liteHome: _liteStatus.liteHome };
    // When dangerouslySkipPermissions is set in config but suppressed because
    // multi-user mode is active, tell the client so it can surface a warning.
    if (dangerouslySkipPermissionsConfigured && !dangerouslySkipPermissions) {
      infoMsg.dangerouslySkipPermissionsBlocked = true;
    }
    sendTo(ws, infoMsg);
    // Update notifications are pushed on a scheduled interval (see
    // scheduleUpdateBroadcast). We no longer push on connect to avoid
    // re-triggering the banner on every page refresh.
    if (sm.slashCommands) {
      sendTo(ws, { type: "slash_commands", commands: sm.slashCommands });
    }
    if (sm.currentModel) {
      sendTo(ws, { type: "model_info", model: sm.currentModel, models: initialModels, vendor: initialVendor, availableVendors: sm.availableVendors || [], installedVendors: sm.installedVendors || [] });
    }
    sendTo(ws, { type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
    sendTo(ws, Object.assign({ type: "codex_config" }, getCodexConfig(sm)));
    sendTo(ws, { type: "term_list", terminals: tm.list(ws) });
    // Context sources sent after session is resolved (per-session storage)
    sendTo(ws, { type: "notes_list", notes: nm.list() });
    sendTo(ws, { type: "loop_registry_updated", records: getHubSchedules() });
    _loop.sendConnectionState(ws);
    if (_mcp) _mcp.sendConnectionState(ws);
    if (_notifications) _notifications.sendConnectionState(ws, sendTo);

    // Session list (filtered for access control)
    // Use the canonical mapper from sessions.js
    var activeId = restoredActive ? restoredActive.localId : sm.activeSessionId;
    sendTo(ws, {
      type: "session_list",
      sessions: allSessions.map(function (s) { return sm.mapSessionForClient(s, activeId); }),
    });

    // Restore active session for this client from server-side presence
    var active = restoredState.active;
    var presenceKey = wsUser ? wsUser.id : "_default";
    var storedPresence = restoredState.storedPresence;
    var autoCreated = false;
    if (!active) {
      var autoOpts = {};
      if (wsUser) autoOpts.ownerId = wsUser.id;
      // TODO(lr-f311): defer createSession until first user message — every
      // network blip or browser reload creates an empty session file here.
      // The reconnect/presence path is subtle; fix deferred to a follow-up PR.
      active = sm.createSession(autoOpts, ws);
      autoCreated = true;
    }
    if (active && !autoCreated) {
      ws._clayActiveSession = active.localId;
      var _vendorCaps = (sm.capabilitiesByVendor && sm.capabilitiesByVendor[active.vendor || sm.defaultVendor || "claude"]) || {};
      // Load history from disk before checking hasHistory — the session may have
      // been evicted from the LRU cache (lr-f311 lazy load), in which case
      // active.history is [] in memory even though the session file has content.
      //
      // This must run before the ownership-claim save below (lr-768c9e): if an
      // unowned session was evicted, active.history is [] in memory. Claiming
      // ownership and calling saveSessionFile() first would serialize that
      // empty array and truncate the on-disk history. Loading history first
      // guarantees saveSessionFile() has the full in-memory history to persist.
      sm.loadSessionHistory(active);
      if (!active.ownerId && wsUser) {
        active.ownerId = wsUser.id;
        sm.saveSessionFile(active);
      }
      sendTo(ws, { type: "session_switched", id: active.localId, cliSessionId: active.cliSessionId || null, loop: active.loop || null, vendor: active.vendor || null, hasHistory: (active.history.length > 0), capabilities: _vendorCaps, agentName: active.agentName || null });
      // Send per-session context sources
      var sessionSources = loadContextSources(slug, active.localId);
      sendTo(ws, { type: "context_sources_state", active: sessionSources });

      // Use sm.replayHistory so history is guaranteed loaded from disk (handles
      // LRU eviction) and the replay logic stays in one place.
      sm.replayHistory(active, undefined, ws, hydrateImageRefs);

      if (active.isProcessing) {
        sendTo(ws, { type: "status", status: "processing" });
      }
      var pendingIds = Object.keys(active.pendingPermissions);
      for (var pi = 0; pi < pendingIds.length; pi++) {
        var p = active.pendingPermissions[pendingIds[pi]];
        sendTo(ws, {
          type: "permission_request_pending",
          requestId: p.requestId,
          toolName: p.toolName,
          toolInput: p.toolInput,
          toolUseId: p.toolUseId,
          decisionReason: p.decisionReason,
          mateId: p.mateId || undefined,
        });
      }
    }

    if (active) {
      userPresence.setPresence(slug, presenceKey, active.localId, storedPresence ? storedPresence.mateDm : null);
      // For auto-created sessions, apply project email defaults
      if (autoCreated) {
        var _emailMod = ctx._email;
        var _saveCtx = ctx.saveContextSources;
        if (_emailMod && _emailMod.getEmailDefaults && _saveCtx) {
          var emailDefs = _emailMod.getEmailDefaults();
          if (emailDefs.length > 0) {
            var defSources = emailDefs.map(function (id) { return "email:" + id; });
            _saveCtx(slug, active.localId, defSources);
            sendTo(ws, { type: "context_sources_state", active: defSources });
          } else {
            sendTo(ws, { type: "context_sources_state", active: [] });
          }
        } else {
          sendTo(ws, { type: "context_sources_state", active: [] });
        }
      }
    }
    broadcastPresence();

    ws.on("message", function (raw) {
      var msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      handleMessage(ws, msg);
    });

    ws.on("close", function () {
      handleDisconnection(ws);
    });

    // Per-client socket faults (e.g. ECONNRESET when a phone/browser drops
    // WiFi mid-connection) emit 'error' on the ws instance. Without a
    // listener, EventEmitter re-throws, which reaches the daemon's
    // uncaughtException handler and tears down every project/session
    // (gracefulShutdown) for a single client's network blip. Log and drop
    // only this socket; 'close' still fires afterward and runs the normal
    // handleDisconnection cleanup.
    ws.on("error", function (err) {
      console.error("[project-connection] client socket error for " + slug + ":", err && err.message ? err.message : err);
      try { ws.terminate(); } catch (e) {}
    });
  }

  function handleDisconnection(ws) {
    if (ws._clayActiveSession) {
      var dcPresKey = ws._clayUser ? ws._clayUser.id : "_default";
      var dcExisting = userPresence.getPresence(slug, dcPresKey);
      userPresence.setPresence(slug, dcPresKey, ws._clayActiveSession, dcExisting ? dcExisting.mateDm : null);
    }
    tm.detachAll(ws);
    clients.delete(ws);
    if (clients.size === 0) {
      stopFileWatch();
      stopAllDirWatches();
    }
    broadcastClientCount();
    broadcastPresence();
  }

  return {
    handleConnection: handleConnection,
    handleDisconnection: handleDisconnection,
  };
}

module.exports = { attachConnection: attachConnection };
