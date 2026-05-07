// app-messages.js - WebSocket message router
// Extracted from app.js (PR-23)
// All dependencies are direct imports; no context injection needed.

import { store } from './store.js';
import { getWs } from './ws-ref.js';

// --- Leaf module imports ---
import { showToast } from './utils.js';
import { refreshIcons, iconHtml } from './icons.js';
import { renderMarkdown, highlightCodeBlocks, renderMermaidBlocks } from './markdown.js';
import { updatePageTitle } from './sidebar.js';
import { renderSessionList, updateSessionPresence, populateCliSessionList, handleSearchResults, updateSessionBadge } from './sidebar-sessions.js';
import { updateDmBadge, renderSidebarPresence, setMentionActive, renderUserStrip } from './sidebar-users.js';
import { refreshMobileChatSheet } from './sidebar-mobile.js';
import { handlePaletteSessionSwitch, setPaletteVersion } from './command-palette.js';
import { handleAgentsList, handleAgentFavoriteToggled } from './agent-picker.js';
import { handleFindInSessionResults } from './session-search.js';
import { handleInputSync, autoResize, resetAutoResize, builtinCommands, setScheduleBtnDisabled } from './input.js';
import { startThinking, appendThinking, stopThinking, resetThinkingGroup, createToolItem, updateToolExecuting, updateToolResult, markAllToolsDone, closeToolGroup, removeToolFromGroup, resetToolState, getTools, getPlanContent, setPlanContent, renderPlanBanner, renderPlanCard, getTodoTools, handleTodoWrite, handleTaskCreate, handleTaskUpdate, applyDeadSessionTodoCompaction, isPlanFilePath, enableMainInput, addTurnMeta, updateSubagentActivity, addSubagentToolEntry, markSubagentDone, initSubagentStop, updateSubagentProgress, updateSubagentTaskStatus, renderAskUserQuestion, markAskUserAnswered, renderPermissionRequest, markPermissionCancelled, markPermissionResolved, renderElicitationRequest, markElicitationResolved } from './tools.js';
import { showDoneNotification, playDoneSound, isNotifAlertEnabled, isNotifSoundEnabled } from './notifications.js';
import { handleFsList, handleFsRead, handleFileChanged, handleDirChanged, handleFileHistory, handleGitDiff, handleFileAt, refreshIfOpen, getPendingNavigate, handleFsSearch } from './filebrowser.js';
import { isProjectSettingsOpen, refreshProjectSettingsModels, handleInstructionsRead, handleInstructionsWrite, handleProjectEnv, handleProjectEnvSaved, handleProjectSharedEnv, handleProjectSharedEnvSaved, handleProjectOwnerChanged } from './project-settings.js';
import { updateSettingsModels, updateSettingsStats, updateDaemonConfig, handleSetPinResult, handleKeepAwakeChanged, handleAutoContinueChanged, handleRestartResult, handleShutdownResult, handleSharedEnv, handleSharedEnvSaved, handleGlobalClaudeMdRead, handleGlobalClaudeMdWrite } from './server-settings.js';
import { handleTermList, handleTermCreated, sendTerminalCommand, handleTermOutput, handleTermResized, handleTermExited, handleTermClosed } from './terminal.js';
import { updateTerminalList, handleContextSourcesState, updateEmailAccountList, updateEmailUnreadCounts, handleEmailTestResult, handleEmailAddResult, handleEmailRemoveResult, handleEmailDefaults } from './context-sources.js';
import { refreshEmailSettings } from './user-settings.js';
import { handleNotesList, handleNoteCreated, handleNoteUpdated, handleNoteDeleted } from './sticky-notes.js';
import { handleSkillInstalled, handleSkillUninstalled } from './skills.js';
import { showRewindModal, onRewindComplete, setRewindMode, onRewindError, clearPendingRewindUuid, addRewindButton } from './rewind.js';
import { checkAdminAccess } from './admin.js';
import { showImageModal, sendExtensionCommand, handleMcpToolCallMessage } from './app-misc.js';
import { handleMcpServersState } from './mcp-ui.js';
import { handleLoopRegistryUpdated, handleScheduleRunStarted, handleScheduleRunFinished, handleLoopScheduled, isSchedulerOpen, enterCraftingMode, exitCraftingMode, handleLoopRegistryFiles } from './scheduler.js';

// --- App module imports ---
import { scrollToBottom, addToMessages, addUserMessage, addSystemMessage, appendDelta, finalizeAssistantBlock, addConflictMessage, addContextOverflowMessage, showSuggestionChips, armStickyBottom } from './app-rendering.js';
import { setActivity, startUrgentBlink, stopUrgentBlink, blinkSessionDot, updateCrossProjectBlink } from './app-favicon.js';
import { setStatus } from './app-connection.js';
import { getModelEffortLevels, accumulateUsage, updateUsagePanel, accumulateContext, updateContextPanel, renderCtxPopover, updateStatusPanel } from './app-panels.js';
import { updateProjectList, resetClientState, showUpdateAvailable, handleRemoveProjectCheckResult, handleRemoveProjectResult, handleBrowseDirResult, handleAddProjectResult, handleCloneProgress } from './app-projects.js';
import { updateHistorySentinel, prependOlderHistory } from './app-header.js';
import { hideHomeHub, handleHubSchedules } from './app-home-hub.js';
import { openDm, enterDmMode, exitDmMode, appendDmMessage, showDmTypingIndicator } from './app-dm.js';
import { handleRateLimitEvent, updateRateLimitUsage, addScheduledMessageBubble, removeScheduledMessageBubble, handleFastModeState } from './app-rate-limit.js';
import { handleRemoteCursorMove, handleRemoteCursorLeave, handleRemoteSelection, clearRemoteCursors } from './app-cursors.js';
import { showLoopBanner, updateLoopBanner, updateLoopInputVisibility, showRalphApprovalBar, updateRalphApprovalStatus, openRalphPreviewModal, showExecModal, updateExecModalStatus } from './app-loop-ui.js';
import { showDebateSticky, showDebateConcludeConfirm, showDebateUserFloor, exitDebateFloorMode, exitDebateConcludeMode, exitDebateEndedMode, updateDebateRound, renderDebateUserFloorDone } from './app-debate-ui.js';
import { handleSkillInstallWs } from './app-skills-install.js';
import { handleNotificationsState, handleNotificationCreated, handleNotificationDismissed, handleNotificationDismissedAll, showUpdateBanner } from './app-notifications.js';
import { handleDebatePreparing, handleDebateBriefReady, renderDebateBriefReady, handleDebateStarted, renderDebateStarted, handleDebateTurn, handleDebateActivity, handleDebateStream, handleDebateTurnDone, handleDebateCommentQueued, handleDebateCommentInjected, renderDebateCommentInjected, handleDebateResumed, handleDebateEnded, renderDebateEnded, handleDebateError, isDebateActive, renderMcpDebateProposal, renderDebateUserResume } from './debate.js';
import { handleMentionStart, handleMentionActivity, handleMentionStream, handleMentionDone, handleMentionError, renderMentionUser, renderMentionResponse, renderUserMention } from './mention.js';

// --- DOM refs (cached once, stable for page lifetime) ---
var messagesEl = document.getElementById("messages");
var headerTitleEl = document.getElementById("header-title");
var inputEl = document.getElementById("input");
var connectOverlay = document.getElementById("connect-overlay");

export function processMessage(msg) {
    // Preserve original timestamp from history replay
    store.set({ currentMsgTs: msg._ts || null });

    switch (msg.type) {
      case "history_meta":
        store.set({ historyFrom: msg.from, historyTotal: msg.total, replayingHistory: true });
        updateHistorySentinel();
        break;

      case "history_prepend":
        prependOlderHistory(msg.items, msg.meta);
        break;

      case "history_done":
        store.set({ replayingHistory: false });
        // Batched syntax highlight + mermaid pass for the entire replayed
        // transcript. Per-message highlights are skipped during replay
        // (see markdown.js) to avoid cascading reflows that the sticky-
        // bottom observer chases for several seconds on long sessions.
        if (messagesEl) {
          highlightCodeBlocks(messagesEl);
          renderMermaidBlocks(messagesEl);
        }
        // Compact dead-session todo widgets (unfinished items will never
        // resolve — the agent isn't coming back) so they don't anchor
        // visual position mid-page on resume.
        if (!store.get('sessionIsProcessing')) {
          applyDeadSessionTodoCompaction();
        }
        // Hide vendor toggle if session has history (vendor already locked)
        var _hTotal = store.get('historyTotal') || 0;
        var _vtw2 = document.getElementById("vendor-toggle-wrap");
        if (_vtw2 && _hTotal > 0) { _vtw2.classList.remove("hidden"); _vtw2.classList.add("locked"); }
        // Restore cached rich context usage BEFORE updateContextPanel runs
        if (msg.contextUsage) {
          store.set({ richContextUsage: msg.contextUsage });
        }
        // Restore accurate context data from the last result in full history
        if (msg.lastUsage || msg.lastModelUsage) {
          accumulateContext(msg.lastCost, msg.lastUsage, msg.lastModelUsage, msg.lastStreamInputTokens);
        }
        updateContextPanel();
        updateUsagePanel();
        // Render + finalize any incomplete turn from the replayed history
        var _hs = store.snap();
        if (_hs.currentMsgEl && _hs.currentFullText) {
          var replayContentEl = _hs.currentMsgEl.querySelector(".md-content");
          if (replayContentEl) {
            replayContentEl.innerHTML = renderMarkdown(_hs.currentFullText);
          }
        }
        markAllToolsDone();
        finalizeAssistantBlock();
        stopUrgentBlink();
        // Clean up debate UI if debate is not active after replay
        if (!isDebateActive()) {
          var dbBar = document.getElementById("debate-bottom-bar");
          if (dbBar) dbBar.remove();
          var dhBar = document.getElementById("debate-hand-raise-bar");
          if (dhBar) dhBar.remove();
          var dbBadges = document.querySelectorAll(".debate-header-badge");
          for (var dbi = 0; dbi < dbBadges.length; dbi++) dbBadges[dbi].remove();
          // Clean up all debate mode banners if debate is not active on this session
          var _ds = store.snap();
          if (_ds.debateFloorMode) exitDebateFloorMode();
          if (_ds.debateConcludeMode) exitDebateConcludeMode();
          if (_ds.debateEndedMode) exitDebateEndedMode();
          var dbBanner = document.getElementById("debate-floor-banner");
          if (dbBanner) dbBanner.remove();
        }
        // Resume landing position: arm sticky-bottom for ~1.5s so deferred
        // layout (tool widgets via tools.js, markdown/syntax highlighting,
        // image loads, IntersectionObserver-driven todo sticky reflows)
        // can't strand the user mid-conversation. The ResizeObserver
        // re-pins on every height change while armed. Disarms early on
        // any real user scroll input.
        // Skip arming when we have a pending in-conversation navigate
        // target (file-edit deeplink) — the navigate block below scrolls
        // that element into view, and sticky-bottom would fight it.
        var nav = getPendingNavigate();
        var hasNavTarget = nav && (nav.toolId || nav.assistantUuid);
        if (hasNavTarget) {
          // Navigate block below will scrollIntoView on the target — don't
          // arm sticky-bottom or it would fight that scroll.
          scrollToBottom();
        } else {
          // Quiet window: ResizeObserver extends this for as long as
          // layout keeps shifting (long sessions, late-rendering tool
          // widgets, image loads), bounded by an internal hard ceiling.
          armStickyBottom(750);
        }
        // Scroll to tool element if navigating from file edit history
        if (hasNavTarget) {
          requestAnimationFrame(function() {
            // Prefer scrolling to the exact tool element
            var target = nav.toolId ? messagesEl.querySelector('[data-tool-id="' + nav.toolId + '"]') : null;
            if (!target && nav.assistantUuid) {
              target = messagesEl.querySelector('[data-uuid="' + nav.assistantUuid + '"]');
            }
            if (target) {
              // Auto-expand parent tool group if collapsed
              var parentGroup = target.closest(".tool-group");
              if (parentGroup) parentGroup.classList.remove("collapsed");
              target.scrollIntoView({ behavior: "smooth", block: "center" });
              target.classList.add("message-blink");
              setTimeout(function() { target.classList.remove("message-blink"); }, 2000);
            }
          });
        }
        break;

      case "restore_mate_dm":
        // removed: mates
        break;

      case "info":
        if (msg.text && !msg.project && !msg.cwd) {
          addSystemMessage(msg.text, false);
          break;
        }
        store.set({ projectName: msg.project || msg.cwd });
        if (msg.cwd) store.set({ cwd: msg.cwd });
        if (msg.slug) store.set({ currentSlug: msg.slug });
        try { var _is = store.snap(); localStorage.setItem("clay-project-name-" + (_is.currentSlug || "default"), _is.projectName); } catch (e) {}
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
        updateProjectList(msg);
        break;

      case "update_available":
        // In multi-user mode, only show update UI to admins
        if (store.get('isMultiUserMode')) {
          checkAdminAccess().then(function (isAdmin) {
            if (!isAdmin) return;
            showUpdateAvailable(msg);
            showUpdateBanner(msg);
          });
        } else {
          showUpdateAvailable(msg);
          showUpdateBanner(msg);
        }
        break;

      case "up_to_date":
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
        break;

      case "update_started":
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
        break;

      case "slash_commands":
        var reserved = new Set(builtinCommands.map(function (c) { return c.name; }));
        store.set({ slashCommands: (msg.commands || []).filter(function (name) {
          return !reserved.has(name);
        }).map(function (name) {
          return { name: name, desc: "Skill" };
        }) });
        break;

      case "model_info": {
        // Drop stale model_info from a vendor that doesn't match the active
        // session's vendor. On high-latency connections, the server's default-
        // adapter model_info can arrive after session_switched has already
        // bound the session to a different vendor. Applying it would replace
        // currentModels with the wrong vendor's list and trigger app-panels
        // to request models for the "wrong" vendor, which feeds back into a
        // ping-pong loop of vendor flapping. See issue #336.
        var _curV = store.get('currentVendor');
        if (msg.vendor && _curV && msg.vendor !== _curV) break;

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
        break;
      }

      case "config_state": {
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
        } break;

      case "codex_config":
        store.set({
          codexApproval: msg.approval,
          codexSandbox: msg.sandbox,
          codexWebSearch: msg.webSearch,
        });
        break;

      case "client_count":
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
        break;

      case "toast":
        showToast(msg.message, msg.level, msg.detail);
        break;

      case "skill_installed":
        handleSkillInstalled(msg);
        if (msg.success) { var _kis = Object.assign({}, store.get('knownInstalledSkills')); _kis[msg.skill] = true; store.set({ knownInstalledSkills: _kis }); }
        handleSkillInstallWs(msg);
        break;

      case "skill_uninstalled":
        handleSkillUninstalled(msg);
        if (msg.success) { var _kis2 = Object.assign({}, store.get('knownInstalledSkills')); delete _kis2[msg.skill]; store.set({ knownInstalledSkills: _kis2 }); }
        break;

      case "loop_registry_updated":
        handleLoopRegistryUpdated(msg);
        break;

      case "schedule_run_started":
        handleScheduleRunStarted(msg);
        break;

      case "schedule_run_finished":
        handleScheduleRunFinished(msg);
        break;

      case "loop_scheduled":
        handleLoopScheduled(msg);
        break;

      case "schedule_move_result":
        if (msg.ok) {
          showToast("Task moved", "success");
        } else {
          showToast(msg.error || "Failed to move task", "error");
        }
        break;

      case "remove_project_check_result":
        handleRemoveProjectCheckResult(msg);
        break;

      case "hub_schedules":
        handleHubSchedules(msg);
        break;

      case "input_sync":
        if (!store.get('dmMode')) handleInputSync(msg.text);
        break;

      case "session_list":
        renderSessionList(msg.sessions || []);
        handlePaletteSessionSwitch();
        break;

      case "agents_list":
        handleAgentsList(msg);
        break;

      case "agent_favorite_toggled":
        handleAgentFavoriteToggled(msg);
        break;

      case "session_presence":
        updateSessionPresence(msg.presence || {});
        break;

      case "cursor_move":
        handleRemoteCursorMove(msg);
        break;

      case "cursor_leave":
        handleRemoteCursorLeave(msg);
        break;

      case "text_select":
        handleRemoteSelection(msg);
        break;

      case "session_io":
        blinkSessionDot(msg.id);
        break;

      case "session_unread":
        updateSessionBadge(msg.id, msg.count);
        break;

      case "search_results":
        handleSearchResults(msg);
        break;

      case "search_content_results":
        if (msg.source === "find_in_session") {
          handleFindInSessionResults(msg);
        }
        break;

      case "cli_session_list":
        populateCliSessionList(msg.sessions || []);
        break;

      case "session_switched":
        hideHomeHub();
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
        // Show vendor toggle only for new sessions (no history)
        var _vtw = document.getElementById("vendor-toggle-wrap");
        if (_vtw) {
          if (msg.hasHistory) { _vtw.classList.remove("hidden"); _vtw.classList.add("locked"); }
          else { _vtw.classList.remove("locked"); _vtw.classList.remove("hidden"); }
        }
        // Session presence is now tracked server-side (user-presence.json)
        clearRemoteCursors();
        resetClientState();

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
        break;

      case "session_id":
        store.set({ cliSessionId: msg.cliSessionId });
        break;

      case "message_uuid":
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
        break;

      case "user_message":
        if (msg._internal) break;
        resetThinkingGroup();
        if (msg.planContent) {
          setPlanContent(msg.planContent);
          renderPlanCard(msg.planContent);
          addUserMessage("Execute the following plan. Do NOT re-enter plan mode — just implement it step by step.", msg.images || null, msg.pastes || null, msg.from, msg.fromName);
        } else {
          addUserMessage(msg.text, msg.images || null, msg.pastes || null, msg.from, msg.fromName);
        }
        break;

      case "plan_content":
        setPlanContent(msg.content || "");
        renderPlanCard(msg.content || "");
        break;

      case "context_preview":
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
        break;

      case "status":
        if (msg.status === "processing") {
          setStatus("processing");
          // Session became live — undo any dead-session todo compaction
          // applied at history_done time.
          store.set({ sessionIsProcessing: true });
          applyDeadSessionTodoCompaction();
          if (!store.get('dmMode')) {
            setActivity("thinking");
          }
        }
        break;

      case "compacting":
        if (msg.active) {
          setActivity("compacting");
        } else if (!store.get('dmMode')) {
          setActivity("thinking");
        }
        break;

      case "thinking_start":
        startThinking();
        break;

      case "thinking_delta":
        if (typeof msg.text === "string") appendThinking(msg.text);
        break;

      case "thinking_stop":
        stopThinking(msg.duration);
        if (!store.get('dmMode')) {
          setActivity("thinking");
        }
        break;

      case "delta":
        if (typeof msg.text !== "string") break;
        stopThinking();
        resetThinkingGroup();
        setActivity(null);
        appendDelta(msg.text);
        break;

      case "tool_start":
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
        } else if (msg.name === "propose_debate" || (msg.name && msg.name.indexOf("propose_debate") !== -1)) {
          getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
        } else if (msg.name === "ask_user_questions") {
          getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
        } else if (getTodoTools()[msg.name]) {
          getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
        } else {
          createToolItem(msg.id, msg.name);
        }
        break;

      case "tool_executing":
        if ((msg.name === "propose_debate" || (msg.name && msg.name.indexOf("propose_debate") !== -1)) && msg.input) {
          var _dpTool = getTools()[msg.id];
          if (_dpTool) {
            if (_dpTool.el) _dpTool.el.style.display = "none";
            _dpTool.done = true;
            _dpTool.hidden = true;
            removeToolFromGroup(msg.id);
          }
          finalizeAssistantBlock();
          renderMcpDebateProposal(msg.id, msg.input);
          startUrgentBlink();
        } else if (msg.name === "AskUserQuestion" && msg.input && msg.input.questions) {
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
          if (t && t.hidden) break;
          updateToolExecuting(msg.id, msg.name, msg.input);
        }
        break;

      case "tool_result": {
          var tr = getTools()[msg.id];
          if (tr && tr.hidden) break; // skip hidden plan tools
          // Always call updateToolResult for Edit (to show diff from input), or when content exists
          if (msg.content != null || msg.images || (tr && tr.name === "Edit" && tr.input && tr.input.old_string)) {
            updateToolResult(msg.id, msg.content || "", msg.is_error || false, msg.images);
          }
          // Refresh file browser if an Edit/Write tool modified the open file
          if (!msg.is_error && tr && (tr.name === "Edit" || tr.name === "Write") && tr.input && tr.input.file_path) {
            refreshIfOpen(tr.input.file_path);
          }
        }
        break;

      case "ask_user_answered":
        markAskUserAnswered(msg.toolId, msg.answers);
        stopUrgentBlink();
        break;

      case "permission_request":
        renderPermissionRequest(msg.requestId, msg.toolName, msg.toolInput, msg.decisionReason);
        startUrgentBlink();
        break;

      case "permission_cancel":
        markPermissionCancelled(msg.requestId);
        stopUrgentBlink();
        break;

      case "permission_resolved":
        markPermissionResolved(msg.requestId, msg.decision);
        stopUrgentBlink();
        break;

      case "permission_request_pending":
        renderPermissionRequest(msg.requestId, msg.toolName, msg.toolInput, msg.decisionReason);
        startUrgentBlink();
        break;

      case "elicitation_request":
        renderElicitationRequest(msg);
        startUrgentBlink();
        break;

      case "elicitation_resolved":
        markElicitationResolved(msg.requestId, msg.action);
        stopUrgentBlink();
        break;

      case "slash_command_result":
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
        break;

      case "subagent_activity":
        updateSubagentActivity(msg.parentToolId, msg.text);
        break;

      case "subagent_tool":
        addSubagentToolEntry(msg.parentToolId, msg.toolName, msg.toolId, msg.text);
        break;

      case "subagent_done":
        markSubagentDone(msg.parentToolId, msg.status, msg.summary, msg.usage);
        break;

      case "task_started":
        initSubagentStop(msg.parentToolId, msg.taskId);
        break;

      case "task_progress":
        updateSubagentProgress(msg.parentToolId, msg.usage, msg.lastToolName, msg.summary);
        break;

      case "task_updated":
        updateSubagentTaskStatus(msg.parentToolId, msg.patch);
        break;

      case "result":
        setActivity(null);
        stopThinking();
        markAllToolsDone();
        closeToolGroup();
        finalizeAssistantBlock();
        addTurnMeta(msg.cost, msg.duration);
        accumulateUsage(msg.cost, msg.usage);
        accumulateContext(msg.cost, msg.usage, msg.modelUsage, msg.lastStreamInputTokens);
        break;

      case "context_usage":
        if (msg.data && !store.get('replayingHistory')) {
          store.set({ richContextUsage: msg.data });
          // UI sync handled by store subscriber in app-panels.js
        }
        break;

      case "done":
        setActivity(null);
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
        break;

      case "stderr":
        addSystemMessage(msg.text, false);
        break;

      case "error":
        setActivity(null);
        addSystemMessage(msg.text, true);
        break;

      case "system_info":
        addSystemMessage(msg.text, false);
        break;

      case "sdk_notification":
        addSystemMessage(msg.text, false);
        break;

      case "process_conflict":
        setActivity(null);
        addConflictMessage(msg);
        break;

      case "context_overflow":
        setActivity(null);
        addContextOverflowMessage(msg);
        break;

      case "auth_required":
        setActivity(null);
        stopThinking();
        markAllToolsDone();
        closeToolGroup();
        appendDelta((msg.text || "Authentication required.") + "\n");
        setStatus("connected");
        var _authLoopSid = store.get('loopCurrentSessionId');
        if (!store.get('loopActive') || !_authLoopSid || store.get('activeSessionId') !== _authLoopSid) {
          enableMainInput();
        }
        break;

      case "rate_limit":
        handleRateLimitEvent(msg);
        break;

      case "rate_limit_usage":
        updateRateLimitUsage(msg);
        break;

      case "scheduled_message_queued":
        addScheduledMessageBubble(msg.text, msg.resetsAt);
        setScheduleBtnDisabled(true);
        break;

      case "scheduled_message_sent":
        removeScheduledMessageBubble();
        setScheduleBtnDisabled(false);
        setStatus("processing");
        break;

      case "scheduled_message_cancelled":
        removeScheduledMessageBubble();
        setScheduleBtnDisabled(false);
        break;

      case "auto_continue_scheduled":
        // Scheduler auto-continue, just show info
        break;

      case "auto_continue_fired":
        setStatus("processing");
        break;

      case "prompt_suggestion":
        showSuggestionChips(msg.suggestion);
        break;

      case "fast_mode_state":
        handleFastModeState(msg.state);
        break;

      case "process_killed":
        addSystemMessage("Process " + msg.pid + " has been terminated. You can retry your message now.", false);
        break;

      case "rewind_preview_result":
        showRewindModal(msg);
        break;

      case "rewind_complete":
        onRewindComplete();
        setRewindMode(false);
        var rewindText = "Rewound to earlier point. Files have been restored.";
        if (msg.mode === "chat") rewindText = "Conversation rewound to earlier point.";
        else if (msg.mode === "files") rewindText = "Files restored to earlier point.";
        addSystemMessage(rewindText, false);
        break;

      case "rewind_error":
        onRewindError();
        clearPendingRewindUuid();
        addSystemMessage(msg.text || "Rewind failed.", true);
        break;

      case "fork_complete":
        addSystemMessage("Session forked successfully.");
        break;

      case "fs_list_result":
        handleFsList(msg);
        break;

      case "fs_search_result":
        handleFsSearch(msg);
        break;

      case "fs_read_result":
        if (msg.path === "CLAUDE.md" && isProjectSettingsOpen()) {
          handleInstructionsRead(msg);
        } else {
          handleFsRead(msg);
        }
        break;

      case "fs_write_result":
        handleInstructionsWrite(msg);
        break;

      case "project_env_result":
        handleProjectEnv(msg);
        break;

      case "set_project_env_result":
        handleProjectEnvSaved(msg);
        break;

      case "global_claude_md_result":
        handleGlobalClaudeMdRead(msg);
        break;

      case "write_global_claude_md_result":
        handleGlobalClaudeMdWrite(msg);
        break;

      case "shared_env_result":
        handleSharedEnv(msg);
        handleProjectSharedEnv(msg);
        break;

      case "set_shared_env_result":
        handleSharedEnvSaved(msg);
        handleProjectSharedEnvSaved(msg);
        break;

      case "fs_file_changed":
        handleFileChanged(msg);
        break;

      case "fs_dir_changed":
        handleDirChanged(msg);
        break;

      case "fs_file_history_result":
        handleFileHistory(msg);
        break;

      case "fs_git_diff_result":
        handleGitDiff(msg);
        break;

      case "fs_file_at_result":
        handleFileAt(msg);
        break;

      case "term_list":
        handleTermList(msg);
        updateTerminalList(msg.terminals);
        break;

      case "context_sources_state":
        handleContextSourcesState(msg);
        break;

      case "email_accounts_list":
        updateEmailAccountList(msg);
        refreshEmailSettings();
        break;

      case "email_unread_update":
        updateEmailUnreadCounts(msg);
        break;

      case "email_account_test_result":
        handleEmailTestResult(msg);
        break;

      case "email_account_add_result":
        handleEmailAddResult(msg);
        break;

      case "email_account_remove_result":
        handleEmailRemoveResult(msg);
        break;

      case "email_defaults":
        handleEmailDefaults(msg);
        break;

      case "extension_command":
        sendExtensionCommand(msg.command, msg.args, msg.requestId);
        break;

      case "mcp_tool_call":
        handleMcpToolCallMessage(msg);
        break;

      case "mcp_servers_state":
        handleMcpServersState(msg);
        break;

      case "term_created":
        handleTermCreated(msg);
        if (store.get('pendingTermCommand')) {
          var cmd = store.get('pendingTermCommand');
          store.set({ pendingTermCommand: null });
          // Small delay to let terminal initialize
          setTimeout(function() {
            sendTerminalCommand(cmd);
          }, 300);
        }
        break;

      case "term_output":
        handleTermOutput(msg);
        break;

      case "term_resized":
        handleTermResized(msg);
        break;

      case "term_exited":
        handleTermExited(msg);
        break;

      case "term_closed":
        handleTermClosed(msg);
        break;

      case "notes_list":
        handleNotesList(msg);
        break;

      case "note_created":
        handleNoteCreated(msg);
        break;

      case "note_updated":
        handleNoteUpdated(msg);
        break;

      case "note_deleted":
        handleNoteDeleted(msg);
        break;

      case "process_stats":
        updateStatusPanel(msg);
        updateSettingsStats(msg);
        break;

      case "browse_dir_result":
        handleBrowseDirResult(msg);
        break;

      case "add_project_result":
        handleAddProjectResult(msg);
        break;

      case "clone_project_progress":
        handleCloneProgress(msg);
        break;

      case "remove_project_result":
        handleRemoveProjectResult(msg);
        break;

      case "reorder_projects_result":
        if (!msg.ok) {
          showToast(msg.error || "Failed to reorder projects", "error");
        }
        break;

      case "set_project_title_result":
        if (!msg.ok) {
          showToast(msg.error || "Failed to rename project", "error");
        }
        break;

      case "set_project_icon_result":
        if (!msg.ok) {
          showToast(msg.error || "Failed to set icon", "error");
        }
        break;

      case "set_project_preferred_agent_result":
        if (!msg.ok) {
          showToast(msg.error || "Failed to set preferred agent", "error");
        }
        break;

      case "projects_updated":
        updateProjectList(msg);
        renderUserStrip();
        break;

      case "project_owner_changed":
        store.set({ currentProjectOwnerId: msg.ownerId });
        handleProjectOwnerChanged(msg);
        break;

      // --- DM ---
      case "dm_history":
        enterDmMode(msg.dmKey, msg.targetUser, msg.messages);
        break;

      case "dm_message":
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
        break;

      case "dm_typing":
        if (store.get('dmMode') && msg.dmKey === store.get('dmKey')) {
          showDmTypingIndicator(msg.typing);
        }
        break;

      case "dm_list":
        // Could be used for DM list view later
        break;

      case "dm_favorites_updated":
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
        break;

      case "mate_created":
        // removed: mates
        break;

      case "mate_deleted":
        // removed: mates
        break;

      case "mate_updated":
        // removed: mates
        break;

      case "mate_list":
        // removed: mates
        break;

      case "mate_available_builtins":
        // removed: mates
        break;

      case "mate_error":
        // removed: mates
        break;

      // --- @Mention ---
      case "mention_processing":
        // removed: mates
        break;

      case "mention_start":
        handleMentionStart(msg);
        break;

      case "mention_activity":
        handleMentionActivity(msg);
        break;

      case "mention_stream":
        handleMentionStream(msg);
        break;

      case "mention_done":
        handleMentionDone(msg);
        break;

      case "mention_error":
        handleMentionError(msg);
        if (msg.error) showToast("@Mention: " + msg.error, "error");
        break;

      case "mention_user":
        // Finalize current assistant block so mention renders in correct DOM position
        finalizeAssistantBlock();
        renderMentionUser(msg);
        break;

      case "mention_response":
        finalizeAssistantBlock();
        renderMentionResponse(msg);
        break;

      case "user_mention":
        // User-to-user side conversation entry. Renders for any session viewer
        // (sender's other tabs and the mentioned user, if they are watching the
        // session). On the sender's own tab, the server uses sendToSessionOthers
        // so we never get a duplicate here.
        finalizeAssistantBlock();
        renderUserMention(msg);
        break;
      case "user_mention_error":
        if (msg.error) showToast("@Mention: " + msg.error, "error");
        break;

      // --- Debate ---
      case "debate_preparing":
        if (!store.get('replayingHistory')) showDebateSticky("preparing", msg);
        handleDebatePreparing(msg);
        break;

      case "debate_brief_ready":
        if (store.get('replayingHistory')) {
          renderDebateBriefReady(msg);
        } else {
          handleDebateBriefReady(msg);
        }
        break;

      case "debate_started":
        if (!store.get('replayingHistory')) showDebateSticky("live", msg);
        if (store.get('replayingHistory')) {
          renderDebateStarted(msg);
        } else {
          handleDebateStarted(msg);
        }
        break;

      case "debate_turn":
        handleDebateTurn(msg);
        if (msg.round) updateDebateRound(msg.round);
        break;

      case "debate_activity":
        handleDebateActivity(msg);
        break;

      case "debate_stream":
        handleDebateStream(msg);
        break;

      case "debate_turn_done":
        if (msg.round) updateDebateRound(msg.round);
        handleDebateTurnDone(msg);
        break;

      case "debate_hand_raised":
        // Visual feedback: hand is raised, waiting for floor
        break;

      case "debate_comment_queued":
        handleDebateCommentQueued(msg);
        break;

      case "debate_comment_injected":
        if (store.get('replayingHistory')) {
          renderDebateCommentInjected(msg);
        } else {
          handleDebateCommentInjected(msg);
        }
        break;

      case "debate_conclude_confirm":
        if (!store.get('replayingHistory')) showDebateConcludeConfirm(msg);
        break;

      case "debate_user_floor":
        if (!store.get('replayingHistory')) showDebateUserFloor(msg);
        break;

      case "debate_user_floor_done":
        renderDebateUserFloorDone(msg);
        break;

      case "debate_user_resume":
        renderDebateUserResume(msg);
        break;

      case "debate_resumed":
        handleDebateResumed(msg);
        if (!store.get('replayingHistory')) showDebateSticky("live", msg);
        break;

      case "debate_ended":
        if (!store.get('replayingHistory')) showDebateSticky("ended", msg);
        if (store.get('replayingHistory')) {
          renderDebateEnded(msg);
        } else {
          handleDebateEnded(msg);
        }
        break;

      case "debate_error":
        handleDebateError(msg);
        if (msg.error) showToast("Debate: " + msg.error, "error");
        break;

      case "daemon_config":
        if (msg.config && msg.config.headless) store.set({ isHeadlessMode: true });
        updateDaemonConfig(msg.config);
        break;

      case "set_pin_result":
        handleSetPinResult(msg);
        break;

      case "set_keep_awake_result":
        handleKeepAwakeChanged(msg);
        break;

      case "keep_awake_changed":
        handleKeepAwakeChanged(msg);
        break;

      case "set_auto_continue_result":
      case "auto_continue_changed":
        handleAutoContinueChanged(msg);
        break;

      case "restart_server_result":
        handleRestartResult(msg);
        break;

      case "shutdown_server_result":
        handleShutdownResult(msg);
        break;

      // --- Ralph Loop ---
      case "loop_available":
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
        break;

      case "loop_started":
        store.set({ loopActive: true, ralphPhase: "executing", loopIteration: 0, loopMaxIterations: msg.maxIterations, loopBannerName: msg.name || null });
        showLoopBanner(true);

        var _lbn = store.get('loopBannerName');
        addSystemMessage((_lbn || "Loop") + " started (max " + msg.maxIterations + " iterations)", false);
        // Do not lock the input here — loop_iteration carries the session ID and will
        // lock only the actual coder/judge session when it becomes active.
        break;

      case "loop_iteration":
        store.set({ loopIteration: msg.iteration, loopMaxIterations: msg.maxIterations, loopCurrentSessionId: msg.sessionId || null });
        updateLoopBanner(msg.iteration, msg.maxIterations, "running");

        var _libn = store.get('loopBannerName');
        addSystemMessage((_libn || "Loop") + " iteration #" + msg.iteration + " started", false);
        // Lock input only if the user is currently viewing the loop's coder session.
        if (msg.sessionId && store.get('activeSessionId') === msg.sessionId) {
          inputEl.disabled = true;
          inputEl.placeholder = (_libn || "Loop") + " is running...";
        }
        break;

      case "loop_judging":
        var _ljs = store.snap();
        store.set({ loopCurrentSessionId: msg.sessionId || _ljs.loopCurrentSessionId });
        updateLoopBanner(_ljs.loopIteration, _ljs.loopMaxIterations, "judging");
        addSystemMessage("Judging iteration #" + msg.iteration + "...", false);
        // Lock input only if the user is currently viewing the judge session.
        if (msg.sessionId && store.get('activeSessionId') === msg.sessionId) {
          inputEl.disabled = true;
          inputEl.placeholder = (_ljs.loopBannerName || "Loop") + " is judging...";
        }
        break;

      case "loop_verdict":
        addSystemMessage("Judge: " + msg.verdict.toUpperCase() + " - " + (msg.summary || ""), false);
        break;

      case "loop_stopping":
        var _lss = store.snap();
        updateLoopBanner(_lss.loopIteration, _lss.loopMaxIterations, "stopping");
        break;

      case "loop_finished":
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
        break;

      case "loop_error":
        addSystemMessage((store.get('loopBannerName') || "Loop") + " error: " + msg.text, true);
        break;

      // --- Ralph Wizard / Crafting ---
      case "ralph_phase":
        var _rps = { ralphPhase: msg.phase || "idle" };
        if (msg.craftingSessionId) _rps.ralphCraftingSessionId = msg.craftingSessionId;
        if (msg.source !== undefined) _rps.ralphCraftingSource = msg.source;
        store.set(_rps);
        if (msg.wizardData) store.set({ wizardData: msg.wizardData });


        break;

      case "ralph_crafting_started":
        store.set({ ralphPhase: "crafting", ralphCraftingSessionId: msg.sessionId || store.get('activeSessionId'), ralphCraftingSource: msg.source || null });


        if (msg.source !== "ralph") {
          // Task sessions open in the scheduler calendar window
          enterCraftingMode(msg.sessionId, msg.taskId);
        }
        // Ralph crafting sessions show in session list as part of the loop group
        break;

      case "ralph_files_status":
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
        break;

      case "loop_registry_files_content":
        handleLoopRegistryFiles(msg);
        break;

      case "ralph_files_content":
        store.set({ ralphPreviewContent: { prompt: msg.prompt || "", judge: msg.judge || "" } });
        openRalphPreviewModal();
        break;

      case "loop_registry_error":
        addSystemMessage("Error: " + msg.text, true);
        break;

      // --- Notifications ---
      case "notifications_state":
        handleNotificationsState(msg);
        break;
      case "notification_created":
        handleNotificationCreated(msg);
        break;
      case "notification_dismissed":
        handleNotificationDismissed(msg);
        break;
      case "notification_dismissed_all":
        handleNotificationDismissedAll();
        break;
    }
}
