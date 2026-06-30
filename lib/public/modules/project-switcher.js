// project-switcher.js — macOS Cmd+Tab-style quick switcher for projects.
//
// Cmd/Ctrl+E activates the project switcher overlay. While the modifier is
// still held, repeating the shortcut cycles forward and Shift cycles back.
// Releasing the modifier commits — matching Cmd+Tab semantics.
// Enter commits explicitly; Escape cancels.
//
// Project mode maintains an in-memory MRU list so the ordering stays
// transient (no persistence — MRU is a hint only, and project rule forbids
// localStorage for preferences).

import { store } from './store.js';
import { refreshIcons } from './icons.js';
import { getCachedProjects, switchProject } from './app-projects.js';
import { parseEmojis } from './markdown.js';
import { renderProjectIcon } from './project-icon.js';

var _projectMru = [];   // project slugs, most recent first
var _overlay = null;
var _list = null;
var _headerEl = null;
var _open = false;
var _highlightedIndex = 0;
var _entries = [];

export function openSwitcherForMode(mode) {
  if (mode !== 'project') return;
  if (_open) closeSwitcher(false);
  openSwitcher();
}

export function initProjectSwitcher() {
  buildOverlayIfMissing();
  _list = _overlay.querySelector('.cmd-palette-results');
  _headerEl = _overlay.querySelector('.project-switcher-header');

  // Seed MRU from current state.
  var seedSlug = store.get('currentSlug');
  if (seedSlug) _projectMru = [seedSlug];

  // Track MRU by watching the store for navigation changes.
  store.subscribe(['currentSlug'], function (state, prev) {
    if (state.currentSlug && state.currentSlug !== prev.currentSlug) {
      bumpMru(_projectMru, state.currentSlug);
      _projectMru = _projectMru; // (keep reference; bumpMru mutates via reassignment)
    }
  });

  var backdrop = _overlay.querySelector('.cmd-palette-backdrop');
  if (backdrop) backdrop.addEventListener('click', function () { closeSwitcher(false); });

  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('keyup', handleKeyUp, true);
  window.addEventListener('blur', function () { if (_open) closeSwitcher(false); });

  // Wire hotkey hint pill next to the icon strip so the keybinding is
  // discoverable in the same surface users use for clicking.
  var isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform);
  var projectHintLabel = isMac ? '⌘E' : 'Ctrl+E';
  var projectHint = document.getElementById('icon-strip-hint-project');
  if (projectHint) {
    projectHint.textContent = projectHintLabel;
    projectHint.title = 'Switch project (' + projectHintLabel + ')';
    projectHint.addEventListener('click', function () { openSwitcherForMode('project'); });
  }
}

function buildOverlayIfMissing() {
  _overlay = document.getElementById('project-switcher');
  if (_overlay) return;
  var isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform);
  var modKbd = isMac ? '<kbd>⌘</kbd>' : '<kbd>Ctrl</kbd>';
  _overlay = document.createElement('div');
  _overlay.id = 'project-switcher';
  _overlay.className = 'cmd-palette hidden project-switcher';
  _overlay.innerHTML =
    '<div class="cmd-palette-backdrop"></div>' +
    '<div class="cmd-palette-dialog project-switcher-dialog">' +
      '<div class="project-switcher-header">Switch project</div>' +
      '<div class="cmd-palette-results"></div>' +
      '<div class="cmd-palette-footer project-switcher-footer">' +
        '<span class="project-switcher-shortcuts">' + modKbd + '<kbd class="proj-next-key">E</kbd> next · <kbd>⇧</kbd>' + modKbd + '<kbd class="proj-prev-key">E</kbd> prev · <kbd>⏎</kbd> select · <kbd>Esc</kbd> cancel</span>' +
      '</div>' +
    '</div>';
  document.body.appendChild(_overlay);
}

function bumpMru(list, key) {
  // Mutate the original array to preserve the module-level reference
  // so subscribers / future reads see the update without a reassign.
  var idx = list.indexOf(key);
  if (idx !== -1) list.splice(idx, 1);
  list.unshift(key);
}

function handleKeyDown(e) {
  if (!e.key) return;
  var isMod = (e.metaKey || e.ctrlKey) && !e.altKey;
  var k = e.key.toLowerCase();

  // Mode shortcut: Cmd/Ctrl+E opens the project switcher.
  if (isMod && k === 'e') {
    e.preventDefault();
    e.stopPropagation();
    if (!_open) {
      openSwitcher();
    } else if (e.shiftKey) {
      cycle(-1);
    } else {
      cycle(1);
    }
    return;
  }

  if (!_open) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSwitcher(false);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    closeSwitcher(true);
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); cycle(1); return; }
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); cycle(-1); return; }
}

function handleKeyUp(e) {
  if (!_open) return;
  if (e.key === 'Meta' || e.key === 'Control') {
    closeSwitcher(true);
  }
}

function openSwitcher() {
  _entries = buildProjectEntries();
  if (_entries.length === 0) {
    // Nothing to switch to; don't show an empty modal.
    if (_open) closeSwitcher(false);
    return;
  }
  if (_headerEl) {
    _headerEl.textContent = 'Switch project';
  }
  renderEntries();
  _highlightedIndex = pickInitialIndex();
  paintHighlight();
  _overlay.classList.remove('hidden');
  _open = true;
  refreshIcons();
  // UI chrome matches the rest of the app by swapping native emoji into
  // Twemoji <img>s (same pattern as title bar, icon strip, project
  // settings). The global COLR font fallback alone isn't reliable for
  // UI surfaces because OS emoji fonts tend to match first.
  parseEmojis(_list);
}

function pickInitialIndex() {
  // Highlight the "previous" selectable entry (Cmd+Tab semantics),
  // while keeping the list in a stable natural order. Uses MRU to
  // find which project was visited before the current one, then
  // locates its position in _entries.
  if (_entries.length === 0) return 0;
  var currentKey = store.get('currentSlug');
  for (var m = 0; m < _projectMru.length; m++) {
    var key = _projectMru[m];
    if (key === currentKey) continue;
    for (var i = 0; i < _entries.length; i++) {
      if (_entries[i].key === key && !_entries[i].disabled) return i;
    }
  }
  // Fallback: first non-current, non-disabled entry.
  for (var j = 0; j < _entries.length; j++) {
    if (!_entries[j].disabled && _entries[j].key !== currentKey) return j;
  }
  for (var d = 0; d < _entries.length; d++) {
    if (!_entries[d].disabled) return d;
  }
  return 0;
}

function buildProjectEntries() {
  var projects = getCachedProjects() || [];
  // Keep natural (server-provided) order so the list looks the same
  // every time the switcher opens. MRU only drives initial highlight.
  return projects.map(function (p) {
    // Worktrees can end up "outside project path" (parent workspace
    // unmounted or moved); those are effectively unreachable from
    // this session and shouldn't be switchable.
    var unreachable = p.isWorktree && p.worktreeAccessible === false;
    return {
      key: p.slug,
      title: p.title || p.project || p.slug,
      icon: p.icon || null,
      fallbackIcon: 'folder',
      isCurrent: p.slug === store.get('currentSlug'),
      disabled: unreachable,
      disabledReason: unreachable ? 'Outside project path' : null,
    };
  });
}

function closeSwitcher(commit) {
  if (!_open) return;
  _open = false;
  _overlay.classList.add('hidden');
  if (!commit) return;
  var entry = _entries[_highlightedIndex];
  if (!entry || entry.disabled) return;
  if (entry.key !== store.get('currentSlug')) switchProject(entry.key);
}

function cycle(delta) {
  if (_entries.length === 0) return;
  // Skip over disabled entries so unreachable worktrees aren't part
  // of the cycle. If every entry is disabled (shouldn't happen, since
  // openSwitcher bails on empty lists), fall back to plain stepping.
  var step = delta > 0 ? 1 : -1;
  var idx = _highlightedIndex;
  for (var i = 0; i < _entries.length; i++) {
    idx = (idx + step + _entries.length) % _entries.length;
    if (!_entries[idx].disabled) {
      _highlightedIndex = idx;
      paintHighlight();
      return;
    }
  }
}

function renderEntries() {
  if (!_list) return;
  _list.innerHTML = '';
  for (var i = 0; i < _entries.length; i++) {
    _list.appendChild(buildEntryNode(_entries[i], i));
  }
}

function buildEntryNode(entry, index) {
  var item = document.createElement('button');
  item.type = 'button';
  item.className = 'cmd-palette-item project-switcher-item';
  if (entry.disabled) item.classList.add('disabled');
  if (entry.disabled && entry.disabledReason) item.title = entry.disabledReason;
  item.dataset.index = String(index);

  var iconWrap = document.createElement('div');
  iconWrap.className = 'cmd-palette-item-icon';
  if (entry.icon) {
    renderProjectIcon(entry.icon, iconWrap, parseEmojis);
  } else if (entry.avatarUrl) {
    var img = document.createElement('img');
    img.src = entry.avatarUrl;
    img.alt = '';
    img.className = 'project-switcher-avatar';
    iconWrap.appendChild(img);
  } else {
    var fallback = document.createElement('i');
    fallback.setAttribute('data-lucide', entry.fallbackIcon || 'folder');
    iconWrap.appendChild(fallback);
  }
  item.appendChild(iconWrap);

  var body = document.createElement('div');
  body.className = 'cmd-palette-item-body';
  var titleRow = document.createElement('div');
  titleRow.className = 'cmd-palette-item-title-row';
  var title = document.createElement('span');
  title.className = 'cmd-palette-item-title';
  title.textContent = entry.title;
  titleRow.appendChild(title);
  if (entry.isCurrent) {
    var badge = document.createElement('span');
    badge.className = 'project-switcher-current';
    badge.textContent = 'current';
    titleRow.appendChild(badge);
  }
  if (entry.disabled && entry.disabledReason) {
    var reason = document.createElement('span');
    reason.className = 'project-switcher-disabled-reason';
    reason.textContent = entry.disabledReason;
    titleRow.appendChild(reason);
  }
  body.appendChild(titleRow);
  item.appendChild(body);

  item.addEventListener('mouseenter', function () {
    if (entry.disabled) return;
    _highlightedIndex = index;
    paintHighlight();
  });
  item.addEventListener('click', function () {
    if (entry.disabled) return;
    _highlightedIndex = index;
    closeSwitcher(true);
  });
  return item;
}

function paintHighlight() {
  if (!_list) return;
  var items = _list.querySelectorAll('.cmd-palette-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('active', i === _highlightedIndex);
  }
  var active = items[_highlightedIndex];
  if (active && active.scrollIntoView) {
    active.scrollIntoView({ block: 'nearest' });
  }
}
