// sidebar-sessions.js - Session list, search, presence, countdown, CLI picker
// Extracted from sidebar.js (PR-35)

import { avatarUrl, userAvatarUrl } from './avatar.js';
import { escapeHtml, relativeTime } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { openSearch as openSessionSearch } from './session-search.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { getSessionListEl } from './dom-refs.js';
import { dismissOverlayPanels, closeSidebar, updatePageTitle, spawnDustParticles } from './sidebar.js';
import { showConfirm } from './app-misc.js';
import { getUpcomingSchedules } from './scheduler.js';
import { refreshMobileChatSheet } from './sidebar-mobile.js';
import { openAgentPicker, openAgentPickerForPreferred } from './agent-picker.js';
import { getCachedProjects } from './app-projects.js';
import { positionPopover } from './popover-position.js';
import { sessionActivity, rollupActivity, indicatorClass } from './activity-state.js';


// --- Session state ---
var cachedSessions = [];
var searchQuery = "";
var searchMatchIds = null; // null = no search, Set of matched session IDs
var searchDebounce = null;
var expandedLoopGroups = new Set();
var expandedLoopRuns = new Set();

// Fingerprint of the last rendered session list. When the server sends a
// session_list that hashes identically to the previous render, skip the
// full innerHTML teardown + rebuild. Fields that affect rendering:
// id, title, active, isProcessing, bookmarked, lastActivity, loop (id+role),
// sessionVisibility, agentName. Presence avatars are updated separately by
// updateSessionPresence() and don't need a full rebuild.
var _sessionListFingerprint = "";

// --- Session presence (multi-user: who is viewing which session) ---
var sessionPresence = {}; // { sessionId: [{ id, displayName, avatarStyle, avatarSeed }] }

// --- Countdown timer for upcoming schedules ---
var countdownTimer = null;
var countdownContainer = null;

// --- Session context menu ---
var sessionCtxMenu = null;
var sessionCtxSessionId = null;
var draggedSessionId = null;
var draggedSessionBookmarked = false;
var openResumePickerModal = function () {};
var headerSearchOpen = false;
var armedDeleteSessionId = null;
var armedDeleteTimer = null;

// Active inline-rename tracking (session or loop). A full session-list
// rebuild (innerHTML = "") detaches the rename <input> from the DOM without
// firing a real user "blur" — the browser's synthetic blur-on-removal still
// invokes commitRename(), but it operates on a textSpan that renderSessionList
// is about to throw away, so the typed title is silently discarded. Tracking
// the active commit/cancel lets renderSessionList settle it cleanly (using the
// input's *current* value) before tearing the list down, instead of losing it.
var activeRename = null; // { commit, cancel } or null

export function openResumePicker() {
  openResumePickerModal();
}

function sendSessionBookmark(sessionId, bookmarked) {
  if (getWs() && store.get('connected')) {
    getWs().send(JSON.stringify({ type: "set_session_bookmark", sessionId: sessionId, bookmarked: !!bookmarked }));
  }
}

function compareSessionListItems(a, b) {
  var aData = a && a.type === "session" ? a.data : a;
  var bData = b && b.type === "session" ? b.data : b;
  var aBookmarked = !!(aData && aData.bookmarked);
  var bBookmarked = !!(bData && bData.bookmarked);
  if (aBookmarked !== bBookmarked) return aBookmarked ? -1 : 1;
  if (aBookmarked && bBookmarked) {
    var ao = aData && typeof aData.favoriteOrder === "number" ? aData.favoriteOrder : Number.MAX_SAFE_INTEGER;
    var bo = bData && typeof bData.favoriteOrder === "number" ? bData.favoriteOrder : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
  }
  return (b.lastActivity || 0) - (a.lastActivity || 0);
}

function clearSessionDragIndicators() {
  var listEl = getSessionListEl();
  if (!listEl) return;
  var active = listEl.querySelectorAll(".session-favorites-divider.drag-hover, .session-regular-drop.drag-hover, .session-item.dragging");
  for (var i = 0; i < active.length; i++) {
    active[i].classList.remove("drag-hover", "dragging");
  }
}

function setupSessionDragHandlers(el, session) {
  el.setAttribute("draggable", "true");

  el.addEventListener("dragstart", function (e) {
    draggedSessionId = session.id;
    draggedSessionBookmarked = !!session.bookmarked;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(session.id));

    var ghost = document.createElement("div");
    ghost.textContent = session.title || "New Session";
    ghost.style.cssText = "position:fixed;left:-200px;top:-200px;max-width:220px;padding:8px 12px;border-radius:10px;" +
      "background:var(--sidebar-active);color:var(--text);font-size:13px;font-weight:600;pointer-events:none;z-index:-1;";
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 18, 18);
    setTimeout(function () { ghost.remove(); }, 0);

    setTimeout(function () { el.classList.add("dragging"); }, 0);
  });

  el.addEventListener("dragend", function () {
    clearSessionDragIndicators();
    draggedSessionId = null;
    draggedSessionBookmarked = false;
  });

  if (session.bookmarked) {
    el.addEventListener("dragover", function (e) {
      if (!draggedSessionId || draggedSessionId === session.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      var rect = el.getBoundingClientRect();
      var insertBefore = e.clientY < rect.top + rect.height / 2;
      el.classList.remove("drag-over-above", "drag-over-below");
      el.classList.add(insertBefore ? "drag-over-above" : "drag-over-below");
    });

    el.addEventListener("dragleave", function () {
      el.classList.remove("drag-over-above", "drag-over-below");
    });

    el.addEventListener("drop", function (e) {
      if (!draggedSessionId || draggedSessionId === session.id) return;
      e.preventDefault();
      var rect = el.getBoundingClientRect();
      var insertBefore = e.clientY < rect.top + rect.height / 2;
      el.classList.remove("drag-over-above", "drag-over-below");
      if (draggedSessionBookmarked) {
        if (getWs() && store.get('connected')) {
          getWs().send(JSON.stringify({
            type: "reorder_session_bookmarks",
            sourceId: draggedSessionId,
            targetId: session.id,
            insertBefore: insertBefore,
          }));
        }
      } else {
        sendSessionBookmark(draggedSessionId, true);
      }
    });
  }
}

function setupBookmarkDropTarget(el, bookmarked) {
  el.addEventListener("dragover", function (e) {
    if (!draggedSessionId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("drag-hover");
  });

  el.addEventListener("dragleave", function () {
    el.classList.remove("drag-hover");
  });

  el.addEventListener("drop", function (e) {
    if (!draggedSessionId) return;
    e.preventDefault();
    el.classList.remove("drag-hover");
    if (draggedSessionBookmarked !== !!bookmarked) {
      sendSessionBookmark(draggedSessionId, !!bookmarked);
    }
    clearSessionDragIndicators();
    draggedSessionId = null;
    draggedSessionBookmarked = false;
  });
}

function spawnSessionDeleteParticles(sessionId) {
  if (!spawnDustParticles) return;
  setTimeout(function () {
    var el = getSessionListEl().querySelector('[data-session-id="' + sessionId + '"]');
    if (!el) return;
    var rect = el.getBoundingClientRect();
    spawnDustParticles(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, 0);
}

function confirmDeleteSession(session) {
  showConfirm('Delete "' + (session.title || "New Session") + '"? This session and its history will be permanently removed.', function () {
    var ws = getWs();
    if (ws && store.get('connected')) {
      ws.send(JSON.stringify({ type: "delete_session", id: session.id }));
      spawnSessionDeleteParticles(session.id);
    }
  });
}

function clearArmedSessionDelete() {
  if (armedDeleteTimer) {
    clearTimeout(armedDeleteTimer);
    armedDeleteTimer = null;
  }
  if (armedDeleteSessionId !== null) {
    var prevBtn = getSessionListEl() ? getSessionListEl().querySelector('.session-close-btn[data-session-id="' + armedDeleteSessionId + '"]') : null;
    if (prevBtn) {
      prevBtn.classList.remove("armed");
      prevBtn.innerHTML = iconHtml("x");
      prevBtn.title = "Delete session";
      prevBtn.setAttribute("aria-label", "Delete session");
      refreshIcons();
    }
  }
  armedDeleteSessionId = null;
}

function armSessionDelete(closeBtn, session) {
  clearArmedSessionDelete();
  armedDeleteSessionId = session.id;
  closeBtn.classList.add("armed");
  closeBtn.innerHTML = iconHtml("check");
  closeBtn.title = "Click again to delete";
  closeBtn.setAttribute("aria-label", "Click again to delete");
  refreshIcons();
  armedDeleteTimer = setTimeout(function () {
    clearArmedSessionDelete();
  }, 1800);
}

function deleteSessionImmediately(session) {
  var ws = getWs();
  if (ws && store.get('connected')) {
    ws.send(JSON.stringify({ type: "delete_session", id: session.id }));
    spawnSessionDeleteParticles(session.id);
  }
}

function collectItemSessionIds(item) {
  if (!item) return [];
  if (item.type === "session" && item.data && typeof item.data.id === "number") {
    if (!isSessionVisibleBySearch(item.data.id)) return [];
    return [item.data.id];
  }
  if (item.type === "loop" && Array.isArray(item.children)) {
    var ids = [];
    for (var i = 0; i < item.children.length; i++) {
      if (typeof item.children[i].id === "number" && isSessionVisibleBySearch(item.children[i].id)) {
        ids.push(item.children[i].id);
      }
    }
    return ids;
  }
  return [];
}

function confirmDeleteSessionGroup(groupLabel, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return;
  var count = sessionIds.length;
  var noun = count === 1 ? "session" : "sessions";
  showConfirm('Clear "' + groupLabel + '"? ' + count + " " + noun + ' will be permanently removed.', function () {
    var ws = getWs();
    if (ws && store.get('connected')) {
      ws.send(JSON.stringify({ type: "bulk_delete_sessions", sessionIds: sessionIds }));
    }
  });
}

function createSessionGroupHeader(group, sessionIds) {
  var header = document.createElement("div");
  header.className = "session-group-header";

  var label = document.createElement("span");
  label.className = "session-group-header-label";
  label.textContent = group;
  header.appendChild(label);

  if ((!store.get('permissions') || store.get('permissions').sessionDelete !== false) && Array.isArray(sessionIds) && sessionIds.length > 0) {
    var clearBtn = document.createElement("button");
    clearBtn.className = "session-group-clear-btn";
    clearBtn.type = "button";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      confirmDeleteSessionGroup(group, sessionIds);
    });
    header.appendChild(clearBtn);
  }

  return header;
}

function appendSessionCloseButton(el, session) {
  if (store.get('permissions') && store.get('permissions').sessionDelete === false) return;

  var closeBtn = document.createElement("button");
  closeBtn.className = "session-close-btn";
  closeBtn.dataset.sessionId = session.id;
  closeBtn.type = "button";
  closeBtn.title = "Delete session";
  closeBtn.setAttribute("aria-label", "Delete session");
  closeBtn.innerHTML = iconHtml("x");
  closeBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (armedDeleteSessionId === session.id) {
      clearArmedSessionDelete();
      deleteSessionImmediately(session);
      return;
    }
    armSessionDelete(closeBtn, session);
  });
  el.appendChild(closeBtn);
}

function renderSessionTopActions() {
  var wrap = document.createElement("div");
  wrap.className = "session-top-actions";

  var isDm = store.get('dmMode');
  // Agent Chat is Claude Code-only — the Claude Agent SDK supports named-agent
  // identity injection; the Codex adapter has no equivalent API surface.
  var isCodex = (store.get('currentVendor') || 'claude') === 'codex';

  // Resolve preferred agent for the current project
  var currentSlug = store.get('currentSlug');
  var preferredAgent = null;
  if (currentSlug && !isDm && !isCodex) {
    var projects = getCachedProjects();
    for (var pi = 0; pi < projects.length; pi++) {
      if (projects[pi].slug === currentSlug) {
        preferredAgent = projects[pi].preferredAgent || null;
        break;
      }
    }
  }

  // Row 1: two equal primary actions — New Session + Agent Chat
  var newBtn = document.createElement("button");
  newBtn.className = "session-top-action";
  newBtn.type = "button";
  newBtn.innerHTML = iconHtml("plus") + '<span>New Session</span>';
  newBtn.addEventListener("click", function () {
    if (getWs() && store.get('connected')) {
      getWs().send(JSON.stringify({ type: "new_session" }));
    }
  });
  wrap.appendChild(newBtn);

  // Agent Chat (full picker) — hidden in dmMode and in Codex mode (no agent
  // identity injection available in the Codex adapter).
  if (!isDm && !isCodex) {
    var agentBtn = document.createElement("button");
    agentBtn.className = "session-top-action";
    agentBtn.type = "button";
    agentBtn.innerHTML = iconHtml("message-circle-plus") + '<span>Agent Chat</span>';
    agentBtn.addEventListener("click", function () {
      openAgentPicker();
    });
    wrap.appendChild(agentBtn);
  }

  // Row 2 (optional): preferred agent quick-launch — full width, only when set.
  // Shows nothing when no preferred agent is configured (no placeholder clutter).
  if (!isDm && !isCodex && preferredAgent) {
    var favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "session-top-action session-top-action--preferred";
    favBtn.innerHTML = iconHtml("bot") + '<span>' + escapeHtml(preferredAgent.name) + '</span>';
    favBtn.title = 'Start chat with ' + preferredAgent.name;
    favBtn.addEventListener("click", function () {
      var ws = getWs();
      if (ws && store.get('connected')) {
        ws.send(JSON.stringify({
          type: "new_session",
          agentName: preferredAgent.name,
          agentKind: preferredAgent.kind,
          agentPluginName: preferredAgent.pluginName || null,
        }));
      }
    });
    wrap.appendChild(favBtn);
  }

  return wrap;
}

// Swap just the top-actions node in-place so vendor-toggle changes take
// effect without a full session list re-render.
function refreshSessionTopActions() {
  var listEl = getSessionListEl();
  if (!listEl) return;
  var stickyTop = listEl.querySelector('.session-list-sticky-top');
  if (!stickyTop) return;
  var oldActions = stickyTop.querySelector('.session-top-actions');
  if (!oldActions) return;
  var newActions = renderSessionTopActions();
  stickyTop.replaceChild(newActions, oldActions);
  refreshIcons(newActions);
}

function runSessionSearch(query) {
  var normalizedQuery = query || "";
  var trimmedQuery = normalizedQuery.trim();
  searchQuery = normalizedQuery;
  if (searchDebounce) {
    clearTimeout(searchDebounce);
    searchDebounce = null;
  }
  if (!trimmedQuery) {
    searchMatchIds = null;
    renderSessionList(null);
    return;
  }
  searchDebounce = setTimeout(function () {
    if (getWs() && store.get('connected')) {
      getWs().send(JSON.stringify({ type: "search_sessions", query: searchQuery }));
    }
  }, 200);
}

function syncHeaderSearchUi() {
  var searchInline = document.getElementById("session-header-search-inline");
  var searchInput = document.getElementById("session-header-search-input");
  var searchClear = document.getElementById("session-header-search-clear");
  var searchBtn = document.getElementById("session-header-search-btn");
  var filterCount = document.getElementById("session-filter-count");
  var isOpen = headerSearchOpen || !!searchQuery;
  if (!searchInline || !searchInput || !searchClear || !searchBtn || !filterCount) return;
  searchInline.classList.toggle("hidden", !isOpen);
  searchBtn.classList.toggle("active", isOpen);
  if (searchInput.value !== searchQuery) {
    searchInput.value = searchQuery;
  }
  searchClear.classList.toggle("hidden", !searchQuery);
  if (!searchQuery || searchMatchIds === null) {
    filterCount.classList.add("hidden");
    filterCount.textContent = "";
  } else {
    filterCount.classList.remove("hidden");
    filterCount.textContent = String(searchMatchIds.size);
  }
}

function openHeaderSearch() {
  headerSearchOpen = true;
  syncHeaderSearchUi();
  var searchInput = document.getElementById("session-header-search-input");
  if (searchInput) {
    requestAnimationFrame(function () {
      searchInput.focus();
      searchInput.select();
    });
  }
}

function closeHeaderSearch() {
  headerSearchOpen = false;
  syncHeaderSearchUi();
}

function clearSessionSearch(shouldBlur, input, shouldClose) {
  if (searchDebounce) {
    clearTimeout(searchDebounce);
    searchDebounce = null;
  }
  searchQuery = "";
  searchMatchIds = null;
  if (shouldClose) {
    headerSearchOpen = false;
  }
  syncHeaderSearchUi();
  renderSessionList(null);
  if (shouldBlur && input) {
    input.blur();
  }
}

export function initSidebarSessions() {

  document.addEventListener("click", function () {
    closeSessionCtxMenu();
    clearArmedSessionDelete();
  });

  var searchBtn = document.getElementById("session-header-search-btn");
  var searchInput = document.getElementById("session-header-search-input");
  var searchClear = document.getElementById("session-header-search-clear");
  var searchInline = document.getElementById("session-header-search-inline");

  if (searchBtn && searchInput && searchClear && searchInline) {
    searchBtn.addEventListener("click", function () {
      if (!headerSearchOpen && !searchQuery) {
        openHeaderSearch();
        return;
      }
      if (!searchQuery) {
        closeHeaderSearch();
        return;
      }
      searchInput.focus();
      searchInput.select();
    });

    searchInput.addEventListener("input", function () {
      runSessionSearch(searchInput.value);
      syncHeaderSearchUi();
    });

    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (searchInput.value.trim()) {
          clearSessionSearch(false, searchInput, false);
          return;
        }
        clearSessionSearch(true, searchInput, true);
      }
    });

    searchInput.addEventListener("blur", function () {
      setTimeout(function () {
        if (!searchQuery && document.activeElement !== searchBtn && document.activeElement !== searchClear) {
          closeHeaderSearch();
        }
      }, 0);
    });

    searchClear.addEventListener("click", function () {
      clearSessionSearch(false, searchInput, false);
      searchInput.focus();
    });

    syncHeaderSearchUi();
  }

  // --- Resume session picker ---
  var resumeModal = document.getElementById("resume-modal");
  var resumeCancel = document.getElementById("resume-cancel");
  var pickerLoading = document.getElementById("resume-picker-loading");
  var pickerEmpty = document.getElementById("resume-picker-empty");
  var pickerList = document.getElementById("resume-picker-list");

  function openResumeModal() {
    resumeModal.classList.remove("hidden");
    pickerLoading.classList.remove("hidden");
    pickerEmpty.classList.add("hidden");
    pickerList.classList.add("hidden");
    pickerList.innerHTML = "";
    if (getWs() && store.get('connected')) {
      getWs().send(JSON.stringify({ type: "list_cli_sessions" }));
    }
  }
  openResumePickerModal = openResumeModal;

  function closeResumeModal() {
    resumeModal.classList.add("hidden");
  }

  resumeCancel.addEventListener("click", closeResumeModal);
  resumeModal.querySelector(".confirm-backdrop").addEventListener("click", closeResumeModal);

  // --- Import CLI palette tile ---
  // The button is created by tool-palette.js with this ID; we wire the handler here.
  var importCliBtn = document.getElementById("import-cli-btn");
  if (importCliBtn) {
    importCliBtn.addEventListener("click", function () {
      openResumePickerModal();
    });
  }

  // --- Reactively update top-actions when vendor changes ---
  // Agent Chat is hidden in Codex mode; the vendor toggle in app-panels
  // updates the store without triggering a session_list, so we subscribe
  // here and swap just the top-actions node to avoid a full list re-render.
  store.subscribe(['currentVendor'], function (state, prev) {
    if (state.currentVendor !== prev.currentVendor) {
      refreshSessionTopActions();
    }
  });

  // --- Schedule countdown timer ---
  startCountdownTimer();
}

// --- Getters for cross-module access ---

export function getCachedSessions() {
  return cachedSessions;
}

// Called by resetClientState() on project switch. Clears the cached session
// list and immediately wipes the DOM so the sidebar is blank while waiting
// for the new project's session_list. Bypasses the fingerprint guard on
// purpose — when both old and new fingerprints are "" (empty list) the guard
// would return early before clearing innerHTML, leaving stale sessions visible.
export function resetSessionList() {
  cachedSessions = [];
  _sessionListFingerprint = "__reset__";
  var listEl = getSessionListEl();
  if (listEl) listEl.innerHTML = "";
}

export function getSearchQuery() {
  return searchQuery;
}

export function getSearchMatchIds() {
  return searchMatchIds;
}

export function getExpandedLoopGroups() {
  return expandedLoopGroups;
}

export function getExpandedLoopRuns() {
  return expandedLoopRuns;
}

// --- Context menu ---

function closeSessionCtxMenu() {
  if (sessionCtxMenu) {
    sessionCtxMenu.remove();
    sessionCtxMenu = null;
    sessionCtxSessionId = null;
  }
}

function showSessionCtxMenu(anchorBtn, sessionId, title, cliSid, sessionData) {
  closeSessionCtxMenu();
  sessionCtxSessionId = sessionId;

  var menu = document.createElement("div");
  menu.className = "session-ctx-menu";

  var bookmarkItem = document.createElement("button");
  bookmarkItem.className = "session-ctx-item";
  bookmarkItem.innerHTML = iconHtml(sessionData && sessionData.bookmarked ? "arrow-down" : "arrow-up") + " <span>" + (sessionData && sessionData.bookmarked ? "Remove from Favorites" : "Add to Favorites") + "</span>";
  bookmarkItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeSessionCtxMenu();
    sendSessionBookmark(sessionId, !(sessionData && sessionData.bookmarked));
  });
  menu.appendChild(bookmarkItem);

  var renameItem = document.createElement("button");
  renameItem.className = "session-ctx-item";
  renameItem.innerHTML = iconHtml("pencil") + " <span>Rename</span>";
  renameItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeSessionCtxMenu();
    startInlineRename(sessionId, title);
  });
  menu.appendChild(renameItem);

  // Session visibility toggle (only the session owner can change)
  if (sessionData && sessionData.ownerId && sessionData.ownerId === store.get('myUserId')) {
    var currentVis = (sessionData && sessionData.sessionVisibility) || "shared";
    var isPrivate = currentVis === "private";
    var visItem = document.createElement("button");
    visItem.className = "session-ctx-item";
    visItem.innerHTML = iconHtml(isPrivate ? "eye" : "eye-off") + " <span>" + (isPrivate ? "Make Shared" : "Make Private") + "</span>";
    visItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeSessionCtxMenu();
      var newVis = isPrivate ? "shared" : "private";
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "set_session_visibility", sessionId: sessionId, visibility: newVis }));
      }
    });
    menu.appendChild(visItem);
  }

  if (!store.get('permissions') || store.get('permissions').sessionDelete !== false) {
    var deleteItem = document.createElement("button");
    deleteItem.className = "session-ctx-item session-ctx-delete";
    deleteItem.innerHTML = iconHtml("trash-2") + " <span>Delete</span>";
    deleteItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeSessionCtxMenu();
      confirmDeleteSession({ id: sessionId, title: title });
    });
    menu.appendChild(deleteItem);
  }

  document.body.appendChild(menu);
  sessionCtxMenu = menu;
  refreshIcons();

  // Position: fixed relative to the anchor button, right-edge aligned,
  // flip-then-clamp on all four edges (lr-a10a: the prior bottom-flip-only
  // logic could leave the flipped menu with top < 0 on a short viewport).
  requestAnimationFrame(function () {
    positionPopover(menu, anchorBtn, { placement: "below-right-aligned", gap: 2 });
  });
}

function showLoopCtxMenu(anchorBtn, loopId, loopName, childCount) {
  closeSessionCtxMenu();

  var menu = document.createElement("div");
  menu.className = "session-ctx-menu";

  var renameItem = document.createElement("button");
  renameItem.className = "session-ctx-item";
  renameItem.innerHTML = iconHtml("pencil") + " <span>Rename</span>";
  renameItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeSessionCtxMenu();
    startLoopInlineRename(loopId, loopName);
  });
  menu.appendChild(renameItem);

  if (!store.get('permissions') || store.get('permissions').sessionDelete !== false) {
    var deleteItem = document.createElement("button");
    deleteItem.className = "session-ctx-item session-ctx-delete";
    deleteItem.innerHTML = iconHtml("trash-2") + " <span>Delete</span>";
    deleteItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeSessionCtxMenu();
      var msg = 'Delete "' + (loopName || "Loop") + '"';
      if (childCount > 1) msg += " and its " + childCount + " sessions";
      msg += "? This cannot be undone.";
      showConfirm(msg, function () {
        if (getWs() && store.get('connected')) {
          getWs().send(JSON.stringify({ type: "delete_loop_group", loopId: loopId }));
        }
      });
    });
    menu.appendChild(deleteItem);
  }

  document.body.appendChild(menu);
  sessionCtxMenu = menu;
  refreshIcons();

  requestAnimationFrame(function () {
    positionPopover(menu, anchorBtn, { placement: "below-right-aligned", gap: 2 });
  });
}

// --- Inline rename ---

function startInlineRename(sessionId, currentTitle) {
  var el = getSessionListEl().querySelector('.session-item[data-session-id="' + sessionId + '"]');
  if (!el) return;
  var textSpan = el.querySelector(".session-item-text");
  if (!textSpan) return;

  // Settle (not silently drop) any rename already in progress elsewhere in
  // the list before starting a new one.
  if (activeRename) activeRename.commit();

  var input = document.createElement("input");
  input.type = "text";
  input.className = "session-rename-input";
  input.value = currentTitle || "New Session";

  var originalHtml = textSpan.innerHTML;
  textSpan.innerHTML = "";
  textSpan.appendChild(input);
  input.focus();
  input.select();

  var settled = false;

  function commitRename() {
    if (settled) return;
    settled = true;
    activeRename = null;
    var newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle && getWs() && store.get('connected')) {
      getWs().send(JSON.stringify({ type: "rename_session", id: sessionId, title: newTitle }));
    }
    // Restore text (server will send updated session_list). Guard against the
    // textSpan already having been detached/replaced by a rebuild that ran
    // this same settle path via activeRename.commit() at its top.
    if (getSessionListEl().contains(textSpan)) {
      textSpan.innerHTML = originalHtml;
      if (newTitle && newTitle !== currentTitle) {
        textSpan.textContent = newTitle;
      }
    }
  }

  function cancelRename() {
    if (settled) return;
    settled = true;
    activeRename = null;
    if (getSessionListEl().contains(textSpan)) textSpan.innerHTML = originalHtml;
  }

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
  });
  input.addEventListener("blur", commitRename);
  input.addEventListener("click", function (e) { e.stopPropagation(); });

  activeRename = { commit: commitRename, cancel: cancelRename };
}

function startLoopInlineRename(loopId, currentName) {
  var el = getSessionListEl().querySelector('.session-loop-group[data-loop-id="' + loopId + '"]');
  if (!el) return;
  var textSpan = el.querySelector(".session-item-text");
  if (!textSpan) return;

  if (activeRename) activeRename.commit();

  var input = document.createElement("input");
  input.type = "text";
  input.className = "session-rename-input";
  input.value = currentName || "Loop";

  var originalHtml = textSpan.innerHTML;
  textSpan.innerHTML = "";
  textSpan.appendChild(input);
  input.focus();
  input.select();

  var settled = false;

  function commitRename() {
    if (settled) return;
    settled = true;
    activeRename = null;
    var newName = input.value.trim();
    if (newName && newName !== currentName && getWs() && store.get('connected')) {
      getWs().send(JSON.stringify({ type: "loop_registry_rename", id: loopId, name: newName }));
    }
    if (getSessionListEl().contains(textSpan)) {
      textSpan.innerHTML = originalHtml;
      if (newName && newName !== currentName) {
        // Update text inline immediately
        var nameNode = textSpan.querySelector(".session-loop-name");
        if (nameNode) nameNode.textContent = newName;
      }
    }
  }

  function cancelRename() {
    if (settled) return;
    settled = true;
    activeRename = null;
    if (getSessionListEl().contains(textSpan)) textSpan.innerHTML = originalHtml;
  }

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
  });
  input.addEventListener("blur", commitRename);
  input.addEventListener("click", function (e) { e.stopPropagation(); });

  activeRename = { commit: commitRename, cancel: cancelRename };
}

// --- Date grouping / highlighting ---

export function getDateGroup(ts) {
  var now = new Date();
  var d = new Date(ts);
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var yesterday = new Date(today.getTime() - 86400000);
  var weekAgo = new Date(today.getTime() - 7 * 86400000);
  if (d >= today) return "Today";
  if (d >= yesterday) return "Yesterday";
  if (d >= weekAgo) return "This Week";
  return "Older";
}

export function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  var lower = text.toLowerCase();
  var qLower = query.toLowerCase();
  var idx = lower.indexOf(qLower);
  if (idx === -1) return escapeHtml(text);
  var before = text.substring(0, idx);
  var match = text.substring(idx, idx + query.length);
  var after = text.substring(idx + query.length);
  return escapeHtml(before) + '<mark class="session-highlight">' + escapeHtml(match) + '</mark>' + escapeHtml(after);
}

function isSessionVisibleBySearch(sessionId) {
  if (searchMatchIds === null) return true;
  return searchMatchIds.has(sessionId);
}

// --- Loop child / run / group rendering ---

function renderLoopChild(s) {
  var el = document.createElement("div");
  var isMatch = searchMatchIds !== null && searchMatchIds.has(s.id);
  el.className = "session-loop-child" + (s.active ? " active" : "") + (isMatch ? " search-match" : "");
  el.dataset.sessionId = s.id;

  var textSpan = document.createElement("span");
  textSpan.className = "session-item-text";
  var textHtml = "";
  var childActivityState = sessionActivity(s, store.get('myUserId'));
  var childActivityCls = indicatorClass(childActivityState);
  if (childActivityCls) {
    textHtml += '<span class="session-processing ' + childActivityCls + '" title="' + escapeHtml(childActivityState.label) + '"></span>';
  }
  if (s.loop) {
    var isRalphChild = s.loop.source === "ralph";
    var roleName = s.loop.role === "crafting" ? "Crafting" : s.loop.role === "judge" ? "Judge" : (isRalphChild ? "Coder" : "Run");
    var iterSuffix = s.loop.role === "crafting" ? "" : " #" + s.loop.iteration;
    var roleCls = s.loop.role === "crafting" ? " crafting" : (!isRalphChild ? " scheduled" : "");
    textHtml += '<span class="session-loop-role-badge' + roleCls + '">' + roleName + iterSuffix + '</span>';
  }
  textSpan.innerHTML = textHtml;
  el.appendChild(textSpan);
  appendSessionCloseButton(el, s);

  el.addEventListener("click", (function (id) {
    return function () {
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "switch_session", id: id }));
        dismissOverlayPanels();
        closeSidebar();
      }
    };
  })(s.id));

  return el;
}

function renderLoopGroup(loopId, children, groupKey) {
  var visibleChildren = children;
  if (searchMatchIds !== null) {
    visibleChildren = [];
    for (var vi = 0; vi < children.length; vi++) {
      if (isSessionVisibleBySearch(children[vi].id)) {
        visibleChildren.push(children[vi]);
      }
    }
    if (visibleChildren.length === 0) {
      return null;
    }
  }

  var gk = groupKey || loopId;

  // Sub-group children by startedAt (each run)
  var runMap = {};
  for (var i = 0; i < visibleChildren.length; i++) {
    var runKey = String(visibleChildren[i].loop && visibleChildren[i].loop.startedAt || 0);
    if (!runMap[runKey]) runMap[runKey] = [];
    runMap[runKey].push(visibleChildren[i]);
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

  var expanded = expandedLoopGroups.has(gk);
  var hasActive = false;
  var latestSession = visibleChildren[0];
  for (var ci = 0; ci < visibleChildren.length; ci++) {
    if (visibleChildren[ci].active) hasActive = true;
    if ((visibleChildren[ci].lastActivity || 0) > (latestSession.lastActivity || 0)) {
      latestSession = visibleChildren[ci];
    }
  }
  // lr-66c118: replaces the open-coded anyProcessing OR-loop above.
  var groupActivityCls = indicatorClass(rollupActivity(visibleChildren, store.get('myUserId')));

  var loopName = (visibleChildren[0].loop && visibleChildren[0].loop.name) || "Loop";
  var isRalph = visibleChildren[0].loop && visibleChildren[0].loop.source === "ralph";
  var isCrafting = false;
  for (var j = 0; j < visibleChildren.length; j++) {
    if (visibleChildren[j].loop && visibleChildren[j].loop.role === "crafting") isCrafting = true;
  }

  var runCount = runKeys.length;

  var wrapper = document.createElement("div");
  wrapper.className = "session-loop-wrapper";

  // Group header row
  var el = document.createElement("div");
  var groupClass = "session-loop-group" + (hasActive ? " active" : "") + (expanded ? " expanded" : "");
  if (!isRalph) groupClass += " scheduled";
  el.className = groupClass;
  el.dataset.loopId = loopId;

  var chevron = document.createElement("button");
  chevron.className = "session-loop-chevron";
  chevron.innerHTML = iconHtml("chevron-right");
  chevron.addEventListener("click", (function (lid) {
    return function (e) {
      e.stopPropagation();
      if (expandedLoopGroups.has(lid)) {
        expandedLoopGroups.delete(lid);
      } else {
        expandedLoopGroups.add(lid);
      }
      renderSessionList(null);
    };
  })(gk));
  el.appendChild(chevron);

  var textSpan = document.createElement("span");
  textSpan.className = "session-item-text";
  var textHtml = "";
  if (groupActivityCls) {
    textHtml += '<span class="session-processing ' + groupActivityCls + '"></span>';
  }
  var groupIcon = isRalph ? "repeat" : "calendar-clock";
  var iconClass = isRalph ? "" : " scheduled";
  textHtml += '<span class="session-loop-icon' + iconClass + '">' + iconHtml(groupIcon) + '</span>';
  textHtml += '<span class="session-loop-name">' + escapeHtml(loopName) + '</span>';
  if (isCrafting && children.length === 1) {
    textHtml += '<span class="session-loop-badge crafting">Crafting</span>';
  } else {
    var countLabel = runCount === 1 ? visibleChildren.length : runCount + (runCount === 1 ? " run" : " runs");
    var countClass = isRalph ? "" : " scheduled";
    textHtml += '<span class="session-loop-count' + countClass + '">' + countLabel + '</span>';
  }
  textSpan.innerHTML = textHtml;
  el.appendChild(textSpan);

  // More button (ellipsis)
  var moreBtn = document.createElement("button");
  moreBtn.className = "session-more-btn";
  moreBtn.innerHTML = iconHtml("ellipsis");
  moreBtn.title = "More options";
  moreBtn.addEventListener("click", (function (lid, name, count, btn) {
    return function (e) {
      e.stopPropagation();
      showLoopCtxMenu(btn, lid, name, count);
    };
  })(loopId, loopName, visibleChildren.length, moreBtn));
  el.appendChild(moreBtn);

  // Click row (not chevron/more) -> switch to latest session
  el.addEventListener("click", (function (id) {
    return function () {
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "switch_session", id: id }));
        dismissOverlayPanels();
        closeSidebar();
      }
    };
  })(latestSession.id));

  wrapper.appendChild(el);

  // Expanded: show runs as sub-groups
  if (expanded) {
    var childContainer = document.createElement("div");
    childContainer.className = "session-loop-children";

    if (runCount === 1) {
      // Single run: show sessions directly (no extra nesting)
      var singleRun = runMap[runKeys[0]];
      for (var sk = 0; sk < singleRun.length; sk++) {
        childContainer.appendChild(renderLoopChild(singleRun[sk]));
      }
    } else {
      // Multiple runs: render each run as a collapsible sub-group
      for (var rk = 0; rk < runKeys.length; rk++) {
        childContainer.appendChild(renderLoopRun(gk, runKeys[rk], runMap[runKeys[rk]], isRalph));
      }
    }

    wrapper.appendChild(childContainer);
  }

  return wrapper;
}

function renderLoopRun(parentGk, startedAtKey, sessions, isRalph) {
  var runGk = parentGk + ":" + startedAtKey;
  var expanded = expandedLoopRuns.has(runGk);
  var startedAt = Number(startedAtKey);
  var timeLabel = startedAt ? new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Unknown";

  var hasActive = false;
  var latestSession = sessions[0];
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].active) hasActive = true;
    if ((sessions[i].lastActivity || 0) > (latestSession.lastActivity || 0)) {
      latestSession = sessions[i];
    }
  }
  // lr-66c118: replaces the open-coded anyProcessing OR-loop above.
  var runActivityCls = indicatorClass(rollupActivity(sessions, store.get('myUserId')));

  var wrapper = document.createElement("div");
  wrapper.className = "session-loop-run-wrapper";

  var el = document.createElement("div");
  el.className = "session-loop-run" + (hasActive ? " active" : "") + (expanded ? " expanded" : "") + (isRalph ? "" : " scheduled");

  var chevron = document.createElement("button");
  chevron.className = "session-loop-chevron";
  chevron.innerHTML = iconHtml("chevron-right");
  chevron.addEventListener("click", (function (rk) {
    return function (e) {
      e.stopPropagation();
      if (expandedLoopRuns.has(rk)) {
        expandedLoopRuns.delete(rk);
      } else {
        expandedLoopRuns.add(rk);
      }
      renderSessionList(null);
    };
  })(runGk));
  el.appendChild(chevron);

  var textSpan = document.createElement("span");
  textSpan.className = "session-item-text";
  var textHtml = "";
  if (runActivityCls) {
    textHtml += '<span class="session-processing ' + runActivityCls + '"></span>';
  }
  textHtml += '<span class="session-loop-run-time">' + escapeHtml(timeLabel) + '</span>';
  textHtml += '<span class="session-loop-count' + (isRalph ? "" : " scheduled") + '">' + sessions.length + '</span>';
  textSpan.innerHTML = textHtml;
  el.appendChild(textSpan);

  // Click row -> switch to latest session of this run
  el.addEventListener("click", (function (id) {
    return function () {
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "switch_session", id: id }));
        dismissOverlayPanels();
        closeSidebar();
      }
    };
  })(latestSession.id));

  wrapper.appendChild(el);

  if (expanded) {
    var childContainer = document.createElement("div");
    childContainer.className = "session-loop-children";
    for (var k = 0; k < sessions.length; k++) {
      childContainer.appendChild(renderLoopChild(sessions[k]));
    }
    wrapper.appendChild(childContainer);
  }

  return wrapper;
}

// --- Session item rendering ---

function renderSessionItem(s) {
  var el = document.createElement("div");
  var isMatch = searchMatchIds !== null && searchMatchIds.has(s.id);
  el.className = "session-item" + (s.active ? " active" : "") + (isMatch ? " search-match" : "");
  el.dataset.sessionId = s.id;

  var textSpan = document.createElement("span");
  textSpan.className = "session-item-text";
  var textHtml = "";
  var itemActivityState = sessionActivity(s, store.get('myUserId'));
  var itemActivityCls = indicatorClass(itemActivityState);
  if (itemActivityCls) {
    textHtml += '<span class="session-processing ' + itemActivityCls + '" title="' + escapeHtml(itemActivityState.label) + '"></span>';
  }
  if (s.sessionVisibility === "private") {
    textHtml += '<span class="session-private-icon" title="Private session">' + iconHtml("lock") + '</span>';
  }
  // lr-7db0 — agent badge for sessions cast as a named agent via the SDK `agent` option.
  // Icon-only with the agent name in `title` matches the lock-icon convention for
  // private sessions (above) and prevents the agent name from bleeding into the
  // window title via .session-item-text.textContent in sidebar.js:updatePageTitle.
  if (s.agentName) {
    textHtml += '<span class="session-agent-badge" title="Agent: ' + escapeHtml(s.agentName) + '">'
      + iconHtml("bot") + '</span>';
  }
  textHtml += highlightMatch(s.title || "New Session", searchQuery);
  textSpan.innerHTML = textHtml;
  el.appendChild(textSpan);

  // Right-click / long-press: context menu
  el.addEventListener("contextmenu", (function(id, title, cliSid, anchor, sData) {
    return function(e) {
      e.preventDefault();
      e.stopPropagation();
      showSessionCtxMenu(anchor, id, title, cliSid, sData);
    };
  })(s.id, s.title, s.cliSessionId, el, s));

  // Unread badge
  var unreadBadge = document.createElement("span");
  unreadBadge.className = "session-unread-badge";
  unreadBadge.dataset.sessionId = s.id;
  if (s.unread > 0) {
    unreadBadge.textContent = s.unread > 99 ? "99+" : String(s.unread);
    unreadBadge.classList.add("has-unread");
  }
  el.appendChild(unreadBadge);
  appendSessionCloseButton(el, s);

  el.addEventListener("click", (function (id) {
    return function () {
      if (getWs() && store.get('connected')) {
        var pendingQuery = searchQuery || "";
        getWs().send(JSON.stringify({ type: "switch_session", id: id }));
        dismissOverlayPanels();
        closeSidebar();
        if (pendingQuery) {
          setTimeout(function () { openSessionSearch(pendingQuery); }, 400);
        }
      }
    };
  })(s.id));

  // Presence avatars (multi-user)
  renderPresenceAvatars(el, String(s.id));
  setupSessionDragHandlers(el, s);

  return el;
}

// --- Main session list ---

// lr-66c118: the activity field below is the derived class (indicatorClass/
// sessionActivity), not a raw processing-flag read — also captures an
// ownerId-driven tone change a boolean would have missed.
function _fingerprintSessions(list, expanded, expandedRuns) {
  var myUserId = store.get('myUserId');
  var parts = [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    parts.push(
      s.id + "," +
      (s.title || "") + "," +
      (s.active ? "1" : "0") + "," +
      indicatorClass(sessionActivity(s, myUserId)) + "," +
      (s.bookmarked ? "1" : "0") + "," +
      // favoriteOrder drives sort order within the favorites section
      // (compareSessionListItems) and unread drives the badge — both must be
      // in the fingerprint or a bookmark reorder / unread-count change with
      // no other field change would be skipped as a no-op render.
      (typeof s.favoriteOrder === "number" ? s.favoriteOrder : "") + "," +
      (s.unread || 0) + "," +
      (s.lastActivity || 0) + "," +
      (s.sessionVisibility || "") + "," +
      (s.agentName || "") + "," +
      (s.loop ? (s.loop.loopId + ":" + s.loop.role + ":" + s.loop.source + ":" +
        (s.loop.name || "") + ":" + (s.loop.iteration || "") + ":" + (s.loop.startedAt || "")) : "")
    );
  }
  // Include expanded state so chevron toggles still trigger a re-render
  expanded.forEach(function (id) { parts.push("exp:" + id); });
  expandedRuns.forEach(function (id) { parts.push("run:" + id); });
  return parts.join("|");
}

export function renderSessionList(sessions) {
  if (sessions) cachedSessions = sessions;

  // A full rebuild below (innerHTML = "") detaches the in-progress rename
  // <input> / armed-delete "x" button without a real user action. Settle
  // both cleanly first: commit the rename using its current value (matching
  // existing blur-to-commit behavior) and clear the armed-delete affordance
  // so the rebuilt button doesn't silently delete on the next single click.
  if (activeRename) activeRename.commit();
  clearArmedSessionDelete();

  // Skip full rebuild when session data hasn't changed. Server often
  // re-broadcasts session_list after unrelated events (session switches,
  // WS reconnects, presence updates). Each rebuild does innerHTML="" on the
  // entire sidebar list + re-creates all elements + calls refreshIcons().
  // Include search state so filter changes always trigger a rebuild.
  var fp = _fingerprintSessions(cachedSessions, expandedLoopGroups, expandedLoopRuns) +
    "|sq:" + searchQuery + "|sm:" + (searchMatchIds ? searchMatchIds.size : "null");
  if (fp === _sessionListFingerprint) {
    // Still need to refresh mobile sheet and search UI on null calls
    if (refreshMobileChatSheet) refreshMobileChatSheet();
    syncHeaderSearchUi();
    if (updatePageTitle) updatePageTitle();
    return;
  }
  _sessionListFingerprint = fp;

  // If mobile chat sheet is open, refresh it
  if (refreshMobileChatSheet) refreshMobileChatSheet();

  getSessionListEl().innerHTML = "";

  // Partition: loop sessions vs normal sessions
  // Group by loopId + date so all runs of the same task on the same day are merged
  var loopGroups = {}; // groupKey -> [sessions]
  var normalSessions = [];
  for (var i = 0; i < cachedSessions.length; i++) {
    var s = cachedSessions[i];
    if (s.loop && s.loop.loopId && s.loop.role === "crafting" && s.loop.source !== "ralph") {
      // Task crafting sessions live in the scheduler calendar, not the main list.
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

  // Build virtual items: normal sessions + one entry per loop group (using latest child's lastActivity)
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
  items.sort(compareSessionListItems);

  var bookmarkedItems = [];
  var regularItems = [];
  for (var n = 0; n < items.length; n++) {
    var item = items[n];
    if (item.type === "session" && item.data && !isSessionVisibleBySearch(item.data.id)) {
      continue;
    }
    if (item.type === "session" && item.data && item.data.bookmarked) {
      bookmarkedItems.push(item);
    } else {
      regularItems.push(item);
    }
  }

  var favoritesContainer = document.createElement("div");
  favoritesContainer.className = "session-favorites-section";
  setupBookmarkDropTarget(favoritesContainer, true);
  if (bookmarkedItems.length === 0) {
    var emptyHint = document.createElement("div");
    emptyHint.className = "session-favorites-empty";
    emptyHint.textContent = "Drag and drop sessions here to add favorites.";
    favoritesContainer.appendChild(emptyHint);
  }
  for (var bi = 0; bi < bookmarkedItems.length; bi++) {
    favoritesContainer.appendChild(renderSessionItem(bookmarkedItems[bi].data));
  }

  var divider = document.createElement("div");
  divider.className = "session-favorites-divider";

  var regularContainer = document.createElement("div");
  regularContainer.className = "session-regular-drop";
  setupBookmarkDropTarget(regularContainer, false);
  var stickyTop = document.createElement("div");
  stickyTop.className = "session-list-sticky-top";
  stickyTop.appendChild(renderSessionTopActions());
  stickyTop.appendChild(favoritesContainer);
  stickyTop.appendChild(divider);
  // Resolve top-action icons synchronously before the first paint so they
  // never appear as blank placeholders. The deferred refreshIcons() at the
  // end of this function covers the rest of the list.
  lucide.createIcons({ root: stickyTop });
  getSessionListEl().appendChild(stickyTop);

  var currentGroup = "";
  var currentGroupIds = [];
  for (var ri = 0; ri < regularItems.length; ri++) {
    var item = regularItems[ri];
    var group = getDateGroup(item.lastActivity || 0);
    if (group !== currentGroup) {
      currentGroup = group;
      currentGroupIds = [];
      for (var gi = ri; gi < regularItems.length; gi++) {
        if (getDateGroup(regularItems[gi].lastActivity || 0) !== group) break;
        var groupIds = collectItemSessionIds(regularItems[gi]);
        for (var gj = 0; gj < groupIds.length; gj++) currentGroupIds.push(groupIds[gj]);
      }
      if (group !== "Today") {
        regularContainer.appendChild(createSessionGroupHeader(group, currentGroupIds));
      }
    }
    if (item.type === "loop") {
      var loopEl = renderLoopGroup(item.loopId, item.children, item.groupKey);
      if (loopEl) {
        regularContainer.appendChild(loopEl);
      }
    } else {
      regularContainer.appendChild(renderSessionItem(item.data));
    }
  }
  getSessionListEl().appendChild(regularContainer);
  refreshIcons();
  if (updatePageTitle) updatePageTitle();
  syncHeaderSearchUi();
  // Re-arm the countdown timer after each render. startCountdownTimer() is a
  // no-op when schedules are outside the 3-minute window or the timer is
  // already running, so calling it here is safe and low-cost.
  startCountdownTimer();
}

// --- Search results ---

export function handleSearchResults(msg) {
  if (msg.query !== searchQuery) return; // stale response
  var ids = new Set();
  for (var i = 0; i < msg.results.length; i++) {
    ids.add(msg.results[i].id);
  }
  searchMatchIds = ids;
  renderSessionList(null);
}

// --- Session presence ---

export function updateSessionPresence(presence) {
  sessionPresence = presence;
  // Update presence avatars on existing session items without full re-render
  var items = getSessionListEl().querySelectorAll("[data-session-id]");
  for (var i = 0; i < items.length; i++) {
    renderPresenceAvatars(items[i], items[i].dataset.sessionId);
  }
}

export function getSessionPresenceUsers(sessionId) {
  return sessionPresence[String(sessionId)] || sessionPresence[sessionId] || [];
}

function presenceAvatarUrl(userOrStyle, seed) {
  if (userOrStyle && typeof userOrStyle === "object") return userAvatarUrl(userOrStyle, 24);
  return avatarUrl(userOrStyle || "thumbs", seed, 24);
}

function renderPresenceAvatars(el, sessionId) {
  // Remove existing presence container
  var existing = el.querySelector(".session-presence");
  if (existing) existing.remove();

  var users = sessionPresence[sessionId];
  if (!users || users.length === 0) return;

  var container = document.createElement("span");
  container.className = "session-presence";

  var max = 3;
  var shown = users.length > max ? max : users.length;
  for (var i = 0; i < shown; i++) {
    var u = users[i];
    var img = document.createElement("img");
    img.className = "session-presence-avatar";
    img.src = presenceAvatarUrl(u);
    img.alt = u.displayName;
    img.dataset.tip = u.displayName + (u.username ? " (@" + u.username + ")" : "");
    if (i > 0) img.style.marginLeft = "-6px";
    container.appendChild(img);
  }
  if (users.length > max) {
    var more = document.createElement("span");
    more.className = "session-presence-more";
    more.textContent = "+" + (users.length - max);
    container.appendChild(more);
  }

  // Insert before the more-btn
  var moreBtn = el.querySelector(".session-more-btn");
  if (moreBtn) {
    el.insertBefore(container, moreBtn);
  } else {
    el.appendChild(container);
  }
}

// --- Session badge ---

export function updateSessionBadge(sessionId, count) {
  var badge = document.querySelector('.session-unread-badge[data-session-id="' + sessionId + '"]');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.add("has-unread");
  } else {
    badge.textContent = "";
    badge.classList.remove("has-unread");
  }
}

// --- Countdown timer ---

function startCountdownTimer() {
  // Only arm the 1s interval when there are schedules within the 3-minute
  // window. Without this guard the interval fired every second for the
  // entire session lifetime even with no upcoming schedules.
  if (countdownTimer) return;
  var upcoming = getUpcomingSchedules(3 * 60 * 1000);
  if (upcoming.length === 0) return;
  countdownTimer = setInterval(updateCountdowns, 1000);
}

function stopCountdownTimer() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function updateCountdowns() {
  if (!getSessionListEl()) return;
  var upcoming = getUpcomingSchedules(3 * 60 * 1000); // 3 minutes

  // Remove stale container
  if (countdownContainer && !getSessionListEl().contains(countdownContainer)) {
    countdownContainer = null;
  }

  if (upcoming.length === 0) {
    if (countdownContainer) {
      countdownContainer.remove();
      countdownContainer = null;
    }
    stopCountdownTimer();
    return;
  }

  if (!countdownContainer) {
    countdownContainer = document.createElement("div");
    countdownContainer.className = "session-countdown-group";
    var stickyTop = getSessionListEl().querySelector(".session-list-sticky-top");
    if (stickyTop && stickyTop.nextSibling) {
      getSessionListEl().insertBefore(countdownContainer, stickyTop.nextSibling);
    } else if (stickyTop) {
      getSessionListEl().appendChild(countdownContainer);
    } else {
      getSessionListEl().insertBefore(countdownContainer, getSessionListEl().firstChild);
    }
  }

  var html = "";
  var now = Date.now();
  for (var i = 0; i < upcoming.length; i++) {
    var u = upcoming[i];
    var remaining = Math.max(0, Math.ceil((u.nextRunAt - now) / 1000));
    var min = Math.floor(remaining / 60);
    var sec = remaining % 60;
    var timeStr = min + ":" + (sec < 10 ? "0" : "") + sec;
    // u.color is server-controlled; only accept a strict hex color into the
    // string-built style="" attribute — anything else is dropped.
    var safeCountdownColor = u.color && /^#[0-9a-f]{3,8}$/i.test(u.color) ? u.color : null;
    var colorStyle = safeCountdownColor ? " style=\"border-left-color:" + safeCountdownColor + "\"" : "";
    html += '<div class="session-countdown-item"' + colorStyle + '>';
    html += '<span class="session-countdown-name">' + escapeHtml(u.name) + '</span>';
    html += '<span class="session-countdown-badge">' + timeStr + '</span>';
    html += '</div>';
  }
  countdownContainer.innerHTML = html;
}

// --- CLI session picker ---

export function populateCliSessionList(sessions) {
  var pickerLoading = document.getElementById("resume-picker-loading");
  var pickerEmpty = document.getElementById("resume-picker-empty");
  var pickerList = document.getElementById("resume-picker-list");
  if (!pickerLoading || !pickerList) return;

  pickerLoading.classList.add("hidden");

  if (!sessions || sessions.length === 0) {
    pickerEmpty.classList.remove("hidden");
    pickerList.classList.add("hidden");
    return;
  }

  pickerEmpty.classList.add("hidden");
  pickerList.classList.remove("hidden");
  pickerList.innerHTML = "";

  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    var item = document.createElement("div");
    item.className = "cli-session-item";

    var title = document.createElement("div");
    title.className = "cli-session-title";
    title.textContent = s.firstPrompt || "Untitled session";
    item.appendChild(title);

    var meta = document.createElement("div");
    meta.className = "cli-session-meta";
    if (s.lastActivity) {
      var time = document.createElement("span");
      time.textContent = relativeTime(s.lastActivity);
      meta.appendChild(time);
    }
    if (s.model) {
      var model = document.createElement("span");
      model.className = "badge";
      model.textContent = s.model;
      meta.appendChild(model);
    }
    if (s.gitBranch) {
      var branch = document.createElement("span");
      branch.className = "badge";
      branch.textContent = s.gitBranch;
      meta.appendChild(branch);
    }
    item.appendChild(meta);

    (function (sessionId) {
      item.addEventListener("click", function () {
        if (getWs() && store.get('connected')) {
          getWs().send(JSON.stringify({ type: "resume_session", cliSessionId: sessionId }));
        }
        var modal = document.getElementById("resume-modal");
        if (modal) modal.classList.add("hidden");
        closeSidebar();
      });
    })(s.sessionId);

    pickerList.appendChild(item);
  }
}

