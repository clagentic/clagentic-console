// app-messages.js - WebSocket message router
// Extracted from app.js (PR-23)
//
// lr-4e49 Part 2: this file used to be a single 185-case switch — every new
// message type had to edit it, making it a permanent merge hotspot. It is
// now a thin handler registry: `handlers[type]` maps a message type to an
// array of handler functions, populated either by the core registration
// call at the bottom of this file (message types with no better single
// owner, or with more than one consumer module already imported together
// here) or by a domain module calling registerHandlers() itself at its own
// module load time (see filebrowser.js, server-settings.js,
// app-history-replay.js). processMessage() looks up the array for
// msg.type and invokes each handler in registration order — this preserves
// the exact per-type call order the original switch cases had (e.g.
// process_stats: updateStatusPanel() before updateSettingsStats()).
//
// Ordering risk (called out in the split task): history_meta/prepend/done
// drive sticky-bottom scroll arming across a whole replay batch — the
// riskiest sequencing in this file. That block is extracted verbatim to
// app-history-replay.js; see the module comment there for why it stays
// self-contained and doesn't change call order.

import { store } from './store.js';
import { getWs } from './ws-ref.js';

// --- Leaf module imports ---
import { showToast } from './utils.js';
import { refreshIcons, iconHtml } from './icons.js';
import { updatePageTitle } from './sidebar.js';
import { renderSessionList, updateSessionPresence, populateCliSessionList, handleSearchResults, updateSessionBadge } from './sidebar-sessions.js';
import { updateDmBadge, renderSidebarPresence, setMentionActive } from './sidebar-users.js';
import { refreshMobileChatSheet } from './sidebar-mobile.js';
import { handlePaletteSessionSwitch, setPaletteVersion } from './command-palette.js';
import { handleAgentsList, handleAgentFavoriteToggled } from './agent-picker.js';
import { handleProjectAgentsList, requestProjectAgents } from './at-agents.js';
import { handleFindInSessionResults } from './session-search.js';
import { handleInputSync, autoResize, resetAutoResize, builtinCommands, setScheduleBtnDisabled } from './input.js';
import { startThinking, appendThinking, stopThinking, resetThinkingGroup, createToolItem, updateToolExecuting, updateToolResult, markAllToolsDone, closeToolGroup, removeToolFromGroup, resetToolState, getTools, getPlanContent, setPlanContent, renderPlanBanner, renderPlanCard, getTodoTools, handleTodoWrite, handleTaskCreate, handleTaskUpdate, applyDeadSessionTodoCompaction, isPlanFilePath, enableMainInput, addTurnMeta, updateSubagentActivity, addSubagentToolEntry, markSubagentDone, initSubagentStop, updateSubagentProgress, updateSubagentTaskStatus, renderAskUserQuestion, markAskUserAnswered, renderPermissionRequest, markPermissionCancelled, markPermissionResolved, renderElicitationRequest, markElicitationResolved } from './tools.js';
import { showDoneNotification, playDoneSound, isNotifAlertEnabled, isNotifSoundEnabled } from './notifications.js';
import { handleFsRead, refreshIfOpen } from './filebrowser.js';
import { isProjectSettingsOpen, refreshProjectSettingsModels, handleInstructionsRead, handleInstructionsWrite, handleProjectEnv, handleProjectEnvSaved, handleProjectSharedEnv, handleProjectSharedEnvSaved, handleProjectOwnerChanged, updateLiteVisibility, handleLiteProjectStatus, handleLiteEnrollResult, handleLiteUnenrollResult } from './project-settings.js';
import { updateSettingsModels, updateSettingsStats, updateDaemonConfig, handleSharedEnv, handleSharedEnvSaved, updateSsLiteVisibility } from './server-settings.js';
import { handleRenameCustomIconResult } from './custom-icons-settings.js';
import { handleTermList, handleTermCreated, sendTerminalCommand, handleTermOutput, handleTermResized, handleTermExited, handleTermClosed } from './terminal.js';
import { updateTerminalList, handleContextSourcesState } from './context-sources.js';
import { handleNotesList, handleNoteCreated, handleNoteUpdated, handleNoteDeleted } from './sticky-notes.js';
import { handleSkillInstalled, handleSkillUninstalled } from './skills.js';
import { showRewindModal, onRewindComplete, setRewindMode, onRewindError, clearPendingRewindUuid, addRewindButton } from './rewind.js';
import { checkAdminAccess } from './admin.js';
import { showImageModal, sendExtensionCommand, handleMcpToolCallMessage } from './app-misc.js';
import { handleMcpServersState } from './mcp-ui.js';
import { handleLoopRegistryUpdated, handleScheduleRunStarted, handleScheduleRunFinished, handleLoopScheduled, isSchedulerOpen, enterCraftingMode, exitCraftingMode, handleLoopRegistryFiles } from './scheduler.js';

// --- App module imports ---
import { scrollToBottom, addToMessages, addUserMessage, addSystemMessage, appendDelta, finalizeAssistantBlock, addConflictMessage, addContextOverflowMessage, showSuggestionChips, removePreThinking } from './app-rendering.js';
import { startUrgentBlink, stopUrgentBlink, blinkSessionDot, updateCrossProjectBlink } from './app-favicon.js';
import { setStatus } from './app-connection.js';
import { getModelEffortLevels, accumulateUsage, setSessionUsage, updateUsagePanel, accumulateContext, updateContextPanel, renderCtxPopover, updateStatusPanel } from './app-panels.js';
import { updateProjectList, resetClientState, showUpdateAvailable, handleRemoveProjectCheckResult, handleRemoveProjectResult, handleBrowseDirResult, handleAddProjectResult, handleCloneProgress } from './app-projects.js';
import { updateHistorySentinel, prependOlderHistory } from './app-header.js';
import { hideHomeHub, handleHubSchedules, handleHubRecentSessions } from './app-home-hub.js';
import { openDm, enterDmMode, exitDmMode, appendDmMessage, showDmTypingIndicator } from './app-dm.js';
import { handleRateLimitEvent, updateRateLimitUsage, addScheduledMessageBubble, removeScheduledMessageBubble, clearScheduledMessage, handleFastModeState, restoreRateLimitStateForSession, forgetSessionRateLimitState } from './app-rate-limit.js';
import { handleRemoteCursorMove, handleRemoteCursorLeave, handleRemoteSelection, clearRemoteCursors } from './app-cursors.js';
import { showLoopBanner, updateLoopBanner, updateLoopInputVisibility, updateLoopPendingBanner, showRalphApprovalBar, updateRalphApprovalStatus, openRalphPreviewModal, showExecModal, updateExecModalStatus } from './app-loop-ui.js';
import { handleSkillInstallWs } from './app-skills-install.js';
import { handleNotificationsState, handleNotificationCreated, handleNotificationDismissed, handleNotificationDismissedAll, showUpdateBanner } from './app-notifications.js';
import { handleMentionStart, handleMentionActivity, handleMentionStream, handleMentionDone, handleMentionError, renderMentionUser, renderMentionResponse, renderUserMention } from './mention.js';
import { handleTeamState, handleTeamMemberUpdate, handleTeamTaskUpdate, handleTeamMessage as handleTeamMsg, handleTeamGone } from './team-panel.js';
import { addDiagnostic } from './diagnostics.js';
import { handleHistoryMeta, handleHistoryDone } from './app-history-replay.js';

// --- DOM refs (cached once, stable for page lifetime) ---
var messagesEl = document.getElementById("messages");
var headerTitleEl = document.getElementById("header-title");
var inputEl = document.getElementById("input");
var connectOverlay = document.getElementById("connect-overlay");

// --- Handler registry ---
// type -> array of handler functions, called in registration order.
// May already be populated by the time this line runs — see the
// registerHandlers() doc comment below (lr-4c58ae circular-import boot
// halt). Do not unconditionally reassign: that would drop any
// registrations a circular caller already made before this module's own
// body reached this line.
var handlers = handlers || {};

/**
 * Register one or more message-type handlers. Called by this module's own
 * core registration (bottom of file) and by domain modules that own a
 * message type outright (filebrowser.js, server-settings.js). Safe to call
 * multiple times for the same type — each call appends, so two modules can
 * both react to one broadcast (e.g. shared_env_result) without either
 * having to import the other.
 *
 * lr-4c58ae: this module sits in an import cycle with several of the domain
 * modules that call registerHandlers() at their own module-body top level
 * (filebrowser.js, server-settings.js — both import registerHandlers from
 * here, and this file imports back from them for their non-registry
 * exports). Depending on which module app.js's graph reaches first, ESM's
 * cycle-breaking semantics can run a caller's top-level registerHandlers()
 * call before this file's own `var handlers = {}` line has executed —
 * registerHandlers itself is always safely callable (function declarations
 * are hoisted at instantiation), but the object it wrote into on the module
 * scope was not yet assigned, throwing "Cannot read properties of
 * undefined" and halting the whole app.js boot before connect() runs.
 * Lazily initializing here (independent of module-body execution order)
 * makes registration order-safe: the first call — whichever module makes
 * it — creates the registry, and the `var handlers = {}` below becomes a
 * no-op once this module's own body eventually runs.
 *
 * @param {Object<string, function(Object): void>} map - type -> handler
 */
export function registerHandlers(map) {
  if (!handlers) handlers = {};
  Object.keys(map).forEach(function (type) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(map[type]);
  });
}

export function processMessage(msg) {
  // Preserve original timestamp from history replay
  store.set({ currentMsgTs: msg._ts || null });

  var list = handlers[msg.type];
  if (!list) return;
  for (var i = 0; i < list.length; i++) {
    list[i](msg);
  }
}

// --- Core handlers ---
// Message types with no single better-fit domain module, or whose original
// case body already called into more than one module and needs both
// imports together (process_stats, shared_env_result, set_shared_env_result,
// daemon_config). See filebrowser.js / server-settings.js /
// app-history-replay.js for the handlers those modules register themselves.
registerHandlers({
  history_meta: function (msg) {
    handleHistoryMeta(msg, updateHistorySentinel);
  },

  history_prepend: function (msg) {
    prependOlderHistory(msg.items, msg.meta);
  },

  history_done: handleHistoryDone,

  info: function (msg) {
    if (msg.text && !msg.project && !msg.cwd) {
      addSystemMessage(msg.text, false);
      return;
    }
    store.set({ projectName: msg.project || msg.cwd });
    if (msg.cwd) store.set({ cwd: msg.cwd });
    if (msg.slug) store.set({ currentSlug: msg.slug });
    try { var _is = store.snap(); localStorage.setItem("clagentic-project-name-" + (_is.currentSlug || "default"), _is.projectName); } catch (e) {}
    headerTitleEl.textContent = store.get('projectName');
    var tbProjectName = document.getElementById("title-bar-project-name");
    if (tbProjectName) tbProjectName.textContent = msg.title || store.get('projectName');
    updatePageTitle();
    if (msg.version) {
      setPaletteVersion(msg.version);
      var serverVersionEl = document.getElementById("settings-server-version");
      if (serverVersionEl) serverVersionEl.textContent = msg.version;
    }
    if (msg.projectOwnerId !== undefined) store.set({ currentProjectOwnerId: msg.projectOwnerId });
    if (msg.ownerLocked !== undefined) store.set({ ownerLocked: !!msg.ownerLocked });
    if (msg.osUsers !== undefined) store.set({ isOsUsers: !!msg.osUsers });
    if (msg.lanHost) window.__lanHost = msg.lanHost;
    if (msg.dangerouslySkipPermissions) {
      store.set({ skipPermsEnabled: true });
      var spBanner = document.getElementById("skip-perms-pill");
      if (spBanner) spBanner.classList.remove("hidden");
    }
    if (msg.dangerouslySkipPermissionsBlocked) {
      // The server config has dangerouslySkipPermissions=true but it is disabled
      // because multi-user mode is active. Warn admins so they know the config
      // flag has no effect and remove it to avoid confusion.
      if (store.get('permissions') && store.get('permissions').projectSettings !== false) {
        showToast("dangerouslySkipPermissions is set in config but is disabled in multi-user mode. All users have normal tool-approval rules.", "warn");
      }
    }
    updateProjectList(msg);
    if (msg.liteInstalled !== undefined) {
      updateLiteVisibility(!!msg.liteInstalled);
      updateSsLiteVisibility(!!msg.liteInstalled);
    }
  },

  update_available: function (msg) {
    // In multi-user mode, only show update UI to admins
    checkAdminAccess().then(function (isAdmin) {
      if (!isAdmin) return;
      showUpdateAvailable(msg);
      showUpdateBanner(msg);
    });
  },

  up_to_date: function (msg) {
    var utdBtn = document.getElementById("settings-update-check");
    if (utdBtn) {
      utdBtn.innerHTML = "";
      var utdIcon = document.createElement("i");
      utdIcon.setAttribute("data-lucide", "check");
      utdBtn.appendChild(utdIcon);
      utdBtn.appendChild(document.createTextNode(" Up to date (v" + msg.version + ")"));
      utdBtn.disabled = true;
      refreshIcons();
      setTimeout(function () {
        utdBtn.innerHTML = "";
        var rwIcon = document.createElement("i");
        rwIcon.setAttribute("data-lucide", "refresh-cw");
        utdBtn.appendChild(rwIcon);
        utdBtn.appendChild(document.createTextNode(" Check for updates"));
        utdBtn.disabled = false;
        utdBtn.classList.remove("settings-btn-update-available");
        refreshIcons();
      }, 3000);
    }
  },

  update_started: function (msg) {
    var updNowBtn = document.getElementById("update-now");
    if (updNowBtn) {
      updNowBtn.innerHTML = '<i data-lucide="loader"></i> Updating...';
      updNowBtn.disabled = true;
      refreshIcons();
      var spinIcon = updNowBtn.querySelector(".lucide");
      if (spinIcon) spinIcon.classList.add("icon-spin-inline");
    }
    // Block the entire screen with the connect overlay
    connectOverlay.classList.remove("hidden");
  },

  slash_commands: function (msg) {
    // Backward compat: server sends {name,desc,type}[] since lr-1c7f;
    // older server versions may still send string[].
    var reserved = new Set(builtinCommands.map(function (c) { return c.name; }));
    var enriched = (msg.commands || []).map(function (cmd) {
      if (typeof cmd === "string") return { name: cmd, desc: "", type: "skill" };
      return cmd;
    });
    store.set({ slashCommands: enriched.filter(function (cmd) {
      return !reserved.has(cmd.name);
    }) });
  },

  model_info: function (msg) {
    // Drop stale model_info from a vendor that doesn't match the active
    // session's vendor. On high-latency connections, the server's default-
    // adapter model_info can arrive after session_switched has already
    // bound the session to a different vendor. Applying it would replace
    // currentModels with the wrong vendor's list and trigger app-panels
    // to request models for the "wrong" vendor, which feeds back into a
    // ping-pong loop of vendor flapping. See issue #336.
    var _curV = store.get('currentVendor');
    if (msg.vendor && _curV && msg.vendor !== _curV) return;

    var _modelVal = msg.model;
    if (_modelVal && typeof _modelVal === "object") _modelVal = _modelVal.value || _modelVal.displayName || "";
    var _miUpdate = { currentModels: msg.models || [] };
    if (Object.prototype.hasOwnProperty.call(msg, "model")) {
      if (store.get('vendorSelectionLocked') && store.get('currentModel')) {
        // Keep the user's existing selection; only update models list
      } else {
        _miUpdate.currentModel = _modelVal || "";
      }
    } else {
      _miUpdate.currentModel = store.get('currentModel');
    }
    if (msg.vendor && !store.get('vendorSelectionLocked')) _miUpdate.currentVendor = msg.vendor;
    if (msg.availableVendors) _miUpdate.availableVendors = msg.availableVendors;
    if (msg.installedVendors) _miUpdate.installedVendors = msg.installedVendors;
    store.set(_miUpdate);
    updateSettingsModels(_modelVal, msg.models || []);
    refreshProjectSettingsModels();
  },

  config_state: function (msg) {
    var _cs = {};
    if (msg.model) _cs.currentModel = msg.model;
    if (msg.mode) _cs.currentMode = msg.mode;
    if (msg.effort) _cs.currentEffort = msg.effort;
    if (msg.betas) _cs.currentBetas = msg.betas;
    if (msg.thinking) _cs.currentThinking = msg.thinking;
    if (msg.thinkingBudget) _cs.currentThinkingBudget = msg.thinkingBudget;
    store.set(_cs);
    // Validate effort against current model's supported levels
    var _csRead = store.snap();
    if (_csRead.currentModels.length > 0) {
      var levels = getModelEffortLevels();
      var effortValid = false;
      for (var ei = 0; ei < levels.length; ei++) {
        if (levels[ei] === _csRead.currentEffort) { effortValid = true; break; }
      }
      if (!effortValid) store.set({ currentEffort: "medium" });
    }
  },

  codex_config: function (msg) {
    store.set({
      codexApproval: msg.approval,
      codexSandbox: msg.sandbox,
      codexWebSearch: msg.webSearch,
    });
  },

  client_count: function (msg) {
    // Sidebar presence: current project's online users
    if (msg.users) {
      renderSidebarPresence(msg.users);
    }
    // Non-multi-user mode: simple count in topbar
    if (!msg.users) {
      var countEl = document.getElementById("client-count");
      var countTextEl = document.getElementById("client-count-text");
      if (countEl && countTextEl) {
        if (msg.count > 1) {
          countTextEl.textContent = msg.count + " connected";
          countEl.classList.remove("hidden");
        } else {
          countEl.classList.add("hidden");
        }
      }
    }
  },

  toast: function (msg) {
    showToast(msg.message, msg.level, msg.detail);
  },

  skill_installed: function (msg) {
    handleSkillInstalled(msg);
    if (msg.success) { var _kis = Object.assign({}, store.get('knownInstalledSkills')); _kis[msg.skill] = true; store.set({ knownInstalledSkills: _kis }); }
    handleSkillInstallWs(msg);
  },

  skill_uninstalled: function (msg) {
    handleSkillUninstalled(msg);
    if (msg.success) { var _kis2 = Object.assign({}, store.get('knownInstalledSkills')); delete _kis2[msg.skill]; store.set({ knownInstalledSkills: _kis2 }); }
  },

  loop_registry_updated: handleLoopRegistryUpdated,
  schedule_run_started: handleScheduleRunStarted,
  schedule_run_finished: handleScheduleRunFinished,
  loop_scheduled: handleLoopScheduled,

  schedule_move_result: function (msg) {
    if (msg.ok) {
      showToast("Task moved", "success");
    } else {
      showToast(msg.error || "Failed to move task", "error");
    }
  },

  remove_project_check_result: handleRemoveProjectCheckResult,
  hub_schedules: handleHubSchedules,
  hub_recent_sessions: handleHubRecentSessions,

  input_sync: function (msg) {
    if (!store.get('dmMode')) handleInputSync(msg.text);
  },

  session_deleted: function (msg) {
    // lr-0827ba (PEACHES follow-up): a session was actually deleted (not
    // merely switched away from) — prune its per-session rate-limit /
    // scheduled-message arming state, canceling any background reset
    // timer, instead of leaking it forever. session_list alone never
    // told the client WHICH id(s) disappeared, so nothing could target
    // this cleanup before this message existed.
    (msg.ids || []).forEach(function (deletedId) {
      forgetSessionRateLimitState(deletedId);
    });
  },

  session_list: function (msg) {
    renderSessionList(msg.sessions || []);
    handlePaletteSessionSwitch();
    // Drain pending hub cross-project session switch (set by handleHubRecentSessions
    // when switching to a session in a different project). Fires here because
    // session_list is the first reliable post-connect message that guarantees
    // the WS is open and the session roster is populated.
    try {
      var _pendingHubSess = sessionStorage.getItem("pending-hub-session");
      if (_pendingHubSess) {
        sessionStorage.removeItem("pending-hub-session");
        var _phWs = getWs();
        if (_phWs && _phWs.readyState === 1) {
          _phWs.send(JSON.stringify({ type: "switch_session", id: parseInt(_pendingHubSess, 10) }));
        }
      }
    } catch (e) {}
  },

  agents_list: handleAgentsList,
  agent_favorite_toggled: handleAgentFavoriteToggled,
  project_agents_list: handleProjectAgentsList,

  session_presence: function (msg) {
    updateSessionPresence(msg.presence || {});
  },

  cursor_move: handleRemoteCursorMove,
  cursor_leave: handleRemoteCursorLeave,
  text_select: handleRemoteSelection,

  session_io: function (msg) {
    blinkSessionDot(msg.id);
  },

  session_unread: function (msg) {
    updateSessionBadge(msg.id, msg.count);
  },

  search_results: handleSearchResults,

  search_content_results: function (msg) {
    if (msg.source === "find_in_session") {
      handleFindInSessionResults(msg);
    }
  },

  cli_session_list: function (msg) {
    populateCliSessionList(msg.sessions || []);
  },

  session_switched: function (msg) {
    // Prefetch project agents so the @ menu is ready without a round-trip
    // the first time the user types @. Best-effort; at-agents.js handles
    // an empty list gracefully.
    requestProjectAgents();
    hideHomeHub();
    // Clear any stale replay indicator from a prior interrupted switch
    var replayLoadingEl = document.getElementById("replay-loading");
    if (replayLoadingEl) replayLoadingEl.classList.add("hidden");
    // Save draft from outgoing session
    var _prevSid = store.get('activeSessionId');
    if (_prevSid && inputEl.value) {
      store.get('sessionDrafts')[_prevSid] = inputEl.value;
    } else if (_prevSid) {
      delete store.get('sessionDrafts')[_prevSid];
    }
    store.set({ activeSessionId: msg.id, cliSessionId: msg.cliSessionId || null, vendorCapabilities: msg.capabilities || {}, sessionIsProcessing: !!msg.isProcessing });
    if (msg.vendor) {
      if (!store.get('vendorSelectionLocked') || msg.hasHistory) {
        store.set({ currentVendor: msg.vendor });
      }
      // Sessions with history have their vendor structurally bound to
      // the session: lock so a late-arriving default-adapter model_info
      // can't flip the UI back. Previously this branch unlocked, which
      // is what allowed the feedback loop in issue #336.
      if (msg.hasHistory) {
        store.set({ vendorSelectionLocked: true });
      }
    } else if (msg.hasHistory) {
      // Existing session without explicit vendor: reset to claude
      store.set({ currentVendor: "claude" });
      store.set({ vendorSelectionLocked: false });
    } else if (!msg.hasHistory) {
      // New session without vendor: no mate vendor lookup needed
    }
    if (!msg.hasHistory && !msg.vendor) {
      // Preserve explicit pre-message vendor choice on brand-new sessions.
    }
    // Show vendor toggle only for new sessions (no history).
    // Agent sessions are Claude Code-only — hide the toggle entirely so
    // the user cannot switch an agent session to Codex (which has no
    // equivalent agent identity API and would silently drop the persona).
    var _vtw = document.getElementById("vendor-toggle-wrap");
    if (_vtw) {
      if (msg.agentName) {
        _vtw.classList.add("hidden");
      } else if (msg.hasHistory) {
        _vtw.classList.remove("hidden"); _vtw.classList.add("locked");
      } else {
        _vtw.classList.remove("locked"); _vtw.classList.remove("hidden");
      }
    }
    // Session presence is now tracked server-side (user-presence.json)
    clearRemoteCursors();
    resetClientState();
    // lr-0827ba: redraw the incoming session's own armed rate-limit /
    // scheduled-message state (arming happens per-session in the
    // background regardless of focus — see rate-limit-state.js) instead
    // of relying on chat-history replay to happen to repaint it.
    restoreRateLimitStateForSession(store.get('activeSessionId'));

    updateLoopInputVisibility(msg.loop);
    // Restore input area visibility (may have been hidden by auth_required)
    var inputAreaSw = document.getElementById("input-area");
    if (inputAreaSw) inputAreaSw.classList.remove("hidden");
    // Restore draft for incoming session
    var draft = store.get('sessionDrafts')[store.get('activeSessionId')] || "";
    inputEl.value = draft;
    // Reset the autoResize line-count cache before the rAF so the skip-
    // guard never freezes the textarea at the outgoing session's height.
    resetAutoResize();
    // Defer autoResize to next frame — avoids a forced synchronous layout
    // read (scrollHeight) immediately after the DOM write (value =).
    requestAnimationFrame(function () { autoResize(); });
    if (!("ontouchstart" in window)) {
      inputEl.focus();
    }
  },

  session_id: function (msg) {
    store.set({ cliSessionId: msg.cliSessionId });
  },

  message_uuid: function (msg) {
    var uuidTarget;
    if (msg.messageType === "user") {
      var allUsers = messagesEl.querySelectorAll(".msg-user:not([data-uuid])");
      if (allUsers.length > 0) uuidTarget = allUsers[allUsers.length - 1];
    } else {
      var allAssistants = messagesEl.querySelectorAll(".msg-assistant:not([data-uuid])");
      if (allAssistants.length > 0) uuidTarget = allAssistants[allAssistants.length - 1];
    }
    if (uuidTarget) {
      uuidTarget.dataset.uuid = msg.uuid;
      if (msg.messageType === "user" && (store.get('vendorCapabilities') || {}).rewind !== false) addRewindButton(uuidTarget);
    }
    store.get('messageUuidMap').push({ uuid: msg.uuid, type: msg.messageType });
  },

  user_message: function (msg) {
    if (msg._internal) return;
    resetThinkingGroup();
    if (msg.planContent) {
      setPlanContent(msg.planContent);
      renderPlanCard(msg.planContent);
      addUserMessage("Execute the following plan. Do NOT re-enter plan mode — just implement it step by step.", msg.images || null, msg.pastes || null, msg.from, msg.fromName);
    } else {
      addUserMessage(msg.text, msg.images || null, msg.pastes || null, msg.from, msg.fromName);
    }
  },

  plan_content: function (msg) {
    setPlanContent(msg.content || "");
    renderPlanCard(msg.content || "");
  },

  context_preview: function (msg) {
    // Show a Context Card with tab screenshot between user message and assistant response
    if (msg.tab) {
      var card = document.createElement("div");
      card.className = "context-card";

      // Header
      var header = document.createElement("div");
      header.className = "context-card-header";
      var icon = document.createElement("span");
      icon.className = "context-card-icon";
      icon.innerHTML = iconHtml("globe");
      header.appendChild(icon);
      var label = document.createElement("span");
      label.textContent = "Viewing tab";
      header.appendChild(label);
      card.appendChild(header);

      // Screenshot
      if (msg.tab.screenshotUrl) {
        var img = document.createElement("img");
        img.className = "context-card-screenshot";
        img.src = msg.tab.screenshotUrl;
        img.loading = "lazy";
        img.addEventListener("click", function () { showImageModal(this.src); });
        card.appendChild(img);
      }

      // Meta: title + domain
      var tabTitle = msg.tab.title || "";
      var tabDomain = "";
      try { tabDomain = new URL(msg.tab.url).hostname; } catch (e) {}
      if (tabTitle || tabDomain) {
        var meta = document.createElement("div");
        meta.className = "context-card-meta";
        if (msg.tab.favIconUrl) {
          var fav = document.createElement("img");
          fav.className = "context-card-favicon";
          fav.src = msg.tab.favIconUrl;
          fav.width = 14;
          fav.height = 14;
          fav.onerror = function () { this.style.display = "none"; };
          meta.appendChild(fav);
        }
        var titleEl = document.createElement("span");
        titleEl.className = "context-card-title";
        titleEl.textContent = tabTitle;
        meta.appendChild(titleEl);
        if (tabDomain) {
          var domainEl = document.createElement("span");
          domainEl.className = "context-card-domain";
          domainEl.textContent = tabDomain;
          meta.appendChild(domainEl);
        }
        card.appendChild(meta);
      }

      messagesEl.appendChild(card);
      scrollToBottom();
    }
  },

  status: function (msg) {
    if (msg.status === "processing") {
      setStatus("processing");
      // Session became live — undo any dead-session todo compaction
      // applied at history_done time.
      store.set({ sessionIsProcessing: true });
      applyDeadSessionTodoCompaction();
      if (!store.get('dmMode')) {
        removePreThinking(); // drop pre-thinking dots before showing activity indicator
      }
    }
  },

  // lr-66c118: setActivity("thinking"/"compacting") re-raise removed here.
  // setActivity collapses to ONE optimistic raise (input.js, on send) — the
  // widget's job is to bridge the gap before the FIRST real server signal
  // arrives; once real streaming UI exists (thinking block, tool items,
  // delta text) that IS the activity indicator, so re-raising the bubble
  // widget mid-turn only risked stacking it on top of the real UI.
  // lr-3af675: the context meter itself no longer needs anything here either
  // — the server re-reads vendor usage on the compacting -> not-compacting
  // transition and pushes a fresh 'context_usage' message (see the 'status'
  // handler in sdk-message-processor.js), which the context_usage handler
  // below already applies to the meter.
  compacting: function (msg) {},

  thinking_start: function (msg) {
    removePreThinking();
    startThinking();
  },

  thinking_delta: function (msg) {
    if (typeof msg.text === "string") appendThinking(msg.text);
  },

  thinking_stop: function (msg) {
    stopThinking(msg.duration);
  },

  delta: function (msg) {
    if (typeof msg.text !== "string") return;
    removePreThinking();
    stopThinking();
    resetThinkingGroup();
    // lr-66c118: the setActivity clear-call removed here (was gated on
    // hasActiveSubagents() per lr-1317b8 Defect 2 — that gate is now moot,
    // there is nothing left to clear here). setActivity collapses to ONE
    // optimistic raise (input.js); real streaming text arriving is itself
    // the strongest possible "not idle" signal, so there is no risk of a
    // stuck indicator from removing this clear.
    appendDelta(msg.text);
  },

  tool_start: function (msg) {
    removePreThinking();
    stopThinking();
    markAllToolsDone();
    if (msg.name === "EnterPlanMode") {
      renderPlanBanner("enter");
      getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
    } else if (msg.name === "ExitPlanMode") {
      if (getPlanContent()) {
        renderPlanCard(getPlanContent());
      }
      renderPlanBanner("exit");
      getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
    } else if (msg.name === "ask_user_questions") {
      getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
    } else if (getTodoTools()[msg.name]) {
      getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
    } else {
      createToolItem(msg.id, msg.name);
    }
  },

  tool_executing: function (msg) {
    if (msg.name === "AskUserQuestion" && msg.input && msg.input.questions) {
      var askTool = getTools()[msg.id];
      if (askTool) {
        if (askTool.el) askTool.el.style.display = "none";
        askTool.done = true;
        removeToolFromGroup(msg.id);
      }
      renderAskUserQuestion(msg.id, msg.input);
      startUrgentBlink();
    } else if (msg.name === "Write" && msg.input && isPlanFilePath(msg.input.file_path)) {
      setPlanContent(msg.input.content || "");
      updateToolExecuting(msg.id, msg.name, msg.input);
    } else if (msg.name === "Edit" && msg.input && isPlanFilePath(msg.input.file_path)) {
      var pc = getPlanContent() || "";
      if (msg.input.old_string && pc.indexOf(msg.input.old_string) !== -1) {
        if (msg.input.replace_all) {
          setPlanContent(pc.split(msg.input.old_string).join(msg.input.new_string || ""));
        } else {
          setPlanContent(pc.replace(msg.input.old_string, msg.input.new_string || ""));
        }
      }
      updateToolExecuting(msg.id, msg.name, msg.input);
    } else if (msg.name === "TodoWrite") {
      handleTodoWrite(msg.input);
    } else if (msg.name === "TaskCreate") {
      handleTaskCreate(msg.input);
    } else if (msg.name === "TaskUpdate") {
      handleTaskUpdate(msg.input);
    } else if (getTodoTools()[msg.name]) {
      // TaskList, TaskGet - silently skip
    } else {
      var t = getTools()[msg.id];
      if (t && t.hidden) return;
      updateToolExecuting(msg.id, msg.name, msg.input);
    }
  },

  tool_result: function (msg) {
    var tr = getTools()[msg.id];
    if (tr && tr.hidden) return; // skip hidden plan tools
    // Always call updateToolResult for Edit (to show diff from input), or when content exists
    if (msg.content != null || msg.images || (tr && tr.name === "Edit" && tr.input && tr.input.old_string)) {
      updateToolResult(msg.id, msg.content || "", msg.is_error || false, msg.images);
    }
    // Refresh file browser if an Edit/Write tool modified the open file
    if (!msg.is_error && tr && (tr.name === "Edit" || tr.name === "Write") && tr.input && tr.input.file_path) {
      refreshIfOpen(tr.input.file_path);
    }
  },

  ask_user_answered: function (msg) {
    markAskUserAnswered(msg.toolId, msg.answers);
    stopUrgentBlink();
  },

  permission_request: function (msg) {
    renderPermissionRequest(msg.requestId, msg.toolName, msg.toolInput, msg.decisionReason);
    startUrgentBlink();
  },

  permission_cancel: function (msg) {
    markPermissionCancelled(msg.requestId);
    stopUrgentBlink();
  },

  permission_resolved: function (msg) {
    markPermissionResolved(msg.requestId, msg.decision);
    stopUrgentBlink();
  },

  permission_request_pending: function (msg) {
    renderPermissionRequest(msg.requestId, msg.toolName, msg.toolInput, msg.decisionReason);
    startUrgentBlink();
  },

  elicitation_request: function (msg) {
    renderElicitationRequest(msg);
    startUrgentBlink();
  },

  elicitation_resolved: function (msg) {
    markElicitationResolved(msg.requestId, msg.action);
    stopUrgentBlink();
  },

  slash_command_result: function (msg) {
    finalizeAssistantBlock();
    var cmdBlock = document.createElement("div");
    cmdBlock.className = "assistant-block";
    cmdBlock.style.maxWidth = "var(--content-width)";
    cmdBlock.style.margin = "12px auto";
    cmdBlock.style.padding = "0 20px";
    var pre = document.createElement("pre");
    pre.style.cssText = "background:var(--code-bg);border:1px solid var(--border-subtle);border-radius:10px;padding:12px 14px;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:12px;line-height:1.55;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto;margin:0";
    pre.textContent = msg.text;
    cmdBlock.appendChild(pre);
    addToMessages(cmdBlock);
    scrollToBottom();
  },

  subagent_activity: function (msg) {
    updateSubagentActivity(msg.parentToolId, msg.text);
  },

  subagent_tool: function (msg) {
    addSubagentToolEntry(msg.parentToolId, msg.toolName, msg.toolId, msg.text);
  },

  subagent_done: function (msg) {
    markSubagentDone(msg.parentToolId, msg.status, msg.summary, msg.usage);
  },

  task_started: function (msg) {
    initSubagentStop(msg.parentToolId, msg.taskId);
  },

  task_progress: function (msg) {
    updateSubagentProgress(msg.parentToolId, msg.usage, msg.lastToolName, msg.summary);
  },

  task_updated: function (msg) {
    updateSubagentTaskStatus(msg.parentToolId, msg.patch);
  },

  result: function (msg) {
    // lr-66c118: the lr-255e hasActiveSubagents()-gated setActivity clear
    // call is removed — setActivity collapses to ONE optimistic raise
    // (input.js) with no manual clears anywhere. The subagent-liveness
    // tracking itself (activeSubagentToolIds, markSubagentDone) is untouched
    // and still governs the real per-tool subagent UI.
    stopThinking();
    markAllToolsDone();
    closeToolGroup();
    finalizeAssistantBlock();
    addTurnMeta(msg.cost, msg.duration);
    accumulateUsage(msg.cost, msg.usage, msg.lastStreamInputTokens);
    accumulateContext(msg.cost, msg.usage, msg.modelUsage, msg.lastStreamInputTokens);
  },

  context_usage: function (msg) {
    if (msg.data && !store.get('replayingHistory')) {
      store.set({ richContextUsage: msg.data });
      // UI sync handled by store subscriber in app-panels.js
    }
  },

  done: function (msg) {
    removePreThinking();
    // lr-66c118: the setActivity clear call is removed here too — see the
    // 'result' handler above. resetToolState() below still clears all
    // per-turn tool tracking (including subagent liveness) unconditionally.
    stopThinking();
    markAllToolsDone();
    closeToolGroup();
    finalizeAssistantBlock();
    setStatus("connected");
    // Re-enable input unless this is one of the loop's own sessions (coder/judge).
    // A loop running in a separate session must not suppress input here.
    var _doneLoopSid = store.get('loopCurrentSessionId');
    if (!store.get('loopActive') || !_doneLoopSid || store.get('activeSessionId') !== _doneLoopSid) {
      enableMainInput();
    }
    resetToolState();
    stopUrgentBlink();
    if (document.hidden) {
      if (isNotifAlertEnabled() && !window._pushSubscription) showDoneNotification();
      if (isNotifSoundEnabled()) playDoneSound();
    }
  },

  stderr: function (msg) {
    addSystemMessage(msg.text, false);
  },

  // lr-66c118: setActivity clear calls removed below (error,
  // process_conflict, context_overflow, auth_required) — setActivity
  // collapses to ONE optimistic raise (input.js) with no manual clears.
  error: function (msg) {
    removePreThinking();
    addSystemMessage(msg.text, true);
  },

  system_info: function (msg) {
    addSystemMessage(msg.text, false);
  },

  sdk_notification: function (msg) {
    addSystemMessage(msg.text, false);
  },

  process_conflict: function (msg) {
    removePreThinking();
    addConflictMessage(msg);
  },

  context_overflow: function (msg) {
    removePreThinking();
    addContextOverflowMessage(msg);
  },

  auth_required: function (msg) {
    removePreThinking();
    stopThinking();
    markAllToolsDone();
    closeToolGroup();
    appendDelta((msg.text || "Authentication required.") + "\n");
    setStatus("connected");
    var _authLoopSid = store.get('loopCurrentSessionId');
    if (!store.get('loopActive') || !_authLoopSid || store.get('activeSessionId') !== _authLoopSid) {
      enableMainInput();
    }
  },

  rate_limit: handleRateLimitEvent,
  rate_limit_usage: updateRateLimitUsage,

  scheduled_message_queued: function (msg) {
    // lr-0827ba: msg.localId identifies the session this schedule
    // actually belongs to — may not be the currently focused session.
    addScheduledMessageBubble(msg.text, msg.resetsAt, msg.localId);
    if (msg.localId == null || msg.localId === store.get('activeSessionId')) setScheduleBtnDisabled(true);
  },

  scheduled_message_sent: function (msg) {
    clearScheduledMessage(msg.localId);
    if (msg.localId == null || msg.localId === store.get('activeSessionId')) {
      setScheduleBtnDisabled(false);
      setStatus("processing");
    }
  },

  scheduled_message_cancelled: function (msg) {
    clearScheduledMessage(msg.localId);
    if (msg.localId == null || msg.localId === store.get('activeSessionId')) setScheduleBtnDisabled(false);
  },

  auto_continue_scheduled: function (msg) {
    // Scheduler auto-continue, just show info
  },

  auto_continue_fired: function (msg) {
    setStatus("processing");
  },

  prompt_suggestion: function (msg) {
    showSuggestionChips(msg.suggestion);
  },

  fast_mode_state: function (msg) {
    handleFastModeState(msg.state);
  },

  process_killed: function (msg) {
    addSystemMessage("Process " + msg.pid + " has been terminated. You can retry your message now.", false);
  },

  rewind_preview_result: function (msg) {
    showRewindModal(msg);
  },

  rewind_complete: function (msg) {
    onRewindComplete();
    setRewindMode(false);
    var rewindText = "Rewound to earlier point. Files have been restored.";
    if (msg.mode === "chat") rewindText = "Conversation rewound to earlier point.";
    else if (msg.mode === "files") rewindText = "Files restored to earlier point.";
    addSystemMessage(rewindText, false);
  },

  rewind_error: function (msg) {
    onRewindError();
    clearPendingRewindUuid();
    addSystemMessage(msg.text || "Rewind failed.", true);
  },

  fork_complete: function (msg) {
    addSystemMessage("Session forked successfully.");
  },

  fs_read_result: function (msg) {
    if (msg.path === "CLAUDE.md" && isProjectSettingsOpen()) {
      handleInstructionsRead(msg);
    } else {
      handleFsRead(msg);
    }
  },

  fs_write_result: handleInstructionsWrite,
  project_env_result: handleProjectEnv,
  set_project_env_result: handleProjectEnvSaved,

  shared_env_result: function (msg) {
    handleSharedEnv(msg);
    handleProjectSharedEnv(msg);
  },

  set_shared_env_result: function (msg) {
    handleSharedEnvSaved(msg);
    handleProjectSharedEnvSaved(msg);
  },

  term_list: function (msg) {
    handleTermList(msg);
    updateTerminalList(msg.terminals);
  },

  context_sources_state: handleContextSourcesState,

  extension_command: function (msg) {
    sendExtensionCommand(msg.command, msg.args, msg.requestId);
  },

  mcp_tool_call: handleMcpToolCallMessage,
  mcp_servers_state: handleMcpServersState,

  term_created: function (msg) {
    handleTermCreated(msg);
    if (store.get('pendingTermCommand')) {
      var cmd = store.get('pendingTermCommand');
      store.set({ pendingTermCommand: null });
      // Small delay to let terminal initialize
      setTimeout(function() {
        sendTerminalCommand(cmd);
      }, 300);
    }
  },

  term_output: handleTermOutput,
  term_resized: handleTermResized,
  term_exited: handleTermExited,
  term_closed: handleTermClosed,

  notes_list: handleNotesList,
  note_created: handleNoteCreated,
  note_updated: handleNoteUpdated,
  note_deleted: handleNoteDeleted,

  process_stats: function (msg) {
    updateStatusPanel(msg);
    updateSettingsStats(msg);
  },

  browse_dir_result: handleBrowseDirResult,
  add_project_result: handleAddProjectResult,
  clone_project_progress: handleCloneProgress,
  remove_project_result: handleRemoveProjectResult,

  reorder_projects_result: function (msg) {
    if (!msg.ok) {
      showToast(msg.error || "Failed to reorder projects", "error");
    }
  },

  set_project_title_result: function (msg) {
    if (!msg.ok) {
      showToast(msg.error || "Failed to rename project", "error");
    }
  },

  set_project_icon_result: function (msg) {
    if (!msg.ok) {
      showToast(msg.error || "Failed to set icon", "error");
    }
  },

  set_project_preferred_agent_result: function (msg) {
    if (!msg.ok) {
      showToast(msg.error || "Failed to set preferred agent", "error");
    }
  },

  set_project_folder_result: function (msg) {
    if (!msg.ok) {
      showToast(msg.error || "Failed to move project to folder", "error");
    }
  },

  rename_project_folder_result: function (msg) {
    if (!msg.ok) {
      showToast(msg.error || "Failed to rename folder", "error");
    }
  },

  set_folder_icon_result: function (msg) {
    if (!msg.ok) {
      showToast(msg.error || "Failed to set folder icon", "error");
    }
  },

  projects_updated: updateProjectList,
  rename_custom_icon_result: handleRenameCustomIconResult,

  project_owner_changed: function (msg) {
    store.set({ currentProjectOwnerId: msg.ownerId });
    handleProjectOwnerChanged(msg);
  },

  // --- DM ---
  dm_history: function (msg) {
    enterDmMode(msg.dmKey, msg.targetUser, msg.messages);
  },

  dm_message: function (msg) {
    if (store.get('dmMode') && msg.dmKey === store.get('dmKey')) {
      showDmTypingIndicator(false); // hide typing when message arrives
      appendDmMessage(msg.message);
      scrollToBottom();
    } else if (msg.message) {
      // DM notification when not in that DM
      var fromId = msg.message.from;
      if (fromId && fromId !== store.get('myUserId')) {
        var _du = Object.assign({}, store.get('dmUnread'));
        _du[fromId] = (_du[fromId] || 0) + 1;
        store.set({ dmUnread: _du });
        // renderUserStrip is handled by the store subscriber
        updateDmBadge(fromId, _du[fromId]);
      }
    }
  },

  dm_typing: function (msg) {
    if (store.get('dmMode') && msg.dmKey === store.get('dmKey')) {
      showDmTypingIndicator(msg.typing);
    }
  },

  dm_list: function (msg) {
    // Could be used for DM list view later
  },

  dm_favorites_updated: function (msg) {
    // Track users explicitly removed from favorites
    var _cdf = store.get('cachedDmFavorites');
    if (_cdf && msg.dmFavorites) {
      for (var ri = 0; ri < _cdf.length; ri++) {
        if (msg.dmFavorites.indexOf(_cdf[ri]) === -1) {
          store.get('dmRemovedUsers')[_cdf[ri]] = true;
        }
      }
    }
    // Clear removed flag for users being added back
    if (msg.dmFavorites) {
      for (var ai = 0; ai < msg.dmFavorites.length; ai++) {
        delete store.get('dmRemovedUsers')[msg.dmFavorites[ai]];
      }
    }
    store.set({ cachedDmFavorites: msg.dmFavorites || [] });
    // renderUserStrip is handled by the store subscriber
  },

  // --- @Mention ---
  mention_start: handleMentionStart,
  mention_activity: handleMentionActivity,
  mention_stream: handleMentionStream,
  mention_done: handleMentionDone,

  mention_error: function (msg) {
    handleMentionError(msg);
    if (msg.error) showToast("@Mention: " + msg.error, "error");
  },

  mention_user: function (msg) {
    // Finalize current assistant block so mention renders in correct DOM position
    finalizeAssistantBlock();
    renderMentionUser(msg);
  },

  mention_response: function (msg) {
    finalizeAssistantBlock();
    renderMentionResponse(msg);
  },

  user_mention: function (msg) {
    // User-to-user side conversation entry. Renders for any session viewer
    // (sender's other tabs and the mentioned user, if they are watching the
    // session). On the sender's own tab, the server uses sendToSessionOthers
    // so we never get a duplicate here.
    finalizeAssistantBlock();
    renderUserMention(msg);
  },

  user_mention_error: function (msg) {
    if (msg.error) showToast("@Mention: " + msg.error, "error");
  },

  // --- Team activity ---
  team_state: handleTeamState,
  team_member_update: handleTeamMemberUpdate,
  team_task_update: handleTeamTaskUpdate,
  team_message: handleTeamMsg,
  team_gone: handleTeamGone,

  diagnostic: function (msg) {
    // Diagnostic events from CLI stderr (stage 4/5, lr-8294, epic lr-1a52).
    // Future sources (e.g. settings preflight from stage 5/5 lr-1a26) will
    // also arrive via this same type — the render path must not assume CLI origin.
    addDiagnostic(msg);
  },

  daemon_config: function (msg) {
    if (msg.config && msg.config.headless) store.set({ isHeadlessMode: true });
    updateDaemonConfig(msg.config);
  },

  daemon_config_changed: updateDaemonConfig,

  lite_project_status: handleLiteProjectStatus,
  lite_enroll_result: handleLiteEnrollResult,
  lite_unenroll_result: handleLiteUnenrollResult,

  // --- Ralph Loop ---
  loop_available: function (msg) {
    store.set({ loopAvailable: msg.available, loopActive: msg.active, loopIteration: msg.iteration || 0, loopMaxIterations: msg.maxIterations || 20, loopBannerName: msg.name || null });

    var _la = store.snap();
    if (_la.loopActive) {
      showLoopBanner(true);
      if (_la.loopIteration > 0) {
        updateLoopBanner(_la.loopIteration, _la.loopMaxIterations, "running");
      }
      // Only lock input if this session is actually a loop session (singleTurn).
      // Other sessions in the project must not be locked by a loop running elsewhere.
      updateLoopInputVisibility(null);
    }
  },

  loop_started: function (msg) {
    store.set({ loopActive: true, ralphPhase: "executing", loopIteration: 0, loopMaxIterations: msg.maxIterations, loopBannerName: msg.name || null });
    showLoopBanner(true);

    var _lbn = store.get('loopBannerName');
    addSystemMessage((_lbn || "Loop") + " started (max " + msg.maxIterations + " iterations)", false);
    // Do not lock the input here — loop_iteration carries the session ID and will
    // lock only the actual coder/judge session when it becomes active.
  },

  loop_iteration: function (msg) {
    store.set({ loopIteration: msg.iteration, loopMaxIterations: msg.maxIterations, loopCurrentSessionId: msg.sessionId || null });
    updateLoopBanner(msg.iteration, msg.maxIterations, "running");

    var _libn = store.get('loopBannerName');
    addSystemMessage((_libn || "Loop") + " iteration #" + msg.iteration + " started", false);
    // lr-e31b: The composer stays enabled (not locked) while viewing the
    // loop's own session — updateLoopInputVisibility() already switched
    // it into queue mode so a human message is queued for the next
    // iteration boundary rather than dropped or blocked outright.
  },

  loop_judging: function (msg) {
    var _ljs = store.snap();
    store.set({ loopCurrentSessionId: msg.sessionId || _ljs.loopCurrentSessionId });
    updateLoopBanner(_ljs.loopIteration, _ljs.loopMaxIterations, "judging");
    addSystemMessage("Judging iteration #" + msg.iteration + "...", false);
    // lr-e31b: composer stays enabled in queue mode (see loop_iteration above).
  },

  loop_verdict: function (msg) {
    addSystemMessage("Judge: " + msg.verdict.toUpperCase() + " - " + (msg.summary || ""), false);
  },

  loop_stopping: function (msg) {
    var _lss = store.snap();
    updateLoopBanner(_lss.loopIteration, _lss.loopMaxIterations, "stopping");
  },

  loop_finished: function (msg) {
    var _lfbn = store.get('loopBannerName');
    store.set({ loopActive: false, ralphPhase: "done", loopBannerName: null, loopCurrentSessionId: null });
    showLoopBanner(false);

    enableMainInput();
    updateLoopInputVisibility(null);
    var loopLabel = _lfbn || "Loop";
    var finishMsg = msg.reason === "pass"
      ? loopLabel + " completed successfully after " + msg.iterations + " iteration(s)."
      : msg.reason === "max_iterations"
        ? loopLabel + " reached maximum iterations (" + msg.iterations + ")."
        : msg.reason === "stopped"
          ? loopLabel + " stopped."
          : loopLabel + " ended with error.";
    addSystemMessage(finishMsg, false);
  },

  loop_error: function (msg) {
    addSystemMessage((store.get('loopBannerName') || "Loop") + " error: " + msg.text, true);
  },

  // lr-e31b: server-confirmed queue of human messages awaiting delivery
  // at the next loop iteration boundary.
  loop_pending_messages: function (msg) {
    store.set({ loopPendingMessages: msg.messages || [] });
    updateLoopPendingBanner();
  },

  loop_message_error: function (msg) {
    addSystemMessage((store.get('loopBannerName') || "Loop") + ": " + msg.text, true);
  },

  // --- Ralph Wizard / Crafting ---
  ralph_phase: function (msg) {
    var _rps = { ralphPhase: msg.phase || "idle" };
    if (msg.craftingSessionId) _rps.ralphCraftingSessionId = msg.craftingSessionId;
    if (msg.source !== undefined) _rps.ralphCraftingSource = msg.source;
    store.set(_rps);
    if (msg.wizardData) store.set({ wizardData: msg.wizardData });
  },

  ralph_crafting_started: function (msg) {
    store.set({ ralphPhase: "crafting", ralphCraftingSessionId: msg.sessionId || store.get('activeSessionId'), ralphCraftingSource: msg.source || null });

    if (msg.source !== "ralph") {
      // Task sessions open in the scheduler calendar window
      enterCraftingMode(msg.sessionId, msg.taskId);
    }
    // Ralph crafting sessions show in session list as part of the loop group
  },

  ralph_files_status: function (msg) {
    store.set({ ralphFilesReady: {
      promptReady: msg.promptReady,
      judgeReady: msg.judgeReady,
      bothReady: msg.bothReady,
    } });
    if (msg.bothReady) {
      var _rfs = store.snap();
      if (_rfs.ralphPhase === "crafting" || _rfs.ralphPhase === "approval") {
        store.set({ ralphPhase: "approval" });
        if (_rfs.ralphCraftingSource !== "ralph" || isSchedulerOpen()) {
          // Task crafting in scheduler: switch from crafting chat to detail view showing files
          exitCraftingMode(msg.taskId);
        } else {
          showRalphApprovalBar(true);
          // Auto-show execution modal (one-time) for Ralph source
          if (!store.get('execModalShown') && _rfs.ralphCraftingSource === "ralph") {
            showExecModal();
          }
        }
      }
    }
    updateRalphApprovalStatus();
    updateExecModalStatus();
  },

  loop_registry_files_content: handleLoopRegistryFiles,

  ralph_files_content: function (msg) {
    store.set({ ralphPreviewContent: { prompt: msg.prompt || "", judge: msg.judge || "" } });
    openRalphPreviewModal();
  },

  loop_registry_error: function (msg) {
    addSystemMessage("Error: " + msg.text, true);
  },

  // --- Notifications ---
  notifications_state: handleNotificationsState,
  notification_created: handleNotificationCreated,
  notification_dismissed: handleNotificationDismissed,

  notification_dismissed_all: function (msg) {
    handleNotificationDismissedAll();
  },
});
