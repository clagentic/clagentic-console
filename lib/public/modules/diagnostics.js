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
//
// Dismiss / clear-all (parity with app-notifications.js banner dismiss +
// clear-all, see initAppNotifications/dismissNotif/clearAllBanners there):
// diagnostics are client-side-only session state — there is no backend
// message type or persistence for them (unlike notifications, which round-
// trip a notification_dismiss/_dismiss_all message over the websocket).
// Dismissing here only ever mutates the in-memory `diagnostics` array and
// the DOM; a dismissed diagnostic can legitimately reappear if the next
// settings-preflight run re-emits the same underlying condition — that is
// expected and not a bug in this module.

import { iconHtml, refreshIcons } from './icons.js';
import { formatDiagnosticSource as _formatSource } from './diagnostic-format.js';

// --- Module state ---
var diagnostics = [];   // [{id, severity, source, message, actionable, ts}]
var panelEl = null;
var panelListEl = null;
var panelToggleBtn = null;
var panelBadgeEl = null;
var clearAllBtn = null;

// Stable per-entry identity so a specific rendered item can be located and
// removed on dismiss. The array otherwise carries no unique key.
var _nextDiagnosticId = 1;

// Severity priority (higher = more prominent).
var SEVERITY_ORDER = { error: 2, warning: 1, info: 0 };

// lr-e901: dedup window for repeated/duplicate diagnostics. Two independent
// emitters (CLI-stderr capture + deterministic settings-preflight runPreflight())
// can legitimately produce a diagnostic for the same underlying condition -
// addDiagnostic() had no dedup, so both were pushed and both toasted. Identity
// is (source, scope, message): scope is included because runPreflight()
// intentionally emits one diagnostic per settings file (user vs project,
// lr-7e22) - those are distinct conditions and must NOT be deduped together.
var DEDUP_WINDOW_MS = 5000;
var _recentDiagnosticKeys = Object.create(null); // key -> last-seen timestamp (ms)

function _diagnosticKey(msg) {
  return (msg.source || "") + "|" + (msg.scope || "") + "|" + (msg.message || "");
}

/**
 * True when an equivalent diagnostic (same source+scope+message) was already
 * recorded within DEDUP_WINDOW_MS. Also prunes the key's prior timestamp so
 * the map does not grow unbounded across a long session.
 */
function _isDuplicateDiagnostic(msg, now) {
  var key = _diagnosticKey(msg);
  var last = _recentDiagnosticKeys[key];
  _recentDiagnosticKeys[key] = now;
  return typeof last === "number" && (now - last) < DEDUP_WINDOW_MS;
}

// ============================================================
// Init
// ============================================================

export function initDiagnostics() {
  panelEl = document.getElementById("diagnostics-panel");
  panelListEl = document.getElementById("diagnostics-panel-list");
  panelToggleBtn = document.getElementById("diagnostics-panel-btn");
  panelBadgeEl = document.getElementById("diagnostics-panel-badge");
  clearAllBtn = panelEl ? panelEl.querySelector(".diagnostics-panel-clear-all") : null;

  if (!panelEl || !panelListEl || !panelToggleBtn) return;

  // Shared helper: close panel and return focus to the topbar button (WCAG 2.1 §2.4.3).
  // Both the close button click and the Escape-key path use this so focus restoration
  // is consistent for all keyboard-accessible dismiss gestures.
  function closePanelAndRefocus() {
    closePanel();
    if (panelToggleBtn) panelToggleBtn.focus();
  }

  // Close button inside the panel header.
  var closeBtn = panelEl.querySelector(".diagnostics-panel-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", function () {
      closePanelAndRefocus();
    });
  }

  // Clear-all button (parity with app-notifications.js clearAllBanners()).
  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", function () {
      clearAllDiagnostics();
      if (closeBtn) closeBtn.focus();
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
      closePanelAndRefocus();
    }
  });

  // Click-outside dismiss: the panel is a non-modal surface (no backdrop
  // element), so listen on the document and close when a click lands
  // outside the panel and outside its topbar toggle button (lr-b580).
  document.addEventListener("click", function (e) {
    if (panelEl.classList.contains("hidden")) return;
    if (panelEl.contains(e.target)) return;
    if (panelToggleBtn && panelToggleBtn.contains(e.target)) return;
    closePanelAndRefocus();
  });
}

// ============================================================
// Public: add a diagnostic
// ============================================================

export function addDiagnostic(msg) {
  var now = Date.now();

  // lr-e901: same condition can arrive via two independent emitters (CLI-stderr
  // capture + deterministic preflight) - collapse to a single visible entry.
  if (_isDuplicateDiagnostic(msg, now)) return;

  var entry = {
    severity: msg.severity || "info",
    source: msg.source || "",
    scope: msg.scope || "",
    message: msg.message || "",
    actionable: msg.actionable || null,
    ts: now,
    id: _nextDiagnosticId++,
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

// lr-e901: fixed top-right corner stack (see diagnostics.css
// #diagnostic-toast-container) so concurrent diagnostic toasts stack via
// normal flex flow instead of piling on top of each other at a single fixed
// position over the input box.
var toastContainerEl = null;

function _getToastContainer() {
  if (toastContainerEl && toastContainerEl.isConnected) return toastContainerEl;
  toastContainerEl = document.getElementById("diagnostic-toast-container");
  if (!toastContainerEl) {
    toastContainerEl = document.createElement("div");
    toastContainerEl.id = "diagnostic-toast-container";
    document.body.appendChild(toastContainerEl);
  }
  return toastContainerEl;
}

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
  sourceEl.textContent = _formatSource(entry.source, entry.scope);

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

  _getToastContainer().appendChild(el);
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
  _removeEmptyPlaceholder();

  var item = document.createElement("div");
  item.className = "diagnostics-item diagnostics-item-" + entry.severity;
  item.setAttribute("data-diag-id", String(entry.id));

  // Icon strip: severity pill.
  var meta = document.createElement("div");
  meta.className = "diagnostics-item-meta";

  var sevEl = document.createElement("span");
  sevEl.className = "diagnostics-sev-badge diagnostics-sev-" + entry.severity;
  sevEl.setAttribute("aria-label", "Severity: " + entry.severity);
  sevEl.textContent = entry.severity;

  var srcEl = document.createElement("span");
  srcEl.className = "diagnostics-source";
  srcEl.textContent = _formatSource(entry.source, entry.scope);

  var dismissBtn = document.createElement("button");
  dismissBtn.className = "diagnostics-item-dismiss";
  dismissBtn.setAttribute("aria-label", "Dismiss this diagnostic");
  dismissBtn.innerHTML = iconHtml("x");
  dismissBtn.addEventListener("click", function () {
    dismissDiagnostic(entry.id);
  });

  meta.appendChild(sevEl);
  meta.appendChild(srcEl);
  meta.appendChild(dismissBtn);

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
  }

  panelListEl.appendChild(item);
  refreshIcons();

  // Scroll the panel to the newest entry.
  panelListEl.scrollTop = panelListEl.scrollHeight;
}

// ============================================================
// Dismiss / clear-all (client-side only — see module header note)
// ============================================================

function _removeEmptyPlaceholder() {
  if (!panelListEl) return;
  var emptyEl = panelListEl.querySelector(".diagnostics-empty");
  if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);
}

// Restore the empty-state placeholder that _appendEntry removes on first
// append. Mirrors the markup baked into index.html so a fresh page load and
// a fully-cleared panel render identically.
function _restoreEmptyPlaceholder() {
  if (!panelListEl) return;
  if (panelListEl.querySelector(".diagnostics-empty")) return;
  var emptyEl = document.createElement("div");
  emptyEl.className = "diagnostics-empty";
  emptyEl.textContent = "No diagnostics this session.";
  panelListEl.appendChild(emptyEl);
}

/**
 * Remove a single diagnostic by id from both the in-memory array and the
 * rendered panel list, then refresh the badge. No-op if the id is unknown
 * (e.g. a stale dismiss click racing a clear-all).
 */
function dismissDiagnostic(id) {
  var idx = -1;
  for (var i = 0; i < diagnostics.length; i++) {
    if (diagnostics[i].id === id) { idx = i; break; }
  }
  if (idx === -1) return;
  diagnostics.splice(idx, 1);

  if (panelListEl) {
    var itemEl = panelListEl.querySelector('[data-diag-id="' + id + '"]');
    if (itemEl && itemEl.parentNode) itemEl.parentNode.removeChild(itemEl);
  }

  if (diagnostics.length === 0) _restoreEmptyPlaceholder();
  _updateBadge();
}

/**
 * Empty the diagnostics array and panel list, restore the empty-state
 * placeholder, and hide the badge. Parity with clearAllBanners() in
 * app-notifications.js, minus the websocket round-trip — diagnostics have
 * no server-side dismiss contract (see module header note).
 */
function clearAllDiagnostics() {
  diagnostics = [];
  if (panelListEl) panelListEl.innerHTML = "";
  _restoreEmptyPlaceholder();
  _updateBadge();
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
