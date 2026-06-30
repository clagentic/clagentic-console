// diagnostics.js — Diagnostic event rendering for epic lr-1a52 stage 4/5 (lr-8294).
//
// Consumes { type:'diagnostic', severity:'info'|'warning'|'error', source:string, message:string,
//            actionable?:{label:string, action:string} } messages from the backend.
//
// Contract (set by stages 1-3, do NOT modify):
//   - The message arrives via sendAndRecord — it is persisted in session history.
//   - Diagnostics can arrive from any source (CLI stderr today, settings preflight in stage 5).
//   - severity 'warning' and 'error' produce a toast (info lands quietly in the panel).
//
// Public surface:
//   initDiagnostics()              — call once on page load (wires up panel button)
//   addDiagnostic(msg)             — call from processMessage case 'diagnostic'
//   formatDiagnosticSource(source) — pure helper, exported for tests

import { iconHtml, refreshIcons } from './icons.js';
import { formatDiagnosticSource as _formatSource } from './diagnostic-format.js';

// --- Module state ---
var diagnostics = [];   // [{severity, source, message, actionable, ts}]
var panelEl = null;
var panelListEl = null;
var panelToggleBtn = null;
var panelBadgeEl = null;

// Severity priority (higher = more prominent).
var SEVERITY_ORDER = { error: 2, warning: 1, info: 0 };

// ============================================================
// Init
// ============================================================

export function initDiagnostics() {
  panelEl = document.getElementById("diagnostics-panel");
  panelListEl = document.getElementById("diagnostics-panel-list");
  panelToggleBtn = document.getElementById("diagnostics-panel-btn");
  panelBadgeEl = document.getElementById("diagnostics-panel-badge");

  if (!panelEl || !panelListEl || !panelToggleBtn) return;

  // Close button inside the panel header.
  var closeBtn = panelEl.querySelector(".diagnostics-panel-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", function () {
      closePanel();
    });
  }

  // Toggle button in the topbar.
  panelToggleBtn.addEventListener("click", function () {
    if (panelEl.classList.contains("hidden")) {
      openPanel();
    } else {
      closePanel();
    }
  });

  // Keyboard: dismiss on Escape when panel is focused.
  panelEl.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closePanel();
      if (panelToggleBtn) panelToggleBtn.focus();
    }
  });
}

// ============================================================
// Public: add a diagnostic
// ============================================================

export function addDiagnostic(msg) {
  var entry = {
    severity: msg.severity || "info",
    source: msg.source || "",
    message: msg.message || "",
    actionable: msg.actionable || null,
    ts: Date.now(),
  };
  diagnostics.push(entry);

  // Render the new entry in the panel list.
  _appendEntry(entry);

  // Update the badge to reflect the highest-severity unread diagnostic.
  _updateBadge();

  // Toast for warning and error severity only.
  if (entry.severity === "warning" || entry.severity === "error") {
    _showDiagnosticToast(entry);
  }
}

// Re-export the pure formatter so callers that import from this module
// can reach it without a second import. Tests should import from
// diagnostic-format.js directly (no DOM deps there).
export { formatDiagnosticSource } from './diagnostic-format.js';

// ============================================================
// Toast
// ============================================================

function _showDiagnosticToast(entry) {
  var el = document.createElement("div");
  // Use a dedicated class so diagnostics are visually distinct from error messages.
  el.className = "toast toast-diagnostic toast-diagnostic-" + entry.severity;
  el.setAttribute("role", "alert");
  el.setAttribute("aria-live", "assertive");

  var headerEl = document.createElement("div");
  headerEl.className = "toast-diagnostic-header";

  var severityEl = document.createElement("span");
  severityEl.className = "toast-diagnostic-severity toast-diag-sev-" + entry.severity;
  severityEl.textContent = entry.severity.toUpperCase();

  var sourceEl = document.createElement("span");
  sourceEl.className = "toast-diagnostic-source";
  sourceEl.textContent = _formatSource(entry.source);

  var dismissBtn = document.createElement("button");
  dismissBtn.className = "toast-diagnostic-dismiss";
  dismissBtn.setAttribute("aria-label", "Dismiss diagnostic notification");
  dismissBtn.innerHTML = iconHtml("x");

  headerEl.appendChild(severityEl);
  headerEl.appendChild(sourceEl);
  headerEl.appendChild(dismissBtn);

  var msgEl = document.createElement("div");
  msgEl.className = "toast-diagnostic-msg";
  msgEl.textContent = entry.message;

  var hintEl = document.createElement("div");
  hintEl.className = "toast-diagnostic-hint";
  hintEl.textContent = "See Diagnostics panel for details";

  el.appendChild(headerEl);
  el.appendChild(msgEl);
  el.appendChild(hintEl);

  document.body.appendChild(el);
  refreshIcons();

  // Animate in.
  requestAnimationFrame(function () { el.classList.add("visible"); });

  // Auto-dismiss after 6s.
  var timer = setTimeout(function () { _removeDiagnosticToast(el); }, 6000);

  // Manual dismiss.
  dismissBtn.addEventListener("click", function () {
    clearTimeout(timer);
    _removeDiagnosticToast(el);
  });

  // Keyboard dismiss.
  el.addEventListener("keydown", function (e) {
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
      clearTimeout(timer);
      _removeDiagnosticToast(el);
    }
  });
}

function _removeDiagnosticToast(el) {
  el.classList.remove("visible");
  setTimeout(function () {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 300);
}

// ============================================================
// Panel
// ============================================================

function openPanel() {
  if (!panelEl) return;
  panelEl.classList.remove("hidden");
  panelEl.setAttribute("aria-expanded", "true");
  if (panelToggleBtn) {
    panelToggleBtn.setAttribute("aria-expanded", "true");
    panelToggleBtn.classList.add("active");
  }
  // Focus the panel for keyboard navigation.
  panelEl.focus();
}

function closePanel() {
  if (!panelEl) return;
  panelEl.classList.add("hidden");
  panelEl.setAttribute("aria-expanded", "false");
  if (panelToggleBtn) {
    panelToggleBtn.setAttribute("aria-expanded", "false");
    panelToggleBtn.classList.remove("active");
  }
}

function _appendEntry(entry) {
  if (!panelListEl) return;

  // Remove the empty-state placeholder if present.
  var emptyEl = panelListEl.querySelector(".diagnostics-empty");
  if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);

  var item = document.createElement("div");
  item.className = "diagnostics-item diagnostics-item-" + entry.severity;

  // Icon strip: severity pill.
  var meta = document.createElement("div");
  meta.className = "diagnostics-item-meta";

  var sevEl = document.createElement("span");
  sevEl.className = "diagnostics-sev-badge diagnostics-sev-" + entry.severity;
  sevEl.setAttribute("aria-label", "Severity: " + entry.severity);
  sevEl.textContent = entry.severity;

  var srcEl = document.createElement("span");
  srcEl.className = "diagnostics-source";
  srcEl.textContent = _formatSource(entry.source);

  meta.appendChild(sevEl);
  meta.appendChild(srcEl);

  var msgEl = document.createElement("div");
  msgEl.className = "diagnostics-message";
  msgEl.textContent = entry.message;

  item.appendChild(meta);
  item.appendChild(msgEl);

  // Actionable hint: surface label when present.
  if (entry.actionable && entry.actionable.label) {
    var actionEl = document.createElement("div");
    actionEl.className = "diagnostics-actionable";

    var fixIcon = document.createElement("span");
    fixIcon.className = "diagnostics-actionable-icon";
    fixIcon.innerHTML = iconHtml("info");

    var fixText = document.createElement("span");
    fixText.className = "diagnostics-actionable-text";
    fixText.textContent = entry.actionable.label;

    actionEl.appendChild(fixIcon);
    actionEl.appendChild(fixText);
    item.appendChild(actionEl);
    refreshIcons();
  }

  panelListEl.appendChild(item);

  // Scroll the panel to the newest entry.
  panelListEl.scrollTop = panelListEl.scrollHeight;
}

// ============================================================
// Badge
// ============================================================

function _updateBadge() {
  if (!panelBadgeEl) return;
  var count = diagnostics.length;
  if (count === 0) {
    panelBadgeEl.classList.add("hidden");
    return;
  }
  // Show count; cap at 99.
  panelBadgeEl.textContent = count > 99 ? "99+" : String(count);
  panelBadgeEl.classList.remove("hidden");

  // Badge color reflects the highest-severity diagnostic in the list.
  panelBadgeEl.className = "diagnostics-panel-badge";
  var maxSev = "info";
  for (var i = 0; i < diagnostics.length; i++) {
    if (SEVERITY_ORDER[diagnostics[i].severity] > SEVERITY_ORDER[maxSev]) {
      maxSev = diagnostics[i].severity;
    }
  }
  panelBadgeEl.classList.add("diagnostics-badge-" + maxSev);
}
