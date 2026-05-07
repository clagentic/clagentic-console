import { closeArchive } from './sticky-notes.js';
import { closeScheduler } from './scheduler.js';
import { initSidebarSessions } from './sidebar-sessions.js';
import { focusFileTree } from './filebrowser.js';
import { initSidebarProjects, closeProjectCtxMenu } from './sidebar-projects.js';
import {
  showIconTooltip,
  showIconTooltipHtml,
  hideIconTooltip,
  closeUserCtxMenu,
  getCurrentDmUserId
} from './sidebar-users.js';
import { initSidebarMobile } from './sidebar-mobile.js';

var ctx;
var _syncResizeHandles = null;

export function syncResizeHandles() {
  if (_syncResizeHandles) _syncResizeHandles();
}

export function dismissOverlayPanels() {
  closeArchive();
  closeScheduler();
}

export function updatePageTitle() {
  var sessionTitle = "";
  var activeItem = ctx.sessionListEl.querySelector(".session-item.active .session-item-text");
  if (activeItem) sessionTitle = activeItem.textContent;
  if (ctx.headerTitleEl) {
    ctx.headerTitleEl.textContent = sessionTitle || ctx.projectName || "Clay";
  }
  var tbProjectName = ctx.$("title-bar-project-name");
  if (tbProjectName && ctx.projectName) {
    tbProjectName.textContent = ctx.projectName;
  } else if (tbProjectName && !tbProjectName.textContent) {
    // Fallback: derive name from URL slug when projectName not yet available
    var _m = location.pathname.match(/^\/p\/([a-z0-9_-]+)/);
    if (_m) tbProjectName.textContent = _m[1];
  }
  if (ctx.projectName && sessionTitle) {
    document.title = sessionTitle + " - " + ctx.projectName;
  } else if (ctx.projectName) {
    document.title = ctx.projectName + " - Clay";
  } else {
    document.title = "Clay";
  }
}

export function openSidebar() {
  ctx.sidebar.classList.add("open");
  ctx.sidebarOverlay.classList.add("visible");
}

export function closeSidebar() {
  ctx.sidebar.classList.remove("open");
  ctx.sidebarOverlay.classList.remove("visible");
}

export function initSidebar(_ctx) {
  ctx = _ctx;

  // Initialize sidebar sub-modules (they import their own deps directly)
  initSidebarSessions();
  initSidebarProjects();
  initSidebarMobile();

  ctx.hamburgerBtn.addEventListener("click", function () {
    ctx.sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
  });

  ctx.sidebarOverlay.addEventListener("click", closeSidebar);

  // --- Desktop sidebar collapse/expand ---
  function toggleSidebarCollapse() {
    var layout = ctx.$("layout");
    var collapsed = layout.classList.toggle("sidebar-collapsed");
    try { localStorage.setItem("sidebar-collapsed", collapsed ? "1" : ""); } catch (e) {}
    setTimeout(function () { syncUserIslandWidth(); syncResizeHandle(); }, 210);
  }

  if (ctx.sidebarToggleBtn) ctx.sidebarToggleBtn.addEventListener("click", toggleSidebarCollapse);
  if (ctx.sidebarExpandBtn) ctx.sidebarExpandBtn.addEventListener("click", toggleSidebarCollapse);
  // Restore collapsed state from localStorage
  try {
    if (localStorage.getItem("sidebar-collapsed") === "1") {
      ctx.$("layout").classList.add("sidebar-collapsed");
    }
  } catch (e) {}

  if (ctx.newSessionBtn) {
    ctx.newSessionBtn.addEventListener("click", function () {
      if (ctx.ws && ctx.connected) {
        ctx.ws.send(JSON.stringify({ type: "new_session" }));
        closeSidebar();
      }
    });
  }

  // --- Loop (Ralph wizard) tool-palette tile ---
  // The tile is rendered by tool-palette.js at the stable id
  // "loop-tool-btn"; we just wire the click to the wizard opener
  // the same way the old header pill did.
  var loopBtn = ctx.$("loop-tool-btn");
  if (loopBtn) {
    loopBtn.addEventListener("click", function () {
      if (ctx.openRalphWizard) ctx.openRalphWizard();
    });
  }

  // --- Panel switch (sessions / files / projects) ---
  var fileBrowserBtn = ctx.$("file-browser-btn");
  var projectsPanel = ctx.$("sidebar-panel-projects");
  var sessionsPanel = ctx.$("sidebar-panel-sessions");
  var filesPanel = ctx.$("sidebar-panel-files");
  var sessionsHeaderContent = ctx.$("sessions-header-content");
  var filePanelClose = ctx.$("file-panel-close");

  function hideAllPanels() {
    if (projectsPanel) projectsPanel.classList.add("hidden");
    if (sessionsPanel) sessionsPanel.classList.add("hidden");
    if (filesPanel) filesPanel.classList.add("hidden");
    if (sessionsHeaderContent) sessionsHeaderContent.classList.add("hidden");
  }

  function showProjectsPanel() {
    hideAllPanels();
    if (projectsPanel) projectsPanel.classList.remove("hidden");
  }

  function showSessionsPanel() {
    hideAllPanels();
    if (sessionsPanel) sessionsPanel.classList.remove("hidden");
    if (sessionsHeaderContent) sessionsHeaderContent.classList.remove("hidden");
  }

  function showFilesPanel() {
    hideAllPanels();
    if (filesPanel) {
      filesPanel.classList.remove("hidden");
      filesPanel.classList.remove("fb-exit");
      filesPanel.classList.add("fb-enter");
    }
    if (ctx.onFilesTabOpen) ctx.onFilesTabOpen();
    // Hand focus to the file tree so arrow keys work immediately
    // after the panel opens (no click-to-focus extra step).
    requestAnimationFrame(function () { focusFileTree(); });
  }

  function hideFilesPanel(cb) {
    if (!filesPanel || filesPanel.classList.contains("hidden")) { if (cb) cb(); return; }
    filesPanel.classList.remove("fb-enter");
    filesPanel.classList.add("fb-exit");
    function onDone() {
      filesPanel.removeEventListener("animationend", onDone);
      filesPanel.classList.remove("fb-exit");
      filesPanel.classList.add("hidden");
      if (cb) cb();
    }
    filesPanel.addEventListener("animationend", onDone);
  }

  if (fileBrowserBtn) {
    // Clicking the tile toggles: open if closed, close (back to sessions)
    // if it's already the visible panel. Same behavior via the Cmd+O
    // hotkey since that calls .click().
    fileBrowserBtn.addEventListener("click", function () {
      if (filesPanel && !filesPanel.classList.contains("hidden")) {
        hideFilesPanel(function () { showSessionsPanel(); });
      } else {
        showFilesPanel();
      }
    });
  }
  if (filePanelClose) {
    filePanelClose.addEventListener("click", function() {
      hideFilesPanel(function() {
        showSessionsPanel();
      });
    });
  }

  // --- User island width sync ---
  var userIsland = document.getElementById("user-island");
  var sidebarColumn = document.getElementById("sidebar-column");

  function syncUserIslandWidth() {
    if (!userIsland) return;
    var col = sidebarColumn;
    if (!col) return;
    var rect = col.getBoundingClientRect();
    userIsland.style.width = (rect.right - 8 - 8) + "px";
  }

  // --- Sidebar resize handle ---
  var resizeHandle = document.getElementById("sidebar-resize-handle");

  function syncResizeHandle() {
    if (!resizeHandle || !sidebarColumn) return;
    var rect = sidebarColumn.getBoundingClientRect();
    var parentRect = sidebarColumn.parentElement.getBoundingClientRect();
    resizeHandle.style.left = (rect.right - parentRect.left) + "px";
  }

  if (resizeHandle && sidebarColumn) {
    var dragging = false;

    function onResizeMove(e) {
      if (!dragging) return;
      e.preventDefault();
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      var iconStrip = document.getElementById("icon-strip");
      var stripWidth = iconStrip ? iconStrip.offsetWidth : 72;
      var newWidth = clientX - stripWidth;
      if (newWidth < 192) newWidth = 192;
      if (newWidth > 320) newWidth = 320;
      sidebarColumn.style.width = newWidth + "px";
      syncResizeHandle();
      syncUserIslandWidth();
    }

    function onResizeEnd() {
      if (!dragging) return;
      dragging = false;
      resizeHandle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onResizeMove);
      document.removeEventListener("mouseup", onResizeEnd);
      document.removeEventListener("touchmove", onResizeMove);
      document.removeEventListener("touchend", onResizeEnd);
      try { localStorage.setItem("sidebar-width", sidebarColumn.style.width); } catch (e) {}
    }

    function onResizeStart(e) {
      e.preventDefault();
      dragging = true;
      resizeHandle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onResizeMove);
      document.addEventListener("mouseup", onResizeEnd);
      document.addEventListener("touchmove", onResizeMove, { passive: false });
      document.addEventListener("touchend", onResizeEnd);
    }

    resizeHandle.addEventListener("mousedown", onResizeStart);
    resizeHandle.addEventListener("touchstart", onResizeStart, { passive: false });

    // Restore saved width (skip transition so user-island syncs immediately)
    try {
      var savedWidth = localStorage.getItem("sidebar-width");
      if (savedWidth) {
        var px = parseInt(savedWidth, 10);
        if (px >= 192 && px <= 320) {
          sidebarColumn.style.transition = "none";
          sidebarColumn.style.width = px + "px";
          sidebarColumn.offsetWidth; // force reflow
          sidebarColumn.style.transition = "";
        }
      }
    } catch (e) {}

    syncResizeHandle();
    syncUserIslandWidth();
  }

  // Expose for external callers (e.g. after DM exit)
  _syncResizeHandles = ctx.syncResizeHandles = function () {
    // Restore project sidebar width from localStorage (may have changed during DM)
    try {
      var sw = localStorage.getItem("sidebar-width");
      if (sw && sidebarColumn) {
        var px = parseInt(sw, 10);
        if (px >= 192 && px <= 320) {
          sidebarColumn.style.width = px + "px";
          sidebarColumn.offsetWidth; // force reflow
        }
      }
    } catch (e) {}
    // Defer handle sync to next frame so layout settles after display changes
    requestAnimationFrame(function () {
      syncResizeHandle();
      syncMateResizeHandle();
      syncUserIslandWidth();
    });
  };

  // Initial sync even if no resize handle
  syncUserIslandWidth();

  // --- User island tooltip on hover (collapsed sidebar) ---
  if (userIsland) {
    var profileArea = userIsland.querySelector(".user-island-profile");
    if (profileArea) {
      profileArea.addEventListener("mouseenter", function () {
        var layout = document.getElementById("layout");
        if (!layout || !layout.classList.contains("sidebar-collapsed")) return;
        var nameEl = userIsland.querySelector(".user-island-name");
        var text = nameEl ? nameEl.textContent : "";
        if (text) showIconTooltip(profileArea, text);
      });
      profileArea.addEventListener("mouseleave", function () {
        hideIconTooltip();
      });
    }
  }

}

export function spawnDustParticles(cx, cy) {
  var colors = ["#8B7355", "#A0522D", "#D2B48C", "#C4A882", "#9E9E9E", "#B8860B", "#BC8F8F"];
  var count = 24;
  var container = document.createElement("div");
  container.style.position = "fixed";
  container.style.top = "0";
  container.style.left = "0";
  container.style.width = "0";
  container.style.height = "0";
  container.style.pointerEvents = "none";
  container.style.zIndex = "10000";
  document.body.appendChild(container);

  for (var i = 0; i < count; i++) {
    var dot = document.createElement("div");
    dot.className = "dust-particle";
    var size = 3 + Math.random() * 5;
    var angle = Math.random() * Math.PI * 2;
    var dist = 30 + Math.random() * 60;
    var dx = Math.cos(angle) * dist;
    var dy = Math.sin(angle) * dist - 20; // bias upward
    var duration = 600 + Math.random() * 500;

    dot.style.width = size + "px";
    dot.style.height = size + "px";
    dot.style.left = cx + "px";
    dot.style.top = cy + "px";
    dot.style.background = colors[Math.floor(Math.random() * colors.length)];
    dot.style.setProperty("--dust-x", dx + "px");
    dot.style.setProperty("--dust-y", dy + "px");
    dot.style.setProperty("--dust-duration", duration + "ms");

    container.appendChild(dot);
  }

  setTimeout(function () { container.remove(); }, 1200);
}
