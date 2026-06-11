// at-agents.js — inline @ mention dropdown for project-local agents (lr-c1a2).
//
// When the user types @ in the session input this module shows a small inline
// autocomplete dropdown listing:
//   1. All agents defined in .claude/agents/ for the active project (from the
//      server via the get_agents / project_agents_list WS round-trip).
//   2. Codex (always shown unless the current session vendor is already codex).
//
// Selecting an agent starts a new session with that agentName — identical to
// what the "Agent Chat" button does in the sidebar. The @ text is cleared from
// the input after selection (the session switch replaces the conversation).
//
// The dropdown is hidden when the agent list is empty (no .claude/agents/ and
// codex not available). Graceful empty state: nothing shown, no errors.
//
// Integration with input.js:
//   - input.js calls showAgentMenu(query) when it detects an active @ and
//     getAgentMentionMenuVisible() is true for keyboard routing.
//   - input.js calls hideAgentMenu() on Escape, slash menu open, or send.
//   - input.js checks isAgentMenuActive() before routing keydown events here.
//
// This module does NOT conflict with mention.js. Mention.js handles
// @user / @plain-vendor sends within an existing session. This module handles
// @agent, which *starts a new session* rather than sending a mention. The two
// are mutually exclusive: agents never appear in mention.js's candidate list,
// and users/plain-vendors never appear in the at-agents dropdown.

import { escapeHtml } from './utils.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';

// --- Module state ---
var _ctx = null;
var _menuEl = null;
var _agents = [];      // project-local agents from server: [{name, slug, description}]
var _items = [];       // rendered items (filtered from _agents + codex entry)
var _activeIdx = -1;
var _menuVisible = false;
var _menuBound = false;
var _currentQuery = "";

// --- Codex entry (always available when not already in a Codex session) ---
var CODEX_ENTRY = {
  name: "Codex",
  slug: "codex",
  description: "OpenAI Codex (Codex CLI)",
  _isCodex: true,
};

// --- Public API ---

export function initAtAgents(ctx) {
  _ctx = ctx;
  _ensureMenu();
  if (!_menuBound) {
    _menuBound = true;
    document.addEventListener("click", function (e) {
      if (!_menuEl) return;
      var item = e.target.closest(".at-agents-item");
      if (item) {
        var idx = parseInt(item.dataset.idx, 10);
        if (!isNaN(idx) && idx >= 0 && idx < _items.length) {
          e.preventDefault();
          e.stopPropagation();
          _activateItem(_items[idx]);
        }
        return;
      }
      // Click outside the menu — hide it.
      if (!_menuEl.contains(e.target)) {
        hideAgentMenu();
      }
    });
  }
}

// Returns true when the @ agent menu is currently visible.
export function isAgentMenuActive() {
  return _menuVisible;
}

// Request a fresh project agent list from the server. Called once on WS open
// (or on session switch). The response arrives as project_agents_list and
// calls handleProjectAgentsList().
export function requestProjectAgents() {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "get_agents" }));
}

// Called from app-messages.js when project_agents_list arrives.
export function handleProjectAgentsList(msg) {
  _agents = Array.isArray(msg.agents) ? msg.agents : [];
  // Re-render if the menu is currently open.
  if (_menuVisible) {
    _render(_currentQuery);
  }
}

// Show the dropdown at the position of the input element. Filter by query.
// Called from input.js when @ is active.
export function showAgentMenu(query) {
  _currentQuery = query || "";
  _ensureMenu();
  _render(_currentQuery);
}

// Hide and clear the dropdown.
export function hideAgentMenu() {
  if (!_menuVisible && !_menuEl) return;
  _menuVisible = false;
  _activeIdx = -1;
  _items = [];
  _currentQuery = "";
  if (_menuEl) {
    _menuEl.classList.remove("visible");
    _menuEl.innerHTML = "";
  }
}

// Keyboard navigation. Returns true if the event was consumed.
export function agentMenuKeydown(e) {
  if (!_menuVisible || _items.length === 0) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    _setActive((_activeIdx + 1) % _items.length);
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    _setActive((_activeIdx - 1 + _items.length) % _items.length);
    return true;
  }
  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
    e.preventDefault();
    if (_activeIdx >= 0 && _activeIdx < _items.length) {
      _activateItem(_items[_activeIdx]);
    }
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    hideAgentMenu();
    return true;
  }
  return false;
}

// --- Private helpers ---

function _ensureMenu() {
  if (_menuEl) return;
  _menuEl = document.createElement("div");
  _menuEl.id = "at-agents-menu";
  _menuEl.className = "at-agents-menu";
  // Attach near the input area (same parent as slash menu / mention menu).
  var inputArea = document.getElementById("input-area");
  if (inputArea) {
    inputArea.appendChild(_menuEl);
  } else {
    document.body.appendChild(_menuEl);
  }
}

function _buildItems(query) {
  var q = (query || "").toLowerCase().trim();
  var sessionVendor = store.get("currentVendor") || "claude";
  var result = [];

  // Project-local agents from .claude/agents/.
  for (var i = 0; i < _agents.length; i++) {
    var a = _agents[i];
    if (!a || !a.name) continue;
    if (q && a.name.toLowerCase().indexOf(q) === -1 &&
        (a.description || "").toLowerCase().indexOf(q) === -1) continue;
    result.push(a);
  }

  // Codex entry — only when not already in a Codex session.
  if (sessionVendor !== "codex") {
    if (!q ||
        CODEX_ENTRY.name.toLowerCase().indexOf(q) !== -1 ||
        CODEX_ENTRY.description.toLowerCase().indexOf(q) !== -1) {
      result.push(CODEX_ENTRY);
    }
  }

  return result;
}

function _render(query) {
  _items = _buildItems(query);
  if (_items.length === 0) {
    hideAgentMenu();
    return;
  }
  _menuVisible = true;
  _activeIdx = 0;

  var html = "";
  for (var i = 0; i < _items.length; i++) {
    var item = _items[i];
    var isCodex = !!item._isCodex;
    var badge = isCodex
      ? '<span class="at-agents-badge">codex</span>'
      : '<span class="at-agents-badge">agent</span>';
    var desc = item.description ? escapeHtml(item.description) : "";
    html +=
      '<div class="at-agents-item' + (i === 0 ? " active" : "") + '" data-idx="' + i + '">' +
        '<span class="at-agents-name">' + escapeHtml(item.name) + '</span>' +
        badge +
        (desc ? '<span class="at-agents-desc">' + desc + '</span>' : '') +
      '</div>';
  }
  _menuEl.innerHTML = html;
  _menuEl.classList.add("visible");

  // Bind mouseenter for hover highlighting.
  var itemEls = _menuEl.querySelectorAll(".at-agents-item");
  for (var j = 0; j < itemEls.length; j++) {
    (function (el) {
      el.addEventListener("mouseenter", function () {
        _setActive(parseInt(el.dataset.idx, 10), true);
      });
    })(itemEls[j]);
  }
}

function _setActive(idx, skipScroll) {
  if (_items.length === 0) return;
  if (idx < 0) idx = _items.length - 1;
  if (idx >= _items.length) idx = 0;
  _activeIdx = idx;
  var els = _menuEl.querySelectorAll(".at-agents-item");
  for (var i = 0; i < els.length; i++) {
    els[i].classList.toggle("active", i === idx);
  }
  if (!skipScroll && els[idx]) {
    els[idx].scrollIntoView({ block: "nearest" });
  }
}

function _activateItem(item) {
  hideAgentMenu();
  // Clear the @ text from the input.
  if (_ctx && _ctx.inputEl) {
    var val = _ctx.inputEl.value;
    // Remove everything from the last @ to the cursor.
    var cursor = _ctx.inputEl.selectionStart;
    var atIdx = val.lastIndexOf("@", cursor - 1);
    if (atIdx !== -1) {
      _ctx.inputEl.value = val.substring(0, atIdx) + val.substring(cursor);
      _ctx.inputEl.selectionStart = _ctx.inputEl.selectionEnd = atIdx;
    }
  }
  // Start (or switch to) the agent session.
  if (item._isCodex) {
    // Codex: open a new plain-codex session via vendor switch.
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "new_session", vendor: "codex" }));
    }
  } else {
    // Named agent: open a new session with agentName.
    var ws2 = getWs();
    if (ws2 && ws2.readyState === 1) {
      ws2.send(JSON.stringify({ type: "new_session", agentName: item.name }));
    }
  }
}
