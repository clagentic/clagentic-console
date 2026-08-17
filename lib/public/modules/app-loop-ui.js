// app-loop-ui.js - Ralph Loop UI: bars, banners, preview modal, execution modal
// Wizard logic extracted to app-loop-wizard.js

import { refreshIcons, iconHtml } from './icons.js';
import { escapeHtml } from './utils.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { showConfirm } from './app-misc.js';
import { openRalphWizard } from './app-loop-wizard.js';
import { openSchedulerToTab } from './scheduler.js';
import { renderModelList, renderModeList, renderEffortBar, renderThinkingBar } from './settings-defaults.js';

// Execution modal: module-internal UI var (not in store)
var pendingIterations = 20;

// ========================================================
// Init
// ========================================================

// lr-fd38ac follow-up: re-check the queue-mode gate whenever the fields it
// depends on change, not only when a handler happens to remember to call
// updateLoopInputVisibility() itself. loop_iteration/loop_judging
// (app-messages.js) write loopCurrentSessionId without re-invoking the
// gate — that used to leave loopQueueMode stale-false for a client already
// viewing the loop's own session (queued messages silently dropped instead
// of queued, the inverse of the original lr-fd38ac bug). See
// recheckLoopQueueModeFromState() for why this branch does not need the
// raw per-session `loop` object that updateLoopInputVisibility()'s direct
// callers (session_switched et al.) pass in.
//
// Split out from initLoopUi() so it can be installed on its own — the rest
// of initLoopUi() renders DOM (banners, buttons) that a unit test covering
// only this reactive gate has no reason to depend on.
export function initLoopQueueModeSync() {
  store.subscribe(['loopActive', 'loopCurrentSessionId', 'activeSessionId'], function () {
    recheckLoopQueueModeFromState();
  });
}

export function initLoopUi() {

  // --- Reactive UI sync for loop state ---
  store.subscribe(['loopActive', 'ralphPhase', 'loopIteration', 'loopMaxIterations', 'ralphCraftingSessionId', 'ralphCraftingSource', 'activeSessionId'], function (state, prev) {
    if (state.loopActive !== prev.loopActive ||
        state.ralphPhase !== prev.ralphPhase ||
        state.loopIteration !== prev.loopIteration ||
        state.loopMaxIterations !== prev.loopMaxIterations) {
      updateLoopButton();
    }
    if (state.ralphPhase !== prev.ralphPhase ||
        state.ralphCraftingSessionId !== prev.ralphCraftingSessionId ||
        state.ralphCraftingSource !== prev.ralphCraftingSource ||
        state.activeSessionId !== prev.activeSessionId) {
      updateRalphBars();
    }
  });

  initLoopQueueModeSync();

  // --- Preview modal listeners ---
  // Backdrop click intentionally does NOT close the modal (no way to reopen it)

  // Run button in preview modal footer
  var previewRunBtn = document.getElementById("ralph-preview-run");
  if (previewRunBtn) {
    previewRunBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      closeRalphPreviewModal();
      startLoopFromUi();
    });
  }

  // Delete/cancel button in preview modal header
  var previewDeleteBtn = document.getElementById("ralph-preview-delete");
  if (previewDeleteBtn) {
    previewDeleteBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      closeRalphPreviewModal();
      showConfirm("Discard this loop setup?", function() {
        var ws = getWs();
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "ralph_wizard_cancel" }));
        }
        var stickyEl = document.getElementById("ralph-sticky");
        if (stickyEl) {
          stickyEl.classList.add("hidden");
          stickyEl.classList.remove("ralph-ready");
          stickyEl.innerHTML = "";
        }
      });
    });
  }

  var previewTabs = document.querySelectorAll(".ralph-tab");
  for (var ti = 0; ti < previewTabs.length; ti++) {
    previewTabs[ti].addEventListener("click", function() {
      showRalphPreviewTab(this.getAttribute("data-tab"));
    });
  }

  // Iterations input in preview modal footer
  var previewIterInput = document.getElementById("ralph-preview-iterations");
  if (previewIterInput) {
    previewIterInput.addEventListener("input", function () {
      pendingIterations = parseInt(this.value, 10) || pendingIterations;
      syncIterationsUi();
    });
  }
}

// ========================================================
// Iteration sync helper
// ========================================================

function syncIterationsUi() {
  var wizData = store.get('wizardData') || {};
  var isSimple = wizData.loopMode === "simple";
  var label = isSimple ? ("Run x" + pendingIterations) : ("Start (max " + pendingIterations + ")");

  // Sync sticky bar input
  var stickyIter = document.getElementById("ralph-sticky-iterations");
  if (stickyIter && parseInt(stickyIter.value, 10) !== pendingIterations) {
    stickyIter.value = pendingIterations;
  }
  var stickyStartBtn = document.querySelector(".ralph-sticky-start");
  if (stickyStartBtn) stickyStartBtn.title = label;

  // Sync preview modal input
  var previewIter = document.getElementById("ralph-preview-iterations");
  if (previewIter && parseInt(previewIter.value, 10) !== pendingIterations) {
    previewIter.value = pendingIterations;
  }
  var comboLabel = document.getElementById("ralph-run-combo-label");
  if (comboLabel) comboLabel.textContent = isSimple ? "Run x" : "Start max";
}

// ========================================================
// Start loop from UI (shared by sticky bar + exec modal)
// ========================================================

function startLoopFromUi() {
  var basePath = store.get('basePath');
  var stickyEl = document.getElementById("ralph-sticky");

  fetch(basePath + "api/git-dirty")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.dirty) {
        var fileList = (data.files || []).slice(0, 15).join("\n");
        if (data.files && data.files.length > 15) fileList += "\n... and " + (data.files.length - 15) + " more";
        var msg = "You have uncommitted changes. The loop uses git diff to track progress, so uncommitted files may cause unexpected results.\n\n" + fileList + "\n\nStart anyway?";
        showConfirm(msg, function () {
          sendLoopStart();
          if (stickyEl) { stickyEl.classList.add("hidden"); stickyEl.innerHTML = ""; }
        }, "Start anyway", false);
      } else {
        sendLoopStart();
        if (stickyEl) { stickyEl.classList.add("hidden"); stickyEl.innerHTML = ""; }
      }
    })
    .catch(function () {
      sendLoopStart();
      if (stickyEl) { stickyEl.classList.add("hidden"); stickyEl.innerHTML = ""; }
    });
}

function sendLoopStart() {
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    var msg = { type: "loop_start", maxIterations: pendingIterations };
    if (Object.keys(_previewLoopSettings).length > 0) {
      msg.settings = _previewLoopSettings;
    }
    ws.send(JSON.stringify(msg));
  }
}

// ========================================================
// Loop UI (exported)
// ========================================================

// lr-e31b: An active (non-crafting) loop iteration session used to hide the
// composer outright, leaving no way for a human to get a message into a
// running loop. Loop iterations are single-turn SDK sessions whose input
// stream is closed immediately after the first push (see the comment in
// project-loop.js runNextIteration()), so a live message cannot be injected
// into the in-flight turn — it is queued and delivered at the next
// iteration boundary instead. The composer stays visible and enabled;
// input.js routes the send through `loop_message` while loopQueueMode is set.
//
// lr-fd38ac: the per-session `loop.active` marker (persisted on the session
// itself, see sessions.js:109/711) is not reliably cleared for every loop
// session by the server (finishLoop() historically cleared only the last
// coder session, and never persisted the clear — see project-loop.js
// finishLoop() for the accompanying server-side fix). A stale `active: true`
// on disk would re-arm queue mode for a session whose loop has already
// ended, misrouting every send into `loop_message`, which the server
// correctly rejects (no loop is running). Gate on the GLOBAL loop-running
// flag as well, and require the loop's own current session to be the one
// actually being viewed (per lr-0cae's scoping precedent) — a per-session
// marker alone is never sufficient to arm queue mode.
export function updateLoopInputVisibility(loop) {
  var inputArea = document.getElementById("input-area");
  if (!inputArea) return;
  inputArea.style.display = "";
  var s = store.snap();
  var queueMode = !!(
    loop && loop.active && loop.role !== "crafting" &&
    s.loopActive && s.loopCurrentSessionId === s.activeSessionId
  );
  applyLoopQueueMode(queueMode);
}

// lr-fd38ac follow-up: shared by updateLoopInputVisibility() (per-session
// `loop` object supplied by the caller — session_switched, loop_available,
// loop_finished) and recheckLoopQueueModeFromState() (no `loop` object
// available; see that function's comment for why store state alone is
// sufficient there). Applies the derived boolean to the store and syncs
// the composer placeholder.
function applyLoopQueueMode(queueMode) {
  var inputEl = document.getElementById("input");
  if (inputEl) {
    if (queueMode) {
      inputEl.placeholder = "Message queues for the next loop iteration…";
    } else if (inputEl.placeholder.indexOf("queues for the next loop iteration") !== -1) {
      inputEl.placeholder = "Message Claude Code...";
    }
  }
  store.set({ loopQueueMode: queueMode });
}

// lr-fd38ac follow-up: re-derive queue mode from store state alone, for the
// reactive subscriber in initLoopUi() — it fires on loopActive/
// loopCurrentSessionId/activeSessionId changes, none of which carry a
// per-session `loop` object the way session_switched's msg.loop does.
//
// This is safe without that object because of a server-side invariant in
// project-loop.js: loopCurrentSessionId is only ever set (via loop_iteration
// or loop_judging) to a session whose own loop.active is true and whose
// loop.role is "coder" or "judge" — never "crafting", and never a stale
// session (finishLoop() clears loopCurrentSessionId to null in the same
// pass that flips every one of the loop's sessions' loop.active to false,
// per the Part 1 fix). So once loopCurrentSessionId === activeSessionId,
// the session actually being viewed IS that loop's own current session —
// the loop.active/role checks updateLoopInputVisibility() performs on the
// caller-supplied object are already guaranteed by that equality and don't
// need to be re-derived here.
function recheckLoopQueueModeFromState() {
  var inputArea = document.getElementById("input-area");
  if (!inputArea) return;
  var s = store.snap();
  var queueMode = !!(s.loopActive && s.loopCurrentSessionId != null && s.loopCurrentSessionId === s.activeSessionId);
  applyLoopQueueMode(queueMode);
}

export function updateLoopButton() {
  var section = document.getElementById("ralph-loop-section");
  if (!section) return;

  var s = store.snap();
  var busy = s.loopActive || s.ralphPhase === "executing";
  var phase = busy ? "executing" : s.ralphPhase;

  var statusHtml = "";
  var statusClass = "";
  var clickAction = "wizard"; // default

  if (phase === "crafting") {
    statusHtml = '<span class="ralph-section-status crafting">' + iconHtml("loader", "icon-spin") + ' Crafting\u2026</span>';
    clickAction = "none";
  } else if (phase === "approval") {
    statusHtml = '<span class="ralph-section-status ready">Ready</span>';
    statusClass = "ralph-section-ready";
    clickAction = "none";
  } else if (phase === "executing") {
    var iterText = s.loopIteration > 0 ? "Running \u00b7 iteration " + s.loopIteration + "/" + s.loopMaxIterations : "Starting\u2026";
    statusHtml = '<span class="ralph-section-status running">' + iconHtml("loader", "icon-spin") + ' ' + iterText + '</span>';
    statusClass = "ralph-section-running";
    clickAction = "popover";
  } else if (phase === "done") {
    statusHtml = '<span class="ralph-section-status done">\u2713 Done</span>';
    statusHtml += '<a href="#" class="ralph-section-tasks-link">View in Scheduled Tasks</a>';
    statusClass = "ralph-section-done";
    clickAction = "wizard";
  } else {
    // idle
    statusHtml = '<span class="ralph-section-hint">Start a new loop</span>';
  }

  section.className = "ralph-loop-section" + (statusClass ? " " + statusClass : "");
  section.innerHTML =
    '<div class="ralph-section-inner">' +
      '<div class="ralph-section-header">' +
        '<span class="ralph-section-icon">' + iconHtml("repeat") + '</span>' +
        '<span class="ralph-section-label">Loop</span>' +
        '<span class="loop-experimental"><i data-lucide="flask-conical"></i> experimental</span>' +
      '</div>' +
      '<div class="ralph-section-body">' + statusHtml + '</div>' +
    '</div>';

  refreshIcons();

  // Click handler on header
  var header = section.querySelector(".ralph-section-header");
  if (header) {
    header.style.cursor = clickAction === "none" ? "default" : "pointer";
    header.addEventListener("click", function() {
      if (clickAction === "popover") {
        toggleLoopPopover();
      } else if (clickAction === "wizard") {
        openRalphWizard();
      }
    });
  }

  // "View in Scheduled Tasks" link
  var tasksLink = section.querySelector(".ralph-section-tasks-link");
  if (tasksLink) {
    tasksLink.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation();
      openSchedulerToTab("library");
    });
  }
}

export function showLoopBanner(show) {
  var stickyEl = document.getElementById("ralph-sticky");
  if (!stickyEl) { updateLoopButton(); return; }
  if (!show) {
    stickyEl.classList.add("hidden");
    stickyEl.classList.remove("ralph-running");
    stickyEl.innerHTML = "";
    updateLoopButton();
    return;
  }

  var bannerLabel = store.get('loopBannerName') || "Loop";
  stickyEl.innerHTML =
    '<div class="ralph-sticky-inner">' +
      '<div class="ralph-sticky-header">' +
        '<button class="ralph-sticky-nav" title="Go to loop session">' +
          '<span class="ralph-sticky-icon">' + iconHtml("repeat") + '</span>' +
          '<span class="ralph-sticky-label">' + escapeHtml(bannerLabel) + '</span>' +
          '<span class="ralph-sticky-status" id="loop-status">Starting\u2026</span>' +
        '</button>' +
        '<button class="ralph-sticky-action ralph-sticky-stop" title="Stop loop">' + iconHtml("square") + '</button>' +
      '</div>' +
    '</div>';
  stickyEl.classList.remove("hidden", "ralph-ready");
  stickyEl.classList.add("ralph-running");
  refreshIcons();

  stickyEl.querySelector(".ralph-sticky-nav").addEventListener("click", function(e) {
    e.stopPropagation();
    var sid = store.get('loopCurrentSessionId');
    var w = getWs();
    if (sid && w && w.readyState === 1) {
      w.send(JSON.stringify({ type: "switch_session", id: sid }));
    }
  });

  stickyEl.querySelector(".ralph-sticky-stop").addEventListener("click", function(e) {
    e.stopPropagation();
    var w = getWs();
    if (w && w.readyState === 1) {
      w.send(JSON.stringify({ type: "loop_stop" }));
    }
  });
  updateLoopButton();
  updateLoopPendingBanner();
}

export function updateLoopBanner(iteration, maxIterations, phase) {
  var statusEl = document.getElementById("loop-status");
  if (!statusEl) return;
  var text;
  if (phase === "stopping") {
    text = "Stopping\u2026";
  } else if (maxIterations <= 1) {
    text = phase === "judging" ? "judging\u2026" : "running";
  } else {
    text = "#" + iteration + "/" + maxIterations;
    if (phase === "judging") text += " judging\u2026";
    else text += " running";
  }
  statusEl.textContent = text;
}

// lr-e31b: Render (or clear) the "N queued" pill in the running-loop sticky
// banner so the human can see a message they sent is waiting for the next
// iteration boundary rather than wondering if it was silently dropped.
// lr-4a9c: the pill is now clickable — it expands into a per-message list
// with a dismiss button so a message queued by mistake doesn't have to wait
// for delivery.
export function updateLoopPendingBanner() {
  var stickyEl = document.getElementById("ralph-sticky");
  if (!stickyEl || !stickyEl.classList.contains("ralph-running")) return;
  var header = stickyEl.querySelector(".ralph-sticky-header");
  if (!header) return;
  var pending = store.get('loopPendingMessages') || [];
  var pill = document.getElementById("loop-pending-pill");
  if (pending.length === 0) {
    if (pill) pill.remove();
    closeLoopPendingPopover();
    return;
  }
  var label = pending.length + " message" + (pending.length > 1 ? "s" : "") + " queued";
  if (!pill) {
    pill = document.createElement("button");
    pill.id = "loop-pending-pill";
    pill.type = "button";
    pill.className = "ralph-sticky-pending";
    pill.title = "Click to view and remove queued messages";
    var statusEl2 = document.getElementById("loop-status");
    if (statusEl2 && statusEl2.parentNode) {
      statusEl2.parentNode.insertBefore(pill, statusEl2.nextSibling);
    } else {
      header.appendChild(pill);
    }
    pill.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleLoopPendingPopover(pill);
    });
  }
  pill.textContent = label;

  // Keep an already-open popover's list in sync (e.g. after a remove
  // confirmation or a new message being queued while it's open).
  if (document.getElementById("loop-pending-popover")) {
    renderLoopPendingPopoverList();
  }
}

// ========================================================
// Pending-message popover: list + per-item dismiss (lr-4a9c)
// ========================================================

function closeLoopPendingPopover() {
  var existing = document.getElementById("loop-pending-popover");
  if (existing) existing.remove();
}

function toggleLoopPendingPopover(anchorEl) {
  var existing = document.getElementById("loop-pending-popover");
  if (existing) {
    closeLoopPendingPopover();
    return;
  }

  var popover = document.createElement("div");
  popover.id = "loop-pending-popover";
  popover.className = "loop-pending-popover";
  anchorEl.parentNode.appendChild(popover);
  renderLoopPendingPopoverList();

  // Close on outside click (deferred so this click doesn't immediately close it).
  setTimeout(function () {
    document.addEventListener("click", onOutsideClick);
  }, 0);
  function onOutsideClick(e) {
    var pop = document.getElementById("loop-pending-popover");
    if (!pop) {
      document.removeEventListener("click", onOutsideClick);
      return;
    }
    if (!pop.contains(e.target) && e.target !== anchorEl) {
      closeLoopPendingPopover();
      document.removeEventListener("click", onOutsideClick);
    }
  }
}

function renderLoopPendingPopoverList() {
  var popover = document.getElementById("loop-pending-popover");
  if (!popover) return;
  var pending = store.get('loopPendingMessages') || [];
  if (pending.length === 0) {
    closeLoopPendingPopover();
    return;
  }

  var html = '<div class="loop-pending-popover-title">Queued for next iteration</div><ul class="loop-pending-list">';
  for (var i = 0; i < pending.length; i++) {
    var m = pending[i];
    var preview = (m.text || "").length > 140 ? m.text.substring(0, 140) + "…" : (m.text || "");
    html += '<li class="loop-pending-item" data-id="' + escapeHtml(m.id || "") + '">' +
      '<span class="loop-pending-item-text">' + escapeHtml(preview) + '</span>' +
      '<button type="button" class="loop-pending-item-remove" title="Remove this queued message">' + iconHtml("x") + '</button>' +
      '</li>';
  }
  html += '</ul>';
  popover.innerHTML = html;
  refreshIcons();

  var removeBtns = popover.querySelectorAll(".loop-pending-item-remove");
  for (var bi = 0; bi < removeBtns.length; bi++) {
    removeBtns[bi].addEventListener("click", function (e) {
      e.stopPropagation();
      var li = this.closest(".loop-pending-item");
      var id = li && li.getAttribute("data-id");
      if (!id) return;
      var ws = getWs();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "loop_message_remove", id: id }));
      }
    });
  }
}

export function updateRalphBars() {
  // Task source uses the scheduler panel, not the sticky bar
  var s = store.snap();
  var isTaskSource = s.ralphCraftingSource !== "ralph";
  var onCraftingSession = s.ralphCraftingSessionId && s.activeSessionId === s.ralphCraftingSessionId;
  // If approval phase but no craftingSessionId (recovered after server restart), show bar anyway
  var recoveredApproval = s.ralphPhase === "approval" && !s.ralphCraftingSessionId;
  if (!isTaskSource && s.ralphPhase === "crafting" && onCraftingSession) {
    showRalphCraftingBar(true);
  } else {
    showRalphCraftingBar(false);
  }
  if (!isTaskSource && s.ralphPhase === "approval") {
    showRalphApprovalBar(true);
  } else {
    showRalphApprovalBar(false);
  }
  // Restore running loop banner on session switch
  if (s.loopActive && s.ralphPhase === "executing") {
    showLoopBanner(true);
    if (s.loopIteration > 0) {
      updateLoopBanner(s.loopIteration, s.loopMaxIterations, "running");
    }
  }

}

// ========================================================
// Internal: toggleLoopPopover
// ========================================================

function toggleLoopPopover() {
  var existing = document.getElementById("loop-status-modal");
  if (existing) {
    existing.remove();
    return;
  }

  var wizData = store.get('wizardData') || {};
  var taskPreview = wizData.task || "\u2014";
  if (taskPreview.length > 120) taskPreview = taskPreview.substring(0, 120) + "\u2026";
  var _s = store.snap();
  var statusText = "Iteration #" + _s.loopIteration + " / " + _s.loopMaxIterations;

  var modal = document.createElement("div");
  modal.id = "loop-status-modal";
  modal.className = "loop-status-modal";
  modal.innerHTML =
    '<div class="loop-status-backdrop"></div>' +
    '<div class="loop-status-dialog">' +
      '<div class="loop-status-dialog-header">' +
        '<span class="loop-status-dialog-icon">' + iconHtml("repeat") + '</span>' +
        '<span class="loop-status-dialog-title">Loop</span>' +
        '<button class="loop-status-dialog-close" title="Close">' + iconHtml("x") + '</button>' +
      '</div>' +
      '<div class="loop-status-dialog-body">' +
        '<div class="loop-status-dialog-row">' +
          '<span class="loop-status-dialog-label">Progress</span>' +
          '<span class="loop-status-dialog-value">' + escapeHtml(statusText) + '</span>' +
        '</div>' +
        '<div class="loop-status-dialog-row">' +
          '<span class="loop-status-dialog-label">Task</span>' +
          '<span class="loop-status-dialog-value loop-status-dialog-task">' + escapeHtml(taskPreview) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="loop-status-dialog-footer">' +
        '<button class="loop-status-dialog-stop">' + iconHtml("square") + ' Stop loop</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);
  refreshIcons();

  function closeModal() { modal.remove(); }

  modal.querySelector(".loop-status-backdrop").addEventListener("click", closeModal);
  modal.querySelector(".loop-status-dialog-close").addEventListener("click", closeModal);

  modal.querySelector(".loop-status-dialog-stop").addEventListener("click", function(e) {
    e.stopPropagation();
    closeModal();
    showConfirm("Stop the running " + (store.get('loopBannerName') || "loop") + "?", function() {
      var w = getWs();
      if (w && w.readyState === 1) {
        w.send(JSON.stringify({ type: "loop_stop" }));
      }
    });
  });
}

// ========================================================
// Crafting / Approval bars (exported)
// ========================================================

export function showRalphCraftingBar(show) {
  var stickyEl = document.getElementById("ralph-sticky");
  if (!stickyEl) return;
  if (!show) {
    stickyEl.classList.add("hidden");
    stickyEl.innerHTML = "";
    return;
  }
  stickyEl.innerHTML =
    '<div class="ralph-sticky-inner">' +
      '<div class="ralph-sticky-header">' +
        '<span class="ralph-sticky-icon">' + iconHtml("repeat") + '</span>' +
        '<span class="ralph-sticky-label">Ralph</span>' +
        '<span class="ralph-sticky-status">' + iconHtml("loader", "icon-spin") + ' Preparing\u2026</span>' +
        '<button class="ralph-sticky-cancel" title="Cancel">' + iconHtml("x") + '</button>' +
      '</div>' +
    '</div>';
  stickyEl.classList.remove("hidden");
  refreshIcons();

  var cancelBtn = stickyEl.querySelector(".ralph-sticky-cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      var ws = getWs();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "ralph_cancel_crafting" }));
      }
      showRalphCraftingBar(false);
      showRalphApprovalBar(false);
    });
  }
}

export function showRalphApprovalBar(show) {
  var stickyEl = document.getElementById("ralph-sticky");
  if (!stickyEl) return;
  if (!show) {
    // Only clear if we're in approval mode (don't clobber crafting)
    if (store.get('ralphPhase') !== "crafting") {
      stickyEl.classList.add("hidden");
      stickyEl.innerHTML = "";
    }
    return;
  }

  var wizData = store.get('wizardData') || {};
  var isSimple = wizData.loopMode === "simple";
  var defaultIter = isSimple ? 5 : 20;
  pendingIterations = defaultIter;

  var runLabel = isSimple ? ("Run x" + defaultIter) : ("Start (max " + defaultIter + ")");

  stickyEl.innerHTML =
    '<div class="ralph-sticky-inner">' +
      '<div class="ralph-sticky-header" id="ralph-sticky-header">' +
        '<span class="ralph-sticky-icon">' + iconHtml("repeat") + '</span>' +
        '<span class="ralph-sticky-label">Ralph</span>' +
        '<span class="ralph-sticky-status" id="ralph-sticky-status">Ready</span>' +
        '<input type="number" id="ralph-sticky-iterations" class="ralph-input-number ralph-sticky-iter" value="' + defaultIter + '" min="1" max="100">' +
        '<button class="ralph-sticky-action ralph-sticky-preview" title="Preview files">' + iconHtml("eye") + '</button>' +
        '<button class="ralph-sticky-action ralph-sticky-start" title="' + runLabel + '">' + iconHtml(wizData.cron ? "calendar-clock" : "play") + '</button>' +
        '<button class="ralph-sticky-action ralph-sticky-dismiss" title="Cancel and discard">' + iconHtml("x") + '</button>' +
      '</div>' +
    '</div>';
  stickyEl.classList.remove("hidden");
  refreshIcons();

  // Iteration input handler
  var stickyIterInput = document.getElementById("ralph-sticky-iterations");
  if (stickyIterInput) {
    stickyIterInput.addEventListener("input", function () {
      pendingIterations = parseInt(this.value, 10) || pendingIterations;
      syncIterationsUi();
    });
  }

  stickyEl.querySelector(".ralph-sticky-preview").addEventListener("click", function(e) {
    e.stopPropagation();
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "ralph_preview_files" }));
    }
  });

  stickyEl.querySelector(".ralph-sticky-start").addEventListener("click", function(e) {
    e.stopPropagation();
    startLoopFromUi();
  });

  stickyEl.querySelector(".ralph-sticky-dismiss").addEventListener("click", function(e) {
    e.stopPropagation();
    showConfirm("Discard this Ralph Loop setup?", function() {
      var ws = getWs();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "ralph_wizard_cancel" }));
      }
      stickyEl.classList.add("hidden");
      stickyEl.classList.remove("ralph-ready");
      stickyEl.innerHTML = "";
    });
  });

  updateRalphApprovalStatus();
}

export function updateRalphApprovalStatus() {
  var stickyEl = document.getElementById("ralph-sticky");
  var statusEl = document.getElementById("ralph-sticky-status");
  var startBtn = document.querySelector(".ralph-sticky-start");
  if (!statusEl) return;

  var wizData = store.get('wizardData') || {};
  var isSimple = wizData.loopMode === "simple";
  var _rf = store.get('ralphFilesReady');
  var ready = isSimple ? _rf.promptReady : _rf.bothReady;

  if (ready) {
    statusEl.textContent = "Ready";
    if (startBtn) startBtn.disabled = false;
    if (stickyEl) stickyEl.classList.add("ralph-ready");
  } else if (_rf.promptReady || _rf.judgeReady) {
    statusEl.textContent = "Partial\u2026";
    if (startBtn) startBtn.disabled = true;
    if (stickyEl) stickyEl.classList.remove("ralph-ready");
  } else {
    statusEl.textContent = "Waiting\u2026";
    if (startBtn) startBtn.disabled = true;
    if (stickyEl) stickyEl.classList.remove("ralph-ready");
  }
}

// ========================================================
// Preview modal (exported: openRalphPreviewModal, showExecModal)
// The preview modal doubles as the execution modal.
// showExecModal opens it with auto-popup flag set.
// ========================================================

export function showExecModal() {
  store.set({ execModalShown: true });
  // Open the preview modal immediately, then request file content to fill in
  openRalphPreviewModal();
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "ralph_preview_files" }));
  }
}

export function closeExecModal() {
  closeRalphPreviewModal();
}

export function updateExecModalStatus() {
  // no-op, preview modal updates on open
}

export function openRalphPreviewModal() {
  // Only show for loop (ralph) source, not scheduled tasks
  var st = store.snap();
  if (st.ralphCraftingSource !== "ralph") return;

  var modal = document.getElementById("ralph-preview-modal");
  if (!modal) return;

  var wizData = st.wizardData || {};
  var isSimple = wizData.loopMode === "simple";

  // Set defaults if not yet set
  if (!pendingIterations || pendingIterations <= 0) {
    pendingIterations = isSimple ? 5 : 20;
  }

  // Set name
  var nameEl = document.getElementById("ralph-preview-name");
  if (nameEl) {
    nameEl.textContent = (wizData && wizData.name) || "Loop";
  }

  // Hide JUDGE.md tab for simple loop
  var judgeTab = document.querySelector('#ralph-preview-modal .ralph-tab[data-tab="judge"]');
  if (judgeTab) judgeTab.style.display = isSimple ? "none" : "";

  // Update footer: iteration label + run button
  var iterInput = document.getElementById("ralph-preview-iterations");
  if (iterInput) iterInput.value = pendingIterations;

  var comboLabel = document.getElementById("ralph-run-combo-label");
  if (comboLabel) comboLabel.textContent = isSimple ? "Run x" : "Start max";

  var runBtn = document.getElementById("ralph-preview-run");
  if (runBtn) runBtn.disabled = !store.get('ralphFilesReady').bothReady;

  _previewLoopSettings = {};
  showRalphPreviewTab("prompt");
  modal.classList.remove("hidden");
  refreshIcons();
  syncIterationsUi();
}

function closeRalphPreviewModal() {
  var modal = document.getElementById("ralph-preview-modal");
  if (modal) modal.classList.add("hidden");
}

// Pending loop settings for the preview modal (saved to LOOP.json on launch)
var _previewLoopSettings = {};

function getPreviewLoopSettings() { return _previewLoopSettings; }

function showRalphPreviewTab(tab) {
  var tabs = document.querySelectorAll("#ralph-preview-modal .ralph-tab");
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].getAttribute("data-tab") === tab) {
      tabs[i].classList.add("active");
    } else {
      tabs[i].classList.remove("active");
    }
  }
  var body = document.getElementById("ralph-preview-body");
  if (!body) return;

  if (tab === "model") {
    renderPreviewModelTab(body);
    return;
  }

  var _rpc = store.get('ralphPreviewContent');
  var content = tab === "prompt" ? _rpc.prompt : _rpc.judge;
  if (typeof marked !== "undefined" && marked.parse) {
    body.innerHTML = '<div class="md-content">' + DOMPurify.sanitize(marked.parse(content)) + '</div>';
  } else {
    body.textContent = content;
  }
}

function renderPreviewModelTab(bodyEl) {
  var s = store.snap();

  bodyEl.innerHTML =
    '<div class="scheduler-model-settings">' +
      '<div class="settings-card"><div class="settings-field">' +
        '<label class="settings-label">Model</label>' +
        '<div class="settings-hint">Choose the Claude model for this loop.</div>' +
        '<div id="rp-model-scope" class="config-scope-label"></div>' +
        '<div id="rp-model-list" class="settings-model-list"></div>' +
      '</div></div>' +
      '<div class="settings-card"><div class="settings-field">' +
        '<label class="settings-label">Mode</label>' +
        '<div class="settings-hint">Controls how Claude handles tool use and file edits.</div>' +
        '<div id="rp-mode-list" class="settings-model-list"></div>' +
      '</div></div>' +
      '<div class="settings-card"><div class="settings-field">' +
        '<label class="settings-label">Effort</label>' +
        '<div class="settings-hint">Controls how much thinking effort Claude puts into responses.</div>' +
        '<div class="settings-btn-group" id="rp-effort-bar"></div>' +
      '</div></div>' +
      '<div class="settings-card"><div class="settings-field">' +
        '<label class="settings-label">Thinking</label>' +
        '<div class="settings-hint">Controls whether Claude shows its reasoning process.</div>' +
        '<div class="settings-btn-group" id="rp-thinking-bar"></div>' +
        '<div id="rp-thinking-budget-row" class="settings-budget-row" style="display:none">' +
          '<label class="settings-budget-label">Budget tokens</label>' +
          '<input id="rp-thinking-budget" type="number" class="settings-budget-input" min="1024" max="128000" step="1024" value="10000">' +
        '</div>' +
      '</div></div>' +
    '</div>';

  function savePreviewSetting(key, value) {
    _previewLoopSettings[key] = value;
  }

  var opts = {
    models: s.currentModels || [],
    currentModel: _previewLoopSettings.model || "",
    currentMode: _previewLoopSettings.permissionMode || "default",
    currentEffort: _previewLoopSettings.effort || "medium",
    currentThinking: _previewLoopSettings.thinking || "adaptive",
    currentThinkingBudget: _previewLoopSettings.thinkingBudget || 10000,
    sendMsg: function (msgType, data) {
      if (msgType === "rp_set_model") savePreviewSetting("model", data.model);
      else if (msgType === "rp_set_mode") savePreviewSetting("permissionMode", data.mode);
      else if (msgType === "rp_set_effort") savePreviewSetting("effort", data.effort);
      else if (msgType === "set_thinking") {
        savePreviewSetting("thinking", data.thinking);
        if (data.budgetTokens) savePreviewSetting("thinkingBudget", data.budgetTokens);
      }
    },
    modelMsgType: "rp_set_model",
    modeMsgType: "rp_set_mode",
    effortMsgType: "rp_set_effort",
    // lr-db0437: loop-scoped — this picker configures the Ralph-loop being
    // created, not the current session or any project/server default.
    scopeLabel: "Loop default (this Ralph-loop only)",
  };

  renderModelList("rp", opts);
  renderModeList("rp", opts);
  renderEffortBar("rp", opts);
  renderThinkingBar("rp", opts);
}
