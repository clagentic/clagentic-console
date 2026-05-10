// sidebar-mobile.js - Mobile sheet overlays, tab bar, and mobile-specific rendering
// Extracted from sidebar.js (PR-38)

import { mateAvatarUrl } from './avatar.js';
import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { getSessionTools } from './tool-palette.js';
import { parseEmojis } from './markdown.js';
import { getCurrentTheme, getChatLayout, setChatLayout, toggleDarkMode, getBrand, setBrand } from './theme.js';
import { openCommandPalette } from './command-palette.js';
import { openAgentPicker, openAgentPickerForPreferred } from './agent-picker.js';
import { openProjectSettings } from './project-settings.js';
import {
  getCachedSessions,
  getDateGroup,
  openResumePicker
} from './sidebar-sessions.js';
import {
  getCachedProjectList,
  getCachedCurrentSlug,
  getProjectAbbrev,
  getCachedFolderMeta,
  isFolderCollapsed,
  toggleFolderCollapsed,
  showProjectCtxMenu,
  showFolderCtxMenu,
  groupByFolders,
  groupProjects
} from './sidebar-projects.js';
import {
  getCurrentDmUserId,
  getCachedDmFavorites,
  getCachedDmUnread,
  getCachedDmRemovedUsers
} from './sidebar-users.js';

import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { dismissOverlayPanels, closeSidebar } from './sidebar.js';
import { switchProject, getCachedProjects } from './app-projects.js';
import { openDm } from './app-dm.js';
import { showHomeHub } from './app-home-hub.js';
import { openTerminal } from './terminal.js';
import { loadRootDirectory } from './filebrowser.js';

// --- Mobile state ---
var mobileChatSheetOpen = false;
var mobileSheetMateData = null;
var expandedMobileLoopGroups = new Set();
var expandedMobileLoopRuns = new Set();

export function setMobileSheetMateData(data) {
  mobileSheetMateData = data;
}

export function openMobileSheet(type) {
  var sheet = document.getElementById("mobile-sheet");
  if (!sheet) return;

  var titleEl = sheet.querySelector(".mobile-sheet-title");
  var listEl = sheet.querySelector(".mobile-sheet-list");
  if (!titleEl || !listEl) return;

  // Return file tree to sidebar before clearing (prevents destroying it)
  if (sheet.classList.contains("sheet-files")) {
    var prevFileTree = document.getElementById("file-tree");
    var prevPanel = document.getElementById("sidebar-panel-files");
    if (prevFileTree && prevPanel) prevPanel.appendChild(prevFileTree);
  }
  listEl.innerHTML = "";
  sheet.classList.remove("sheet-files");

  if (type === "projects") {
    titleEl.textContent = "Projects";
    renderSheetProjects(listEl);
  } else if (type === "sessions") {
    titleEl.textContent = "Chat";
    renderSheetSessions(listEl);
  } else if (type === "files") {
    titleEl.textContent = "Files";
    sheet.classList.add("sheet-files");
    var fileTree = document.getElementById("file-tree");
    if (fileTree) {
      listEl.appendChild(fileTree);
      fileTree.classList.remove("hidden");
    }
    loadRootDirectory();
  } else if (type === "search") {
    titleEl.textContent = "Search";
    renderSheetSearch(listEl);
  } else if (type === "more") {
    titleEl.textContent = "More";
    renderSheetMore(listEl);
  }

  sheet.classList.remove("hidden", "closing");
  // Always start at the top so the header actions are immediately visible
  if (listEl) listEl.scrollTop = 0;
  refreshIcons();
}

function closeMobileSheet() {
  var sheet = document.getElementById("mobile-sheet");
  if (!sheet || sheet.classList.contains("hidden")) return;

  mobileChatSheetOpen = false;

  // Return file tree to sidebar if it was moved
  if (sheet.classList.contains("sheet-files")) {
    var fileTree = document.getElementById("file-tree");
    var sidebarFilesPanel = document.getElementById("sidebar-panel-files");
    if (fileTree && sidebarFilesPanel) {
      sidebarFilesPanel.appendChild(fileTree);
    }
  }
  sheet.classList.add("closing");
  setTimeout(function () {
    sheet.classList.add("hidden");
    sheet.classList.remove("closing", "sheet-files");
  }, 230);
}

function renderSheetProjects(listEl) {
  // Sheet header: title + [+] button
  var header = document.createElement("div");
  header.className = "mobile-projects-header";
  var addBtn = document.createElement("button");
  addBtn.className = "mobile-projects-add-btn";
  addBtn.innerHTML = '<i data-lucide="plus"></i>';
  addBtn.title = "New Project";
  addBtn.addEventListener("click", function () {
    closeMobileSheet();
    setTimeout(function () {
      var btn = document.getElementById("add-project-btn");
      if (btn) btn.click();
    }, 250);
  });
  header.appendChild(addBtn);
  listEl.appendChild(header);

  var projects = getCachedProjectList();
  var folderMeta = getCachedFolderMeta();
  // Use live store value — getCachedCurrentSlug() lags until renderIconStrip() fires,
  // which causes stale badge/active state when the sheet opens right after a switch.
  var currentSlug = store.get('currentSlug') || getCachedCurrentSlug();

  // Group projects in desktop order: folders appear at the position of their
  // first member, not sorted to the top. Strip worktrees (mobile doesn't show
  // them as separate rows), then use the same groupByFolders() as the desktop
  // icon strip so order always matches.
  var grouped = groupProjects(projects);
  var units = groupByFolders(grouped.parents);

  function renderProjectRow(p, indent) {
    var el = document.createElement("button");
    el.className = "mobile-project-item" + (p.slug === currentSlug ? " active" : "") + (indent ? " mobile-project-item-indent" : "");

    var abbrev = document.createElement("span");
    abbrev.className = "mobile-project-abbrev";
    if (p.icon) {
      abbrev.textContent = p.icon;
      parseEmojis(abbrev);
    } else {
      abbrev.textContent = getProjectAbbrev(p.name);
    }
    el.appendChild(abbrev);

    var nameSpan = document.createElement("span");
    nameSpan.className = "mobile-project-name";
    nameSpan.textContent = p.name;
    el.appendChild(nameSpan);

    if (p.isProcessing) {
      var dot = document.createElement("span");
      dot.className = "mobile-project-processing";
      el.appendChild(dot);
    }
    if (p.unread > 0 && p.slug !== currentSlug) {
      var mBadge = document.createElement("span");
      mBadge.className = "mobile-project-unread";
      mBadge.textContent = p.unread > 99 ? "99+" : String(p.unread);
      el.appendChild(mBadge);
    }

    el.addEventListener("click", function () {
      if (p.slug !== getCachedCurrentSlug()) {
        // Different project — switch first, then open Chat sheet once WS confirms
        if (switchProject) switchProject(p.slug);
      }
      // Open Chat sheet for this project (active or just switched)
      openMobileSheet("sessions");
    });

    // Long-press → project context menu
    (function (proj, rowEl) {
      var lpt = null;
      rowEl.addEventListener("touchstart", function (e) {
        lpt = setTimeout(function () {
          lpt = null;
          showProjectCtxMenu(rowEl, proj.slug, proj.name, proj.icon, "below");
        }, 500);
      }, { passive: true });
      rowEl.addEventListener("touchend", function () { if (lpt) { clearTimeout(lpt); lpt = null; } });
      rowEl.addEventListener("touchmove", function () { if (lpt) { clearTimeout(lpt); lpt = null; } });
      rowEl.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        showProjectCtxMenu(rowEl, proj.slug, proj.name, proj.icon, "below");
      });
    })(p, el);

    return el;
  }

  function renderFolderSection(fn, folderProjects) {
    var meta = folderMeta[fn] || {};
    var collapsed = isFolderCollapsed(fn);
    var isActiveFolder = !collapsed && folderProjects.some(function (fp) { return fp.slug === currentSlug; });
    // Aggregate unread + processing from the project list.
    // Exclude the currently-active project from unread so switching into a
    // project inside a folder clears its contribution to the folder badge.
    var totalUnread = 0;
    var anyProcessing = false;
    for (var fai = 0; fai < folderProjects.length; fai++) {
      if (folderProjects[fai].slug !== currentSlug) {
        totalUnread += (folderProjects[fai].unread || 0);
      }
      if (folderProjects[fai].isProcessing) anyProcessing = true;
    }

    // Folder header row
    var headerEl = document.createElement("button");
    headerEl.className = "mobile-folder-header" + (isActiveFolder ? " active" : "");

    var iconWrap = document.createElement("span");
    iconWrap.className = "mobile-folder-icon-wrap";
    iconWrap.innerHTML = '<i data-lucide="folder"></i>';
    if (meta.icon) {
      var overlay = document.createElement("span");
      overlay.className = "mobile-folder-emoji-overlay";
      overlay.textContent = meta.icon;
      parseEmojis(overlay);
      iconWrap.appendChild(overlay);
    }
    headerEl.appendChild(iconWrap);

    var fnLabel = document.createElement("span");
    fnLabel.className = "mobile-folder-name";
    fnLabel.textContent = fn;
    headerEl.appendChild(fnLabel);

    var chevron = document.createElement("span");
    chevron.className = "mobile-folder-chevron" + (collapsed ? "" : " open");
    chevron.innerHTML = '<i data-lucide="chevron-right"></i>';
    headerEl.appendChild(chevron);

    if (anyProcessing) {
      var fdot = document.createElement("span");
      fdot.className = "mobile-project-processing";
      headerEl.appendChild(fdot);
    }
    if (totalUnread > 0) {
      var fbadge = document.createElement("span");
      fbadge.className = "mobile-project-unread";
      fbadge.textContent = totalUnread > 99 ? "99+" : String(totalUnread);
      headerEl.appendChild(fbadge);
    }

    listEl.appendChild(headerEl);

    // Children container
    var childrenEl = document.createElement("div");
    childrenEl.className = "mobile-folder-children" + (collapsed ? " hidden" : "");
    for (var fi = 0; fi < folderProjects.length; fi++) {
      childrenEl.appendChild(renderProjectRow(folderProjects[fi], true));
    }
    listEl.appendChild(childrenEl);

    // Toggle on click
    headerEl.addEventListener("click", function () {
      var nowCollapsed = toggleFolderCollapsed(fn);
      chevron.className = "mobile-folder-chevron" + (nowCollapsed ? "" : " open");
      if (nowCollapsed) {
        childrenEl.classList.add("hidden");
      } else {
        childrenEl.classList.remove("hidden");
      }
    });

    // Long-press → folder context menu
    (function (fName, fEl) {
      var lpt = null;
      fEl.addEventListener("touchstart", function (e) {
        lpt = setTimeout(function () {
          lpt = null;
          showFolderCtxMenu(fEl, fName);
        }, 500);
      }, { passive: true });
      fEl.addEventListener("touchend", function () { if (lpt) { clearTimeout(lpt); lpt = null; } });
      fEl.addEventListener("touchmove", function () { if (lpt) { clearTimeout(lpt); lpt = null; } });
      fEl.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        showFolderCtxMenu(fEl, fName);
      });
    })(fn, headerEl);
  }

  // Render in desktop order: folders at position of their first member
  for (var ui = 0; ui < units.length; ui++) {
    var unit = units[ui];
    if (unit.type === 'folder') {
      renderFolderSection(unit.name, unit.projects);
    } else {
      listEl.appendChild(renderProjectRow(unit.project, false));
    }
  }
}

function renderSheetSessions(listEl) {
  // --- Project header (display only) + [⋯] action button ---
  // Use store.get('currentSlug') directly — getCachedCurrentSlug() is stale
  // until renderIconStrip() runs, which may not have happened yet after a
  // project switch (causing the header to show the previous project's icon/name).
  var currentProject = null;
  var liveSlug = store.get('currentSlug') || getCachedCurrentSlug();
  for (var pi = 0; pi < getCachedProjectList().length; pi++) {
    if (getCachedProjectList()[pi].slug === liveSlug) {
      currentProject = getCachedProjectList()[pi];
      break;
    }
  }

  var chatHeader = document.createElement("div");
  chatHeader.className = "mobile-chat-project-header";

  if (currentProject) {
    // Icon + name are a button that opens the project action sheet
    var projHeaderBtn = document.createElement("button");
    projHeaderBtn.className = "mobile-chat-project-titlearea";
    projHeaderBtn.title = "Switch project";
    projHeaderBtn.addEventListener("click", function () {
      openMobileSheet("projects");
    });

    var projIcon = document.createElement("span");
    projIcon.className = "mobile-chat-project-icon";
    if (currentProject.icon) {
      projIcon.textContent = currentProject.icon;
      parseEmojis(projIcon);
    } else {
      projIcon.textContent = getProjectAbbrev(currentProject.name);
    }
    projHeaderBtn.appendChild(projIcon);

    var projName = document.createElement("span");
    projName.className = "mobile-chat-project-name";
    projName.textContent = currentProject.name;
    projHeaderBtn.appendChild(projName);

    chatHeader.appendChild(projHeaderBtn);
  }

  // [⋯] button → project action mini-sheet
  var moreBtn = document.createElement("button");
  moreBtn.className = "mobile-chat-project-more";
  moreBtn.innerHTML = '<i data-lucide="ellipsis"></i>';
  moreBtn.title = "Project actions";
  moreBtn.addEventListener("click", function () {
    showChatProjectActionSheet(currentProject);
  });
  chatHeader.appendChild(moreBtn);

  listEl.appendChild(chatHeader);

  // --- Session list ---
  var sessionListEl = document.createElement("div");
  sessionListEl.className = "mobile-chat-session-list";
  listEl.appendChild(sessionListEl);

  // Track that chat sheet is open
  mobileChatSheetOpen = true;

  // Render sessions for current project
  renderMobileSessionsInto(sessionListEl);
  refreshIcons();
}

// Show a mini action sheet for current project actions (replaces old chips + context menu)
function showChatProjectActionSheet(proj) {
  var overlay = document.createElement("div");
  overlay.className = "mobile-action-sheet-overlay";

  var sheet = document.createElement("div");
  sheet.className = "mobile-action-sheet";

  function addAction(icon, label, handler) {
    var btn = document.createElement("button");
    btn.className = "mobile-action-sheet-item";
    btn.innerHTML = '<i data-lucide="' + icon + '"></i><span>' + label + '</span>';
    btn.addEventListener("click", function () {
      document.body.removeChild(overlay);
      handler();
    });
    sheet.appendChild(btn);
  }

  if (proj) {
    addAction("settings", "Project Settings", function () {
      setTimeout(function () {
        openProjectSettings(proj.slug, {
          slug: proj.slug, name: proj.name, icon: proj.icon,
          projectOwnerId: store.get('currentProjectOwnerId'),
          ownerLocked: store.get('ownerLocked')
        });
      }, 250);
    });

    addAction("smile", "Set Icon", function () {
      // Trigger emoji picker via icon strip button context menu
      setTimeout(function () {
        var stripEl = document.querySelector('[data-slug="' + proj.slug + '"]');
        if (stripEl) {
          var ctxEvt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
          stripEl.dispatchEvent(ctxEvt);
        }
      }, 250);
    });

    addAction("bot", "Set Preferred Agent", function () {
      setTimeout(function () { openAgentPickerForPreferred(proj.slug); }, 250);
    });

    // Manage Access: only show for multi-user if owner/admin
    var perms = store.get('permissions');
    var isMultiUser = store.get('isMultiUser');
    if (isMultiUser && (!perms || perms.manageAccess !== false)) {
      addAction("users", "Manage Access", function () {
        setTimeout(function () {
          var accessBtn = document.getElementById("manage-access-btn");
          if (accessBtn) accessBtn.click();
        }, 250);
      });
    }
  }

  var cancelBtn = document.createElement("button");
  cancelBtn.className = "mobile-action-sheet-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", function () {
    document.body.removeChild(overlay);
  });
  sheet.appendChild(cancelBtn);

  overlay.appendChild(sheet);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) document.body.removeChild(overlay);
  });
  document.body.appendChild(overlay);
  refreshIcons();
}

// Helper: create a mobile session item element
function createMobileSessionItem(s) {
  var el = document.createElement("button");
  el.className = "mobile-session-item" + (s.active ? " active" : "");

  // Processing dot (left side, before title)
  if (s.isProcessing) {
    var dot = document.createElement("span");
    dot.className = "mobile-session-processing";
    el.appendChild(dot);
  }

  // lr-7db0 — agent badge for sessions cast as a named agent. Icon-only with
  // the agent name in `title`, matching desktop sidebar-sessions.js. Built as
  // a span via innerHTML to reuse iconHtml() the same way desktop does, then
  // appended before the title node so the agent name does not leak into the
  // text node (mobile reads .textContent for window-title sync).
  if (s.agentName) {
    var agentBadge = document.createElement("span");
    agentBadge.className = "session-agent-badge";
    agentBadge.title = "Agent: " + s.agentName;
    agentBadge.innerHTML = iconHtml("bot");
    el.appendChild(agentBadge);
  }

  var titleSpan = document.createElement("span");
  titleSpan.className = "mobile-session-title";
  titleSpan.appendChild(document.createTextNode(s.title || "New Session"));
  el.appendChild(titleSpan);

  // Unread badge (right side)
  if (s.unread > 0 && !s.active) {
    var badge = document.createElement("span");
    badge.className = "mobile-session-unread";
    badge.textContent = s.unread > 99 ? "99+" : String(s.unread);
    el.appendChild(badge);
  }

  (function (id) {
    el.addEventListener("click", function () {
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "switch_session", id: id }));
      }
      if (dismissOverlayPanels) dismissOverlayPanels();
      closeMobileSheet();
    });
  })(s.id);

  return el;
}

// Helper: create a mobile loop child element (individual session inside a group)
function createMobileLoopChild(s) {
  var el = document.createElement("button");
  el.className = "mobile-loop-child" + (s.active ? " active" : "");

  if (s.isProcessing) {
    var dot = document.createElement("span");
    dot.className = "mobile-session-processing";
    el.appendChild(dot);
  }

  var textSpan = document.createElement("span");
  textSpan.className = "mobile-session-title";
  if (s.loop) {
    var isRalphChild = s.loop.source === "ralph";
    var roleName = s.loop.role === "crafting" ? "Crafting" : s.loop.role === "judge" ? "Judge" : (isRalphChild ? "Coder" : "Run");
    var iterSuffix = s.loop.role === "crafting" ? "" : " #" + s.loop.iteration;
    var roleCls = s.loop.role === "crafting" ? " crafting" : (!isRalphChild ? " scheduled" : "");
    var badge = document.createElement("span");
    badge.className = "mobile-loop-role-badge" + roleCls;
    badge.textContent = roleName + iterSuffix;
    textSpan.appendChild(badge);
  }
  el.appendChild(textSpan);

  (function (id) {
    el.addEventListener("click", function () {
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "switch_session", id: id }));
      }
      if (dismissOverlayPanels) dismissOverlayPanels();
      closeMobileSheet();
    });
  })(s.id);

  return el;
}

// Helper: create a mobile loop run sub-group (collapsible time group)
function createMobileLoopRun(parentGk, startedAtKey, sessions, isRalph) {
  var runGk = parentGk + ":" + startedAtKey;
  var expanded = expandedMobileLoopRuns.has(runGk);
  var startedAt = Number(startedAtKey);
  var timeLabel = startedAt ? new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Unknown";

  var hasActive = false;
  var anyProcessing = false;
  var latestSession = sessions[0];
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].active) hasActive = true;
    if (sessions[i].isProcessing) anyProcessing = true;
    if ((sessions[i].lastActivity || 0) > (latestSession.lastActivity || 0)) {
      latestSession = sessions[i];
    }
  }

  var wrapper = document.createElement("div");
  wrapper.className = "mobile-loop-run-wrapper";

  var header = document.createElement("button");
  header.className = "mobile-loop-run" + (hasActive ? " active" : "") + (expanded ? " expanded" : "") + (isRalph ? "" : " scheduled");

  var chevron = document.createElement("span");
  chevron.className = "mobile-loop-chevron";
  chevron.innerHTML = iconHtml("chevron-right");
  header.appendChild(chevron);

  var label = document.createElement("span");
  label.className = "mobile-loop-run-time";
  var labelHtml = "";
  if (anyProcessing) {
    labelHtml += '<span class="mobile-session-processing"></span> ';
  }
  labelHtml += escapeHtml(timeLabel);
  label.innerHTML = labelHtml;
  header.appendChild(label);

  var countBadge = document.createElement("span");
  countBadge.className = "mobile-loop-count" + (isRalph ? "" : " scheduled");
  countBadge.textContent = String(sessions.length);
  header.appendChild(countBadge);

  header.addEventListener("click", (function (rk) {
    return function (e) {
      e.stopPropagation();
      if (expandedMobileLoopRuns.has(rk)) {
        expandedMobileLoopRuns.delete(rk);
      } else {
        expandedMobileLoopRuns.add(rk);
      }
      refreshMobileChatSheet();
    };
  })(runGk));

  wrapper.appendChild(header);

  if (expanded) {
    var childContainer = document.createElement("div");
    childContainer.className = "mobile-loop-children";
    for (var k = 0; k < sessions.length; k++) {
      childContainer.appendChild(createMobileLoopChild(sessions[k]));
    }
    wrapper.appendChild(childContainer);
  }

  return wrapper;
}

// Helper: create a mobile loop group element (collapsible group header)
function createMobileLoopGroup(loopId, children, groupKey) {
  var gk = groupKey || loopId;

  // Sub-group children by startedAt (each run)
  var runMap = {};
  for (var i = 0; i < children.length; i++) {
    var runKey = String(children[i].loop && children[i].loop.startedAt || 0);
    if (!runMap[runKey]) runMap[runKey] = [];
    runMap[runKey].push(children[i]);
  }
  var runKeys = Object.keys(runMap);

  // Sort each run's children by iteration then role
  for (var ri = 0; ri < runKeys.length; ri++) {
    runMap[runKeys[ri]].sort(function (a, b) {
      var ai = (a.loop && a.loop.iteration) || 0;
      var bi = (b.loop && b.loop.iteration) || 0;
      if (ai !== bi) return ai - bi;
      var ar = (a.loop && a.loop.role === "judge") ? 1 : 0;
      var br = (b.loop && b.loop.role === "judge") ? 1 : 0;
      return ar - br;
    });
  }

  // Sort runs by startedAt descending (newest first)
  runKeys.sort(function (a, b) { return Number(b) - Number(a); });

  var expanded = expandedMobileLoopGroups.has(gk);
  var hasActive = false;
  var anyProcessing = false;
  var latestSession = children[0];
  for (var ci = 0; ci < children.length; ci++) {
    if (children[ci].active) hasActive = true;
    if (children[ci].isProcessing) anyProcessing = true;
    if ((children[ci].lastActivity || 0) > (latestSession.lastActivity || 0)) {
      latestSession = children[ci];
    }
  }

  var loopName = (children[0].loop && children[0].loop.name) || "Loop";
  var isRalph = children[0].loop && children[0].loop.source === "ralph";
  var isCrafting = false;
  for (var j = 0; j < children.length; j++) {
    if (children[j].loop && children[j].loop.role === "crafting") isCrafting = true;
  }
  var runCount = runKeys.length;

  var wrapper = document.createElement("div");
  wrapper.className = "mobile-loop-wrapper";

  // Group header row
  var header = document.createElement("button");
  header.className = "mobile-loop-group" + (hasActive ? " active" : "") + (expanded ? " expanded" : "") + (isRalph ? "" : " scheduled");

  var chevron = document.createElement("span");
  chevron.className = "mobile-loop-chevron";
  chevron.innerHTML = iconHtml("chevron-right");
  header.appendChild(chevron);

  var iconSpan = document.createElement("span");
  var groupIcon = isRalph ? "repeat" : "calendar-clock";
  iconSpan.className = "mobile-loop-icon" + (isRalph ? "" : " scheduled");
  iconSpan.innerHTML = iconHtml(groupIcon);
  header.appendChild(iconSpan);

  if (anyProcessing) {
    var dot = document.createElement("span");
    dot.className = "mobile-session-processing";
    header.appendChild(dot);
  }

  var nameSpan = document.createElement("span");
  nameSpan.className = "mobile-loop-name";
  nameSpan.textContent = loopName;
  header.appendChild(nameSpan);

  if (isCrafting && children.length === 1) {
    var craftBadge = document.createElement("span");
    craftBadge.className = "mobile-loop-badge crafting";
    craftBadge.textContent = "Crafting";
    header.appendChild(craftBadge);
  } else {
    var countBadge = document.createElement("span");
    countBadge.className = "mobile-loop-count" + (isRalph ? "" : " scheduled");
    var countLabel = runCount === 1 ? String(children.length) : runCount + (runCount === 1 ? " run" : " runs");
    countBadge.textContent = countLabel;
    header.appendChild(countBadge);
  }

  // Chevron toggles expansion
  header.addEventListener("click", (function (lid) {
    return function (e) {
      e.stopPropagation();
      if (expandedMobileLoopGroups.has(lid)) {
        expandedMobileLoopGroups.delete(lid);
      } else {
        expandedMobileLoopGroups.add(lid);
      }
      refreshMobileChatSheet();
    };
  })(gk));

  wrapper.appendChild(header);

  // Expanded: show runs
  if (expanded) {
    var childContainer = document.createElement("div");
    childContainer.className = "mobile-loop-children";

    if (runCount === 1) {
      var singleRun = runMap[runKeys[0]];
      for (var sk = 0; sk < singleRun.length; sk++) {
        childContainer.appendChild(createMobileLoopChild(singleRun[sk]));
      }
    } else {
      for (var rk = 0; rk < runKeys.length; rk++) {
        childContainer.appendChild(createMobileLoopRun(gk, runKeys[rk], runMap[runKeys[rk]], isRalph));
      }
    }

    wrapper.appendChild(childContainer);
  }

  return wrapper;
}

function renderMateMobileActions(container) {
  var newSessionBtn = document.createElement("button");
  newSessionBtn.className = "mobile-session-new";
  newSessionBtn.innerHTML = '<i data-lucide="plus" style="width:16px;height:16px"></i> New session';
  newSessionBtn.addEventListener("click", function () {
    if (getWs() && store.get('connected')) {
      getWs().send(JSON.stringify({ type: "new_session" }));
    }
    closeMobileSheet();
  });
  container.appendChild(newSessionBtn);

  var debateBtn = document.createElement("button");
  debateBtn.className = "mobile-session-new";
  debateBtn.innerHTML = '<i data-lucide="mic" style="width:16px;height:16px"></i> New debate';
  debateBtn.addEventListener("click", function () {
    closeMobileSheet();
    var targetBtn = document.getElementById("mate-debate-btn");
    if (targetBtn) setTimeout(function () { targetBtn.click(); }, 250);
  });
  container.appendChild(debateBtn);

  // removed: mates — no mate session list

  refreshIcons();
}

// Helper: render sorted sessions into a container with date groups (with loop session grouping)
function renderMobileSessionsInto(container) {
  // Action grid: 2-column layout for the top action buttons
  var actionGrid = document.createElement("div");
  actionGrid.className = "mobile-session-actions";

  var isDmMode = store.get('dmMode');

  // Row 1: New session
  var newBtn = document.createElement("button");
  newBtn.className = "mobile-session-new";
  newBtn.innerHTML = '<i data-lucide="plus" style="width:16px;height:16px"></i> New session';
  newBtn.addEventListener("click", function () {
    if (getWs() && store.get('connected')) {
      getWs().send(JSON.stringify({ type: "new_session" }));
    }
    closeMobileSheet();
  });
  actionGrid.appendChild(newBtn);

  // Row 2: Agent chat (full picker) — hidden in dmMode
  if (!isDmMode) {
    var agentBtn = document.createElement("button");
    agentBtn.className = "mobile-session-new";
    agentBtn.innerHTML = '<i data-lucide="message-circle-plus" style="width:16px;height:16px"></i> Agent chat';
    agentBtn.addEventListener("click", function () {
      closeMobileSheet();
      setTimeout(function () { openAgentPicker(); }, 250);
    });
    actionGrid.appendChild(agentBtn);
  }

  // Row 3 (optional): preferred agent quick-launch — only when set, no placeholder
  if (!isDmMode) {
    var currentSlugMobile = store.get('currentSlug');
    var preferredAgentMobile = null;
    if (currentSlugMobile) {
      var allProjsMobile = getCachedProjects();
      for (var mpai = 0; mpai < allProjsMobile.length; mpai++) {
        if (allProjsMobile[mpai].slug === currentSlugMobile) {
          preferredAgentMobile = allProjsMobile[mpai].preferredAgent || null;
          break;
        }
      }
    }
    if (preferredAgentMobile) {
      var prefBtn = document.createElement("button");
      prefBtn.className = "mobile-session-new";
      prefBtn.innerHTML = '<i data-lucide="bot" style="width:16px;height:16px"></i> ' + escapeHtml(preferredAgentMobile.name);
      prefBtn.addEventListener("click", function () {
        closeMobileSheet();
        setTimeout(function () {
          var ws = getWs();
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: "new_session",
              agentName: preferredAgentMobile.name,
              agentKind: preferredAgentMobile.kind,
              agentPluginName: preferredAgentMobile.pluginName || null,
            }));
          }
        }, 250);
      });
      actionGrid.appendChild(prefBtn);
    }
  }

  container.appendChild(actionGrid);

  // Partition: loop sessions vs normal sessions (same logic as desktop renderSessionList)
  var sessions = getCachedSessions();
  var loopGroups = {};
  var normalSessions = [];
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    if (s.loop && s.loop.loopId && s.loop.role === "crafting" && s.loop.source !== "ralph" && s.loop.source !== "debate") {
      continue;
    } else if (s.loop && s.loop.loopId) {
      var startedAt = s.loop.startedAt || 0;
      var dateStr = startedAt ? new Date(startedAt).toISOString().slice(0, 10) : "unknown";
      var groupKey = s.loop.loopId + ":" + dateStr;
      if (!loopGroups[groupKey]) loopGroups[groupKey] = [];
      loopGroups[groupKey].push(s);
    } else {
      normalSessions.push(s);
    }
  }

  // Build virtual items
  var items = [];
  for (var j = 0; j < normalSessions.length; j++) {
    items.push({ type: "session", data: normalSessions[j], lastActivity: normalSessions[j].lastActivity || 0 });
  }
  var groupKeys = Object.keys(loopGroups);
  for (var k = 0; k < groupKeys.length; k++) {
    var gk = groupKeys[k];
    var children = loopGroups[gk];
    var realLoopId = children[0].loop.loopId;
    var maxActivity = 0;
    for (var m = 0; m < children.length; m++) {
      var act = children[m].lastActivity || 0;
      if (act > maxActivity) maxActivity = act;
    }
    items.push({ type: "loop", loopId: realLoopId, groupKey: gk, children: children, lastActivity: maxActivity });
  }

  // Sort by lastActivity descending
  items.sort(function (a, b) {
    var aBookmarked = !!(a.type === "loop" ? false : a.data && a.data.bookmarked);
    var bBookmarked = !!(b.type === "loop" ? false : b.data && b.data.bookmarked);
    if (aBookmarked !== bBookmarked) return aBookmarked ? -1 : 1;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });

  var bookmarkedItems = [];
  var regularItems = [];
  for (var n = 0; n < items.length; n++) {
    var item = items[n];
    if (item.type === "session" && item.data && item.data.bookmarked) {
      bookmarkedItems.push(item);
    } else {
      regularItems.push(item);
    }
  }

  if (bookmarkedItems.length > 0) {
    var bookmarkedHeader = document.createElement("div");
    bookmarkedHeader.className = "mobile-sheet-group";
    bookmarkedHeader.textContent = "Favorites";
    container.appendChild(bookmarkedHeader);

    for (var bi = 0; bi < bookmarkedItems.length; bi++) {
      container.appendChild(createMobileSessionItem(bookmarkedItems[bi].data));
    }

    // Thin rule separating favorites from the rest of the session list
    if (regularItems.length > 0) {
      var favDivider = document.createElement("hr");
      favDivider.className = "mobile-sheet-divider";
      container.appendChild(favDivider);
    }
  }

  var currentGroup = "";
  for (var ri = 0; ri < regularItems.length; ri++) {
    var item = regularItems[ri];
    var group = getDateGroup(item.lastActivity || 0);
    if (group !== currentGroup) {
      currentGroup = group;
      if (group !== "Today") {
        var header = document.createElement("div");
        header.className = "mobile-sheet-group";
        header.textContent = group;
        container.appendChild(header);
      }
    }
    if (item.type === "loop") {
      container.appendChild(createMobileLoopGroup(item.loopId, item.children, item.groupKey));
    } else {
      container.appendChild(createMobileSessionItem(item.data));
    }
  }
}

// Refresh mobile chat sheet when session data updates (called from renderSessionList)
export function refreshMobileChatSheet() {
  if (!mobileChatSheetOpen) return;
  var sheet = document.getElementById("mobile-sheet");
  if (!sheet || sheet.classList.contains("hidden")) {
    mobileChatSheetOpen = false;
    return;
  }
  var sessionListEl = sheet.querySelector(".mobile-chat-session-list");
  if (!sessionListEl) return;

  // Update chips: active state and processing dots
  var chips = sheet.querySelectorAll(".mobile-chat-chip");
  for (var i = 0; i < chips.length; i++) {
    var chip = chips[i];
    chip.classList.remove("active");

    // Update active state
    var isDmActive = !!getCurrentDmUserId();
    if (chip.dataset.type === "project" && chip.dataset.slug === getCachedCurrentSlug() && !isDmActive) {
      chip.classList.add("active");
    } else if (chip.dataset.type === "mate" && chip.dataset.mateId === getCurrentDmUserId()) {
      chip.classList.add("active");
    }

    // Update processing dot: same class as icon strip
    var statusDot = chip.querySelector(".icon-strip-status");
    if (statusDot) {
      var isProcessing = false;
      var allProjects = getCachedProjects() || [];
      var lookupSlug = chip.dataset.type === "mate" ? ("mate-" + chip.dataset.mateId) : chip.dataset.slug;
      for (var pi = 0; pi < allProjects.length; pi++) {
        if (allProjects[pi].slug === lookupSlug && allProjects[pi].isProcessing) {
          isProcessing = true;
          break;
        }
      }
      statusDot.classList.toggle("processing", isProcessing);
    }
  }

  // Re-render sessions for current context
  sessionListEl.innerHTML = "";
  if (getCurrentDmUserId()) {
    renderMateMobileActions(sessionListEl);
  } else {
    renderMobileSessionsInto(sessionListEl);
  }

  refreshIcons();
}

function renderSheetMateProfile(listEl) {
  if (!mobileSheetMateData) return;
  var data = mobileSheetMateData;

  // Profile header
  var header = document.createElement("div");
  header.className = "mate-profile-header";

  var avatar = document.createElement("img");
  avatar.className = "mate-profile-avatar";
  avatar.src = data.avatarUrl || "";
  avatar.alt = data.displayName || "";
  header.appendChild(avatar);

  var info = document.createElement("div");
  info.className = "mate-profile-info";
  var nameEl = document.createElement("div");
  nameEl.className = "mate-profile-name";
  nameEl.textContent = data.displayName || "";
  info.appendChild(nameEl);
  if (data.description) {
    var descEl = document.createElement("div");
    descEl.className = "mate-profile-desc";
    descEl.textContent = data.description;
    info.appendChild(descEl);
  }
  header.appendChild(info);
  listEl.appendChild(header);

  // Action buttons
  var actions = [
    { icon: "sticky-note", label: "Sticky Notes", btnId: "sticky-notes-sidebar-btn", countId: "sticky-notes-sidebar-count" },
    { icon: "puzzle", label: "Skills", btnId: "skills-btn" },
    { icon: "calendar", label: "Scheduled Tasks", btnId: "scheduler-btn" }
  ];

  for (var i = 0; i < actions.length; i++) {
    (function (action) {
      var btn = document.createElement("button");
      btn.className = "mate-profile-action";
      var countHtml = "";
      if (action.countId) {
        var countEl = document.getElementById(action.countId);
        if (countEl && !countEl.classList.contains("hidden") && countEl.textContent) {
          countHtml = '<span class="mate-profile-action-count">' + escapeHtml(countEl.textContent) + '</span>';
        }
      }
      btn.innerHTML = '<i data-lucide="' + action.icon + '"></i><span>' + action.label + '</span>' + countHtml;
      btn.addEventListener("click", function () {
        closeMobileSheet();
        var targetBtn = document.getElementById(action.btnId);
        if (targetBtn) {
          setTimeout(function () { targetBtn.click(); }, 250);
        }
      });
      listEl.appendChild(btn);
    })(actions[i]);
  }
}

function renderSheetSearch(listEl) {
  // Search input at top
  var wrap = document.createElement("div");
  wrap.className = "mobile-search-input-wrap";
  var input = document.createElement("input");
  input.className = "mobile-search-input";
  input.type = "text";
  input.placeholder = "Search sessions, messages...";
  input.autocomplete = "off";
  input.spellcheck = false;
  wrap.appendChild(input);
  listEl.appendChild(wrap);

  // Results container
  var resultsEl = document.createElement("div");
  resultsEl.style.padding = "0 8px";
  listEl.appendChild(resultsEl);

  // Auto-focus
  setTimeout(function () { input.focus(); }, 300);

  // Show all sessions initially
  renderSearchResults(resultsEl, "");

  input.addEventListener("input", function () {
    var q = input.value.trim().toLowerCase();
    renderSearchResults(resultsEl, q);
  });
  input.addEventListener("keydown", function (e) { e.stopPropagation(); });
  input.addEventListener("keyup", function (e) { e.stopPropagation(); });
  input.addEventListener("keypress", function (e) { e.stopPropagation(); });
}

function renderSearchResults(container, query) {
  container.innerHTML = "";
  var sorted = getCachedSessions().slice().sort(function (a, b) {
    if (!!a.bookmarked !== !!b.bookmarked) return a.bookmarked ? -1 : 1;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });

  var found = 0;
  for (var i = 0; i < sorted.length; i++) {
    var s = sorted[i];
    var title = s.title || "New Session";
    if (query && title.toLowerCase().indexOf(query) === -1) continue;
    found++;

    var el = document.createElement("button");
    el.className = "mobile-session-item";
    if (s.active) el.classList.add("active");

    var titleSpan = document.createElement("span");
    titleSpan.className = "mobile-session-title";
    titleSpan.appendChild(document.createTextNode(title));
    el.appendChild(titleSpan);

    if (s.isProcessing) {
      var dot = document.createElement("span");
      dot.className = "mobile-session-processing";
      el.appendChild(dot);
    }

    (function (id) {
      el.addEventListener("click", function () {
        if (getWs() && store.get('connected')) {
          getWs().send(JSON.stringify({ type: "switch_session", id: id }));
        }
        if (dismissOverlayPanels) dismissOverlayPanels();
        closeMobileSheet();
      });
    })(s.id);

    container.appendChild(el);
  }

  if (found === 0 && query) {
    var empty = document.createElement("div");
    empty.className = "mobile-alert-empty";
    empty.textContent = 'No results for "' + query + '"';
    container.appendChild(empty);
  }
}

function renderSheetMore(listEl) {
  function addDivider() {
    var hr = document.createElement("div");
    hr.className = "mobile-sheet-divider";
    listEl.appendChild(hr);
  }

  function addItem(icon, label, handler) {
    var btn = document.createElement("button");
    btn.className = "mobile-more-item";
    btn.innerHTML = '<i data-lucide="' + icon + '"></i><span class="mobile-more-item-label">' + label + '</span>';
    btn.addEventListener("click", handler);
    listEl.appendChild(btn);
    return btn;
  }

  function addInlineRow(icon, label, valueText) {
    var row = document.createElement("div");
    row.className = "mobile-more-item mobile-more-inline-row";
    row.innerHTML = '<i data-lucide="' + icon + '"></i><span class="mobile-more-item-label">' + label + '</span>'
      + '<span class="mobile-more-inline-value">' + valueText + '</span>';
    listEl.appendChild(row);
    return row;
  }

  // --- Section 1: Tools (driven from SESSION_TOOLS registry) ---
  // File browser and terminal need special mobile handlers; everything
  // else is proxied through the palette button ID.
  addItem("folder-tree", "Files", function () {
    closeMobileSheet();
    setTimeout(function () { openMobileSheet("files"); }, 250);
  });
  addItem("square-terminal", "Terminal", function () {
    closeMobileSheet();
    openTerminal();
  });
  var sessionTools = getSessionTools();
  var SPECIAL_IDS = { "file-browser-btn": true, "terminal-sidebar-btn": true };
  for (var ti = 0; ti < sessionTools.length; ti++) {
    (function (tool) {
      if (SPECIAL_IDS[tool.id]) return;
      addItem(tool.icon, tool.label, function () {
        closeMobileSheet();
        var btn = document.getElementById(tool.id);
        if (btn) setTimeout(function () { btn.click(); }, 250);
      });
    })(sessionTools[ti]);
  }

  addDivider();

  // --- Section 2: Project & Server ---
  addItem("folder-cog", "Project Settings", function () {
    closeMobileSheet();
    setTimeout(function () {
      var proj = null;
      for (var pi = 0; pi < getCachedProjectList().length; pi++) {
        if (getCachedProjectList()[pi].slug === getCachedCurrentSlug()) {
          proj = getCachedProjectList()[pi];
          break;
        }
      }
      if (proj && store.get('ownerLocked')) proj = Object.assign({}, proj, { ownerLocked: true });
      openProjectSettings(getCachedCurrentSlug(), proj);
    }, 250);
  });
  addItem("settings", "Server Settings", function () {
    closeMobileSheet();
    var btn = document.getElementById("server-settings-btn");
    if (btn) setTimeout(function () { btn.click(); }, 250);
  });

  addDivider();

  // --- Section 3: Appearance ---

  // Dark mode — real toggle switch
  var isDark = getCurrentTheme().variant === "dark";
  var themeRow = document.createElement("div");
  themeRow.className = "mobile-more-item mobile-more-toggle-row";

  var themeLeft = document.createElement("span");
  themeLeft.className = "mobile-more-toggle-left";
  themeLeft.innerHTML = '<i data-lucide="' + (isDark ? "moon" : "sun") + '"></i><span class="mobile-more-item-label">Dark mode</span>';
  themeRow.appendChild(themeLeft);

  var toggleWrap = document.createElement("label");
  toggleWrap.className = "mobile-settings-theme-toggle";
  var toggleInput = document.createElement("input");
  toggleInput.type = "checkbox";
  toggleInput.checked = isDark;
  var toggleThumb = document.createElement("span");
  toggleThumb.className = "mobile-settings-theme-thumb";
  toggleWrap.appendChild(toggleInput);
  toggleWrap.appendChild(toggleThumb);
  themeRow.appendChild(toggleWrap);
  listEl.appendChild(themeRow);

  toggleInput.addEventListener("change", function () {
    toggleDarkMode();
    setTimeout(function () {
      var nowDark = getCurrentTheme().variant === "dark";
      toggleInput.checked = nowDark;
      themeLeft.innerHTML = '<i data-lucide="' + (nowDark ? "moon" : "sun") + '"></i><span class="mobile-more-item-label">Dark mode</span>';
      refreshIcons();
    }, 50);
  });

  // Chat layout — inline selector showing current value
  var currentLayout = getChatLayout();
  var layoutRow = addInlineRow("layout-panel-left", "Chat layout", currentLayout === "bubble" ? "Bubble" : "Channel");
  layoutRow.style.cursor = "pointer";
  layoutRow.addEventListener("click", function () {
    var next = getChatLayout() === "bubble" ? "channel" : "bubble";
    setChatLayout(next);
    fetch('/api/user/chat-layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: next })
    });
    var valEl = layoutRow.querySelector(".mobile-more-inline-value");
    if (valEl) valEl.textContent = next === "bubble" ? "Bubble" : "Channel";
  });

  // Brand — inline selector showing current value
  var currentBrand = getBrand();
  var brandRow = addInlineRow("palette", "Brand", currentBrand === "clagentic" ? "Clagentic" : "Classic");
  brandRow.style.cursor = "pointer";
  brandRow.addEventListener("click", function () {
    var nb = getBrand() === "classic" ? "clagentic" : "classic";
    setBrand(nb);
    var valEl = brandRow.querySelector(".mobile-more-inline-value");
    if (valEl) valEl.textContent = nb === "clagentic" ? "Clagentic" : "Classic";
    refreshIcons();
  });

  // --- Section 4: App ---
  if (!document.documentElement.classList.contains("pwa-standalone")) {
    addDivider();
    addItem("smartphone", "Open as app", function () {
      closeMobileSheet();
      var installPill = document.getElementById("pwa-install-pill");
      if (installPill) setTimeout(function () { installPill.click(); }, 250);
    });
  }
}

export function initSidebarMobile() {

  // --- Mobile sheet close handlers ---
  var mobileSheet = document.getElementById("mobile-sheet");
  if (mobileSheet) {
    var sheetBackdrop = mobileSheet.querySelector(".mobile-sheet-backdrop");
    var sheetCloseBtn = mobileSheet.querySelector(".mobile-sheet-close");
    if (sheetBackdrop) sheetBackdrop.addEventListener("click", closeMobileSheet);
    if (sheetCloseBtn) sheetCloseBtn.addEventListener("click", closeMobileSheet);

    // --- Drag to dismiss sheet ---
    var sheetHandle = mobileSheet.querySelector(".mobile-sheet-handle");
    var sheetContent = mobileSheet.querySelector(".mobile-sheet-content");
    if (sheetHandle && sheetContent) {
      var dragStartY = 0;
      var dragging = false;

      sheetHandle.addEventListener("touchstart", function (e) {
        dragStartY = e.touches[0].clientY;
        dragging = true;
        sheetContent.style.transition = "none";
      }, { passive: true });

      mobileSheet.addEventListener("touchmove", function (e) {
        if (!dragging) return;
        var deltaY = e.touches[0].clientY - dragStartY;
        if (deltaY < 0) deltaY = 0;
        sheetContent.style.transform = "translateY(" + deltaY + "px)";
        if (sheetBackdrop) {
          var opacity = Math.max(0, 1 - deltaY / (sheetContent.offsetHeight * 0.5));
          sheetBackdrop.style.opacity = opacity;
        }
      }, { passive: true });

      mobileSheet.addEventListener("touchend", function () {
        if (!dragging) return;
        dragging = false;
        var currentY = parseFloat(sheetContent.style.transform.replace(/[^0-9.-]/g, "")) || 0;
        var threshold = sheetContent.offsetHeight * 0.3;

        if (currentY > threshold) {
          sheetContent.style.transition = "transform 0.22s ease-in";
          sheetContent.style.transform = "translateY(100%)";
          if (sheetBackdrop) {
            sheetBackdrop.style.transition = "opacity 0.22s ease-in";
            sheetBackdrop.style.opacity = "0";
          }
          setTimeout(function () {
            sheetContent.style.transition = "";
            sheetContent.style.transform = "";
            if (sheetBackdrop) {
              sheetBackdrop.style.transition = "";
              sheetBackdrop.style.opacity = "";
            }
            // Close without animation since we already animated
            var sheet = document.getElementById("mobile-sheet");
            if (sheet) {
              if (sheet.classList.contains("sheet-files")) {
                var fileTree = document.getElementById("file-tree");
                var sidebarFilesPanel = document.getElementById("sidebar-panel-files");
                if (fileTree && sidebarFilesPanel) {
                  sidebarFilesPanel.appendChild(fileTree);
                }
              }
              sheet.classList.add("hidden");
              sheet.classList.remove("closing", "sheet-files");
            }
          }, 230);
        } else {
          sheetContent.style.transition = "transform 0.2s ease-out";
          sheetContent.style.transform = "translateY(0)";
          if (sheetBackdrop) {
            sheetBackdrop.style.transition = "opacity 0.2s ease-out";
            sheetBackdrop.style.opacity = "";
          }
          setTimeout(function () {
            sheetContent.style.transition = "";
            sheetContent.style.transform = "";
            if (sheetBackdrop) {
              sheetBackdrop.style.transition = "";
              sheetBackdrop.style.opacity = "";
            }
          }, 200);
        }
      }, { passive: true });
    }
  }

  // --- Mobile tab bar ---
  var mobileTabBar = document.getElementById("mobile-tab-bar");
  var mobileTabs = mobileTabBar ? mobileTabBar.querySelectorAll(".mobile-tab") : [];
  var mobileHomeBtn = document.getElementById("mobile-home-btn");

  function setMobileTabActive(tabName) {
    for (var i = 0; i < mobileTabs.length; i++) {
      if (mobileTabs[i].dataset.tab === tabName) {
        mobileTabs[i].classList.add("active");
      } else {
        mobileTabs[i].classList.remove("active");
      }
    }
    if (mobileHomeBtn) {
      if (tabName === "home") {
        mobileHomeBtn.classList.add("active");
      } else {
        mobileHomeBtn.classList.remove("active");
      }
    }
  }

  for (var t = 0; t < mobileTabs.length; t++) {
    (function (tab) {
      tab.addEventListener("click", function () {
        var name = tab.dataset.tab;

        if (name === "projects") {
          openMobileSheet("projects");
          setMobileTabActive("projects");
        } else if (name === "chat") {
          openMobileSheet("sessions");
          setMobileTabActive("chat");
        } else if (name === "search") {
          openCommandPalette();
          setMobileTabActive("search");
        } else if (name === "more") {
          openMobileSheet("more");
          setMobileTabActive("more");
        }
      });
    })(mobileTabs[t]);
  }

  if (mobileHomeBtn) {
    mobileHomeBtn.addEventListener("click", function () {
      closeSidebar();
      setMobileTabActive("home");
      showHomeHub();
    });
  }
}

// Update the Projects tab unread badge with total across all projects
export function updateMobileProjectsTabBadge(projects) {
  var badge = document.querySelector("#mob-tab-projects .mobile-tab-projects-badge");
  if (!badge) return;
  var total = 0;
  for (var i = 0; i < projects.length; i++) {
    total += (projects[i].unread || 0);
  }
  if (total > 0) {
    badge.textContent = total > 99 ? "99+" : String(total);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}
