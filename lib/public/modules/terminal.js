import { iconHtml, refreshIcons } from './icons.js';
import { closeSidebar } from './sidebar.js';
import { closeFileViewer } from './filebrowser.js';
import { copyToClipboard } from './utils.js';
import { getTerminalTheme } from './theme.js';
import { positionAtPoint } from './popover-position.js';
import { createMultiLineLinkProvider, copyTextForSelection } from './terminal-links.js';
import { store } from './store.js';
import { vendorEntry } from './vendor-registry.js';
import { createLoginTab } from './login-tab.js';

var ctx;
var tabs = new Map(); // termId -> { id, title, exited, xterm, fitAddon, bodyEl }
var activeTabId = null;
var isOpen = false;
var ctrlActive = false;
var altActive = false;
var isTouchDevice = "ontouchstart" in window;
var viewportHandler = null;
var resizeObserver = null;
// termId -> sign-in panel controller. Present only for the terminal that
// startLoginCommand opened; every other terminal's output is never parsed.
var loginTabs = new Map();

function closeLoginTab(termId) {
  var login = loginTabs.get(termId);
  if (!login) return;
  login.close();
  loginTabs.delete(termId);
}

function loginIdentity() {
  if (store.get('isOsUsers')) return "os-users";
  return store.get('isMultiUserMode') ? "shared" : "";
}

/**
 * Marks a terminal as the login tab for an agent, so its output feeds the
 * sign-in panel. Called once, for the terminal the login command was typed into.
 * @param {string} termId
 * @param {string} vendorId
 */
export function markLoginTerminal(termId, vendorId) {
  if (!termId) return;
  var entry = vendorEntry(vendorId);
  if (!entry || !entry.loginPatterns) return;
  closeLoginTab(termId);
  loginTabs.set(termId, createLoginTab({
    patterns: entry.loginPatterns,
    vendorName: entry.displayName,
    identity: loginIdentity(),
    sendCode: function (text) { sendTerminalInput(termId, text); },
    copy: copyToClipboard,
    openLink: function (url) { window.open(url, "_blank", "noopener"); },
    mount: function (panelEl) {
      ctx.terminalContainerEl.insertBefore(panelEl, ctx.terminalBodyEl);
    },
  }));
  syncLoginPanels();
}

function syncLoginPanels() {
  for (var entry of loginTabs.entries()) entry[1].setActive(entry[0] === activeTabId);
}

function disposeTab(tab) {
  closeLoginTab(tab.id);
  if (tab._webglAddon) {
    try { tab._webglAddon.dispose(); } catch (e) {}
    tab._webglAddon = null;
  }
  if (tab.xterm) {
    tab.xterm.dispose();
    tab.xterm = null;
  }
  tab.fitAddon = null;
  if (tab.bodyEl && tab.bodyEl.parentNode) {
    tab.bodyEl.parentNode.removeChild(tab.bodyEl);
    tab.bodyEl = null;
  }
}
var toolbarBound = false;
var termCtxMenu = null;

// --- Init ---
export function initTerminal(_ctx) {
  ctx = _ctx;

  // Close panel button
  document.getElementById("terminal-close").addEventListener("click", function () {
    closeTerminal();
  });

  // Fullscreen toggle
  document.getElementById("terminal-fullscreen").addEventListener("click", function () {
    var isFs = ctx.terminalContainerEl.classList.toggle("panel-fullscreen");
    var icon = this.querySelector("[data-lucide]");
    if (icon) {
      icon.setAttribute("data-lucide", isFs ? "minimize-2" : "maximize-2");
      refreshIcons();
    }
    fitTerminal();
  });

  // Header toggle button
  var toggleBtn = document.getElementById("terminal-toggle-btn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      if (isOpen && !ctx.terminalContainerEl.classList.contains("hidden")) {
        closeTerminal();
      } else {
        openTerminal();
      }
    });
  }

  // Sidebar terminal button — toggles open/close. Second click (or the
  // Cmd+O hotkey on the same tile) dismisses the terminal panel.
  var sidebarTermBtn = document.getElementById("terminal-sidebar-btn");
  if (sidebarTermBtn) {
    sidebarTermBtn.addEventListener("click", function () {
      if (isOpen && !ctx.terminalContainerEl.classList.contains("hidden")) {
        closeTerminal();
      } else {
        closeSidebar();
        openTerminal();
      }
    });
  }

  // New tab button
  var newTabBtn = document.getElementById("terminal-new-tab");
  if (newTabBtn) {
    newTabBtn.addEventListener("click", function () {
      createNewTab();
    });
  }
}

// --- Open terminal panel ---
export function openTerminal() {
  var container = ctx.terminalContainerEl;

  // Hide file viewer if open (also unwatches)
  closeFileViewer();

  container.classList.remove("hidden");
  isOpen = true;

  // If no tabs exist, create one
  if (tabs.size === 0) {
    createNewTab();
    return; // createNewTab will handle the rest via term_created
  }

  // Attach to active tab (or first available)
  if (!activeTabId || !tabs.has(activeTabId)) {
    activeTabId = tabs.keys().next().value;
  }

  activateTab(activeTabId);

  // Mobile: close sidebar and hide tab bar
  if (window.innerWidth <= 768) {
    closeSidebar();
    var mTabBar = document.getElementById("mobile-tab-bar");
    if (mTabBar) mTabBar.classList.add("keyboard-hidden");
  }

  refreshIcons();
}

// --- Close terminal panel (hide, detach, but keep PTYs alive) ---
export function closeTerminal() {
  var container = ctx.terminalContainerEl;
  container.classList.remove("panel-fullscreen");
  container.classList.add("hidden");
  // Reset fullscreen icon
  var fsIcon = document.querySelector("#terminal-fullscreen [data-lucide]");
  if (fsIcon) {
    fsIcon.setAttribute("data-lucide", "maximize-2");
    refreshIcons();
  }

  // Detach from active tab
  if (activeTabId && ctx.ws && ctx.connected) {
    ctx.ws.send(JSON.stringify({ type: "term_detach", id: activeTabId }));
  }

  cleanupListeners();

  // Hide toolbar
  var toolbar = document.getElementById("terminal-toolbar");
  if (toolbar) {
    toolbar.classList.add("hidden");
    var ctrlBtn = toolbar.querySelector("[data-key='ctrl']");
    if (ctrlBtn) ctrlBtn.classList.remove("active");
    var altBtn = toolbar.querySelector("[data-key='alt']");
    if (altBtn) altBtn.classList.remove("active");
  }
  ctrlActive = false;
  altActive = false;

  // Mobile: restore tab bar
  var mTabBar = document.getElementById("mobile-tab-bar");
  if (mTabBar) mTabBar.classList.remove("keyboard-hidden");

  isOpen = false;
}

// --- Create new tab ---
function createNewTab() {
  if (!ctx.ws || !ctx.connected) return;

  // Get current terminal body dimensions for cols/rows
  var cols = 80;
  var rows = 24;
  if (activeTabId && tabs.has(activeTabId)) {
    var activeTab = tabs.get(activeTabId);
    if (activeTab.xterm) {
      cols = activeTab.xterm.cols || 80;
      rows = activeTab.xterm.rows || 24;
    }
  }

  ctx.ws.send(JSON.stringify({ type: "term_create", cols: cols, rows: rows }));
}

// --- Close a tab (kill PTY) ---
function closeTab(termId) {
  if (!ctx.ws || !ctx.connected) return;
  ctx.ws.send(JSON.stringify({ type: "term_close", id: termId }));
}

// --- Activate a tab (show xterm, attach) ---
function activateTab(termId) {
  var tab = tabs.get(termId);
  if (!tab) return;

  // Detach from old active
  if (activeTabId && activeTabId !== termId && ctx.ws && ctx.connected) {
    ctx.ws.send(JSON.stringify({ type: "term_detach", id: activeTabId }));
  }

  // Hide all tab bodies
  for (var t of tabs.values()) {
    if (t.bodyEl) t.bodyEl.style.display = "none";
  }

  activeTabId = termId;
  syncLoginPanels();

  // Lazy-create xterm instance
  if (!tab.xterm) {
    createXtermForTab(tab);
  }

  // Show this tab's body
  if (tab.bodyEl) tab.bodyEl.style.display = "";

  // Attach to server
  if (ctx.ws && ctx.connected) {
    ctx.ws.send(JSON.stringify({ type: "term_attach", id: termId }));
  }

  // Fit and focus
  setupListeners();
  fitTerminal();
  // Re-fit after layout settles (flex may not have computed final size yet)
  setTimeout(fitTerminal, 50);

  if (tab.xterm) {
    tab.xterm.focus();
  }

  // Show toolbar on touch devices
  var toolbar = document.getElementById("terminal-toolbar");
  if (toolbar && isTouchDevice) {
    toolbar.classList.remove("hidden");
    initToolbar(toolbar);
  }

  // Mobile viewport handling
  if (window.visualViewport && !viewportHandler) {
    viewportHandler = function () {
      ctx.terminalContainerEl.style.height = window.visualViewport.height + "px";
      fitTerminal();
    };
    window.visualViewport.addEventListener("resize", viewportHandler);
  }

  renderTabBar();
}

// --- Create xterm.js instance for a tab ---
function createXtermForTab(tab) {
  if (typeof Terminal === "undefined") return;

  var xterm = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    theme: getTerminalTheme(),
  });

  var fitAddon = null;
  if (typeof FitAddon !== "undefined") {
    fitAddon = new FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
  }

  // Web links addon: make URLs clickable (single-line)
  if (typeof WebLinksAddon !== "undefined") {
    xterm.loadAddon(new WebLinksAddon.WebLinksAddon());
  }

  // Custom multi-line link provider: detect URLs that wrap across lines
  xterm.registerLinkProvider(createMultiLineLinkProvider(xterm, {
    onHover: function (url) { tab._hoverLink = url; },
    onLeave: function () { tab._hoverLink = null; },
  }));

  // Create a container div for this tab's terminal
  var bodyEl = document.createElement("div");
  bodyEl.className = "terminal-tab-body";
  ctx.terminalBodyEl.appendChild(bodyEl);

  xterm.open(bodyEl);

  // WebGL addon: pixel-perfect rendering (eliminates gaps in block characters)
  // Must be loaded after xterm.open() so the rendering context is available.
  if (typeof WebglAddon !== "undefined") {
    try {
      var webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(function () {
        webgl.dispose();
        tab._webglAddon = null;
      });
      xterm.loadAddon(webgl);
      tab._webglAddon = webgl;
    } catch (e) {
      // WebGL not available, fall back to DOM renderer
    }
  }

  // Route input to server. While scrollback is being replayed, xterm answers
  // the queries inside it (OSC 11 colour, DSR cursor position); those answers
  // belong to programs that already exited, so they must not reach the shell.
  xterm.onData(function (data) {
    if (tab._replaying > 0) return;
    if (ctx.ws && ctx.connected) {
      ctx.ws.send(JSON.stringify({ type: "term_input", id: tab.id, data: data }));
    }
  });

  // Keyboard paste is left to xterm's own paste listener (the key handler lets
  // the browser event through), so there is no separate body listener that
  // would send raw clipboard text.
  xterm.attachCustomKeyEventHandler(createKeyHandler(tab, xterm));

  // Right-click context menu
  bodyEl.addEventListener("contextmenu", function (e) {
    showTermCtxMenu(e, tab);
  });

  tab.xterm = xterm;
  tab.fitAddon = fitAddon;
  tab.bodyEl = bodyEl;
}

// --- Fit active terminal ---
var fitRafId = null;

function fitTerminal() {
  if (fitRafId) cancelAnimationFrame(fitRafId);
  fitRafId = requestAnimationFrame(function () {
    fitRafId = null;
    if (!activeTabId) return;
    var tab = tabs.get(activeTabId);
    if (!tab || !tab.fitAddon || !tab.xterm) return;

    try {
      tab.fitAddon.fit();
      if (ctx.ws && ctx.connected) {
        ctx.ws.send(JSON.stringify({
          type: "term_resize",
          id: activeTabId,
          cols: tab.xterm.cols,
          rows: tab.xterm.rows,
        }));
      }
    } catch (e) {}
  });
}

// --- Setup/cleanup resize listeners ---
function setupListeners() {
  cleanupListeners();

  window.addEventListener("resize", fitTerminal);

  if (typeof ResizeObserver !== "undefined" && ctx.terminalBodyEl) {
    resizeObserver = new ResizeObserver(function () {
      fitTerminal();
    });
    resizeObserver.observe(ctx.terminalBodyEl);
  }
}

function cleanupListeners() {
  window.removeEventListener("resize", fitTerminal);

  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }

  if (viewportHandler && window.visualViewport) {
    window.visualViewport.removeEventListener("resize", viewportHandler);
    viewportHandler = null;
  }
  ctx.terminalContainerEl.style.height = "";
}

// --- Render tab bar ---
function renderTabBar() {
  var tabsEl = document.getElementById("terminal-tabs");
  if (!tabsEl) return;

  tabsEl.innerHTML = "";

  for (var tab of tabs.values()) {
    (function (t) {
      var el = document.createElement("div");
      el.className = "terminal-tab";
      if (t.id === activeTabId) el.classList.add("active");
      if (t.exited) el.classList.add("exited");

      var label = document.createElement("span");
      label.className = "terminal-tab-label";
      label.textContent = t.title;
      el.appendChild(label);

      // Double-click label to rename
      label.addEventListener("dblclick", function (e) {
        e.stopPropagation();
        startRenameTab(t, label);
      });

      var moreBtn = document.createElement("button");
      moreBtn.className = "terminal-tab-more";
      moreBtn.innerHTML = '<i data-lucide="ellipsis" style="width:12px;height:12px"></i>';
      moreBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        showTabContextMenu(e, t, label);
      });
      el.appendChild(moreBtn);

      el.addEventListener("click", function () {
        if (t.id !== activeTabId) {
          activateTab(t.id);
        }
      });

      tabsEl.appendChild(el);
    })(tab);
  }

  updateTerminalBadge();
  refreshIcons();
}

// --- Tab context menu (three-dot) ---
function showTabContextMenu(e, tab, labelEl) {
  var existing = document.querySelector(".terminal-tab-ctx");
  if (existing) existing.remove();

  var menu = document.createElement("div");
  menu.className = "terminal-tab-ctx";

  var renameItem = document.createElement("button");
  renameItem.className = "terminal-tab-ctx-item";
  renameItem.innerHTML = '<i data-lucide="pencil" style="width:13px;height:13px"></i> Rename';
  renameItem.addEventListener("click", function () {
    menu.remove();
    startRenameTab(tab, labelEl);
  });
  menu.appendChild(renameItem);

  var closeItem = document.createElement("button");
  closeItem.className = "terminal-tab-ctx-item terminal-tab-ctx-danger";
  closeItem.innerHTML = '<i data-lucide="trash-2" style="width:13px;height:13px"></i> Close';
  closeItem.addEventListener("click", function () {
    menu.remove();
    closeTab(tab.id);
  });
  menu.appendChild(closeItem);

  document.body.appendChild(menu);
  refreshIcons();

  // Position near the button
  var rect = e.currentTarget.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + "px";
  menu.style.left = rect.left + "px";

  // Dismiss on outside click
  function dismiss(ev) {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("mousedown", dismiss, true);
    }
  }
  setTimeout(function () {
    document.addEventListener("mousedown", dismiss, true);
  }, 0);
}

// --- Rename tab inline ---
function startRenameTab(tab, labelEl) {
  var input = document.createElement("input");
  input.className = "terminal-tab-rename";
  input.value = tab.title;
  input.maxLength = 50;

  labelEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    var newTitle = input.value.trim();
    if (newTitle && newTitle !== tab.title) {
      tab.title = newTitle;
      if (ctx.ws && ctx.connected) {
        ctx.ws.send(JSON.stringify({ type: "term_rename", id: tab.id, title: newTitle }));
      }
    }
    renderTabBar();
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { input.blur(); }
    if (e.key === "Escape") {
      input.value = tab.title; // revert
      input.blur();
    }
    e.stopPropagation();
  });
}

// --- Update terminal count badge ---
function updateTerminalBadge() {
  var countEl = document.getElementById("terminal-count");
  var sidebarCountEl = document.getElementById("terminal-sidebar-count");

  var count = 0;
  for (var t of tabs.values()) {
    if (!t.exited) count++;
  }

  if (countEl) {
    if (count > 0) {
      countEl.textContent = count;
      countEl.classList.remove("hidden");
    } else {
      countEl.classList.add("hidden");
    }
  }

  if (sidebarCountEl) {
    if (count > 0) {
      sidebarCountEl.textContent = count;
      sidebarCountEl.classList.remove("hidden");
    } else {
      sidebarCountEl.classList.add("hidden");
    }
  }

  var mobileCountEl = document.getElementById("mobile-terminal-count");
  if (mobileCountEl) {
    if (count > 0) {
      mobileCountEl.textContent = count;
      mobileCountEl.classList.remove("hidden");
    } else {
      mobileCountEl.classList.add("hidden");
    }
  }
}

// --- Handle server messages ---

export function handleTermList(msg) {
  var serverTerminals = msg.terminals || [];
  var serverIds = new Set();

  // Add/update tabs from server list
  for (var i = 0; i < serverTerminals.length; i++) {
    var st = serverTerminals[i];
    serverIds.add(st.id);

    if (tabs.has(st.id)) {
      var existing = tabs.get(st.id);
      existing.title = st.title;
      existing.exited = st.exited;
    } else {
      tabs.set(st.id, {
        id: st.id,
        title: st.title,
        exited: st.exited,
        xterm: null,
        fitAddon: null,
        bodyEl: null,
      });
    }
  }

  // Remove tabs no longer on server
  for (var id of tabs.keys()) {
    if (!serverIds.has(id)) {
      var removed = tabs.get(id);
      disposeTab(removed);
      tabs.delete(id);
    }
  }

  // If active tab was removed, switch to first available
  if (activeTabId && !tabs.has(activeTabId)) {
    activeTabId = null;
  }

  renderTabBar();

  // If panel is open and we have tabs, re-attach
  if (isOpen && tabs.size > 0) {
    if (!activeTabId) {
      activeTabId = tabs.keys().next().value;
    }
    activateTab(activeTabId);
  }

  // If panel is open and all tabs are gone, close panel
  if (isOpen && tabs.size === 0) {
    closeTerminal();
  }
}

export function handleTermCreated(msg) {
  // Switch to the newly created tab
  if (msg.id && tabs.has(msg.id)) {
    activateTab(msg.id);
  }
}

export function handleTermOutput(msg) {
  if (!msg.id) return;
  var tab = tabs.get(msg.id);
  if (tab && tab.xterm && msg.data) {
    var login = loginTabs.get(msg.id);
    if (msg.replay) {
      // The replay is the whole scrollback: start from a clean screen so a live
      // xterm does not show its old output twice. Replies stay suppressed until
      // xterm has parsed the chunk (its write callback), which is when it emits them.
      tab.xterm.reset();
      tab._replaying = (tab._replaying || 0) + 1;
      tab.xterm.write(msg.data, function () {
        tab._replaying -= 1;
        if (login) login.feed(tab.xterm);
      });
    } else if (login) {
      // Read the buffer once xterm has parsed this chunk, not the raw bytes.
      tab.xterm.write(msg.data, function () { login.feed(tab.xterm); });
    } else {
      tab.xterm.write(msg.data);
    }
  }
}

export function handleTermResized(msg) {
  if (!msg.id) return;
  var tab = tabs.get(msg.id);
  if (tab && tab.xterm && msg.cols > 0 && msg.rows > 0) {
    tab.xterm.resize(msg.cols, msg.rows);
  }
}

export function handleTermExited(msg) {
  if (!msg.id) return;
  var tab = tabs.get(msg.id);
  if (tab) {
    tab.exited = true;
    closeLoginTab(msg.id);
    if (tab.xterm) {
      tab.xterm.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
    }
    renderTabBar();
  }
}

export function handleTermClosed(msg) {
  if (!msg.id) return;
  var tab = tabs.get(msg.id);
  if (tab) {
    disposeTab(tab);
    tabs.delete(msg.id);

    if (activeTabId === msg.id) {
      activeTabId = null;
      if (tabs.size > 0) {
        activeTabId = tabs.keys().next().value;
        activateTab(activeTabId);
      }
    }

    renderTabBar();

    // Close panel if no tabs left
    if (isOpen && tabs.size === 0) {
      closeTerminal();
    }
  }
}

// --- Reset on reconnect ---
export function resetTerminals() {
  // Dispose all xterm instances (server state survives, client re-syncs via term_list)
  for (var tab of tabs.values()) {
    disposeTab(tab);
  }
  tabs.clear();
  activeTabId = null;
  cleanupListeners();
  renderTabBar();
}

// Types text into one named terminal through the ordinary input message.
export function sendTerminalInput(termId, data) {
  if (!termId || !tabs.has(termId)) return;
  if (ctx.ws && ctx.connected) {
    ctx.ws.send(JSON.stringify({ type: "term_input", id: termId, data: data }));
  }
}

export function sendTerminalCommand(command) {
  sendTerminalInput(activeTabId, command);
}

export function setTerminalTheme(xtermTheme) {
  for (var tab of tabs.values()) {
    if (tab.xterm) {
      tab.xterm.options.theme = xtermTheme;
    }
  }
}

// --- Terminal context menu ---
function closeTermCtxMenu() {
  if (termCtxMenu) {
    termCtxMenu.remove();
    termCtxMenu = null;
  }
}

function showTermCtxMenu(e, tab) {
  e.preventDefault();
  e.stopPropagation();
  closeTermCtxMenu();

  var menu = document.createElement("div");
  menu.className = "term-ctx-menu";

  // Copy selection
  var sel = tab.xterm ? copyTextForSelection(tab.xterm, tab.xterm.getSelection()) : "";
  if (tab._hoverLink) {
    var hoverUrl = tab._hoverLink;
    var copyLinkItem = document.createElement("button");
    copyLinkItem.className = "term-ctx-item";
    copyLinkItem.innerHTML = iconHtml("link") + " <span>Copy Link</span>";
    copyLinkItem.addEventListener("click", function (ev) {
      ev.stopPropagation();
      closeTermCtxMenu();
      copyToClipboard(hoverUrl);
    });
    menu.appendChild(copyLinkItem);
  }
  if (sel) {
    var copySelItem = document.createElement("button");
    copySelItem.className = "term-ctx-item";
    copySelItem.innerHTML = iconHtml("copy") + " <span>Copy</span>";
    copySelItem.addEventListener("click", function (ev) {
      ev.stopPropagation();
      closeTermCtxMenu();
      if (sel) copyToClipboard(sel);
    });
    menu.appendChild(copySelItem);
  }

  // Copy entire console
  var copyItem = document.createElement("button");
  copyItem.className = "term-ctx-item";
  copyItem.innerHTML = iconHtml("clipboard-copy") + " <span>Copy Console</span>";
  copyItem.addEventListener("click", function (ev) {
    ev.stopPropagation();
    closeTermCtxMenu();
    if (!tab.xterm) return;
    tab.xterm.selectAll();
    var text = tab.xterm.getSelection();
    tab.xterm.clearSelection();
    if (text) copyToClipboard(text);
  });
  menu.appendChild(copyItem);

  // Paste
  var pasteItem = document.createElement("button");
  pasteItem.className = "term-ctx-item";
  pasteItem.innerHTML = iconHtml("clipboard-paste") + " <span>Paste</span>";
  pasteItem.addEventListener("click", function (ev) {
    ev.stopPropagation();
    closeTermCtxMenu();
    if (!tab.xterm) return;
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (text) {
        // xterm.paste() normalises line endings to CR and adds the
        // bracketed-paste markers; its onData then sends the bytes.
        if (text && tab.xterm) tab.xterm.paste(text);
      }).catch(function () { /* permission denied or not available */ });
    }
  });
  menu.appendChild(pasteItem);

  // Clear
  var clearItem = document.createElement("button");
  clearItem.className = "term-ctx-item";
  clearItem.innerHTML = iconHtml("trash-2") + " <span>Clear Console</span>";
  clearItem.addEventListener("click", function (ev) {
    ev.stopPropagation();
    closeTermCtxMenu();
    if (!tab.xterm) return;
    tab.xterm.clear();
  });
  menu.appendChild(clearItem);

  // Position at mouse cursor, clamped to viewport on all four edges
  // (lr-a10a: mobile's synthetic contextmenu can fire from a low/edge
  // touch point, so a right/bottom-only clamp isn't enough).
  document.body.appendChild(menu);
  positionAtPoint(menu, { x: e.clientX, y: e.clientY });

  termCtxMenu = menu;
  refreshIcons();

  // Close on outside click (next tick to avoid immediate trigger)
  setTimeout(function () {
    document.addEventListener("click", closeTermCtxMenu, { once: true });
  }, 0);
}

// --- Mobile toolbar ---
var KEY_MAP = {
  tab: "\t",
  esc: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  pipe: "|",
  slash: "/",
  tilde: "~",
};

function initToolbar(toolbar) {
  if (!toolbarBound) {
    toolbarBound = true;

    toolbar.addEventListener("mousedown", function (e) { e.preventDefault(); });

    toolbar.addEventListener("click", function (e) {
      var btn = e.target.closest(".term-key");
      if (!btn) return;

      var tab = activeTabId ? tabs.get(activeTabId) : null;
      if (!tab || !tab.xterm) return;

      var key = btn.dataset.key;
      if (!key) return;

      if (key === "ctrl") {
        ctrlActive = !ctrlActive;
        btn.classList.toggle("active", ctrlActive);
        return;
      }

      if (key === "alt") {
        altActive = !altActive;
        btn.classList.toggle("active", altActive);
        return;
      }

      var seq = KEY_MAP[key];
      if (!seq) return;

      // Alt prefix: send ESC before the character
      if (altActive) {
        seq = "\x1b" + seq;
        altActive = false;
        var altBtn = toolbar.querySelector("[data-key='alt']");
        if (altBtn) altBtn.classList.remove("active");
      }

      if (ctx.ws && ctx.connected) {
        ctx.ws.send(JSON.stringify({ type: "term_input", id: activeTabId, data: seq }));
      }

      if (ctrlActive) {
        ctrlActive = false;
        var ctrlBtn = toolbar.querySelector("[data-key='ctrl']");
        if (ctrlBtn) ctrlBtn.classList.remove("active");
      }
    });
  }
}

// One key handler per xterm. xterm keeps a single custom handler, so the
// toolbar's virtual Ctrl and the Cmd/Ctrl+C / Cmd/Ctrl+V handling must live in
// the same function or the later registration silently drops the earlier one.
function createKeyHandler(tab, xterm) {
  return function (e) {
    if (e.type !== "keydown") return true;

    // Toolbar Ctrl armed: turn the next letter into its control character.
    if (ctrlActive && e.key && e.key.length === 1) {
      var charCode = e.key.toUpperCase().charCodeAt(0);
      if (charCode >= 65 && charCode <= 90) {
        sendTerminalInput(tab.id, String.fromCharCode(charCode - 64));
        ctrlActive = false;
        var ctrlBtn = document.querySelector("#terminal-toolbar [data-key='ctrl']");
        if (ctrlBtn) ctrlBtn.classList.remove("active");
        return false;
      }
    }

    // Cmd/Ctrl+C: copy selection if any, otherwise send SIGINT
    if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      var sel = copyTextForSelection(xterm, xterm.getSelection());
      if (sel) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(sel).catch(function () {});
        }
        return false; // prevent xterm from handling
      }
      // No selection on macOS Cmd+C: do nothing (not SIGINT)
      if (e.metaKey) return false;
    }
    // Cmd/Ctrl+V: the browser fires a paste event that xterm turns into
    // xterm.paste(), which normalises line endings and adds bracketed-paste markers.
    if ((e.ctrlKey || e.metaKey) && e.key === "v") {
      return false;
    }
    return true;
  };
}
