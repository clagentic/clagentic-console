// app-header.js - Session rename, session info popover, progressive history loading
// Extracted from app.js (PR-34)

import { refreshIcons, iconHtml } from './icons.js';
import { escapeHtml, copyToClipboard } from './utils.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { getMessagesEl } from './dom-refs.js';
import { getActivityEl, setActivityEl, getTurnCounter, setTurnCounter, getPrependAnchor, setPrependAnchor, finalizeAssistantBlock, resetCurrentFullText } from './app-rendering.js';
import { processMessage } from './app-messages.js';
import { saveToolState, resetToolState, restoreToolState } from './tools.js';
import { getSessionUsage, setSessionUsage, getContextData, setContextData, updateContextPanel, updateUsagePanel } from './app-panels.js';
import { onHistoryPrepended as onSessionSearchHistoryPrepended } from './session-search.js';
import { positionPopover } from './popover-position.js';

// --- Module-owned state ---
var sessionInfoPopover = null;
var historySentinelObserver = null;

export function initHeader() {
  var headerRenameBtn = document.getElementById("header-rename-btn");
  var headerTitleEl = document.getElementById("header-title");
  var headerInfoBtn = document.getElementById("header-info-btn");

  // --- Header session rename ---
  if (headerRenameBtn) {
    headerRenameBtn.addEventListener("click", function () {
      if (!store.get('activeSessionId')) return;
      var currentText = headerTitleEl.textContent;
      var input = document.createElement("input");
      input.type = "text";
      input.className = "header-rename-input";
      input.value = currentText;
      headerTitleEl.style.display = "none";
      headerRenameBtn.style.display = "none";
      headerTitleEl.parentNode.insertBefore(input, headerTitleEl.nextSibling);
      input.focus();
      input.select();

      function commit() {
        var newTitle = input.value.trim();
        var ws = getWs();
        if (newTitle && newTitle !== currentText && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "rename_session", id: store.get('activeSessionId'), title: newTitle }));
          headerTitleEl.textContent = newTitle;
        }
        input.remove();
        headerTitleEl.style.display = "";
        headerRenameBtn.style.display = "";
      }

      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") {
          e.preventDefault();
          input.remove();
          headerTitleEl.style.display = "";
          headerRenameBtn.style.display = "";
        }
      });
      input.addEventListener("blur", commit);
    });
  }

  // --- Session info popover ---
  if (headerInfoBtn) {
    headerInfoBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (sessionInfoPopover) { closeSessionInfoPopover(); return; }

      var pop = document.createElement("div");
      pop.className = "session-info-popover";

      function addRow(label, value) {
        var val = value == null ? "-" : String(value);
        var row = document.createElement("div");
        row.className = "info-row";
        row.innerHTML =
          '<span class="info-label">' + label + '</span>' +
          '<span class="info-value">' + escapeHtml(val) + '</span>' +
          '<button class="info-copy-btn" title="Copy">' + iconHtml("copy") + '</button>';
        var btn = row.querySelector(".info-copy-btn");
        btn.addEventListener("click", function () {
          copyToClipboard(value || "").then(function () {
            btn.innerHTML = iconHtml("check");
            refreshIcons();
            setTimeout(function () { btn.innerHTML = iconHtml("copy"); refreshIcons(); }, 1200);
          });
        });
        pop.appendChild(row);
      }

      var s = store.snap();
      var vendor = s.currentVendor || "claude";
      if (s.cliSessionId) addRow("Session ID", s.cliSessionId);
      if (s.activeSessionId) addRow("Local ID", s.activeSessionId);
      if (s.cliSessionId) {
        var resumeCmd = vendor === "codex"
          ? "codex resume " + s.cliSessionId
          : "claude --resume " + s.cliSessionId;
        addRow("Resume", resumeCmd);
      }

      document.body.appendChild(pop);
      sessionInfoPopover = pop;
      refreshIcons();

      // Four-edge clamp (lr-a10a): the prior right-only clamp could leave
      // the popover's bottom edge off-screen on short viewports.
      positionPopover(pop, headerInfoBtn, { placement: "below" });
    });

    document.addEventListener("click", function (e) {
      if (sessionInfoPopover && !sessionInfoPopover.contains(e.target) && !e.target.closest("#header-info-btn")) {
        closeSessionInfoPopover();
      }
    });
  }
}

export function closeSessionInfoPopover() {
  if (sessionInfoPopover) {
    sessionInfoPopover.remove();
    sessionInfoPopover = null;
  }
}

export function updateHistorySentinel() {
  var messagesEl = getMessagesEl();
  var existing = messagesEl.querySelector(".history-sentinel");
  if (store.get('historyFrom') > 0) {
    // Never render a solitary sentinel (lr-c24b): if there is no visible
    // message currently rendered below where the sentinel would sit, a lone
    // "Load earlier messages" button with nothing above it is not a useful
    // affordance — trigger a load instead of displaying it. This can happen
    // after a prepend page advanced historyFrom without rendering any
    // visible content. Skipped mid-initial-replay (replayingHistory): that
    // path's own history_meta -> item stream -> history_done sequence is
    // already populating #messages and has not finished yet, so an empty
    // container at this instant is expected, not a stuck page.
    var hasRenderedContent = !!(existing ? existing.nextElementSibling : messagesEl.firstElementChild);
    if (!hasRenderedContent && !store.get('replayingHistory')) {
      if (existing) existing.remove();
      if (historySentinelObserver) { historySentinelObserver.disconnect(); historySentinelObserver = null; }
      if (!store.get('loadingMore')) requestMoreHistory();
      return;
    }
    if (!existing) {
      var sentinel = document.createElement("div");
      sentinel.className = "history-sentinel";
      sentinel.innerHTML = '<button class="load-more-btn">Load earlier messages</button>';
      sentinel.querySelector(".load-more-btn").addEventListener("click", function () {
        requestMoreHistory();
      });
      messagesEl.insertBefore(sentinel, messagesEl.firstChild);

      // Auto-load when sentinel scrolls into view
      if (historySentinelObserver) historySentinelObserver.disconnect();
      historySentinelObserver = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && !store.get('loadingMore') && store.get('historyFrom') > 0) {
          requestMoreHistory();
        }
      }, { root: messagesEl, rootMargin: "200px 0px 0px 0px" });
      historySentinelObserver.observe(sentinel);
    }
  } else {
    if (existing) existing.remove();
    if (historySentinelObserver) { historySentinelObserver.disconnect(); historySentinelObserver = null; }
  }
}

// Sends the load_more_history request. Assumes the caller has already
// validated preconditions (ws connected, historyFrom > 0) and set
// loadingMore — shared by requestMoreHistory (guarded, user/observer-
// triggered) and prependOlderHistory's auto-advance (lr-c24b), which is
// already mid-load and must not be blocked by the loadingMore guard.
function sendLoadMoreHistory(before) {
  var ws = getWs();
  if (!ws) return;
  var messagesEl = getMessagesEl();
  var btn = messagesEl.querySelector(".load-more-btn");
  if (btn) btn.classList.add("loading");
  ws.send(JSON.stringify({ type: "load_more_history", before: before }));
}

export function requestMoreHistory() {
  var ws = getWs();
  var s = store.snap();
  if (s.loadingMore || s.historyFrom <= 0 || !ws || !s.connected) return;
  store.set({ loadingMore: true });
  sendLoadMoreHistory(s.historyFrom);
}

export function prependOlderHistory(items, meta) {
  var messagesEl = getMessagesEl();

  // Save current rendering state
  var savedMsgEl = store.get('currentMsgEl');
  var savedActivity = getActivityEl();
  var savedFullText = store.get('currentFullText');
  var savedTurnCounter = getTurnCounter();
  var savedToolsState = saveToolState();
  // Save context & usage so old result messages don't overwrite current values
  var savedContext = JSON.parse(JSON.stringify(getContextData()));
  var savedUsage = JSON.parse(JSON.stringify(getSessionUsage()));

  // Reset to initial values for clean rendering
  store.set({ currentMsgEl: null, currentFullText: "" });
  resetCurrentFullText("");
  setActivityEl(null);
  setTurnCounter(0);
  resetToolState();

  // Set prepend anchor to insert before existing content
  // Skip the sentinel itself when setting anchor
  var firstReal = messagesEl.querySelector(".history-sentinel");
  setPrependAnchor(firstReal ? firstReal.nextSibling : messagesEl.firstChild);

  // Remember the first existing content element and its position
  var anchorEl = getPrependAnchor();
  var anchorOffset = anchorEl ? anchorEl.getBoundingClientRect().top : 0;

  // Snapshot the sibling immediately before the anchor (or the last child,
  // when the container was empty) so the batch's visible yield can be
  // measured after rendering (lr-c24b). addToMessages() (app-rendering.js)
  // is the single choke point for top-level #messages insertion during
  // processMessage(), and it always inserts immediately before the current
  // prepend anchor — so any new node from this batch appears between this
  // snapshot and anchorEl. anchorEl itself is never removed/replaced by the
  // rendering pipeline, so it remains a stable reference across the batch.
  var siblingBeforeAnchor = anchorEl ? anchorEl.previousSibling : messagesEl.lastChild;

  // Process each item through the rendering pipeline
  for (var i = 0; i < items.length; i++) {
    processMessage(items[i]);
  }

  // Finalize any open assistant block from the batch
  finalizeAssistantBlock();

  // Clear prepend mode
  setPrependAnchor(null);

  // Did this page render any visible DOM? If the sibling immediately before
  // the anchor (or the container's last child, for an initially-empty
  // container) is unchanged, the batch inserted nothing new.
  var renderedNoVisibleContent = anchorEl
    ? anchorEl.previousSibling === siblingBeforeAnchor
    : messagesEl.lastChild === siblingBeforeAnchor;

  // Restore saved state
  store.set({ currentMsgEl: savedMsgEl, currentFullText: savedFullText });
  resetCurrentFullText(savedFullText);
  setActivityEl(savedActivity);
  setTurnCounter(savedTurnCounter);
  restoreToolState(savedToolsState);
  // Restore context & usage (old result messages must not overwrite current values)
  setContextData(savedContext);
  setSessionUsage(savedUsage);
  updateContextPanel();
  updateUsagePanel();

  // Fix scroll: restore anchor element to same visual position
  if (anchorEl) {
    var newTop = anchorEl.getBoundingClientRect().top;
    messagesEl.scrollTop += (newTop - anchorOffset);
  }

  // Update state
  store.set({ historyFrom: meta.from });

  // Renumber data-turn attributes in DOM order
  var turnEls = messagesEl.querySelectorAll("[data-turn]");
  for (var t = 0; t < turnEls.length; t++) {
    turnEls[t].dataset.turn = t + 1;
  }
  setTurnCounter(turnEls.length);

  // Auto-advance when this page rendered nothing visible (lr-c24b): the
  // server already extends the window by turn boundary to surface a visible
  // event when possible, but a bounded extension can still exhaust its step
  // cap on a pathologically long invisible-yield run. One user click (or one
  // sentinel auto-load) must always surface >=1 message when older history
  // exists — settle loadingMore:false only once something rendered, or there
  // is nothing left to load.
  if (renderedNoVisibleContent && meta.hasMore) {
    // loadingMore stays true; the next history_prepend response re-enters
    // this function and re-evaluates.
    sendLoadMoreHistory(meta.from);
  } else {
    store.set({ loadingMore: false });
    // Update sentinel
    if (meta.hasMore) {
      var btn = messagesEl.querySelector(".load-more-btn");
      if (btn) btn.classList.remove("loading");
    } else {
      updateHistorySentinel();
    }
  }

  // Notify in-session search that history was prepended (for pending scroll targets)
  onSessionSearchHistoryPrepended();
}
