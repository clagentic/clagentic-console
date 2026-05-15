// agent-picker.js — searchable picker for the SDK `agent` option (lr-7db0).
//
// Modeled on command-palette.js so the visual idiom is identical: backdrop +
// dialog + search input + grouped results + keyboard nav. Reuses the
// .cmd-palette-* CSS classes so we don't fork the styling; agent-specific
// affordances (star toggle, source badge) are layered on with .agent-*
// classes in agent-picker.css.
//
// Two tabs: Favorites (default) and All agents. Star toggle on each row
// flips chattable.json membership. Recents pinned above Favorites when not
// searching. Hidden caller-side (sidebar-sessions) when current project is
// a Mate; server also enforces.

import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';

var paletteEl = null;
var inputEl = null;
var resultsEl = null;
var tabsEl = null;
var activeIndex = -1;
var items = [];

// When set, activateItem() saves as preferred agent instead of starting a session.
var _preferredTargetSlug = null;

var allAgents = [];
var favorites = [];
var recents = [];
var activeTab = "favorites"; // "favorites" | "all"

// Identity match: name is the sole key (lr-8e39, flat SDK catalog).
function sameAgent(a, b) {
  if (!a || !b) return false;
  return a.name === b.name;
}

function isFavorite(agent) {
  for (var i = 0; i < favorites.length; i++) {
    if (sameAgent(favorites[i], agent)) return true;
  }
  return false;
}

export function initAgentPicker() {
  buildDOM();
}

export function isAgentPickerOpen() {
  return paletteEl && !paletteEl.classList.contains("hidden");
}

export function openAgentPicker() {
  if (!paletteEl) return;
  // Refuse to open inside Mate DM mode (server also enforces; this just keeps
  // the surface from flickering open).
  if (store.get('dmMode')) return;
  _preferredTargetSlug = null;
  paletteEl.classList.remove("hidden");
  inputEl.value = "";
  activeIndex = -1;
  items = [];
  activeTab = "favorites";
  resultsEl.innerHTML = '<div class="cmd-palette-loading">Loading agents…</div>';
  inputEl.focus();
  // Request fresh catalog every open — agents come and go as plugins
  // install/uninstall, and discovery is cheap.
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "list_agents" }));
  }
}

// Open the picker in "set preferred agent" mode for the given project slug.
// On selection the agent is saved as that project's preferredAgent; no session
// is started.
export function openAgentPickerForPreferred(slug) {
  if (!paletteEl || !slug) return;
  _preferredTargetSlug = slug;
  paletteEl.classList.remove("hidden");
  inputEl.value = "";
  activeIndex = -1;
  items = [];
  activeTab = "all";
  syncTabUi();
  resultsEl.innerHTML = '<div class="cmd-palette-loading">Loading agents…</div>';
  // Update footer hint
  var footerEl = paletteEl.querySelector(".cmd-palette-footer-shortcuts");
  if (footerEl) {
    footerEl.innerHTML =
      '<span><kbd>&uarr;</kbd> <kbd>&darr;</kbd> navigate</span>' +
      '<span><kbd>Enter</kbd> set as preferred</span>' +
      '<span><kbd>Esc</kbd> cancel</span>';
  }
  inputEl.focus();
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "list_agents" }));
  }
}

export function closeAgentPicker() {
  if (!paletteEl) return;
  paletteEl.classList.add("hidden");
  inputEl.value = "";
  resultsEl.innerHTML = "";
  items = [];
  activeIndex = -1;
  _preferredTargetSlug = null;
  // Restore default footer
  var footerEl = paletteEl.querySelector(".cmd-palette-footer-shortcuts");
  if (footerEl) {
    footerEl.innerHTML =
      '<span><kbd>&uarr;</kbd> <kbd>&darr;</kbd> navigate</span>' +
      '<span><kbd>Enter</kbd> start chat</span>' +
      '<span><kbd>&#9733;</kbd> toggle favorite</span>';
  }
}

// Server pushed an updated catalog — render if we're open.
export function handleAgentsList(msg) {
  allAgents = Array.isArray(msg.agents) ? msg.agents : [];
  favorites = Array.isArray(msg.favorites) ? msg.favorites : [];
  recents = Array.isArray(msg.recents) ? msg.recents : [];
  if (isAgentPickerOpen()) {
    render();
  }
}

// Server confirmed a favorite toggle — no-op visually because agents_list
// follows immediately and re-renders.
export function handleAgentFavoriteToggled(_msg) { /* re-render comes via agents_list */ }

function buildDOM() {
  paletteEl = document.createElement("div");
  paletteEl.className = "cmd-palette agent-picker hidden";
  paletteEl.innerHTML =
    '<div class="cmd-palette-backdrop"></div>' +
    '<div class="cmd-palette-dialog">' +
      '<div class="cmd-palette-input-row">' +
        '<i data-lucide="bot"></i>' +
        '<input class="cmd-palette-input" type="text" placeholder="Search agents…" autocomplete="off" spellcheck="false" />' +
        '<span class="cmd-palette-kbd agent-picker-close"><i data-lucide="x"></i></span>' +
      '</div>' +
      '<div class="agent-picker-tabs">' +
        '<button class="agent-picker-tab active" data-tab="favorites" type="button">Favorites</button>' +
        '<button class="agent-picker-tab" data-tab="all" type="button">All agents</button>' +
      '</div>' +
      '<div class="cmd-palette-results"></div>' +
      '<div class="cmd-palette-footer">' +
        '<span class="cmd-palette-footer-shortcuts">' +
          '<span><kbd>&uarr;</kbd> <kbd>&darr;</kbd> navigate</span>' +
          '<span><kbd>Enter</kbd> start chat</span>' +
          '<span><kbd>★</kbd> toggle favorite</span>' +
        '</span>' +
      '</div>' +
    '</div>';

  document.body.appendChild(paletteEl);
  refreshIcons();

  inputEl = paletteEl.querySelector(".cmd-palette-input");
  resultsEl = paletteEl.querySelector(".cmd-palette-results");
  tabsEl = paletteEl.querySelector(".agent-picker-tabs");

  paletteEl.querySelector(".cmd-palette-backdrop").addEventListener("click", closeAgentPicker);
  paletteEl.querySelector(".agent-picker-close").addEventListener("click", closeAgentPicker);

  inputEl.addEventListener("input", render);

  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeAgentPicker();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(activeIndex + 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(activeIndex - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < items.length) activateItem(items[activeIndex]);
      return;
    }
    if (e.key === "Tab") {
      // Tab swaps tabs without leaving the input.
      e.preventDefault();
      activeTab = activeTab === "favorites" ? "all" : "favorites";
      syncTabUi();
      render();
      return;
    }
  });

  // Tab clicks
  var tabButtons = tabsEl.querySelectorAll(".agent-picker-tab");
  for (var ti = 0; ti < tabButtons.length; ti++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        activeTab = btn.getAttribute("data-tab");
        syncTabUi();
        render();
        inputEl.focus();
      });
    })(tabButtons[ti]);
  }

  paletteEl.querySelector(".cmd-palette-dialog").addEventListener("click", function (e) {
    e.stopPropagation();
  });
}

function syncTabUi() {
  var btns = tabsEl.querySelectorAll(".agent-picker-tab");
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle("active", btns[i].getAttribute("data-tab") === activeTab);
  }
}

function render() {
  var f = (inputEl.value || "").toLowerCase().trim();
  items = [];
  var html = "";
  var flatIndex = 0;

  function matches(a) {
    if (!f) return true;
    return (a.name || "").toLowerCase().indexOf(f) !== -1
      || (a.description || "").toLowerCase().indexOf(f) !== -1;
  }

  // Resolve recents/favorites against the catalog so we always render fresh
  // metadata (description/model) rather than the stale snapshot the server
  // stored in chattable.json.
  function resolve(stub) {
    for (var i = 0; i < allAgents.length; i++) {
      if (sameAgent(allAgents[i], stub)) return allAgents[i];
    }
    return null;
  }

  if (activeTab === "favorites") {
    // Recents (pinned, only when not searching).
    if (!f) {
      var recentResolved = recents.map(resolve).filter(Boolean);
      if (recentResolved.length > 0) {
        html += '<div class="cmd-palette-group-label">Recents</div>';
        for (var ri = 0; ri < recentResolved.length; ri++) {
          var ra = recentResolved[ri];
          items.push({ type: "agent", data: ra });
          html += renderRow(flatIndex, ra);
          flatIndex++;
        }
      }
    }

    var favResolved = favorites.map(resolve).filter(Boolean).filter(matches);
    if (favResolved.length > 0) {
      html += '<div class="cmd-palette-group-label">Favorites</div>';
      for (var fi = 0; fi < favResolved.length; fi++) {
        var fa = favResolved[fi];
        items.push({ type: "agent", data: fa });
        html += renderRow(flatIndex, fa);
        flatIndex++;
      }
    } else if (!f && favorites.length === 0) {
      html += '<div class="agent-picker-empty">' +
        'No favorites yet. Switch to <strong>All agents</strong> and star the ones you want here.' +
      '</div>';
    }
  } else {
    // All agents — flat list from SDK catalog (lr-8e39).
    var filtered = [];
    for (var ai = 0; ai < allAgents.length; ai++) {
      if (matches(allAgents[ai])) filtered.push(allAgents[ai]);
    }
    if (filtered.length > 0) {
      html += '<div class="cmd-palette-group-label">All agents</div>';
      for (var ii = 0; ii < filtered.length; ii++) {
        var aa = filtered[ii];
        items.push({ type: "agent", data: aa });
        html += renderRow(flatIndex, aa);
        flatIndex++;
      }
    }
  }

  if (items.length === 0 && !html) {
    html = '<div class="agent-picker-empty">' +
      (f ? 'No agents match "' + escapeHtml(f) + '".' : 'No agents discovered.') +
    '</div>';
  }

  resultsEl.innerHTML = html;
  refreshIcons();
  bindItemEvents();
  if (items.length > 0) setActive(0, true);
}

function renderRow(index, agent) {
  var fav = isFavorite(agent);
  var sourceLabel = "agent";
  var modelChip = agent.model
    ? '<span class="agent-picker-model">' + escapeHtml(agent.model) + '</span>'
    : '';
  var description = agent.description ? escapeHtml(agent.description) : '';
  var starIcon = fav ? "star" : "star-off";
  var starClass = fav ? "agent-picker-star is-favorite" : "agent-picker-star";
  return '<div class="cmd-palette-item agent-picker-item" data-index="' + index + '">' +
    '<div class="cmd-palette-item-icon"><i data-lucide="bot"></i></div>' +
    '<div class="cmd-palette-item-body">' +
      '<div class="cmd-palette-item-title-row">' +
        '<span class="cmd-palette-item-title">' + escapeHtml(agent.name) + '</span>' +
        modelChip +
        '<span class="agent-picker-source">' + sourceLabel + '</span>' +
      '</div>' +
      (description ? '<div class="cmd-palette-item-meta"><span class="cmd-palette-item-project">' + description + '</span></div>' : '') +
    '</div>' +
    '<button class="' + starClass + '" data-fav-index="' + index + '" type="button" title="Toggle favorite">' +
      '<i data-lucide="' + starIcon + '"></i>' +
    '</button>' +
  '</div>';
}

function bindItemEvents() {
  var itemEls = resultsEl.querySelectorAll(".agent-picker-item");
  for (var k = 0; k < itemEls.length; k++) {
    (function (el) {
      el.addEventListener("click", function (e) {
        if (e.target.closest(".agent-picker-star")) return; // star handler runs separately
        var idx = parseInt(el.getAttribute("data-index"), 10);
        if (idx >= 0 && idx < items.length) activateItem(items[idx]);
      });
      el.addEventListener("mouseenter", function () {
        var idx = parseInt(el.getAttribute("data-index"), 10);
        setActive(idx, true);
      });
    })(itemEls[k]);
  }
  var starEls = resultsEl.querySelectorAll(".agent-picker-star");
  for (var s = 0; s < starEls.length; s++) {
    (function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(el.getAttribute("data-fav-index"), 10);
        if (idx >= 0 && idx < items.length) {
          var it = items[idx];
          if (it && it.type === "agent") toggleFavorite(it.data);
        }
      });
    })(starEls[s]);
  }
}

function setActive(idx, skipScroll) {
  if (items.length === 0) return;
  if (idx < 0) idx = items.length - 1;
  if (idx >= items.length) idx = 0;
  activeIndex = idx;
  var els = resultsEl.querySelectorAll(".agent-picker-item");
  for (var i = 0; i < els.length; i++) {
    els[i].classList.toggle("active", i === idx);
  }
  if (!skipScroll && els[idx]) {
    els[idx].scrollIntoView({ block: "nearest" });
  }
}

function activateItem(entry) {
  if (!entry || entry.type !== "agent") return;
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  if (_preferredTargetSlug) {
    // "Set preferred agent" mode — persist the choice, no new session.
    ws.send(JSON.stringify({
      type: "set_project_preferred_agent",
      slug: _preferredTargetSlug,
      agent: { name: entry.data.name },
    }));
  } else {
    ws.send(JSON.stringify({
      type: "new_session",
      agentName: entry.data.name,
    }));
  }
  closeAgentPicker();
}

function toggleFavorite(agent) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "toggle_agent_favorite", name: agent.name }));
}
