var fs = require("fs");
var path = require("path");
var utils = require("./utils");
var { execFileSync, execFile } = require("child_process");
var { CODEX_DEFAULTS, getCodexConfig } = require("./codex-defaults");
var liteDetect = require("./lite-detect");
var { readMemAvailableMB } = require("./sdk-bridge");
var agentsModule = require("./agents");
var agentsFavorites = require("./agents-favorites");
var sessionActivity = require("./session-activity");
// Kick off SDK agent discovery in the background at module load.
// Errors are swallowed inside refresh(); the cache starts empty and fills
// when the SDK subprocess completes initialization (~9s on this box).
//
// lr-795882: skipped under `node --test` (NODE_TEST_CONTEXT is set natively
// by the test runner itself — not a project-invented flag). This module is
// required, directly or transitively via lib/project.js, by ~18 test files;
// none of them exercise agent discovery, so this was spawning a real
// @anthropic-ai/claude-agent-sdk subprocess purely as an unrequested
// module-load side effect on every full suite run. refresh()'s SDK session
// is aborted in a finally block (lib/agents.js) but the underlying process
// exit is deferred by the SDK's own internal debounce, so the spawned
// subprocess could still be alive — holding the event loop open — well
// after the module that triggered it finished loading. This was the root
// cause package.json's --test-force-exit was added to paper over (see
// 5c17b6d) and was never actually fixed, only masked. Tests that need real
// agent discovery call agentsModule.refresh() themselves explicitly.
if (!process.env.NODE_TEST_CONTEXT) {
  agentsModule.refresh().catch(function (e) {
    console.error("[project-sessions] initial agent refresh failed:", e && e.message ? e.message : e);
  });
}

// Format a user's answer to an ask_user_questions card as a plain user
// message so the MCP path can feed it back to the agent on the next turn.
// Always use "- Q → A" form and prefix with a header so the model can
// connect the answer to its earlier AskUserQuestion call even across a
// turn break. A bare answer with no context reads as a non-sequitur and
// triggers "I don't see an answer" responses from the model.
function formatAskUserAnswerAsMessage(input, answers) {
  var questions = (input && Array.isArray(input.questions)) ? input.questions : [];
  if (questions.length === 0) {
    // Shouldn't happen, but be defensive.
    try { return "(answered with: " + JSON.stringify(answers || {}) + ")"; }
    catch (e) { return "(answered)"; }
  }
  var lines = [];
  for (var i = 0; i < questions.length; i++) {
    var q = questions[i];
    var qText = (q && q.question) ? q.question : ("Question " + (i + 1));
    var ans = (answers && answers[i] != null) ? String(answers[i]) : "";
    if (!ans) continue;
    lines.push("- " + qText + " → " + ans);
  }
  if (lines.length === 0) return "(no answer provided)";
  // Prefix tells the model this is a structured answer to its previous
  // AskUserQuestion call — unambiguous even when read out of turn context.
  return "[Answer to your AskUserQuestion]\n" + lines.join("\n");
}

/**
 * Attach session management, config, project management, and mid-section
 * message handlers to a project context.
 *
 * ctx fields:
 *   cwd, slug, isMate, osUsers, debug, dangerouslySkipPermissions, currentVersion,
 *   sm, sdk, tm, clients,
 *   send, sendTo, sendToAdmins, sendToSession, sendToSessionOthers,
 *   opts, usersModule, userPresence, matesModule, pushModule,
 *   getSessionForWs, getLinuxUserForSession, ensureProjectAccessForSession, getOsUserInfoForWs,
 *   hydrateImageRefs, onProcessingChanged, broadcastPresence,
 *   adapter, getProjectList, getProjectCount, getScheduleCount,
 *   moveScheduleToProject, moveAllSchedulesToProject, getHubSchedules,
 *   fetchVersion, isNewer, onCreateWorktree, IGNORED_DIRS,
 *   scheduleMessage, cancelScheduledMessage,
 *   getProjectOwnerId, setProjectOwnerId,
 *   getUpdateChannel, setUpdateChannel,
 *   getLatestVersion, setLatestVersion
 */

// lr-2016fe: the process_stats WS response is split into a base tier (sent
// to any authenticated caller) and an admin-only diagnostic tier (see the
// process_stats handler below). This is the allowlist of base-tier field
// keys — the ONLY keys the base-tier projection may emit. It is the
// structural guard: a field added to the handler's raw base object without
// also being added here is silently dropped from every response rather than
// silently shipped to a non-admin. Exported for test/ws-process-stats-role-
// gate-lr-2016fe.test.js, which asserts the exact base-tier key set of a
// real (non-admin) response equals this list — so adding a key here is a
// deliberate, reviewed decision, not something that happens by accident.
var PROCESS_STATS_BASE_FIELD_KEYS = [
  "pid",
  "uptime",
  "memory",
  "sessions",
  "processing",
  "clients",
  "terminals",
  "memAvailableMB",
];

function attachSessions(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var osUsers = ctx.osUsers;
  var currentVersion = ctx.currentVersion;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var tm = ctx.tm;
  var clients = ctx.clients;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToAdmins = ctx.sendToAdmins;
  var sendToSession = ctx.sendToSession;
  var sendToSessionOthers = ctx.sendToSessionOthers;
  var opts = ctx.opts;
  var usersModule = ctx.usersModule;
  var userPresence = ctx.userPresence;
  var pushModule = ctx.pushModule;
  var getSessionForWs = ctx.getSessionForWs;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var getOsUserInfoForWs = ctx.getOsUserInfoForWs;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var onProcessingChanged = ctx.onProcessingChanged;
  var broadcastPresence = ctx.broadcastPresence;
  var adapter = ctx.adapter;
  var getProjectList = ctx.getProjectList;
  var getProjectCount = ctx.getProjectCount;
  var getScheduleCount = ctx.getScheduleCount;
  var moveScheduleToProject = ctx.moveScheduleToProject;
  var moveAllSchedulesToProject = ctx.moveAllSchedulesToProject;
  var getHubSchedules = ctx.getHubSchedules;
  var fetchVersion = ctx.fetchVersion;
  var isNewer = ctx.isNewer;
  var onCreateWorktree = ctx.onCreateWorktree;
  var IGNORED_DIRS = ctx.IGNORED_DIRS;
  var scheduleMessage = ctx.scheduleMessage;
  var cancelScheduledMessage = ctx.cancelScheduledMessage;
  var getProjectOwnerId = ctx.getProjectOwnerId;
  var setProjectOwnerId = ctx.setProjectOwnerId;
  var getUpdateChannel = ctx.getUpdateChannel;
  var setUpdateChannel = ctx.setUpdateChannel;
  var getLatestVersion = ctx.getLatestVersion;
  var setLatestVersion = ctx.setLatestVersion;
  var loadContextSources = ctx.loadContextSources;
  var saveContextSources = ctx.saveContextSources;

  function handleSessionsMessage(ws, msg) {

    if (msg.type === "push_subscribe") {
      var _pushUserId = ws._clagenticUser ? ws._clagenticUser.id : null;
      if (pushModule && msg.subscription) pushModule.addSubscription(msg.subscription, msg.replaceEndpoint, _pushUserId);
      return true;
    }

    if (msg.type === "load_more_history") {
      var session = getSessionForWs(ws);
      if (!session || typeof msg.before !== "number") return true;
      var before = msg.before;
      var targetFrom = typeof msg.target === "number" ? msg.target : before - sm.HISTORY_PAGE_SIZE;
      var baseIndex = session._historyBaseIndex || 0;
      // lr-2ea2a7: `before`/`targetFrom` are ABSOLUTE indices per the wire
      // contract (client only ever sees absolute indices from history_meta /
      // a prior history_prepend). Once the heap array can be trimmed, this
      // window can land at or above baseIndex (served from heap, translating
      // absolute<->heap-relative around the existing turn-boundary helpers)
      // or below it (no longer in heap — bounded disk read of the full
      // on-disk history, using the SAME turn-boundary/visibility helpers
      // against that array with absolute indices directly, since index 0 of
      // a fresh disk read IS absolute index 0). Either path is a rare
      // user-initiated scroll-up action — an O(file) disk read is acceptable
      // here and does not retain anything in session.history/heap state.
      var from, to, items;
      if (Math.max(0, targetFrom) >= baseIndex) {
        var heapTargetFrom = Math.max(0, targetFrom) - baseIndex;
        var heapBefore = before - baseIndex;
        var heapFrom = sm.findTurnBoundary(session.history, heapTargetFrom);
        // Extend backward turn-boundary by turn-boundary (bounded — see
        // extendWindowForVisibility) until the page contains at least one
        // visibly-rendering event. Otherwise a page landing entirely on
        // invisible-yield events (todo/task bookkeeping, hidden plan tools,
        // state events, thinking deltas) advances historyFrom but renders
        // nothing — "Load earlier" appears to do nothing (lr-c24b).
        heapFrom = sm.extendWindowForVisibility(session.history, heapFrom, heapBefore);
        from = baseIndex + heapFrom;
        to = before;
        items = session.history.slice(heapFrom, heapBefore).map(hydrateImageRefs);
      } else {
        var diskHistory = sm.readSessionHistoryFromDisk(session);
        var diskFrom = sm.findTurnBoundary(diskHistory, Math.max(0, targetFrom));
        diskFrom = sm.extendWindowForVisibility(diskHistory, diskFrom, before);
        from = diskFrom;
        to = before;
        items = diskHistory.slice(diskFrom, before).map(hydrateImageRefs);
      }
      sendTo(ws, {
        type: "history_prepend",
        items: items,
        meta: { from: from, to: to, hasMore: from > 0 },
      });
      return true;
    }

    if (msg.type === "new_session") {
      var sessionOpts = {};
      if (ws._clagenticUser) sessionOpts.ownerId = ws._clagenticUser.id;
      if (msg.sessionVisibility) sessionOpts.sessionVisibility = msg.sessionVisibility;
      if (msg.vendor) sessionOpts.vendor = msg.vendor;
      if (msg.agentName && typeof msg.agentName === "string") {
        sessionOpts.agentName = msg.agentName;
        try { agentsFavorites.touchRecent({ name: msg.agentName }); }
        catch (e) { /* recents are best-effort */ }
      }
      var newSess = sm.createSession(sessionOpts, ws);
      // Seed per-session model/mode from the project/global DEFAULT
      // (sm._savedDefaultModel / sm._savedDefaultMode, populated at project
      // startup from onGetProjectDefaultModel/onGetServerDefaultModel — see
      // lib/project.js) so the first query uses the right values even before
      // the user changes anything. Seeding from sm.currentModel/
      // sm.currentPermissionMode directly is wrong (lr-db0437): those two
      // fields also mirror whatever model/mode the CURRENTLY ACTIVE session
      // happens to be using, so a brand-new session would inherit another
      // session's in-progress choice instead of the actual saved default.
      newSess.model = sm._savedDefaultModel || null;
      newSess.permissionMode = sm._savedDefaultMode || null;
      ws._clagenticActiveSession = newSess.localId;
      // Apply project-level email defaults to new session
      if (typeof ctx._email === "object" && ctx._email.getEmailDefaults) {
        var emailDefaults = ctx._email.getEmailDefaults();
        if (emailDefaults.length > 0) {
          var defaultSources = emailDefaults.map(function (id) { return "email:" + id; });
          saveContextSources(slug, newSess.localId, defaultSources);
          sendTo(ws, { type: "context_sources_state", active: defaultSources });
        }
      }
      var nsPresKey = ws._clagenticUser ? ws._clagenticUser.id : "_default";
      userPresence.setPresence(slug, nsPresKey, newSess.localId, null);
      broadcastPresence();
      return true;
    }

    // lr-7db0 — agent picker support.
    //
    // list_agents returns the discovered Claude agent catalog plus the user's
    // favorites and recents (Clay-side state in ~/.clay/agents/chattable.json).
    // Hidden client-side when active project is a Mate; we still answer here
    // because the daemon shouldn't make UX decisions that the client already
    // owns. UI gates the surface; daemon stays a data plane.
    //
    // Background refresh: respond immediately with the cached list, then kick
    // off a refresh(). If the catalog changes, re-send to this client only.
    // Cost is paid exactly when the user opens the agent picker — not on a timer.
    if (msg.type === "list_agents") {
      var favorites = [];
      var recents = [];
      try { favorites = agentsFavorites.listFavorites(); recents = agentsFavorites.listRecents(); }
      catch (e) { /* favorites are best-effort */ }
      var cachedAgents = agentsModule.getAll();
      sendTo(ws, {
        type: "agents_list",
        agents: cachedAgents,
        favorites: favorites,
        recents: recents,
      });
      // Refresh in background; re-send only if the catalog changed.
      var cachedJson = JSON.stringify(cachedAgents);
      agentsModule.refresh().then(function () {
        var freshAgents = agentsModule.getAll();
        if (JSON.stringify(freshAgents) === cachedJson) return;
        var favFresh = [];
        var recFresh = [];
        try { favFresh = agentsFavorites.listFavorites(); recFresh = agentsFavorites.listRecents(); }
        catch (e) { /* best-effort */ }
        sendTo(ws, { type: "agents_list", agents: freshAgents, favorites: favFresh, recents: recFresh });
      }).catch(function (e) {
        console.error("[project-sessions] background agent refresh failed:", e && e.message ? e.message : e);
      });
      return true;
    }

    // refresh_agents — explicit on-demand refresh triggered from the settings UI.
    // Re-runs SDK discovery, then broadcasts the updated catalog to ALL connected
    // clients. Responds immediately with ok:true (async broadcast follows).
    if (msg.type === "refresh_agents") {
      sendTo(ws, { type: "refresh_agents_result", ok: true });
      agentsModule.refresh().then(function () {
        var freshAgents = agentsModule.getAll();
        var favFresh = [];
        var recFresh = [];
        try { favFresh = agentsFavorites.listFavorites(); recFresh = agentsFavorites.listRecents(); }
        catch (e) { /* best-effort */ }
        send({ type: "agents_list", agents: freshAgents, favorites: favFresh, recents: recFresh });
        send({ type: "toast", level: "info", message: "Agent catalog refreshed — " + freshAgents.length + " agent" + (freshAgents.length === 1 ? "" : "s") + " found." });
      }).catch(function (e) {
        console.error("[project-sessions] refresh_agents failed:", e && e.message ? e.message : e);
        send({ type: "toast", level: "error", message: "Agent catalog refresh failed." });
      });
      return true;
    }

    // lr-c1a2 — get_agents returns agents installed in the project's
    // .claude/agents/ directory (not the SDK global catalog). Used by the
    // @ mention dropdown in the session input to offer project-local agents.
    if (msg.type === "get_agents") {
      var projectAgents = [];
      try { projectAgents = agentsModule.readProjectAgents(cwd); }
      catch (e) { console.error("[project-sessions] get_agents failed:", e && e.message ? e.message : e); }
      sendTo(ws, { type: "project_agents_list", agents: projectAgents });
      return true;
    }

    // toggle_agent_favorite flips an agent's membership in chattable.json.
    // Required field: name.
    if (msg.type === "toggle_agent_favorite") {
      if (!msg.name) return true;
      var entry = { name: msg.name };
      var nowFav;
      try { nowFav = agentsFavorites.toggleFavorite(entry); }
      catch (e) {
        console.error("[project-sessions] toggle_agent_favorite failed:", e.message);
        return true;
      }
      // Re-broadcast updated catalog to the requesting client. Other clients
      // pull on demand; favorites is per-machine state, not multi-user shared.
      sendTo(ws, {
        type: "agents_list",
        agents: agentsModule.getAll(),
        favorites: agentsFavorites.listFavorites(),
        recents: agentsFavorites.listRecents(),
      });
      sendTo(ws, { type: "agent_favorite_toggled", name: msg.name, favorite: nowFav });
      return true;
    }

    // set_session_agent attaches/detaches a named agent on an existing session.
    // Pass agentName="" (or null) to clear. Takes effect on the next turn —
    // the SDK reads queryOpts at createQuery time, so a session that's mid-turn
    // keeps its current identity for that turn.
    if (msg.type === "set_session_agent") {
      if (typeof msg.sessionId !== "number") return true;
      var agentTarget = sm.sessions.get(msg.sessionId);
      if (!agentTarget) return true;
      if (ws._clagenticUser) {
        if (!usersModule.canAccessSession(ws._clagenticUser.id, agentTarget, { visibility: "public" })) return true;
      }
      var nextAgent = (msg.agentName && typeof msg.agentName === "string") ? msg.agentName : null;
      var prevAgent = agentTarget.agentName || null;
      agentTarget.agentName = nextAgent;
      sm.saveSessionFile(agentTarget);
      if (nextAgent) {
        try { agentsFavorites.touchRecent({ name: nextAgent }); }
        catch (e) { /* best-effort */ }
      }
      sm.broadcastSessionList();
      return true;
    }

    if (msg.type === "set_session_visibility") {
      if (typeof msg.sessionId === "number" && (msg.visibility === "shared" || msg.visibility === "private")) {
        var visTarget = sm.sessions.get(msg.sessionId);
        if (!visTarget) return true;
        if (ws._clagenticUser) {
          if (!usersModule.canAccessSession(ws._clagenticUser.id, visTarget, { visibility: "public" })) return true;
        }
        sm.setSessionVisibility(msg.sessionId, msg.visibility);
      }
      return true;
    }

    if (msg.type === "set_session_bookmark") {
      if (typeof msg.sessionId === "number") {
        var bookmarkTarget = sm.sessions.get(msg.sessionId);
        if (!bookmarkTarget) return true;
        if (ws._clagenticUser) {
          if (!usersModule.canAccessSession(ws._clagenticUser.id, bookmarkTarget, { visibility: "public" })) return true;
        }
        sm.setSessionBookmarked(msg.sessionId, !!msg.bookmarked);
      }
      return true;
    }

    if (msg.type === "reorder_session_bookmarks") {
      if (typeof msg.sourceId === "number" && typeof msg.targetId === "number" && msg.sourceId !== msg.targetId) {
        var source = sm.sessions.get(msg.sourceId);
        var target = sm.sessions.get(msg.targetId);
        if (!source || !target) return true;
        if (ws._clagenticUser) {
          if (!usersModule.canAccessSession(ws._clagenticUser.id, source, { visibility: "public" })) return true;
          if (!usersModule.canAccessSession(ws._clagenticUser.id, target, { visibility: "public" })) return true;
        }
        sm.reorderBookmarkedSessions(msg.sourceId, msg.targetId, msg.insertBefore !== false);
      }
      return true;
    }

    // lr-13c047 (Badge A non-switch clear path): let a client dismiss the
    // Projects-tab cross-project unread badge for a specific project without
    // requiring a full switch/connect to that project — previously the only
    // clear path was connect-time (lib/server.js onConnection) or the
    // same-project switchSession zeroing. slug is validated against the
    // live project registry indirectly: markCrossProjectRead only mutates
    // this ws's own crossProjectUnread map, so an invalid/unknown slug is
    // harmless (its prefix simply matches nothing).
    if (msg.type === "mark_cross_project_read") {
      if (opts && typeof opts.markCrossProjectRead === "function" && typeof msg.slug === "string" && msg.slug) {
        opts.markCrossProjectRead(ws, msg.slug);
      }
      return true;
    }

    if (msg.type === "bulk_delete_sessions") {
      if (!Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) return true;
      var deletableIds = [];
      for (var di = 0; di < msg.sessionIds.length; di++) {
        var bulkId = msg.sessionIds[di];
        if (typeof bulkId !== "number") continue;
        var bulkTarget = sm.sessions.get(bulkId);
        if (!bulkTarget) continue;
        if (ws._clagenticUser) {
          if (!usersModule.canAccessSession(ws._clagenticUser.id, bulkTarget, { visibility: "public" })) continue;
        }
        deletableIds.push(bulkId);
      }
      if (deletableIds.length > 0) {
        sm.deleteSessionsBulk(deletableIds, ws);
      }
      return true;
    }

    if (msg.type === "transfer_project_owner") {
      // Home directory projects: ownership is permanently locked
      if (osUsers && osUsers.length > 0 && /^\/home\/[^/]+\//.test(cwd)) {
        sendTo(ws, { type: "error", text: "Cannot transfer ownership of home directory projects." });
        return true;
      }
      var projectOwnerId = getProjectOwnerId();
      var isAdmin = ws._clagenticUser && ws._clagenticUser.role === "admin";
      var isProjectOwner = ws._clagenticUser && projectOwnerId && ws._clagenticUser.id === projectOwnerId;
      if (!ws._clagenticUser || (!isAdmin && !isProjectOwner)) {
        sendTo(ws, { type: "error", text: "Only project owners or admins can transfer ownership." });
        return true;
      }
      var targetUser = msg.userId ? usersModule.findUserById(msg.userId) : null;
      if (!targetUser) {
        sendTo(ws, { type: "error", text: "User not found." });
        return true;
      }
      setProjectOwnerId(targetUser.id);
      // Persist via daemon callback
      if (opts.onProjectOwnerChanged) {
        opts.onProjectOwnerChanged(slug, targetUser.id);
      }
      send({ type: "project_owner_changed", ownerId: targetUser.id, ownerName: targetUser.displayName || targetUser.username });
      return true;
    }

    if (msg.type === "resume_session") {
      if (!msg.cliSessionId) return true;
      var cliSess = require("./cli-sessions");

      // If Clay already has a persisted meta file for this cliSessionId, read
      // its vendor so resumeSession doesn't silently default to the project's
      // primary vendor (which would break codex sessions after server restart).
      // Also read allowedTools (lr-8b2e) so a previously-granted "allow for
      // session" decision survives this rehydration path instead of
      // re-prompting — resumeSession() itself defaults to {} when absent.
      var persistedVendor = null;
      var persistedAllowedTools = null;
      try {
        var _fsResume = require("fs");
        var _pathResume = require("path");
        var metaPath = _pathResume.join(sm.sessionsDir, msg.cliSessionId + ".jsonl");
        if (_fsResume.existsSync(metaPath)) {
          var firstLine = _fsResume.readFileSync(metaPath, "utf8").split("\n", 1)[0];
          try {
            var metaObj = JSON.parse(firstLine);
            if (metaObj && metaObj.type === "meta" && metaObj.vendor) persistedVendor = metaObj.vendor;
            // Sanitize before it ever reaches resumeSession() (lr-8b2e
            // hardening) — a crafted meta record must not be able to
            // auto-approve a tool with no operator click.
            if (metaObj && metaObj.type === "meta" && metaObj.allowedTools) {
              persistedAllowedTools = utils.sanitizeAllowedTools(metaObj.allowedTools);
            }
          } catch (e) {}
        }
      } catch (e) {}

      // Try SDK for title first, then fall back to manual parsing
      var titlePromise = adapter.getSessionInfo(msg.cliSessionId, { dir: cwd }).then(function(info) {
        return (info && info.summary) ? info.summary.substring(0, 100) : null;
      }).catch(function() { return null; });

      Promise.all([
        cliSess.readCliSessionHistory(cwd, msg.cliSessionId),
        titlePromise
      ]).then(function(results) {
        var history = results[0];
        var sdkTitle = results[1];
        var title = sdkTitle || "Resumed session";
        if (!sdkTitle) {
          for (var i = 0; i < history.length; i++) {
            if (history[i].type === "user_message" && history[i].text) {
              title = history[i].text.substring(0, 50);
              break;
            }
          }
        }
        var resumed = sm.resumeSession(msg.cliSessionId, { history: history, title: title, vendor: persistedVendor || undefined, allowedTools: persistedAllowedTools || undefined }, ws);
        if (resumed) ws._clagenticActiveSession = resumed.localId;
      }).catch(function() {
        var resumed = sm.resumeSession(msg.cliSessionId, (persistedVendor || persistedAllowedTools) ? { vendor: persistedVendor, allowedTools: persistedAllowedTools } : undefined, ws);
        if (resumed) ws._clagenticActiveSession = resumed.localId;
      });
      return true;
    }

    if (msg.type === "list_cli_sessions") {
      var _fs = require("fs");
      // Collect session IDs already in relay (in-memory + persisted on disk)
      var relayIds = {};
      sm.sessions.forEach(function (s) {
        if (s.cliSessionId) relayIds[s.cliSessionId] = true;
      });
      try {
        var sessDir = sm.sessionsDir;
        var diskFiles = _fs.readdirSync(sessDir);
        for (var fi = 0; fi < diskFiles.length; fi++) {
          if (diskFiles[fi].endsWith(".jsonl")) {
            relayIds[diskFiles[fi].replace(".jsonl", "")] = true;
          }
        }
      } catch (e) {}

      adapter.listSessions({ dir: cwd }).then(function(sdkSessions) {
        var filtered = sdkSessions.filter(function(s) {
          return !relayIds[s.sessionId];
        }).map(function(s) {
          return {
            sessionId: s.sessionId,
            firstPrompt: s.summary || s.firstPrompt || "",
            model: null,
            gitBranch: s.gitBranch || null,
            startTime: s.createdAt ? new Date(s.createdAt).toISOString() : null,
            lastActivity: s.lastModified ? new Date(s.lastModified).toISOString() : null,
          };
        });
        sendTo(ws, { type: "cli_session_list", sessions: filtered });
      }).catch(function() {
        // Fallback to manual parsing if SDK fails
        var cliSessions = require("./cli-sessions");
        cliSessions.listCliSessions(cwd).then(function(sessions) {
          var filtered = sessions.filter(function(s) {
            return !relayIds[s.sessionId];
          });
          sendTo(ws, { type: "cli_session_list", sessions: filtered });
        }).catch(function() {
          sendTo(ws, { type: "cli_session_list", sessions: [] });
        });
      });
      return true;
    }

    if (msg.type === "switch_session") {
      if (msg.id && sm.sessions.has(msg.id)) {
        // If the target session's vendor doesn't own the currently cached
        // model, clear sm.currentModel so the UI and next query don't leak
        // the previous session's vendor-specific model into this one.
        var switchTargetSess = sm.sessions.get(msg.id);
        if (switchTargetSess && sm.currentModel) {
          var targetVendor = switchTargetSess.vendor || sm.defaultVendor || null;
          var tvModels = (targetVendor && sm.modelsByVendor && sm.modelsByVendor[targetVendor]) || [];
          var found = false;
          var _curLc = sm.currentModel.toLowerCase();
          for (var tvi = 0; tvi < tvModels.length; tvi++) {
            var tvEntry = tvModels[tvi];
            var tvVal = typeof tvEntry === "string" ? tvEntry : (tvEntry && (tvEntry.value || tvEntry.id)) || "";
            if (tvVal === sm.currentModel || (tvVal && (tvVal.toLowerCase().indexOf(_curLc) !== -1 || _curLc.indexOf(tvVal.toLowerCase()) !== -1))) { found = true; break; }
          }
          if (tvModels.length > 0 && !found) {
            sm.currentModel = "";
          }
        }
        // Check session access
        if (ws._clagenticUser) {
          var switchTarget = sm.sessions.get(msg.id);
          if (!usersModule.canAccessSession(ws._clagenticUser.id, switchTarget, { visibility: "public" })) return true;
        }
        ws._clagenticActiveSession = msg.id;
        sm.switchSession(msg.id, ws, hydrateImageRefs);
        broadcastPresence();
        // Send per-session context sources
        if (typeof loadContextSources === "function") {
          var switchedSources = loadContextSources(slug, msg.id);
          sendTo(ws, { type: "context_sources_state", active: switchedSources });
        }
        // Re-sync chip state to the incoming session's own model/mode.
        // Sessions track their own model/permissionMode so the chip shows
        // per-session values rather than the shared project state.
        // lr-041af8: routed through the shared effectiveSessionModel() helper
        // (sessions.js) instead of re-deriving the same session-model-first
        // fallback here — this was the one sender that already had the
        // precedence right; sharing it prevents a future sender from
        // reintroducing the sm.currentModel-only bug this task fixes.
        var _swSess = sm.sessions.get(msg.id);
        var _swModel = sm.effectiveSessionModel(_swSess);
        var _swMode = (_swSess && _swSess.permissionMode) || sm.currentPermissionMode || "default";
        sendTo(ws, { type: "config_state", model: _swModel, mode: _swMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
        var swPresKey = ws._clagenticUser ? ws._clagenticUser.id : "_default";
        userPresence.setPresence(slug, swPresKey, msg.id, null);
      }
      return true;
    }

    if (msg.type === "delete_session") {
      if (ws._clagenticUser) {
        var sdPerms = usersModule.getEffectivePermissions(ws._clagenticUser, osUsers);
        if (!sdPerms.sessionDelete) {
          sendTo(ws, { type: "error", text: "You do not have permission to delete sessions" });
          return true;
        }
      }
      if (msg.id && sm.sessions.has(msg.id)) {
        sm.deleteSession(msg.id, ws);
      }
      return true;
    }

    if (msg.type === "rename_session") {
      if (msg.id && sm.sessions.has(msg.id) && msg.title) {
        var s = sm.sessions.get(msg.id);
        s.title = String(msg.title).substring(0, 100);
        s.titleManuallySet = true;
        sm.saveSessionFile(s);
        sm.broadcastSessionList();
        // Sync title to SDK session
        if (s.cliSessionId) {
          adapter.renameSession(s.cliSessionId, s.title, { dir: cwd }).catch(function(e) {
            console.error("[project] SDK renameSession failed:", e.message);
          });
        }
      }
      return true;
    }

    if (msg.type === "search_sessions") {
      var results = sm.searchSessions(msg.query || "");
      sendTo(ws, { type: "search_results", query: msg.query || "", results: results });
      return true;
    }

    if (msg.type === "search_session_content") {
      var targetSession = msg.id ? sm.sessions.get(msg.id) : getSessionForWs(ws);
      if (!targetSession) return true;
      var contentResults = sm.searchSessionContent(targetSession.localId, msg.query || "");
      var searchResp = { type: "search_content_results", query: msg.query || "", sessionId: targetSession.localId, hits: contentResults.hits, total: contentResults.total };
      if (msg.source) searchResp.source = msg.source;
      sendTo(ws, searchResp);
      return true;
    }

    if (msg.type === "set_update_channel") {
      var channel = msg.channel === "beta" ? "beta" : "stable";
      ctx.setUpdateChannel && ctx.setUpdateChannel(channel);
      return true;
    }

    if (msg.type === "check_update") {
      var updateChannel = ctx.getUpdateChannel ? ctx.getUpdateChannel() : "stable";
      fetchVersion(updateChannel).then(function (latest) {
        if (latest && isNewer(latest, currentVersion)) {
          setLatestVersion(latest);
          sendTo(ws, { type: "update_available", version: latest, current: currentVersion });
        } else {
          sendTo(ws, { type: "up_to_date", version: currentVersion });
        }
      });
      return true;
    }

    if (msg.type === "update_now") {
      if (!ws._clagenticUser || ws._clagenticUser.role !== "admin") return true;
      send({ type: "update_started", version: getLatestVersion() || "" });
      var _ipc = require("./ipc");
      var _config = require("./config");
      _ipc.sendIPCCommand(_config.socketPath(), { cmd: "update" });
      return true;
    }

    if (msg.type === "process_stats") {
      var sessionCount = sm.sessions.size;
      var processingCount = 0;
      sm.sessions.forEach(function (s) {
        if (s.isProcessing) processingCount++;
      });
      var mem = process.memoryUsage();
      var memAvailMB = readMemAvailableMB();
      // lr-2016fe: the base/admin split here is STRUCTURAL, not a
      // developer-discipline convention, because that convention already
      // failed twice (PR #403 briefly added a session-identifying field
      // with no gate at all; this handler's first fix moved the gate down
      // but still let a future field land in the wrong tier by hand-typing
      // it onto statsResp). PROCESS_STATS_BASE_FIELD_KEYS is the allowlist
      // of what any authenticated caller — admin or not — may receive. The
      // projection loop below is the only place that may populate the
      // response's base-tier keys: it reads only keys named in the
      // allowlist off rawBase, so a field added to rawBase without also
      // adding its key to PROCESS_STATS_BASE_FIELD_KEYS is silently
      // dropped from every response rather than silently shipped
      // (test/ws-process-stats-role-gate-lr-2016fe.test.js asserts the
      // exact base-tier key set). The admin-only
      // diagnostic fields (sourced from sdk.getMemoryStats(), which is
      // daemon-wide — module-scope counters shared across every project's
      // bridge instance, not scoped to this project) are built as a wholly
      // separate named object and merged in only inside the admin branch,
      // so the base object's own shape is never touched by admin-tier work.
      var rawBase = {
        pid: process.pid,
        uptime: process.uptime(),
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
        sessions: sessionCount,
        processing: processingCount,
        clients: clients.size,
        terminals: tm.list().length,
        memAvailableMB: memAvailMB,
      };
      var baseFields = {};
      for (var pbi = 0; pbi < PROCESS_STATS_BASE_FIELD_KEYS.length; pbi++) {
        var pbKey = PROCESS_STATS_BASE_FIELD_KEYS[pbi];
        baseFields[pbKey] = rawBase[pbKey];
      }
      var statsResp = Object.assign({ type: "process_stats" }, baseFields);
      // The fields below (activeLiveCount, maxConcurrentSessions,
      // activityDivergenceCount, activityDivergenceRecentSamples) are the
      // ones a future author is most likely to enrich with per-session
      // identifying data (that already happened once — see above), so
      // sdk.getMemoryStats() itself is only ever called for an admin.
      if (ws._clagenticUser && ws._clagenticUser.role === "admin") {
        var memStats = (sdk && typeof sdk.getMemoryStats === "function") ? sdk.getMemoryStats() : {};
        var diagnosticFields = {
          activeLiveCount: memStats.activeLiveCount !== undefined ? memStats.activeLiveCount : null,
          maxConcurrentSessions: memStats.maxConcurrentSessions !== undefined ? memStats.maxConcurrentSessions : null,
          activityDivergenceCount: memStats.activityDivergenceCount !== undefined ? memStats.activityDivergenceCount : null,
          activityDivergenceRecentSamples: memStats.activityDivergenceRecentSamples || [],
        };
        Object.assign(statsResp, diagnosticFields);
      }
      sendTo(ws, statsResp);
      return true;
    }

    if (msg.type === "stop") {
      var session = getSessionForWs(ws);
      if (session && session.isProcessing) {
        session.taskStopRequested = true;
        if (session.abortController) session.abortController.abort();
      }
      return true;
    }

    if (msg.type === "stop_task") {
      if (msg.taskId) {
        // Pass the requester's session so stopTask aborts the correct session
        // rather than the globally-active one (lr-e0de). Single-session installs
        // are unaffected: getSessionForWs returns the same session as
        // sm.getActiveSession() when only one session exists.
        var stopSession = getSessionForWs(ws);
        sdk.stopTask(msg.taskId, stopSession);
      }
      return true;
    }

    if (msg.type === "kill_process") {
      // Restrict to admins in multi-user mode — any user could otherwise SIGTERM
      // another user's running claude subprocess (lr-eb1a).
      if (!ws._clagenticUser || ws._clagenticUser.role !== "admin") {
        // lr-93e3c8 (fnd-66af4e, item 7): app-messages.js's client-side
        // `error` handler reads msg.text (addSystemMessage(msg.text, true)),
        // not msg.message -- both admin-gate rejections in this file used
        // to send `message:`, so the frame arrived client-side but rendered
        // as addSystemMessage(undefined, true), effectively swallowed.
        sendTo(ws, { type: "error", text: "Admin access required" });
        return true;
      }
      var pid = msg.pid;
      if (!pid || typeof pid !== "number") return true;
      // Verify target is actually a claude process before killing
      if (!sdk.isClaudeProcess(pid)) {
        console.error("[project] Refused to kill PID " + pid + ": not a claude process");
        sendTo(ws, { type: "error", text: "Process " + pid + " is not a Claude process." });
        return true;
      }
      try {
        process.kill(pid, "SIGTERM");
        console.log("[project] Sent SIGTERM to conflicting Claude process PID " + pid);
        sendTo(ws, { type: "process_killed", pid: pid });
      } catch (e) {
        console.error("[project] Failed to kill PID " + pid + ":", e.message);
        sendTo(ws, { type: "error", text: "Failed to kill process " + pid + ": " + (e.message || e) });
      }
      return true;
    }

    if (msg.type === "set_model" && msg.model) {
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setModel(session, msg.model).then(function (result) {
          // lr-f22787: sdk.setModel now reports { ok, error } instead of
          // always resolving as if the switch succeeded (it used to swallow
          // an invalid/unentitled model ID with no signal back to the
          // requesting client — see sdk-bridge.js's setModel). A missing
          // `result` (older/no-op session-not-active branch) is still ok.
          if (result && result.ok === false) {
            sendTo(ws, { type: "error", text: "Failed to switch model: " + result.error });
            return;
          }
          // lr-db0437: persist session.model to disk (meta line) so a
          // daemon restart resumes with the same model instead of falling
          // back to the project/global default (acceptance criterion:
          // "session picked model X, daemon restarts, session still uses X").
          sm.saveSessionFile(session);
          // Targeted reply — only this client's chip updates, not all sessions.
          // lr-041af8: shared helper (see switch_session above and
          // effectiveSessionModel() in sessions.js).
          sendTo(ws, { type: "config_state", model: sm.effectiveSessionModel(session), mode: session.permissionMode || sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
        }).catch(function (e) {
          // Defensive: setModel is not expected to reject (its own try/catch
          // returns { ok: false } instead), but a rejection must still reach
          // the client rather than vanish silently.
          sendTo(ws, { type: "error", text: "Failed to switch model: " + (e.message || e) });
        });
      }
      return true;
    }

    if (msg.type === "set_vendor" && msg.vendor) {
      var vendorSession = getSessionForWs(ws);
      if (vendorSession) {
        // Refuse to rebind vendor on a session that is already bound to a
        // different CLI (cliSessionId is vendor-specific). This prevents a
        // stale client-side vendor state from clobbering the persisted vendor
        // on page reload / server restart.
        var alreadyBound = vendorSession.cliSessionId && vendorSession.vendor && vendorSession.vendor !== msg.vendor;
        if (alreadyBound) {
          console.warn("[project] set_vendor ignored: session " + vendorSession.localId +
            " is bound to '" + vendorSession.vendor + "', refused rebind to '" + msg.vendor + "'");
        } else {
          vendorSession.vendor = msg.vendor;
          // lr-041af8: clear THIS session's own model too, not just the
          // shared sm.currentModel below — the old model belongs to the old
          // vendor and must not survive the rebind on the session itself
          // (previously only sm.currentModel was cleared, so a session with
          // its own persisted .model kept showing a foreign-vendor model ID
          // after switching vendor).
          vendorSession.model = null;
          // Clear the shared model so the next query uses the vendor's default
          // instead of leaking the previous vendor's model into a fresh session.
          if (sm.currentModel) {
            sm.currentModel = "";
          }
          // Agent sessions are Claude Code-only. If the user somehow switches
          // vendor to Codex on a session that carries agentName (e.g. via a
          // direct WS message), clear the agent identity so the badge doesn't
          // misrepresent an identity that Codex cannot apply.
          if (msg.vendor === "codex" && vendorSession.agentName) {
            console.warn("[project] set_vendor to codex on agent session " + vendorSession.localId +
              " — clearing agentName '" + vendorSession.agentName + "'");
            vendorSession.agentName = null;
          }
          sm.saveSessionFile(vendorSession);
          sm.broadcastSessionList();
        }
      }
      if (msg.vendor) {
        var vendorModels = (sm.modelsByVendor && sm.modelsByVendor[msg.vendor]) || [];
        sendTo(ws, {
          type: "model_info",
          model: "",
          models: vendorModels,
          vendor: msg.vendor,
          availableVendors: sm.availableVendors || [],
          installedVendors: sm.installedVendors || [],
        });
        // lr-041af8: targeted, not broadcast — set_vendor acts on the
        // requesting client's own session (vendorSession above); broadcasting
        // this reply to every connected client via send() previously stomped
        // on every OTHER session's displayed model with this session's
        // (now-cleared) model, the same cross-session bleed class this task
        // fixes elsewhere. vendorSession may be null (no active session for
        // this ws yet) — effectiveSessionModel handles that by falling back
        // to the shared default, same as every other targeted sender.
        sendTo(ws, { type: "config_state", model: sm.effectiveSessionModel(vendorSession), mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      }
      return true;
    }

    if (msg.type === "set_server_default_model" && msg.model) {
      if (typeof opts.onSetServerDefaultModel === "function") {
        opts.onSetServerDefaultModel(msg.model);
      }
      // lr-db0437: update the DEFAULT only — never the live session's model.
      // A running session's model is set-in-stone until the user explicitly
      // changes it via set_model; changing the server default must not
      // silently retarget whatever session happens to be focused (that was
      // the "reverse bleed" root cause this task fixes). sm.currentModel is
      // consulted by new_session (this file) and by startQuery's fallback
      // (sdk-bridge.js) as the project/global default.
      sm.currentModel = msg.model;
      sm._savedDefaultModel = msg.model;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_project_default_model" && msg.model) {
      if (typeof opts.onSetProjectDefaultModel === "function") {
        opts.onSetProjectDefaultModel(slug, msg.model);
      }
      // lr-db0437: same as set_server_default_model above — default-only write.
      sm.currentModel = msg.model;
      sm._savedDefaultModel = msg.model;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_permission_mode" && msg.mode) {
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setPermissionMode(session, msg.mode).then(function () {
          // Targeted reply — only update the requesting client's chip.
          // lr-041af8: shared helper (see effectiveSessionModel() in sessions.js).
          sendTo(ws, { type: "config_state", model: sm.effectiveSessionModel(session), mode: session.permissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
        });
      }
      return true;
    }

    if (msg.type === "set_server_default_mode" && msg.mode) {
      if (typeof opts.onSetServerDefaultMode === "function") {
        opts.onSetServerDefaultMode(msg.mode);
      }
      sm.currentPermissionMode = msg.mode;
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setPermissionMode(session, msg.mode);
      }
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_project_default_mode" && msg.mode) {
      if (typeof opts.onSetProjectDefaultMode === "function") {
        opts.onSetProjectDefaultMode(slug, msg.mode);
      }
      sm.currentPermissionMode = msg.mode;
      // Apply to ALL active sessions in this project, not just the focused one.
      // Without this, sessions that already started a query keep the old mode.
      sm.sessions.forEach(function (s) {
        sdk.setPermissionMode(s, msg.mode);
      });
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_effort" && msg.effort) {
      sm.currentEffort = msg.effort;
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setEffort(session, msg.effort);
      }
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_server_default_effort" && msg.effort) {
      if (typeof opts.onSetServerDefaultEffort === "function") {
        opts.onSetServerDefaultEffort(msg.effort);
      }
      sm.currentEffort = msg.effort;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_project_default_effort" && msg.effort) {
      if (typeof opts.onSetProjectDefaultEffort === "function") {
        opts.onSetProjectDefaultEffort(slug, msg.effort);
      }
      sm.currentEffort = msg.effort;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_betas") {
      sm.currentBetas = msg.betas || [];
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas, thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_server_default_betas") {
      if (typeof opts.onSetServerDefaultBetas === "function") {
        opts.onSetServerDefaultBetas(msg.betas || []);
      }
      sm.currentBetas = msg.betas || [];
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas, thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_project_default_betas") {
      if (typeof opts.onSetProjectDefaultBetas === "function") {
        opts.onSetProjectDefaultBetas(slug, msg.betas || []);
      }
      sm.currentBetas = msg.betas || [];
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas, thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_thinking") {
      sm.currentThinking = msg.thinking || "adaptive";
      if (msg.budgetTokens) sm.currentThinkingBudget = msg.budgetTokens;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    // Codex-specific settings (stored on sessionManager, passed to adapter via adapterOptions)
    if (msg.type === "set_codex_approval") {
      sm.codexApproval = msg.approval || CODEX_DEFAULTS.approval;
      send(Object.assign({ type: "codex_config" }, getCodexConfig(sm)));
      return true;
    }
    if (msg.type === "set_codex_sandbox") {
      sm.codexSandbox = msg.sandbox || CODEX_DEFAULTS.sandbox;
      send(Object.assign({ type: "codex_config" }, getCodexConfig(sm)));
      return true;
    }
    if (msg.type === "set_codex_websearch") {
      sm.codexWebSearch = msg.webSearch || CODEX_DEFAULTS.webSearch;
      send(Object.assign({ type: "codex_config" }, getCodexConfig(sm)));
      return true;
    }

    if (msg.type === "rewind_preview") {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId || !msg.uuid) return true;
      if (session._rewindInProgress) return true;

      (async function () {
        try {
          var r = await sdk.rewindPreview(session, msg.uuid);
          sendTo(ws, { type: "rewind_preview_result", preview: r.preview, diffs: r.diffs, uuid: msg.uuid, chatOnly: r.chatOnly || false });
        } catch (err) {
          sendTo(ws, { type: "rewind_error", text: "Failed to preview rewind: " + err.message });
        }
      })();
      return true;
    }

    if (msg.type === "rewind_execute") {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId || !msg.uuid) return true;
      // Guard against concurrent rewind executions
      if (session._rewindInProgress) {
        sendTo(ws, { type: "rewind_error", text: "Rewind already in progress." });
        return true;
      }
      session._rewindInProgress = true;
      var mode = msg.mode || "both";

      (async function () {
        try {
          // File restoration (delegated to adapter via sdk-bridge)
          if (mode !== "chat") {
            await sdk.rewindExecuteFiles(session, msg.uuid);
          }

          // Conversation rollback (skip for files-only mode)
          if (mode !== "files") {
            // lr-2ea2a7: messageUUIDs[].historyIndex is an ABSOLUTE index and
            // the rewind target may be older than the current heap tail
            // (session._historyBaseIndex > 0) — loadFullSessionHistory()
            // materializes the complete on-disk history into session.history
            // first (cap-exempt), so every index below is safe to use as a
            // direct session.history offset without base-index translation.
            // retrimHistory() re-applies the bounded cap once the trim/save
            // below is done so this session doesn't permanently hold
            // unbounded history in heap after a rewind.
            sm.loadFullSessionHistory(session);

            var targetIdx = -1;
            for (var i = 0; i < session.messageUUIDs.length; i++) {
              if (session.messageUUIDs[i].uuid === msg.uuid) {
                targetIdx = i;
                break;
              }
            }

            // Count turns to roll back BEFORE trimming local history
            var turnsToRollBack = 0;
            if (targetIdx >= 0) {
              for (var ri = targetIdx; ri < session.messageUUIDs.length; ri++) {
                if (session.messageUUIDs[ri].type === "user") turnsToRollBack++;
              }
            }

            if (targetIdx >= 0) {
              var trimTo = session.messageUUIDs[targetIdx].historyIndex;
              for (var k = trimTo - 1; k >= 0; k--) {
                if (session.history[k].type === "user_message") {
                  trimTo = k;
                  break;
                }
              }
              session.history = session.history.slice(0, trimTo);
              session._historyBaseIndex = 0; // full history now starts at absolute 0 again
              session.messageUUIDs = session.messageUUIDs.slice(0, targetIdx);
              // Reset digest checkpoint if it points past the trimmed history
              if (typeof session._dmLastDigestedIndex === "number" && session._dmLastDigestedIndex > trimTo) {
                session._dmLastDigestedIndex = trimTo;
              }
              // Note (lr-f940): this truncation changes session.history.length,
              // which sm.saveSessionFile()'s historyMatchesDisk() check detects
              // automatically — the save below still does a full rewrite, no
              // extra bookkeeping needed here.
            }

            // Notify adapter of conversation rollback (e.g. Codex thread/rollback)
            if (turnsToRollBack > 0) {
              try {
                await sdk.rollbackConversation(session, turnsToRollBack);
              } catch (rbErr) {
                console.error("[project-sessions] conversation rollback failed:", rbErr.message || rbErr);
              }
            }

            var kept = session.messageUUIDs;
            session.lastRewindUuid = kept.length > 0 ? kept[kept.length - 1].uuid : null;
            // lr-2ea2a7: re-apply the bounded tail cap now that the trim/save
            // is complete — see loadFullSessionHistory() call above.
            sm.retrimHistory(session);
          }

          if (session.abortController) {
            try { session.abortController.abort(); } catch (e) {}
          }
          if (session.messageQueue) {
            try { session.messageQueue.end(); } catch (e) {}
          }
          session.queryInstance = null;
          session.messageQueue = null;
          session.abortController = null;
          session.blocks = {};
          session.sentToolResults = {};
          session.pendingPermissions = {};
          session.pendingAskUser = {};
          // lr-9bcd7b: a rewind destroys the in-flight query outright (the
          // queryInstance null-out above), so nothing can genuinely still be
          // running for this session afterward. Unlike the reconciliation
          // sites in sdk-message-processor.js/sdk-bridge.js, isProcessing:false
          // here is correct even without consulting the registry -- but the
          // registry itself must still be reset wholesale (leak-resistance
          // layer 4: never merge stale pre-rewind tokens into the post-rewind
          // session), or a Task token acquired before the rewind would
          // linger and make a LATER query look active for the wrong reason.
          sessionActivity.replaceRegistry(session);
          session.isProcessing = false;
          onProcessingChanged();

          sm.saveSessionFile(session);
          sm.switchSession(session.localId, ws, hydrateImageRefs);
          sm.sendAndRecord(session, { type: "rewind_complete", mode: mode });
          sm.broadcastSessionList();
        } catch (err) {
          sendTo(ws, { type: "rewind_error", text: "Rewind failed: " + err.message });
        } finally {
          session._rewindInProgress = false;
        }
      })();
      return true;
    }

    if (msg.type === "fork_session" && msg.uuid) {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId) {
        sendTo(ws, { type: "error", text: "Cannot fork: no CLI session" });
        return true;
      }
      var forkTitle = (session.title || "New Session") + " (fork)";

      sdk.forkSession(session, msg.uuid).then(function(result) {
        if (result.useLocalHistory) {
          // lr-2ea2a7: the fork target (messageUUIDs[].historyIndex, an
          // ABSOLUTE index) may be older than the current heap tail — load
          // the complete on-disk history first (cap-exempt) so the source
          // session's indices are safe to use as direct offsets, and the
          // forked prefix can include everything up to the target uuid even
          // if it was already trimmed out of the source session's heap.
          sm.loadFullSessionHistory(session);

          // Copy local history up to the target UUID
          var targetIdx = -1;
          for (var fi = 0; fi < session.messageUUIDs.length; fi++) {
            if (session.messageUUIDs[fi].uuid === msg.uuid) { targetIdx = fi; break; }
          }
          var forkHistory = [];
          if (targetIdx >= 0) {
            var trimTo = session.messageUUIDs[targetIdx].historyIndex;
            forkHistory = session.history.slice(0, trimTo);
          } else {
            forkHistory = session.history.slice();
          }
          // Source session's heap is restored to its bounded cap now that
          // the full prefix has been copied out for the fork.
          sm.retrimHistory(session);

          var forked = sm.createSession({ vendor: session.vendor, ownerId: session.ownerId || null }, ws);
          forked.cliSessionId = result.sessionId;
          forked.title = forkTitle;
          forked.history = forkHistory;
          forked._historyBaseIndex = 0; // forked history starts fresh at absolute 0
          forked.messageUUIDs = [];
          for (var hi = 0; hi < forkHistory.length; hi++) {
            if (forkHistory[hi].type === "message_uuid") {
              forked.messageUUIDs.push({ uuid: forkHistory[hi].uuid, type: forkHistory[hi].messageType, historyIndex: hi });
            }
          }
          // Note (lr-f940): forked.history was just assigned directly, which
          // sm.saveSessionFile()'s historyMatchesDisk() check detects via the
          // length mismatch against the freshly-created session's persisted
          // count — the save below still does a full rewrite automatically.
          // The FULL forkHistory (pre-trim) is what gets written to disk here
          // — saveSessionFile() serializes session.history as of this call,
          // which is still the untrimmed forkHistory; retrimHistory() below
          // only bounds the in-heap copy after the durable write completes.
          sm.saveSessionFile(forked);
          // lr-2ea2a7: bound the forked session's heap too — a fork target
          // deep into a long conversation can itself exceed HISTORY_INMEM_MAX.
          sm.retrimHistory(forked);
          sm.switchSession(forked.localId, ws, hydrateImageRefs);
          sendTo(ws, { type: "fork_complete", sessionId: forked.localId });
          sm.broadcastSessionList();
        } else {
          // Read history from CLI session files
          var cliSess = require("./cli-sessions");
          return cliSess.readCliSessionHistory(cwd, result.sessionId).then(function(history) {
            var forked = sm.resumeSession(result.sessionId, { history: history, title: forkTitle }, ws);
            if (forked) {
              ws._clagenticActiveSession = forked.localId;
              sendTo(ws, { type: "fork_complete", sessionId: forked.localId });
            }
          });
        }
      }).catch(function(e) {
        sendTo(ws, { type: "error", text: "Fork failed: " + (e.message || e) });
      });
      return true;
    }

    if (msg.type === "ask_user_response") {
      var session = getSessionForWs(ws);
      if (!session) return true;
      var toolId = msg.toolId;
      var answers = msg.answers || {};
      var pending = session.pendingAskUser[toolId];
      if (!pending) return true;
      delete session.pendingAskUser[toolId];
      sm.sendAndRecord(session, { type: "ask_user_answered", toolId: toolId, answers: answers });

      if (pending.mode === "mcp") {
        // Stateless MCP path: the tool already returned. Inject the user's
        // answer as a new user message so the conversation continues
        // naturally on the next turn. This matches how the mate would see
        // any other user input.
        var answerText = formatAskUserAnswerAsMessage(pending.input, answers);
        var userMsg = { type: "user_message", text: answerText };
        // lr-2ea2a7: routes through the shared history-cap helper (see grep-guard test).
        sm.recordHistoryEntry(session, userMsg, true);
        sm.appendToSessionFile(session, userMsg);
        sendToSession(session.localId, userMsg);

        if (!session.isProcessing) {
          session.isProcessing = true;
          onProcessingChanged();
          session.sentToolResults = {};
          sendToSession(session.localId, { type: "status", status: "processing" });
          if (!session.queryInstance && !session.worker) {
            sdk.startQuery(session, answerText, undefined, ensureProjectAccessForSession(session));
          } else {
            sdk.pushMessage(session, answerText);
          }
        } else {
          // Turn is still running; queue for the next turn.
          sdk.pushMessage(session, answerText);
        }
      } else {
        // Claude native AskUserQuestion path (canUseTool). The SDK is
        // synchronously blocked on the permission callback, so we must
        // resolve it with the standard permission shape.
        //
        // The CLI's AskUserQuestion tool expects answers keyed by question
        // TEXT (e.g. {"What is your goal?": "Build a widget"}), not by
        // numeric index. Clay's client sends index-keyed answers
        // ({"0": "Build a widget"}). Remap here before passing to the CLI.
        //
        // Both camelCase (updatedInput) and snake_case (updated_input) are
        // included: the SDK passes the object through as-is and the stdio
        // permission handler reads the snake_case key.
        var questions = (pending.input && Array.isArray(pending.input.questions))
          ? pending.input.questions : [];
        var textKeyedAnswers = {};
        for (var qi = 0; qi < questions.length; qi++) {
          var qText = questions[qi] && questions[qi].question;
          if (qText && answers[qi] != null) {
            textKeyedAnswers[qText] = answers[qi];
          }
        }
        var updatedInput = Object.assign({}, pending.input, { answers: textKeyedAnswers });
        pending.resolve({
          behavior: "allow",
          updatedInput: updatedInput,
          updated_input: updatedInput,
        });
      }
      return true;
    }

    if (msg.type === "input_sync") {
      sendToSessionOthers(ws, ws._clagenticActiveSession, msg);
      return true;
    }

    if (msg.type === "cursor_move" || msg.type === "cursor_leave" || msg.type === "text_select") {
      if (!ws._clagenticUser) return true;
      var u = ws._clagenticUser;
      var p = u.profile || {};
      var cursorMsg = {
        type: msg.type,
        userId: u.id,
        displayName: p.name || u.displayName || u.username,
        avatarStyle: p.avatarStyle || "thumbs",
        avatarSeed: p.avatarSeed || u.username,
        avatarCustom: p.avatarCustom || "",
      };
      if (msg.type === "cursor_move") {
        cursorMsg.turn = msg.turn;
        if (msg.rx != null) cursorMsg.rx = msg.rx;
        if (msg.ry != null) cursorMsg.ry = msg.ry;
      }
      if (msg.type === "text_select") {
        cursorMsg.ranges = msg.ranges || [];
      }
      sendToSessionOthers(ws, ws._clagenticActiveSession, cursorMsg);
      return true;
    }

    if (msg.type === "permission_response") {
      var requestId = msg.requestId;
      var decision = msg.decision;
      // Look up session by requestId index (O(1)), fall back to active session
      var sessionId = sm.permissionRequestIndex[requestId];
      var session = sessionId ? sm.sessions.get(sessionId) : getSessionForWs(ws);
      if (!session) return true;
      var pending = session.pendingPermissions[requestId];
      if (!pending) return true;
      delete sm.permissionRequestIndex[requestId];
      delete session.pendingPermissions[requestId];
      onProcessingChanged(); // update cross-project permission badge

      // --- Plan approval: "allow_accept_edits" -- approve + switch to acceptEdits mode ---
      if (decision === "allow_accept_edits") {
        sdk.setPermissionMode(session, "acceptEdits");
        sm.currentPermissionMode = "acceptEdits";
        send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
        pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });
        return true;
      }

      // --- Plan approval: "allow_clear_context" -- new session + plan as first message + acceptEdits ---
      if (decision === "allow_clear_context") {
        // Deny current plan to end the turn
        pending.resolve({ behavior: "deny", message: "User chose to clear context and restart" });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });

        // Abort the old session's query -- but defer to next tick so the SDK's
        // deny write (scheduled as microtask by pending.resolve) completes first.
        // Aborting synchronously would kill the subprocess before the write,
        // causing an "Operation aborted" crash in the SDK.
        session.isProcessing = false;
        onProcessingChanged();
        session.pendingPermissions = {};
        session.pendingAskUser = {};
        sm.broadcastSessionList();
        setImmediate(function () {
          if (session.abortController) {
            session.abortController.abort();
          }
        });

        // Update permission mode for the new session
        sm.currentPermissionMode = "acceptEdits";
        send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });

        // Build prompt from plan content (sent from client) or plan file path
        var clientPlanContent = msg.planContent || "";
        var planPrompt;
        if (clientPlanContent) {
          planPrompt = "Execute the following plan. Do NOT re-enter plan mode -- just implement it step by step.\n\n" + clientPlanContent;
        } else {
          var planFilePath = (pending.toolInput && pending.toolInput.planFilePath) || "";
          planPrompt = "Execute the plan in " + planFilePath + ". Do NOT re-enter plan mode -- read the plan file and implement it step by step.";
        }

        // Wait for old query stream to fully terminate, then create new session + send plan
        var oldStreamPromise = session.streamPromise || Promise.resolve();
        Promise.race([
          oldStreamPromise,
          new Promise(function (resolve) { setTimeout(resolve, 3000); }),
        ]).then(function () {
          try {
            var newSession = sm.createSession(null, ws);
            // Send the plan as the first user message (with planContent for UI rendering)
            var userMsg = { type: "user_message", text: planPrompt, planContent: clientPlanContent || null };
            // lr-2ea2a7: routes through the shared history-cap helper (see grep-guard test).
            sm.recordHistoryEntry(newSession, userMsg, true);
            sm.appendToSessionFile(newSession, userMsg);
            newSession.title = "Plan execution (cleared context)";
            sm.saveSessionFile(newSession);
            sm.broadcastSessionList();
            sendToSession(newSession.localId, userMsg);

            newSession.isProcessing = true;
            onProcessingChanged();
            newSession.sentToolResults = {};
            sendToSession(newSession.localId, { type: "status", status: "processing" });
            newSession.acceptEditsAfterStart = true;
            sdk.startQuery(newSession, planPrompt, undefined, ensureProjectAccessForSession(newSession));
          } catch (e) {
            console.error("[project] Error starting plan execution:", e);
            sendTo(ws, { type: "error", text: "Failed to start plan execution: " + (e.message || e) });
          }
        }).catch(function (e) {
          console.error("[project] Plan execution stream wait failed:", e.message || e);
        });
        return true;
      }

      // --- Plan approval: "deny_with_feedback" -- deny + send feedback as follow-up message ---
      if (decision === "deny_with_feedback") {
        var feedback = msg.feedback || "";
        pending.resolve({ behavior: "deny", message: feedback || "User provided feedback" });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });

        // Send feedback as next user message if there's text
        if (feedback) {
          setTimeout(function () {
            var userMsg = { type: "user_message", text: feedback };
            // lr-2ea2a7: routes through the shared history-cap helper (see grep-guard test).
            sm.recordHistoryEntry(session, userMsg, true);
            sm.appendToSessionFile(session, userMsg);
            sendToSession(session.localId, userMsg);

            if (!session.isProcessing) {
              session.isProcessing = true;
              onProcessingChanged();
              session.sentToolResults = {};
              sendToSession(session.localId, { type: "status", status: "processing" });
              if (!session.queryInstance && !session.worker) {
                sdk.startQuery(session, feedback, undefined, ensureProjectAccessForSession(session));
              } else {
                sdk.pushMessage(session, feedback);
              }
            } else {
              sdk.pushMessage(session, feedback);
            }
          }, 200);
        }
        return true;
      }

      if (decision === "allow" || decision === "allow_always") {
        if (decision === "allow_always") {
          if (!session.allowedTools) session.allowedTools = {};
          // lr-f969dc: keyed on toolName + input discriminator (not bare
          // toolName) so a Skill grant scopes to the specific skill that was
          // actually approved rather than silently authorizing every skill.
          session.allowedTools[utils.permissionGrantKey(pending.toolName, pending.toolInput)] = true;
          // Flush immediately (lr-8b2e) so the grant survives daemon restart /
          // resume-by-cliSessionId rehydration even without a later save
          // trigger — previously this lived only in the in-memory session
          // object and was lost on rebuild, causing a spurious re-prompt.
          sm.saveSessionFile(session);
        }
        pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
      } else {
        pending.resolve({ behavior: "deny", message: "User denied permission" });
      }

      sm.sendAndRecord(session, {
        type: "permission_resolved",
        requestId: requestId,
        decision: decision,
      });
      return true;
    }

    // --- MCP elicitation response ---
    if (msg.type === "elicitation_response") {
      var session = getSessionForWs(ws);
      if (!session) return true;
      var pending = session.pendingElicitations && session.pendingElicitations[msg.requestId];
      if (!pending) return true;
      delete session.pendingElicitations[msg.requestId];
      if (msg.action === "accept") {
        pending.resolve({ action: "accept", content: msg.content || {} });
      } else {
        pending.resolve({ action: "reject" });
      }
      sm.sendAndRecord(session, {
        type: "elicitation_resolved",
        requestId: msg.requestId,
        action: msg.action,
      });
      return true;
    }

    // --- Browse directories (for add-project autocomplete) ---
    if (msg.type === "browse_dir") {
      var rawPath = (msg.path || "").replace(/^~/, require("./config").REAL_HOME);
      var absTarget = path.resolve(rawPath);
      // Multi-user mode: non-admins can only browse their home directory
      if (osUsers && osUsers.length > 0 && ws._clagenticUser && ws._clagenticUser.role !== "admin") {
        var browseHome = ws._clagenticUser.linuxUser ? "/home/" + ws._clagenticUser.linuxUser : null;
        if (!browseHome || (absTarget !== browseHome && (absTarget + "/").indexOf(browseHome + "/") !== 0)) {
          sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: [], error: "Access restricted to your home directory" });
          return true;
        }
      }
      var parentDir, prefix;
      try {
        var stat = fs.statSync(absTarget);
        if (stat.isDirectory()) {
          // Input is an existing directory -- list its children
          parentDir = absTarget;
          prefix = "";
        } else {
          parentDir = path.dirname(absTarget);
          prefix = path.basename(absTarget).toLowerCase();
        }
      } catch (e) {
        // Path doesn't exist -- list parent and filter by typed prefix
        parentDir = path.dirname(absTarget);
        prefix = path.basename(absTarget).toLowerCase();
      }
      try {
        var dirItems = fs.readdirSync(parentDir, { withFileTypes: true });
        var dirEntries = [];
        for (var di = 0; di < dirItems.length; di++) {
          var d = dirItems[di];
          if (!d.isDirectory()) continue;
          if (d.name.charAt(0) === ".") continue;
          if (IGNORED_DIRS.has(d.name)) continue;
          if (prefix && !d.name.toLowerCase().startsWith(prefix)) continue;
          dirEntries.push({ name: d.name, path: path.join(parentDir, d.name) });
        }
        dirEntries.sort(function (a, b) { return a.name.localeCompare(b.name); });
        sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: dirEntries });
      } catch (e) {
        sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: [], error: e.message });
      }
      return true;
    }

    // --- Add project from web UI ---
    if (msg.type === "add_project") {
      var addPath = (msg.path || "").replace(/^~/, require("./config").REAL_HOME);
      var addAbs = path.resolve(addPath);
      // Multi-user mode: normal users restricted to their home directory
      if (osUsers && osUsers.length > 0 && ws._clagenticUser && ws._clagenticUser.role !== "admin") {
        if (!ws._clagenticUser.linuxUser) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "No Linux user assigned" });
          return true;
        }
        var userHome = "/home/" + ws._clagenticUser.linuxUser;
        if (addAbs !== userHome && (addAbs + "/").indexOf(userHome + "/") !== 0) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "Path not allowed. You can only add directories under " + userHome });
          return true;
        }
      }
      try {
        var addStat = fs.statSync(addAbs);
        if (!addStat.isDirectory()) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "Not a directory" });
          return true;
        }
      } catch (e) {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Directory not found" });
        return true;
      }
      if (typeof opts.onAddProject === "function") {
        var result = opts.onAddProject(addAbs, ws._clagenticUser);
        sendTo(ws, { type: "add_project_result", ok: result.ok, slug: result.slug, error: result.error, existing: result.existing });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Create new empty project ---
    if (msg.type === "create_project" || msg.type === "clone_project") {
      if (ws._clagenticUser) {
        var cpPerms = usersModule.getEffectivePermissions(ws._clagenticUser, osUsers);
        if (!cpPerms.createProject) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "You do not have permission to create projects" });
          return true;
        }
      }
    }
    if (msg.type === "create_project") {
      var createName = (msg.name || "").trim();
      if (!createName || !/^[a-zA-Z0-9_-]+$/.test(createName)) {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Invalid name. Use only letters, numbers, dashes, and underscores." });
        return true;
      }
      if (typeof opts.onCreateProject === "function") {
        var createResult = opts.onCreateProject(createName, ws._clagenticUser);
        sendTo(ws, { type: "add_project_result", ok: createResult.ok, slug: createResult.slug, error: createResult.error });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Clone project from GitHub ---
    if (msg.type === "clone_project") {
      var cloneUrl = (msg.url || "").trim();
      if (!cloneUrl || (!/^https?:\/\//.test(cloneUrl) && !/^git@/.test(cloneUrl))) {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Invalid URL. Use https:// or git@ format." });
        return true;
      }
      sendTo(ws, { type: "clone_project_progress", status: "cloning" });
      if (typeof opts.onCloneProject === "function") {
        opts.onCloneProject(cloneUrl, ws._clagenticUser, function (cloneResult) {
          sendTo(ws, { type: "add_project_result", ok: cloneResult.ok, slug: cloneResult.slug, error: cloneResult.error });
        });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Create worktree from web UI ---
    if (msg.type === "create_worktree") {
      var wtBranch = (msg.branch || "").trim();
      var wtDirName = (msg.dirName || "").trim() || wtBranch.replace(/\//g, "-");
      var wtBase = (msg.baseBranch || "").trim() || null;
      if (!wtBranch || !/^[a-zA-Z0-9_\/.@-]+$/.test(wtBranch)) {
        sendTo(ws, { type: "create_worktree_result", ok: false, dirName: wtDirName, error: "Invalid branch name" });
        return true;
      }
      if (typeof onCreateWorktree === "function") {
        var wtResult = onCreateWorktree(slug, wtBranch, wtDirName, wtBase);
        sendTo(ws, { type: "create_worktree_result", ok: wtResult.ok, dirName: wtDirName, slug: wtResult.slug, error: wtResult.error });
      } else {
        sendTo(ws, { type: "create_worktree_result", ok: false, dirName: wtDirName, error: "Not supported" });
      }
      return true;
    }

    // --- Pre-check: does the project have tasks/schedules? ---
    if (msg.type === "remove_project_check") {
      var checkSlug = msg.slug;
      if (!checkSlug) {
        sendTo(ws, { type: "remove_project_check_result", slug: checkSlug, name: msg.name || checkSlug, count: 0 });
        return true;
      }
      var schedCount = getScheduleCount(checkSlug);
      sendTo(ws, { type: "remove_project_check_result", slug: checkSlug, name: msg.name || checkSlug, count: schedCount });
      return true;
    }

    // --- Remove project from web UI ---
    if (msg.type === "remove_project") {
      if (ws._clagenticUser) {
        var dpPerms = usersModule.getEffectivePermissions(ws._clagenticUser, osUsers);
        if (!dpPerms.deleteProject) {
          sendTo(ws, { type: "remove_project_result", ok: false, error: "You do not have permission to delete projects" });
          return true;
        }
      }
      var removeSlug = msg.slug;
      if (!removeSlug) {
        sendTo(ws, { type: "remove_project_result", ok: false, error: "Missing slug" });
        return true;
      }
      // If client chose to move tasks to another project before removing
      if (msg.moveTasksTo) {
        moveAllSchedulesToProject(removeSlug, msg.moveTasksTo);
      }
      if (typeof opts.onRemoveProject === "function") {
        // onRemoveProject is synchronous (git worktree remove runs via
        // execFileSync) — call it first and forward its actual result.
        // Previously this sent {ok:true} unconditionally before calling
        // onRemoveProject, so a real failure (e.g. dirty/locked worktree
        // returned by removeWorktree) was silently discarded: the client
        // was told removal succeeded while the worktree stayed on disk
        // (lr-fc2818).
        var removeUserId = ws._clagenticUser ? ws._clagenticUser.id : null;
        var removeResult = opts.onRemoveProject(removeSlug, removeUserId) || {};
        sendTo(ws, { type: "remove_project_result", ok: removeResult.ok !== false, slug: removeSlug, error: removeResult.error });
      } else {
        sendTo(ws, { type: "remove_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Move a single schedule to another project ---
    if (msg.type === "schedule_move") {
      if (ws._clagenticUser) {
        var schMovePerms = usersModule.getEffectivePermissions(ws._clagenticUser, osUsers);
        if (!schMovePerms.scheduledTasks) {
          sendTo(ws, { type: "error", text: "Scheduled tasks access is not permitted" });
          return true;
        }
      }
      var moveResult = moveScheduleToProject(msg.recordId, msg.fromSlug, msg.toSlug);
      if (moveResult.ok) {
        // Re-broadcast updated records to this project's clients
        send({ type: "loop_registry_updated", records: getHubSchedules() });
      }
      sendTo(ws, { type: "schedule_move_result", ok: moveResult.ok, error: moveResult.error });
      return true;
    }

    // --- Reorder projects ---
    if (msg.type === "reorder_projects") {
      var slugs = msg.slugs;
      if (!Array.isArray(slugs) || slugs.length === 0) {
        sendTo(ws, { type: "reorder_projects_result", ok: false, error: "Missing slugs" });
        return true;
      }
      if (typeof opts.onReorderProjects === "function") {
        var reorderResult = opts.onReorderProjects(slugs);
        sendTo(ws, { type: "reorder_projects_result", ok: reorderResult.ok, error: reorderResult.error });
      } else {
        sendTo(ws, { type: "reorder_projects_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Set project title (rename) ---
    if (msg.type === "set_project_title") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_title_result", ok: false, error: "Missing slug" });
        return true;
      }
      if (typeof opts.onSetProjectTitle === "function") {
        var titleResult = opts.onSetProjectTitle(msg.slug, msg.title || null);
        sendTo(ws, { type: "set_project_title_result", ok: titleResult.ok, slug: msg.slug, error: titleResult.error });
      } else {
        sendTo(ws, { type: "set_project_title_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Set project icon (emoji) ---
    if (msg.type === "set_project_icon") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_icon_result", ok: false, error: "Missing slug" });
        return true;
      }
      if (typeof opts.onSetProjectIcon === "function") {
        var iconResult = opts.onSetProjectIcon(msg.slug, msg.icon || null);
        sendTo(ws, { type: "set_project_icon_result", ok: iconResult.ok, slug: msg.slug, error: iconResult.error });
      } else {
        sendTo(ws, { type: "set_project_icon_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Set project preferred agent ---
    if (msg.type === "set_project_preferred_agent") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_preferred_agent_result", ok: false, error: "Missing slug" });
        return true;
      }
      if (typeof opts.onSetProjectPreferredAgent === "function") {
        // agent is null to clear, or { name, kind, pluginName } to set
        var agentVal = msg.agent || null;
        var paResult = opts.onSetProjectPreferredAgent(msg.slug, agentVal);
        sendTo(ws, { type: "set_project_preferred_agent_result", ok: paResult.ok, slug: msg.slug, error: paResult.error });
      } else {
        sendTo(ws, { type: "set_project_preferred_agent_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Set project folder ---
    if (msg.type === "set_project_folder") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_folder_result", ok: false, error: "Missing slug" });
        return true;
      }
      if (typeof opts.onSetProjectFolder === "function") {
        var folderResult = opts.onSetProjectFolder(msg.slug, msg.folderName || null);
        sendTo(ws, { type: "set_project_folder_result", ok: folderResult.ok, slug: msg.slug, error: folderResult.error });
      } else {
        sendTo(ws, { type: "set_project_folder_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Rename project folder ---
    if (msg.type === "rename_project_folder") {
      if (!msg.oldName || !msg.newName) {
        sendTo(ws, { type: "rename_project_folder_result", ok: false, error: "Missing oldName or newName" });
        return true;
      }
      if (typeof opts.onRenameProjectFolder === "function") {
        var renameResult = opts.onRenameProjectFolder(msg.oldName, msg.newName);
        sendTo(ws, { type: "rename_project_folder_result", ok: renameResult.ok, error: renameResult.error });
      } else {
        sendTo(ws, { type: "rename_project_folder_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Set folder icon ---
    if (msg.type === "set_folder_icon") {
      if (!msg.folderName) {
        sendTo(ws, { type: "set_folder_icon_result", ok: false, error: "Missing folderName" });
        return true;
      }
      if (typeof opts.onSetFolderIcon === "function") {
        var fIconResult = opts.onSetFolderIcon(msg.folderName, msg.icon || null);
        sendTo(ws, { type: "set_folder_icon_result", ok: fIconResult.ok, error: fIconResult.error });
      } else {
        sendTo(ws, { type: "set_folder_icon_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Rename a custom-icon upload (lr-d1d9) ---
    // Auth parity with the picker's POST/DELETE /api/custom-emoji HTTP routes:
    // no admin gate, no ownership model. Every WS connection reaching this
    // handler already passed the upgrade-time isRequestAuthed() check in
    // server.js, so no additional per-message auth check is needed here —
    // same posture as the neighboring set_project_icon / set_folder_icon ops.
    if (msg.type === "rename_custom_icon") {
      if (!msg.oldSlug || !msg.newSlug) {
        sendTo(ws, { type: "rename_custom_icon_result", ok: false, error: "Missing oldSlug or newSlug" });
        return true;
      }
      if (typeof opts.onRenameCustomIcon === "function") {
        var renameIconResult = opts.onRenameCustomIcon(msg.oldSlug, msg.newSlug);
        sendTo(ws, {
          type: "rename_custom_icon_result",
          ok: renameIconResult.ok,
          oldSlug: msg.oldSlug,
          newSlug: renameIconResult.slug || msg.newSlug,
          error: renameIconResult.error,
        });
      } else {
        sendTo(ws, { type: "rename_custom_icon_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Daemon config / server management (admin-only in multi-user mode) ---
    if (msg.type === "get_daemon_config" || msg.type === "set_pin" || msg.type === "set_keep_awake" ||
        msg.type === "set_auto_continue" || msg.type === "set_image_retention" || msg.type === "set_mem_available_threshold" ||
        msg.type === "set_tokens_per_mb_headroom" ||
        msg.type === "set_lite_auto_enroll" ||
        msg.type === "shutdown_server" || msg.type === "restart_server") {
      var _wsUser = ws._clagenticUser;
      if (!_wsUser || _wsUser.role !== "admin") {
        // lr-93e3c8 (fnd-66af4e, item 7): app-messages.js's client-side
        // `error` handler reads msg.text (addSystemMessage(msg.text, true)),
        // not msg.message -- both admin-gate rejections in this file used
        // to send `message:`, so the frame arrived client-side but rendered
        // as addSystemMessage(undefined, true), effectively swallowed.
        sendTo(ws, { type: "error", text: "Admin access required" });
        return true;
      }
    }

    if (msg.type === "get_daemon_config") {
      if (typeof opts.onGetDaemonConfig === "function") {
        // lr-20e71c: ws._clagenticEffectiveProtocol was resolved once at WS-upgrade
        // time (server.js), where X-Forwarded-Proto is still in scope — this
        // per-message dispatch only has ws/msg, not the original req.
        var daemonConfig = opts.onGetDaemonConfig(ws._clagenticEffectiveProtocol);
        sendTo(ws, { type: "daemon_config", config: daemonConfig });
      }
      return true;
    }

    if (msg.type === "set_pin") {
      if (typeof opts.onSetPin === "function") {
        var pinResult = opts.onSetPin(msg.pin || null);
        sendTo(ws, { type: "set_pin_result", ok: pinResult.ok, pinEnabled: pinResult.pinEnabled });
      }
      return true;
    }

    if (msg.type === "set_keep_awake") {
      if (typeof opts.onSetKeepAwake === "function") {
        var kaResult = opts.onSetKeepAwake(msg.value);
        sendTo(ws, { type: "set_keep_awake_result", ok: kaResult.ok, keepAwake: kaResult.keepAwake });
        send({ type: "keep_awake_changed", keepAwake: kaResult.keepAwake });
      }
      return true;
    }

    if (msg.type === "set_auto_continue") {
      if (typeof opts.onSetAutoContinue === "function") {
        var acResult = opts.onSetAutoContinue(msg.value);
        sendTo(ws, { type: "set_auto_continue_result", ok: acResult.ok, autoContinueOnRateLimit: acResult.autoContinueOnRateLimit });
        send({ type: "auto_continue_changed", autoContinueOnRateLimit: acResult.autoContinueOnRateLimit });
      }
      return true;
    }

    if (msg.type === "set_image_retention") {
      if (typeof opts.onSetImageRetention === "function") {
        var irResult = opts.onSetImageRetention(msg.days);
        sendTo(ws, { type: "set_image_retention_result", ok: irResult.ok, days: irResult.days });
      }
      return true;
    }

    if (msg.type === "set_lite_auto_enroll") {
      if (typeof opts.onSetLiteAutoEnroll === "function") {
        var laeResult = opts.onSetLiteAutoEnroll(msg.value);
        // set_lite_auto_enroll_result is intentionally not consumed by the client:
        // the daemon_config_changed broadcast below carries the updated liteAutoEnroll
        // flag and is the authoritative sync path for all connected clients.
        sendTo(ws, { type: "set_lite_auto_enroll_result", ok: laeResult.ok, liteAutoEnroll: laeResult.liteAutoEnroll });
        send({ type: "daemon_config_changed", liteAutoEnroll: laeResult.liteAutoEnroll });
      }
      return true;
    }

    if (msg.type === "set_mem_available_threshold") {
      if (typeof opts.onSetMemAvailableThreshold === "function") {
        var matResult = opts.onSetMemAvailableThreshold(msg.value);
        sendTo(ws, { type: "set_mem_available_threshold_result", ok: matResult.ok, memAvailableMinMB: matResult.memAvailableMinMB, error: matResult.error });
        // lr-93e3c8 (item 6): only broadcast "changed" on an actual change —
        // onSetMemAvailableThreshold now rejects (ok:false) instead of
        // silently substituting a value, so a rejected edit must not tell
        // every other connected client the value changed when it didn't.
        if (matResult.ok) {
          send({ type: "mem_available_threshold_changed", memAvailableMinMB: matResult.memAvailableMinMB });
        }
      }
      return true;
    }

    if (msg.type === "set_tokens_per_mb_headroom") {
      if (typeof opts.onSetTokensPerMbHeadroom === "function") {
        var tpmResult = opts.onSetTokensPerMbHeadroom(msg.value);
        sendTo(ws, { type: "set_tokens_per_mb_headroom_result", ok: tpmResult.ok, tokensPerMbHeadroom: tpmResult.tokensPerMbHeadroom, error: tpmResult.error });
        // See comment on set_mem_available_threshold above — same reasoning.
        if (tpmResult.ok) {
          send({ type: "tokens_per_mb_headroom_changed", tokensPerMbHeadroom: tpmResult.tokensPerMbHeadroom });
        }
      }
      return true;
    }

    if (msg.type === "shutdown_server") {
      if (typeof opts.onShutdown === "function") {
        sendTo(ws, { type: "shutdown_server_result", ok: true });
        send({ type: "toast", level: "warn", message: "Server is shutting down..." });
        // Small delay so the response has time to reach clients
        setTimeout(function () {
          opts.onShutdown();
        }, 500);
      } else {
        sendTo(ws, { type: "shutdown_server_result", ok: false, error: "Shutdown not supported" });
      }
      return true;
    }

    if (msg.type === "restart_server") {
      if (typeof opts.onRestart === "function") {
        sendTo(ws, { type: "restart_server_result", ok: true });
        send({ type: "toast", level: "info", message: "Server is restarting..." });
        // Small delay so the response has time to reach clients
        setTimeout(function () {
          opts.onRestart();
        }, 500);
      } else {
        sendTo(ws, { type: "restart_server_result", ok: false, error: "Restart not supported" });
      }
      return true;
    }

    // --- Clagentic: Lite integration WS messages ---

    // get_lite_project_status — responds with lite_project_status { enrolled: bool }
    if (msg.type === "get_lite_project_status") {
      var liteEnrolled = liteDetect.isProjectEnrolled(cwd);
      sendTo(ws, { type: "lite_project_status", enrolled: liteEnrolled });
      return true;
    }

    // lite_enroll_project — shells out to `clagentic-lite enroll <projectDir>`
    if (msg.type === "lite_enroll_project") {
      execFile("clagentic-lite", ["enroll", cwd], { timeout: 30000 }, function (err, stdout, stderr) {
        if (err) {
          sendTo(ws, {
            type: "lite_enroll_result",
            ok: false,
            error: (stderr && stderr.trim()) || (err.message || "enroll failed"),
          });
        } else {
          sendTo(ws, { type: "lite_enroll_result", ok: true });
          // Refresh enrollment status after successful enroll
          sendTo(ws, { type: "lite_project_status", enrolled: liteDetect.isProjectEnrolled(cwd) });
        }
      });
      return true;
    }

    // lite_unenroll_project — shells out to `clagentic-lite unenroll <projectDir>`
    if (msg.type === "lite_unenroll_project") {
      execFile("clagentic-lite", ["unenroll", cwd], { timeout: 30000 }, function (err, stdout, stderr) {
        if (err) {
          sendTo(ws, {
            type: "lite_unenroll_result",
            ok: false,
            error: (stderr && stderr.trim()) || (err.message || "unenroll failed"),
          });
        } else {
          sendTo(ws, { type: "lite_unenroll_result", ok: true });
          // Refresh enrollment status after successful unenroll
          sendTo(ws, { type: "lite_project_status", enrolled: liteDetect.isProjectEnrolled(cwd) });
        }
      });
      return true;
    }

    return false;
  }

  return {
    handleSessionsMessage: handleSessionsMessage,
  };
}

module.exports = {
  attachSessions: attachSessions,
  PROCESS_STATS_BASE_FIELD_KEYS: PROCESS_STATS_BASE_FIELD_KEYS,
};

