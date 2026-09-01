// server-settings.js — Full-screen server settings overlay
import { refreshIcons } from './icons.js';
import { showToast, copyToClipboard, escapeHtml } from './utils.js';
import { pushOverlayState, popOverlayState } from './overlay-history.js';
import { parseEnvString, looksLikeEnv } from './project-settings.js';
import { checkAdminAccess, loadAdminSection } from './admin.js';
import { closeFileViewer } from './filebrowser.js';
import { renderModelList, renderModeList, renderEffortBar, renderThinkingBar, renderBetaCard, isSonnetModel } from './settings-defaults.js';
import { initCustomIconsSettings, initCustomIconsUpload, loadCustomIcons } from './custom-icons-settings.js';
import { formatBytes } from './app-panels.js';
import { registerHandlers } from './app-messages.js';

var ctx = null;
var settingsEl = null;
var settingsBtn = null;
var closeBtn = null;
var navItems = null;
var sections = null;
var statsTimer = null;

// Section data for command palette
var SETTINGS_SECTIONS = [
  { section: 'overview',       label: 'Status',        group: 'General',  icon: 'shield',         danger: false },
  { section: 'notifications',  label: 'Notifications', group: 'General',  icon: 'bell',           danger: false },
  { section: 'security',       label: 'Security',      group: 'General',  icon: 'lock',           danger: false },
  { section: 'models',         label: 'Model',         group: 'Defaults', icon: 'cpu',            danger: false },
  { section: 'claudemd',       label: 'Instructions',  group: 'Config',   icon: 'file-text',      danger: false },
  { section: 'environment',    label: 'Environment',   group: 'Config',   icon: 'terminal',       danger: false },
  { section: 'storage',        label: 'Storage',       group: 'Config',   icon: 'database',       danger: false },
  { section: 'custom-icons',   label: 'Custom Icons',  group: 'Config',   icon: 'image',          danger: false },
  { section: 'lite',           label: 'Lite',          group: 'Clagentic', icon: 'zap',           danger: false },
  { section: 'admin-users',    label: 'Users',         group: 'Admin',    icon: 'users',          danger: false, adminOnly: true },
  { section: 'admin-invites',  label: 'Invites',       group: 'Admin',    icon: 'mail',           danger: false, adminOnly: true },
  { section: 'admin-projects', label: 'Projects',      group: 'Admin',    icon: 'folder',         danger: false, adminOnly: true },
  { section: 'admin-smtp',     label: 'Email',         group: 'Server',   icon: 'send',           danger: false, adminOnly: true },
  { section: 'advanced',       label: 'Advanced',      group: 'Server',   icon: 'settings-2',     danger: false },
  { section: 'restart',        label: 'Restart',       group: 'Server',   icon: 'refresh-cw',     danger: false },
  { section: 'shutdown',       label: 'Shutdown',      group: 'Server',   icon: 'power',          danger: true },
];

var currentSection = 'overview';
var paletteOpen = false;
var paletteHighlight = -1;
var isAdminUser = false;

export function initServerSettings(appCtx) {
  ctx = appCtx;
  settingsEl = document.getElementById("server-settings");
  settingsBtn = document.getElementById("server-settings-btn");
  closeBtn = document.getElementById("server-settings-close");

  if (!settingsEl || !settingsBtn) return;

  initCustomIconsSettings(appCtx);
  initCustomIconsUpload();

  navItems = settingsEl.querySelectorAll(".settings-nav-item");
  sections = settingsEl.querySelectorAll(".server-settings-section");

  // Open settings
  settingsBtn.addEventListener("click", function () {
    openSettings();
  });

  // Close settings
  closeBtn.addEventListener("click", function () {
    closeSettings();
  });

  // ESC to close
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !settingsEl.classList.contains("hidden")) {
      if (paletteOpen) {
        closeSettingsPalette();
      } else {
        closeSettings();
      }
    }
  });

  // Global keyboard: Cmd+K / Ctrl+K inside settings, Esc to close palette
  document.addEventListener("keydown", function (e) {
    if (settingsEl && !settingsEl.classList.contains("hidden")) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (paletteOpen) {
          closeSettingsPalette();
        } else {
          openSettingsPalette();
        }
      }
    }
  });

  // Nav item clicks
  for (var i = 0; i < navItems.length; i++) {
    navItems[i].addEventListener("click", function () {
      var section = this.dataset.section;
      switchSection(section);
    });
  }

  // Mobile command palette pill
  var navPill = document.getElementById("settings-nav-pill");
  if (navPill) {
    navPill.addEventListener("click", function () {
      openSettingsPalette();
    });
  }

  // Palette backdrop click to close
  var paletteEl = document.getElementById("settings-palette");
  if (paletteEl) {
    var backdrop = paletteEl.querySelector(".settings-palette-backdrop");
    if (backdrop) {
      backdrop.addEventListener("click", function () {
        closeSettingsPalette();
      });
    }
  }

  // Palette input events
  var paletteInput = document.getElementById("settings-palette-input");
  if (paletteInput) {
    paletteInput.addEventListener("input", function () {
      renderPaletteResults(this.value);
    });
    paletteInput.addEventListener("keydown", function (e) {
      handlePaletteKey(e);
    });
  }

  // Copyable command blocks
  var copyables = settingsEl.querySelectorAll(".settings-copyable");
  for (var c = 0; c < copyables.length; c++) {
    copyables[c].addEventListener("click", function () {
      var text = this.dataset.copy;
      if (!text) return;
      var btn = this.querySelector(".settings-copy-btn");
      copyToClipboard(text).then(function () {
        if (btn) {
          var orig = btn.textContent;
          btn.textContent = "✓";
          setTimeout(function () { btn.textContent = orig; }, 1500);
        }
        showToast("Copied to clipboard");
      });
    });
  }

  // Notification toggles
  var notifAlert = document.getElementById("settings-notif-alert");
  var notifSound = document.getElementById("settings-notif-sound");
  var notifPush = document.getElementById("settings-notif-push");

  if (notifAlert) {
    notifAlert.addEventListener("change", function () {
      var src = document.getElementById("notif-toggle-alert");
      if (src) {
        src.checked = this.checked;
        src.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  if (notifSound) {
    notifSound.addEventListener("change", function () {
      var src = document.getElementById("notif-toggle-sound");
      if (src) {
        src.checked = this.checked;
        src.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  if (notifPush) {
    notifPush.addEventListener("change", function () {
      var src = document.getElementById("notif-toggle-push");
      if (src) {
        src.checked = this.checked;
        src.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  // lr-db0437: the model-row click used to be double-handled — this
  // delegated listener sent the (correct) set_server_default_model message,
  // while renderModelList's own click handler (settings-defaults.js) sent
  // set_model (session-scoped, wrong for a default picker — see
  // ssDefaultsOpts() above). Now that ssDefaultsOpts() sends the correct
  // message type itself, this second listener would just double-send the
  // same message on every click.

  // PIN buttons
  var pinSetBtn = document.getElementById("settings-pin-set-btn");
  var pinRemoveBtn = document.getElementById("settings-pin-remove-btn");
  var pinSaveBtn = document.getElementById("settings-pin-save-btn");
  var pinCancelBtn = document.getElementById("settings-pin-cancel-btn");
  var pinInput = document.getElementById("settings-pin-input");

  if (pinSetBtn) pinSetBtn.addEventListener("click", function () { showPinForm(); });
  if (pinRemoveBtn) pinRemoveBtn.addEventListener("click", function () {
    var ws = ctx.ws;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "set_pin", pin: null }));
    }
  });
  if (pinSaveBtn) pinSaveBtn.addEventListener("click", function () { submitPin(); });
  if (pinCancelBtn) pinCancelBtn.addEventListener("click", function () { hidePinForm(); });
  if (pinInput) pinInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submitPin(); }
    if (e.key === "Escape") { e.preventDefault(); hidePinForm(); }
  });

  // Auto-continue moved to User Settings > Behavior

  // Keep awake toggle
  var keepAwakeToggle = document.getElementById("settings-keep-awake");
  if (keepAwakeToggle) {
    keepAwakeToggle.addEventListener("change", function () {
      var ws = ctx.ws;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "set_keep_awake", value: this.checked }));
      }
    });
  }

  // Image retention select
  var imageRetentionSelect = document.getElementById("settings-image-retention");
  if (imageRetentionSelect) {
    imageRetentionSelect.addEventListener("change", function () {
      var ws = ctx.ws;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "set_image_retention", days: parseInt(this.value, 10) }));
      }
    });
  }

  // Advanced Memory: min available memory input.
  // change (blur/Enter) stays wired as an implicit commit path for users who
  // expect it; the explicit ss-memory-save-btn click below (lr-9e6569) is
  // the primary, discoverable affordance — this panel had none before.
  var memAvailInput = document.getElementById("settings-mem-available-min");
  if (memAvailInput) {
    memAvailInput.addEventListener("change", function () { saveMemAvailableThreshold(); });
  }

  // Advanced Memory: tokens per MB headroom input (same change-listener rationale).
  var tpmInput = document.getElementById("settings-tokens-per-mb-headroom");
  if (tpmInput) {
    tpmInput.addEventListener("change", function () { saveTokensPerMbHeadroom(); });
  }

  // Advanced Memory: explicit Save button (lr-9e6569). The panel previously had
  // no commit affordance at all -- only the native change event above, which
  // never fires for a user who types a value and navigates away without
  // blurring. Saves both fields; each still validates independently.
  var memorySaveBtn = document.getElementById("ss-memory-save-btn");
  if (memorySaveBtn) {
    memorySaveBtn.addEventListener("click", function () {
      saveMemAvailableThreshold();
      saveTokensPerMbHeadroom();
    });
  }

  // Advanced Memory: collapse toggle
  var advMemToggle = document.getElementById("settings-advanced-memory-toggle");
  var advMemBody = document.getElementById("settings-advanced-memory-body");
  if (advMemToggle && advMemBody) {
    advMemToggle.addEventListener("click", function () {
      var isOpen = !advMemBody.classList.contains("hidden");
      advMemBody.classList.toggle("hidden", isOpen);
      advMemToggle.setAttribute("aria-expanded", String(!isOpen));
      var chevron = advMemToggle.querySelector(".settings-adv-chevron");
      if (chevron) chevron.style.transform = isOpen ? "" : "rotate(90deg)";
    });
  }

  // Global CLAUDE.md: save button
  var ssClaudeMdSave = document.getElementById("ss-claudemd-save");
  if (ssClaudeMdSave) {
    ssClaudeMdSave.addEventListener("click", function () { saveGlobalClaudeMd(); });
  }

  // Shared environment: add button
  var ssEnvAddBtn = document.getElementById("ss-env-add-btn");
  if (ssEnvAddBtn) {
    ssEnvAddBtn.addEventListener("click", function () {
      addSharedEnvRow("", "", true);
      autoSaveSharedEnv();
    });
  }

  // Refresh agent catalog
  var refreshAgentsBtn = document.getElementById("settings-refresh-agents-btn");
  if (refreshAgentsBtn) {
    refreshAgentsBtn.addEventListener("click", function () {
      var ws = ctx.ws;
      if (ws && ws.readyState === 1) {
        refreshAgentsBtn.disabled = true;
        refreshAgentsBtn.innerHTML = '<i data-lucide="refresh-cw" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px;"></i>Refreshing...';
        ws.send(JSON.stringify({ type: "refresh_agents" }));
      }
    });
  }

  // Restart server
  var restartBtn = document.getElementById("settings-restart-btn");
  if (restartBtn) {
    restartBtn.addEventListener("click", function () {
      var ws = ctx.ws;
      if (ws && ws.readyState === 1) {
        restartBtn.disabled = true;
        restartBtn.textContent = "Restarting...";
        ws.send(JSON.stringify({ type: "restart_server" }));
      }
    });
  }

  // Shutdown server
  var shutdownInput = document.getElementById("settings-shutdown-input");
  var shutdownBtn = document.getElementById("settings-shutdown-btn");

  if (shutdownInput && shutdownBtn) {
    shutdownInput.addEventListener("input", function () {
      var val = this.value.trim().toLowerCase();
      shutdownBtn.disabled = val !== "shutdown";
    });

    shutdownInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!shutdownBtn.disabled) shutdownBtn.click();
      }
    });

    shutdownBtn.addEventListener("click", function () {
      var val = shutdownInput.value.trim().toLowerCase();
      if (val !== "shutdown") return;
      var ws = ctx.ws;
      if (ws && ws.readyState === 1) {
        shutdownBtn.disabled = true;
        shutdownBtn.textContent = "Shutting down...";
        shutdownInput.disabled = true;
        ws.send(JSON.stringify({ type: "shutdown_server" }));
      }
    });
  }
}

function openSettingsPalette() {
  var paletteEl = document.getElementById("settings-palette");
  var paletteInput = document.getElementById("settings-palette-input");
  var pill = document.getElementById("settings-nav-pill");
  if (!paletteEl) return;
  paletteEl.classList.remove("hidden");
  paletteOpen = true;
  paletteHighlight = -1;
  if (pill) pill.setAttribute("aria-expanded", "true");
  renderPaletteResults("");
  if (paletteInput) {
    paletteInput.value = "";
    // Only autofocus on non-touch devices — on mobile, focus triggers the soft keyboard
    // which pushes the viewport and obscures the palette
    if (window.matchMedia("(pointer: fine)").matches) {
      paletteInput.focus();
    }
  }
  // Prevent body scroll on iOS
  document.body.style.overflow = "hidden";
  refreshIcons(paletteEl);
}

function closeSettingsPalette() {
  var paletteEl = document.getElementById("settings-palette");
  var pill = document.getElementById("settings-nav-pill");
  if (!paletteEl) return;
  paletteEl.classList.add("hidden");
  paletteOpen = false;
  if (pill) {
    pill.setAttribute("aria-expanded", "false");
    if (window.matchMedia("(pointer: fine)").matches) {
      pill.focus();
    }
  }
  document.body.style.overflow = "";
}

function getVisibleSections() {
  var result = [];
  for (var i = 0; i < SETTINGS_SECTIONS.length; i++) {
    var s = SETTINGS_SECTIONS[i];
    // Skip admin-only if not admin
    if (s.adminOnly && !isAdminUser) continue;
    // Skip conditional sections that are hidden
    if (s.conditionalId) {
      var el = document.getElementById(s.conditionalId);
      if (!el || el.classList.contains("hidden")) continue;
    }
    result.push(s);
  }
  return result;
}

function renderPaletteResults(query) {
  var resultsEl = document.getElementById("settings-palette-results");
  if (!resultsEl) return;
  var q = query.toLowerCase();
  var visible = getVisibleSections();
  var filtered = [];
  for (var i = 0; i < visible.length; i++) {
    var s = visible[i];
    if (!q || s.label.toLowerCase().indexOf(q) !== -1 || s.group.toLowerCase().indexOf(q) !== -1) {
      filtered.push(s);
    }
  }
  if (filtered.length === 0) {
    resultsEl.innerHTML = '<div class="settings-palette-empty">No matches for "' + escapeHtml(query) + '"</div>';
    paletteHighlight = -1;
    return;
  }
  // Group results
  var groups = {};
  var groupOrder = [];
  for (var j = 0; j < filtered.length; j++) {
    var g = filtered[j].group;
    if (!groups[g]) { groups[g] = []; groupOrder.push(g); }
    groups[g].push(filtered[j]);
  }
  var html = "";
  var itemIndex = 0;
  for (var gi = 0; gi < groupOrder.length; gi++) {
    var gName = groupOrder[gi];
    html += '<div class="settings-palette-group-header">' + escapeHtml(gName) + '</div>';
    var items = groups[gName];
    for (var ii = 0; ii < items.length; ii++) {
      var item = items[ii];
      var isCurrent = item.section === currentSection;
      var cls = "settings-palette-item";
      if (isCurrent) cls += " current";
      if (item.danger) cls += " danger";
      if (itemIndex === paletteHighlight) cls += " highlighted";
      html += '<button class="' + cls + '" data-section="' + item.section + '" data-index="' + itemIndex + '">' +
        '<i data-lucide="' + item.icon + '" class="settings-palette-item-icon"></i>' +
        '<span class="settings-palette-item-label">' + escapeHtml(item.label) + '</span>' +
        (isCurrent ? '<i data-lucide="check" class="settings-palette-item-check"></i>' : '') +
        '</button>';
      itemIndex++;
    }
  }
  resultsEl.innerHTML = html;
  refreshIcons(resultsEl);
  // Bind clicks
  var buttons = resultsEl.querySelectorAll(".settings-palette-item");
  for (var bi = 0; bi < buttons.length; bi++) {
    buttons[bi].addEventListener("click", function () {
      var sec = this.dataset.section;
      closeSettingsPalette();
      switchSection(sec);
    });
  }
  paletteHighlight = -1;
}

function handlePaletteKey(e) {
  var resultsEl = document.getElementById("settings-palette-results");
  if (!resultsEl) return;
  var buttons = resultsEl.querySelectorAll(".settings-palette-item");
  if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
    e.preventDefault();
    paletteHighlight = Math.min(paletteHighlight + 1, buttons.length - 1);
    updatePaletteHighlight(buttons);
  } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
    e.preventDefault();
    paletteHighlight = Math.max(paletteHighlight - 1, 0);
    updatePaletteHighlight(buttons);
  } else if (e.key === "Enter") {
    if (paletteHighlight >= 0 && paletteHighlight < buttons.length) {
      var sec = buttons[paletteHighlight].dataset.section;
      closeSettingsPalette();
      switchSection(sec);
    }
  }
}

function updatePaletteHighlight(buttons) {
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle("highlighted", i === paletteHighlight);
    if (i === paletteHighlight) {
      buttons[i].scrollIntoView({ block: "nearest" });
    }
  }
}

function updateNavPill(sectionName) {
  var pill = document.getElementById("settings-nav-pill");
  if (!pill) return;
  var groupEl = document.getElementById("settings-nav-pill-group");
  var labelEl = document.getElementById("settings-nav-pill-label");
  for (var i = 0; i < SETTINGS_SECTIONS.length; i++) {
    if (SETTINGS_SECTIONS[i].section === sectionName) {
      if (groupEl) groupEl.textContent = SETTINGS_SECTIONS[i].group;
      if (labelEl) labelEl.textContent = SETTINGS_SECTIONS[i].label;
      break;
    }
  }
}

function switchSection(sectionName) {
  currentSection = sectionName;
  updateNavPill(sectionName);
  for (var i = 0; i < navItems.length; i++) {
    var isActive = navItems[i].dataset.section === sectionName;
    navItems[i].classList.toggle("active", isActive);
  }
  for (var j = 0; j < sections.length; j++) {
    var isActive2 = sections[j].dataset.section === sectionName;
    sections[j].classList.toggle("active", isActive2);
  }

  // Lazy-load section data
  if (sectionName === "claudemd") loadGlobalClaudeMd();
  if (sectionName === "environment") loadSharedEnv();
  if (sectionName === "custom-icons") loadCustomIcons();
  if (sectionName === "admin-users" || sectionName === "admin-invites" || sectionName === "admin-projects" || sectionName === "admin-smtp") {
    var adminBody = document.getElementById(sectionName + "-body");
    if (adminBody) loadAdminSection(sectionName, adminBody);
  }
}

function openSettings() {
  closeFileViewer();
  pushOverlayState();
  settingsEl.classList.remove("hidden");
  settingsBtn.classList.add("active");
  refreshIcons(settingsEl);
  populateSettings();
  requestDaemonConfig();
  resetRestartButton();
  resetShutdownForm();

  // Show/hide admin sections based on role
  checkAdminAccess().then(function (isAdmin) {
    isAdminUser = isAdmin;
    var adminEls = settingsEl.querySelectorAll(".settings-admin-only");
    for (var ai = 0; ai < adminEls.length; ai++) {
      adminEls[ai].style.display = isAdmin ? "" : "none";
    }
  });

  // Start periodic stats refresh
  requestStats();
  statsTimer = setInterval(requestStats, 5000);
}

function resetRestartButton() {
  var btn = document.getElementById("settings-restart-btn");
  var errorEl = document.getElementById("settings-restart-error");
  if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="refresh-cw" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px;"></i>Restart'; }
  if (errorEl) errorEl.classList.add("hidden");
}

function resetShutdownForm() {
  var input = document.getElementById("settings-shutdown-input");
  var btn = document.getElementById("settings-shutdown-btn");
  var errorEl = document.getElementById("settings-shutdown-error");
  if (input) { input.value = ""; input.disabled = false; }
  if (btn) { btn.disabled = true; btn.textContent = "Shutdown"; }
  if (errorEl) errorEl.classList.add("hidden");
}

export function closeSettings() {
  popOverlayState();
  settingsEl.classList.add("hidden");
  settingsBtn.classList.remove("active");
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

export function isSettingsOpen() {
  return settingsEl && !settingsEl.classList.contains("hidden");
}

function requestStats() {
  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "process_stats" }));
  }
}

function populateSettings() {
  var nameEl = document.getElementById("settings-server-name");
  var versionEl = document.getElementById("settings-server-version");
  var slugEl = document.getElementById("settings-project-slug");
  var wsPathEl = document.getElementById("settings-ws-path");
  var skipPermsEl = document.getElementById("settings-skip-perms");

  // Nav header defaults to hostname (updated by updateDaemonConfig)
  if (nameEl && !nameEl.textContent) nameEl.textContent = "Server";

  // Version is set from WebSocket "info" message in app.js
  if (versionEl && !versionEl.textContent) versionEl.textContent = "-";

  if (slugEl) slugEl.textContent = ctx.currentSlug || "(default)";
  if (wsPathEl) wsPathEl.textContent = ctx.wsPath || "/ws";

  // Skip permissions
  var spBanner = document.getElementById("skip-perms-pill");
  if (skipPermsEl) {
    var isSkip = spBanner && !spBanner.classList.contains("hidden");
    skipPermsEl.textContent = isSkip ? "Enabled" : "Disabled";
    skipPermsEl.classList.toggle("settings-badge-on", isSkip);
  }

  // Sync notification toggles
  syncNotifToggles();

  // Session defaults
  updateModelList();
  updateModeList();
  updateEffortBar();
  updateThinkingBar();
  updateSsBetaCard();
}

function syncNotifToggles() {
  var pairs = [
    ["notif-toggle-alert", "settings-notif-alert"],
    ["notif-toggle-sound", "settings-notif-sound"],
    ["notif-toggle-push", "settings-notif-push"],
  ];
  for (var i = 0; i < pairs.length; i++) {
    var src = document.getElementById(pairs[i][0]);
    var dst = document.getElementById(pairs[i][1]);
    if (src && dst) dst.checked = src.checked;
  }
}

function ssSendMsg(type, data) {
  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    var msg = Object.assign({ type: type }, data);
    ws.send(JSON.stringify(msg));
  }
}

function ssDefaultsOpts() {
  return {
    models: ctx.currentModels || [],
    currentModel: ctx.currentModel || ctx._currentModelValue || "",
    currentMode: ctx.currentMode || "default",
    currentEffort: ctx.currentEffort || "medium",
    currentThinking: ctx.currentThinking || "adaptive",
    currentThinkingBudget: ctx.currentThinkingBudget || 10000,
    currentBetas: ctx.currentBetas || [],
    sendMsg: ssSendMsg,
    // lr-db0437: was "set_model" — the session-scoped message type, wrong for
    // a server DEFAULT picker. Every sibling control on this same panel
    // (mode/effort/betas below) already uses the set_server_default_* type;
    // the model row was the one surface still routing through the live
    // session's setModel handler instead of the default-setter.
    modelMsgType: "set_server_default_model",
    modeMsgType: "set_server_default_mode",
    effortMsgType: "set_server_default_effort",
    betasMsgType: "set_server_default_betas",
    scopeLabel: "Server default",
    onModelSelect: function (model) { updateSsBetaCard(model); },
  };
}

function updateModelList() {
  renderModelList("ss", ssDefaultsOpts());
}

function updateModeList() {
  renderModeList("ss", ssDefaultsOpts());
}

function updateEffortBar() {
  renderEffortBar("ss", ssDefaultsOpts());
}

function updateThinkingBar() {
  renderThinkingBar("ss", ssDefaultsOpts());
}

function updateSsBetaCard(overrideModel) {
  renderBetaCard("ss", Object.assign(ssDefaultsOpts(), { overrideModel: overrideModel }));
}

export function updateSettingsStats(data) {
  if (!isSettingsOpen()) return;
  var pid = document.getElementById("settings-status-pid");
  var uptime = document.getElementById("settings-status-uptime");
  var rss = document.getElementById("settings-status-rss");
  var sessions = document.getElementById("settings-status-sessions");
  var clients = document.getElementById("settings-status-clients");

  if (pid) pid.textContent = String(data.pid);
  if (uptime) uptime.textContent = formatUptime(data.uptime);
  if (rss) rss.textContent = formatBytes(data.memory.rss);
  if (sessions) sessions.textContent = String(data.sessions);
  if (clients) clients.textContent = String(data.clients);
}

export function updateSettingsModels(current, models) {
  if (!ctx) return;
  ctx.currentModels = models;
  ctx._currentModelValue = current;
  if (isSettingsOpen()) {
    updateModelList();
    updateModeList();
    updateEffortBar();
    updateThinkingBar();
    updateSsBetaCard();
  }
}

// --- Daemon config ---
function requestDaemonConfig() {
  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "get_daemon_config" }));
  }
}

export function updateDaemonConfig(config) {
  // Nav header: show hostname (strip .local suffix, lowercase)
  var nameEl = document.getElementById("settings-server-name");
  if (nameEl && config.hostname) {
    var displayHost = config.hostname.replace(/\.local$/i, "").toLowerCase();
    nameEl.textContent = displayHost;
    nameEl.title = config.hostname;
  }

  // Host
  var hostnameEl = document.getElementById("settings-hostname");
  var lanIpEl = document.getElementById("settings-lan-ip");
  if (hostnameEl) hostnameEl.textContent = config.hostname || "-";
  if (lanIpEl) lanIpEl.textContent = config.lanIp || "";

  // Port
  var portEl = document.getElementById("settings-port");
  if (portEl) portEl.textContent = String(config.port || "-");

  // HTTPS (lr-20e71c): three states, not two. tlsState distinguishes the
  // daemon terminating TLS itself ("direct") from a trusted reverse proxy
  // terminating it in front of the daemon ("proxy") — both are genuinely
  // HTTPS from the client's perspective, but only "direct" means tlsOptions
  // is set. A real unencrypted deployment ("disabled") must render visibly
  // distinct from both, never silently reported as Enabled.
  var tlsEl = document.getElementById("settings-tls");
  if (tlsEl) {
    var tlsState = config.tlsState || (config.tls ? "direct" : "disabled");
    var tlsLabel = tlsState === "direct" ? "Enabled" :
      tlsState === "proxy" ? "Enabled (proxy)" : "Disabled";
    tlsEl.textContent = tlsLabel;
    tlsEl.classList.toggle("settings-badge-green", tlsState === "direct");
    tlsEl.classList.toggle("settings-badge-proxy", tlsState === "proxy");
    tlsEl.title = tlsState === "proxy"
      ? "TLS is terminated by a reverse proxy in front of this daemon, not by the daemon itself."
      : "";
  }

  // Debug
  var debugEl = document.getElementById("settings-debug");
  if (debugEl) {
    debugEl.textContent = config.debug ? "Enabled" : "Disabled";
    debugEl.classList.toggle("settings-badge-on", !!config.debug);
  }

  // PIN status
  updatePinStatus(!!config.pinEnabled);

  // Auto-continue on rate limit
  // Auto-continue is now per-user (User Settings > Behavior)

  // Keep awake
  var keepAwakeToggle = document.getElementById("settings-keep-awake");
  if (keepAwakeToggle) keepAwakeToggle.checked = !!config.keepAwake;

  // Image retention
  var imageRetentionSelect = document.getElementById("settings-image-retention");
  if (imageRetentionSelect && config.imageRetentionDays !== undefined) {
    imageRetentionSelect.value = String(config.imageRetentionDays);
  }

  // Early Access toggle
  var channelToggle = document.getElementById("settings-update-channel");
  if (channelToggle) {
    channelToggle.checked = (config.updateChannel === "beta");
    channelToggle.onchange = function () {
      var channel = channelToggle.checked ? "beta" : "stable";
      if (ctx.ws && ctx.ws.readyState === 1) {
        ctx.ws.send(JSON.stringify({ type: "set_update_channel", channel: channel }));
        // Auto-trigger update check after channel change
        setTimeout(function () {
          ctx.ws.send(JSON.stringify({ type: "check_update" }));
        }, 200);
      }
    };
  }

  // Lite auto-enroll toggle
  var liteAutoEnrollToggle = document.getElementById("settings-lite-auto-enroll");
  if (liteAutoEnrollToggle && config.liteAutoEnroll !== undefined) {
    liteAutoEnrollToggle.checked = !!config.liteAutoEnroll;
  }

  // Advanced Memory inputs. lr-9e6569: memAvailableMinMBIsDefault /
  // tokensPerMbHeadroomIsDefault distinguish "this number is a fallback
  // because nothing was ever persisted" from "this number was saved" -- an
  // absent config key renders a value visually identical to a persisted one
  // otherwise, which is part of why a discarded edit went unnoticed.
  var memAvailEl = document.getElementById("settings-mem-available-min");
  if (memAvailEl && config.memAvailableMinMB !== undefined) {
    memAvailEl.value = String(config.memAvailableMinMB);
    // lr-9e6569 fold-in (BOBBIE bobbie.uncat.1): the dedup marker means "the
    // value the server is known to hold", not "the last value this tab
    // optimistically transmitted". This snapshot IS the server's authoritative
    // state, so reconcile the marker here too -- otherwise a save whose
    // response never arrives (disconnect between send and daemon processing)
    // leaves the marker pinned to the unconfirmed value; a reconnect repaints
    // .value but not the marker, and a later legitimate retry of that exact
    // value is then silently suppressed by saveMemAvailableThreshold's
    // `val === lastSentMemAvailableMin` check with no send and no feedback.
    lastSentMemAvailableMin = config.memAvailableMinMB;
  }
  // lr-9e6569 fold-in (PEACHES finding 3): updateDaemonConfig also receives
  // the PARTIAL daemon_config_changed broadcast (currently just
  // { liteAutoEnroll }), not only the full onGetDaemonConfig snapshot -- see
  // app-messages.js's daemon_config_changed -> updateDaemonConfig wiring.
  // Every other field above guards on `!== undefined` so a partial broadcast
  // leaves it untouched; the note lines below must do the same. Gating only
  // on `!== undefined` before writing keeps an unrelated setting change
  // (e.g. Lite auto-enroll) elsewhere in the app from clearing "Using
  // default — not yet saved" for memory settings that were never part of
  // that broadcast in the first place.
  var memAvailNoteEl = document.getElementById("settings-mem-available-min-default-note");
  if (memAvailNoteEl && config.memAvailableMinMBIsDefault !== undefined) {
    memAvailNoteEl.textContent = config.memAvailableMinMBIsDefault ? "Using default — not yet saved" : "";
  }
  var tpmEl = document.getElementById("settings-tokens-per-mb-headroom");
  if (tpmEl && config.tokensPerMbHeadroom !== undefined) {
    tpmEl.value = String(config.tokensPerMbHeadroom);
    // lr-9e6569 fold-in (BOBBIE bobbie.uncat.1): same reconciliation as
    // memAvailableMinMB above -- see that comment for the full failure
    // sequence this closes.
    lastSentTokensPerMbHeadroom = config.tokensPerMbHeadroom;
  }
  var tpmNoteEl = document.getElementById("settings-tokens-per-mb-headroom-default-note");
  if (tpmNoteEl && config.tokensPerMbHeadroomIsDefault !== undefined) {
    tpmNoteEl.textContent = config.tokensPerMbHeadroomIsDefault ? "Using default — not yet saved" : "";
  }

  // Show keep awake subsection only on macOS (lives inside the Advanced section)
  var keepAwakeSection = document.getElementById("settings-keep-awake-section");
  var keepAwakeOpt = document.getElementById("settings-keep-awake-opt");
  if (config.platform === "darwin") {
    if (keepAwakeSection) keepAwakeSection.classList.remove("hidden");
    if (keepAwakeOpt) keepAwakeOpt.classList.remove("hidden");
  } else {
    if (keepAwakeSection) keepAwakeSection.classList.add("hidden");
    if (keepAwakeOpt) keepAwakeOpt.classList.add("hidden");
  }
}

// lr-93e3c8 (fnd-66af4e): the Advanced > Memory inputs had a working change
// listener and a working daemon-side handler, but zero client-side feedback
// on either success or failure — a working control was indistinguishable
// from a dead one. Every other control in this panel (CLAUDE.md save,
// shared-env autosave) has a status element; these had none.
//
// lr-9e6569 fold-in (PEACHES finding 1): both memory fields share this one
// status element, but each field saves independently and responses can
// arrive out of order. Writing text unconditionally meant an error from one
// field was silently overwritten by "Saving..."/"Saved" from the other --
// a green success indication for a field that actually failed. Track each
// field's own outcome and render the combined result: any field currently
// in error wins the display (an error is never masked by the other field's
// success), and the shared element only clears once neither field is in
// error and neither has a message actively pending.
var MEMORY_FIELD_LABELS = {
  memAvail: "Min available memory",
  tpm: "Tokens per MB headroom",
};
var memoryFieldStatus = {
  memAvail: { text: "", isError: false },
  tpm: { text: "", isError: false },
};

function renderMemorySaveStatus() {
  var el = document.getElementById("ss-memory-save-status");
  if (!el) return;
  var memAvail = memoryFieldStatus.memAvail;
  var tpm = memoryFieldStatus.tpm;
  var errors = [];
  if (memAvail.isError && memAvail.text) errors.push(MEMORY_FIELD_LABELS.memAvail + ": " + memAvail.text);
  if (tpm.isError && tpm.text) errors.push(MEMORY_FIELD_LABELS.tpm + ": " + tpm.text);

  if (errors.length > 0) {
    // An error is never masked by the other field's success -- always wins the display.
    el.textContent = errors.join(" | ");
    el.classList.add("ps-save-status-error");
    return;
  }

  el.classList.remove("ps-save-status-error");
  // Neither field is in error: show whichever non-empty status is most recent
  // (the field object holding text is the one that just transitioned).
  el.textContent = memAvail.text || tpm.text || "";
}

function setFieldSaveStatus(field, text, isError) {
  memoryFieldStatus[field] = { text: text, isError: !!isError };
  renderMemorySaveStatus();
  if (!isError && text) {
    setTimeout(function () {
      if (memoryFieldStatus[field].text === text && !memoryFieldStatus[field].isError) {
        memoryFieldStatus[field] = { text: "", isError: false };
        renderMemorySaveStatus();
      }
    }, 2000);
  }
}

// lr-9e6569: a value the daemon derived from DEFAULT_MEM_AVAILABLE_MIN_MB /
// DEFAULT_TOKENS_PER_MB_HEADROOM because the config key was never set renders
// visually identical to a persisted value equal to that default -- part of
// why a silently-discarded edit went unnoticed for three rounds. Once this
// module explicitly saves a value, it IS persisted, so clear the note here
// rather than waiting on the next full daemon_config round-trip.
function clearDefaultNote(elId) {
  var el = document.getElementById(elId);
  if (el) el.textContent = "";
}

// lr-9e6569 fold-in (PEACHES finding 2): the blur/Enter `change` listener and
// the explicit Save button's click listener both call these same save
// functions, so typing a value then clicking Save fired the WS send twice
// for the same field (blur fires `change` first, then the click handler
// calls the save function again with the identical, already-sent value).
// Track the last value this field successfully attempted to send; if the
// current input value hasn't changed since then, the second call is a
// no-op. A genuinely new edit (different value) still sends -- this only
// suppresses the redundant repeat of a value already in flight/saved,
// keeping both commit paths (blur/Enter and the button) working for their
// own distinct edits.
var lastSentMemAvailableMin = null;
var lastSentTokensPerMbHeadroom = null;

function saveMemAvailableThreshold() {
  var input = document.getElementById("settings-mem-available-min");
  if (!input) return;
  var val = parseInt(input.value, 10);
  if (isNaN(val) || val < 0) {
    setFieldSaveStatus("memAvail", "Invalid value — must be 0 or greater", true);
    return;
  }
  if (val === lastSentMemAvailableMin) return;
  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    lastSentMemAvailableMin = val;
    setFieldSaveStatus("memAvail", "Saving...", false);
    ws.send(JSON.stringify({ type: "set_mem_available_threshold", value: val }));
  } else {
    setFieldSaveStatus("memAvail", "Not connected — change not saved", true);
  }
}

function saveTokensPerMbHeadroom() {
  var input = document.getElementById("settings-tokens-per-mb-headroom");
  if (!input) return;
  var val = parseInt(input.value, 10);
  if (isNaN(val) || val < 10 || val > 500) {
    setFieldSaveStatus("tpm", "Invalid value — must be 10-500", true);
    return;
  }
  if (val === lastSentTokensPerMbHeadroom) return;
  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    lastSentTokensPerMbHeadroom = val;
    setFieldSaveStatus("tpm", "Saving...", false);
    ws.send(JSON.stringify({ type: "set_tokens_per_mb_headroom", value: val }));
  } else {
    setFieldSaveStatus("tpm", "Not connected — change not saved", true);
  }
}

export function handleSetMemAvailableThresholdResult(msg) {
  if (msg.ok) {
    setFieldSaveStatus("memAvail", "Saved", false);
    var memAvailEl = document.getElementById("settings-mem-available-min");
    if (memAvailEl && typeof msg.memAvailableMinMB === "number") {
      memAvailEl.value = String(msg.memAvailableMinMB);
      lastSentMemAvailableMin = msg.memAvailableMinMB;
    }
    clearDefaultNote("settings-mem-available-min-default-note");
  } else {
    // A failed save must not be treated as "in flight" for dedup purposes --
    // clear the last-sent marker so a retry of the same value is not
    // silently suppressed.
    lastSentMemAvailableMin = null;
    setFieldSaveStatus("memAvail", "Error: " + (msg.error || "Failed to save"), true);
  }
}

export function handleMemAvailableThresholdChanged(msg) {
  var memAvailEl = document.getElementById("settings-mem-available-min");
  if (memAvailEl && typeof msg.memAvailableMinMB === "number") {
    memAvailEl.value = String(msg.memAvailableMinMB);
    lastSentMemAvailableMin = msg.memAvailableMinMB;
  }
  clearDefaultNote("settings-mem-available-min-default-note");
}

export function handleSetTokensPerMbHeadroomResult(msg) {
  if (msg.ok) {
    setFieldSaveStatus("tpm", "Saved", false);
    var tpmEl = document.getElementById("settings-tokens-per-mb-headroom");
    if (tpmEl && typeof msg.tokensPerMbHeadroom === "number") {
      tpmEl.value = String(msg.tokensPerMbHeadroom);
      lastSentTokensPerMbHeadroom = msg.tokensPerMbHeadroom;
    }
    clearDefaultNote("settings-tokens-per-mb-headroom-default-note");
  } else {
    lastSentTokensPerMbHeadroom = null;
    setFieldSaveStatus("tpm", "Error: " + (msg.error || "Failed to save"), true);
  }
}

export function handleTokensPerMbHeadroomChanged(msg) {
  var tpmEl = document.getElementById("settings-tokens-per-mb-headroom");
  if (tpmEl && typeof msg.tokensPerMbHeadroom === "number") {
    tpmEl.value = String(msg.tokensPerMbHeadroom);
    lastSentTokensPerMbHeadroom = msg.tokensPerMbHeadroom;
  }
  clearDefaultNote("settings-tokens-per-mb-headroom-default-note");
}

export function handleSetPinResult(msg) {
  if (msg.ok) {
    updatePinStatus(!!msg.pinEnabled);
    hidePinForm();
    showToast(msg.pinEnabled ? "PIN set successfully" : "PIN removed");
  }
}

export function handleKeepAwakeChanged(msg) {
  var keepAwakeToggle = document.getElementById("settings-keep-awake");
  if (keepAwakeToggle) keepAwakeToggle.checked = !!msg.keepAwake;
}

export function handleAutoContinueChanged(msg) {
  // Auto-continue is now per-user; server broadcast no longer updates UI
}

export function handleRefreshAgentsResult(msg) {
  var btn = document.getElementById("settings-refresh-agents-btn");
  if (!btn) return;
  // Reset button regardless of ok — the toast (broadcast from server) carries
  // the outcome. If not ok, we just unblock the button silently.
  btn.disabled = false;
  btn.innerHTML = '<i data-lucide="refresh-cw" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px;"></i>Refresh agents';
  refreshIcons();
}

export function handleRestartResult(msg) {
  var restartBtn = document.getElementById("settings-restart-btn");
  var errorEl = document.getElementById("settings-restart-error");

  if (msg.ok) {
    if (restartBtn) restartBtn.textContent = "Server restarting...";
    showToast("Server is restarting...");
  } else {
    if (restartBtn) {
      restartBtn.textContent = "Restart";
      restartBtn.disabled = false;
    }
    if (errorEl) {
      errorEl.textContent = msg.error || "Restart failed";
      errorEl.classList.remove("hidden");
    }
  }
}

export function handleShutdownResult(msg) {
  var shutdownInput = document.getElementById("settings-shutdown-input");
  var shutdownBtn = document.getElementById("settings-shutdown-btn");
  var errorEl = document.getElementById("settings-shutdown-error");

  if (msg.ok) {
    if (shutdownBtn) shutdownBtn.textContent = "Server stopped";
    showToast("Server is shutting down...");
  } else {
    if (shutdownBtn) {
      shutdownBtn.textContent = "Shutdown";
      shutdownBtn.disabled = false;
    }
    if (shutdownInput) shutdownInput.disabled = false;
    if (errorEl) {
      errorEl.textContent = msg.error || "Shutdown failed";
      errorEl.classList.remove("hidden");
    }
  }
}

// --- PIN form management ---
function showPinForm() {
  var form = document.getElementById("settings-pin-form");
  var input = document.getElementById("settings-pin-input");
  var errorEl = document.getElementById("settings-pin-error");
  if (form) form.classList.remove("hidden");
  if (errorEl) errorEl.classList.add("hidden");
  if (input) { input.value = ""; input.focus(); }
}

function hidePinForm() {
  var form = document.getElementById("settings-pin-form");
  var input = document.getElementById("settings-pin-input");
  var errorEl = document.getElementById("settings-pin-error");
  if (form) form.classList.add("hidden");
  if (input) input.value = "";
  if (errorEl) errorEl.classList.add("hidden");
}

function submitPin() {
  var input = document.getElementById("settings-pin-input");
  var errorEl = document.getElementById("settings-pin-error");
  if (!input) return;
  var pin = input.value.trim();
  if (!/^\d{6}$/.test(pin)) {
    if (errorEl) errorEl.classList.remove("hidden");
    input.focus();
    return;
  }
  if (errorEl) errorEl.classList.add("hidden");
  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "set_pin", pin: pin }));
  }
}

function updatePinStatus(enabled) {
  var statusEl = document.getElementById("settings-pin-status");
  var setBtn = document.getElementById("settings-pin-set-btn");
  var removeBtn = document.getElementById("settings-pin-remove-btn");
  var actionLabel = document.getElementById("settings-pin-action-label");

  if (statusEl) {
    statusEl.textContent = enabled ? "Enabled" : "Disabled";
    statusEl.classList.toggle("settings-badge-green", enabled);
  }
  if (setBtn) setBtn.textContent = enabled ? "Change PIN" : "Set PIN";
  if (removeBtn) removeBtn.classList.toggle("hidden", !enabled);
  if (actionLabel) actionLabel.textContent = enabled ? "Change PIN" : "Set PIN";
}

// ===== Global CLAUDE.md =====
function loadGlobalClaudeMd() {
  var editor = document.getElementById("ss-claudemd-editor");
  var status = document.getElementById("ss-claudemd-status");
  var saveStatus = document.getElementById("ss-claudemd-save-status");
  if (saveStatus) saveStatus.textContent = "";
  if (status) status.textContent = "Loading...";

  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "read_global_claude_md" }));
  }
}

export function handleGlobalClaudeMdRead(msg) {
  var editor = document.getElementById("ss-claudemd-editor");
  var status = document.getElementById("ss-claudemd-status");
  if (!editor) return;

  if (msg.error) {
    editor.value = "";
    if (status) status.textContent = "No global CLAUDE.md found. Save to create one.";
  } else {
    editor.value = msg.content || "";
    if (status) status.textContent = "";
  }
}

function saveGlobalClaudeMd() {
  var editor = document.getElementById("ss-claudemd-editor");
  var saveStatus = document.getElementById("ss-claudemd-save-status");
  if (!editor) return;

  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "write_global_claude_md", content: editor.value }));
    if (saveStatus) saveStatus.textContent = "Saving...";
  }
}

export function handleGlobalClaudeMdWrite(msg) {
  var saveStatus = document.getElementById("ss-claudemd-save-status");
  if (!saveStatus) return;
  if (msg.ok) {
    saveStatus.textContent = "Saved";
    setTimeout(function () { saveStatus.textContent = ""; }, 2000);
  } else {
    saveStatus.textContent = "Error: " + (msg.error || "Failed to save");
  }
}

// ===== Shared Environment Variables =====
var sharedEnvSaveTimer = null;

function loadSharedEnv() {
  var saveStatus = document.getElementById("ss-env-save-status");
  if (saveStatus) saveStatus.textContent = "";

  var ws = ctx.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "get_shared_env" }));
  }
}

export function handleSharedEnv(msg) {
  var list = document.getElementById("ss-env-list");
  if (!list) return;
  list.innerHTML = "";

  var pairs = parseEnvString(msg.envrc || "");
  for (var i = 0; i < pairs.length; i++) {
    addSharedEnvRow(pairs[i].key, pairs[i].value, false);
  }
  refreshIcons();
}

export function handleSharedEnvSaved(msg) {
  var saveStatus = document.getElementById("ss-env-save-status");
  if (!saveStatus) return;
  if (msg.ok) {
    saveStatus.textContent = "Saved";
    setTimeout(function () { saveStatus.textContent = ""; }, 2000);
  } else {
    saveStatus.textContent = "Error: " + (msg.error || "Failed to save");
  }
}

function buildSharedEnvString() {
  var list = document.getElementById("ss-env-list");
  if (!list) return "";
  var rows = list.querySelectorAll(".ps-env-row");
  var lines = [];
  for (var i = 0; i < rows.length; i++) {
    var keyInput = rows[i].querySelector(".ps-env-key");
    var valInput = rows[i].querySelector(".ps-env-val");
    var key = keyInput ? keyInput.value.trim() : "";
    var val = valInput ? valInput.value : "";
    if (key) lines.push("export " + key + "=" + val);
  }
  return lines.join("\n");
}

function addSharedEnvRow(key, value, focus) {
  var list = document.getElementById("ss-env-list");
  if (!list) return;

  var row = document.createElement("div");
  row.className = "ps-env-row";

  var keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.className = "ps-env-key";
  keyInput.placeholder = "KEY";
  keyInput.value = key;
  keyInput.spellcheck = false;
  keyInput.autocomplete = "off";

  var valInput = document.createElement("input");
  valInput.type = "text";
  valInput.className = "ps-env-val";
  valInput.placeholder = "value";
  valInput.value = value;
  valInput.spellcheck = false;
  valInput.autocomplete = "off";

  var delBtn = document.createElement("button");
  delBtn.className = "ps-env-del";
  delBtn.title = "Remove";
  delBtn.innerHTML = '<i data-lucide="x"></i>';

  delBtn.addEventListener("click", function () {
    row.remove();
    autoSaveSharedEnv();
  });

  keyInput.addEventListener("input", function () { autoSaveSharedEnv(); });
  valInput.addEventListener("input", function () { autoSaveSharedEnv(); });

  // Paste detection
  keyInput.addEventListener("paste", function (e) {
    var text = (e.clipboardData || window.clipboardData).getData("text");
    if (text && looksLikeEnv(text)) {
      e.preventDefault();
      var pairs = parseEnvString(text);
      if (pairs.length > 0) {
        keyInput.value = pairs[0].key;
        valInput.value = pairs[0].value;
        for (var p = 1; p < pairs.length; p++) {
          addSharedEnvRow(pairs[p].key, pairs[p].value, false);
        }
        autoSaveSharedEnv();
      }
    }
  });

  valInput.addEventListener("paste", function (e) {
    var text = (e.clipboardData || window.clipboardData).getData("text");
    if (text && text.indexOf("\n") !== -1 && text.indexOf("=") !== -1) {
      e.preventDefault();
      var pairs = parseEnvString(text);
      if (pairs.length > 0) {
        keyInput.value = pairs[0].key;
        valInput.value = pairs[0].value;
        for (var p = 1; p < pairs.length; p++) {
          addSharedEnvRow(pairs[p].key, pairs[p].value, false);
        }
        autoSaveSharedEnv();
      }
    }
  });

  row.appendChild(keyInput);
  row.appendChild(valInput);
  row.appendChild(delBtn);
  list.appendChild(row);
  refreshIcons();

  if (focus) keyInput.focus();
}

function autoSaveSharedEnv() {
  if (sharedEnvSaveTimer) clearTimeout(sharedEnvSaveTimer);
  sharedEnvSaveTimer = setTimeout(function () {
    var envrc = buildSharedEnvString();
    var ws = ctx.ws;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "set_shared_env", envrc: envrc }));
      var saveStatus = document.getElementById("ss-env-save-status");
      if (saveStatus) {
        saveStatus.textContent = "Saved";
        setTimeout(function () { saveStatus.textContent = ""; }, 2000);
      }
    }
  }, 800);
}

function formatUptime(seconds) {
  var d = Math.floor(seconds / 86400);
  var h = Math.floor((seconds % 86400) / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  if (d > 0) return d + "d " + h + "h " + m + "m";
  if (h > 0) return h + "h " + m + "m " + s + "s";
  return m + "m " + s + "s";
}

// ===== Clagentic: Lite system settings =====

/**
 * Toggle between the installed and not-installed sub-states in the Lite section.
 * The nav item and section are always visible in the HTML; only the sub-states change.
 * Called from app.js when the /info response is received.
 */
export function updateSsLiteVisibility(liteInstalled) {
  var installedEl = document.getElementById("settings-clagentic-installed");
  var notInstalledEl = document.getElementById("settings-clagentic-not-installed");
  if (installedEl) installedEl.classList.toggle("hidden", !liteInstalled);
  if (notInstalledEl) notInstalledEl.classList.toggle("hidden", !!liteInstalled);
}

export function initSsLiteToggle() {
  var liteAutoEnrollToggle = document.getElementById("settings-lite-auto-enroll");
  if (liteAutoEnrollToggle) {
    liteAutoEnrollToggle.addEventListener("change", function () {
      var ws = ctx.ws;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "set_lite_auto_enroll", value: liteAutoEnrollToggle.checked }));
      }
    });
  }
}

// --- WS message registry (lr-4e49 Part 2) ---
// Registers this module's own single-owner result handlers directly with
// the app-messages.js registry. Runs once at module load — app.js imports
// every domain module (including this one) before connect() opens the
// WebSocket, so registration always completes before any message can
// arrive (see lib/public/app.js). Message types with more than one
// consumer module (shared_env_result, set_shared_env_result, process_stats,
// daemon_config) stay registered directly in app-messages.js, which is the
// only place both consumers are already imported together.
registerHandlers({
  global_claude_md_result: handleGlobalClaudeMdRead,
  write_global_claude_md_result: handleGlobalClaudeMdWrite,
  set_pin_result: handleSetPinResult,
  set_keep_awake_result: handleKeepAwakeChanged,
  keep_awake_changed: handleKeepAwakeChanged,
  set_auto_continue_result: handleAutoContinueChanged,
  auto_continue_changed: handleAutoContinueChanged,
  refresh_agents_result: handleRefreshAgentsResult,
  restart_server_result: handleRestartResult,
  shutdown_server_result: handleShutdownResult,
  // lr-93e3c8: these four were declared in ws-schema.js with app-messages.js
  // named as handler but never actually implemented anywhere (fnd-66af4e) —
  // the client-side half of why edits to Advanced > Memory silently reverted.
  set_mem_available_threshold_result: handleSetMemAvailableThresholdResult,
  mem_available_threshold_changed: handleMemAvailableThresholdChanged,
  set_tokens_per_mb_headroom_result: handleSetTokensPerMbHeadroomResult,
  tokens_per_mb_headroom_changed: handleTokensPerMbHeadroomChanged,
});
