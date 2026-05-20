// emoji-picker.js — Shared emoji picker with search, backed by emoji-data.json
// Replaces hand-curated EMOJI_CATEGORIES in sidebar-projects.js / project-settings.js

import { parseEmojis } from './markdown.js';

// Group metadata matching emojibase-data group numbers
var GROUP_META = [
  { g: 0, icon: "😀", label: "Smileys & Emotion" },
  { g: 1, icon: "🧑", label: "People & Body" },
  { g: 3, icon: "🐻", label: "Animals & Nature" },
  { g: 4, icon: "🍔", label: "Food & Drink" },
  { g: 5, icon: "🚗", label: "Travel & Places" },
  { g: 6, icon: "⚽", label: "Activities" },
  { g: 7, icon: "💡", label: "Objects" },
  { g: 8, icon: "❤️", label: "Symbols" },
  { g: 9, icon: "🏁", label: "Flags" },
];

// Cached data promise — fetched once
var _dataPromise = null;
var _emojiData = null; // flat array of {e, l, g, t}
var _byGroup = null;   // Map<groupNum, emoji[]>

function loadEmojiData() {
  if (_dataPromise) return _dataPromise;
  _dataPromise = fetch("/emoji-data.json")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      _emojiData = data;
      _byGroup = {};
      for (var i = 0; i < GROUP_META.length; i++) {
        _byGroup[GROUP_META[i].g] = [];
      }
      for (var j = 0; j < data.length; j++) {
        var entry = data[j];
        if (_byGroup[entry.g] !== undefined) {
          _byGroup[entry.g].push(entry.e);
        }
      }
      return data;
    });
  return _dataPromise;
}

// Pre-built search index: flat array of {e, s} where s is the searchable string
var _searchIndex = null;
function getSearchIndex() {
  if (_searchIndex) return _searchIndex;
  if (!_emojiData) return null;
  _searchIndex = _emojiData.map(function (entry) {
    var s = entry.l;
    if (entry.t && entry.t.length) s += " " + entry.t.join(" ");
    return { e: entry.e, s: s.toLowerCase() };
  });
  return _searchIndex;
}

function searchEmojis(query) {
  var idx = getSearchIndex();
  if (!idx) return [];
  var q = query.toLowerCase().trim();
  if (!q) return [];
  var results = [];
  for (var i = 0; i < idx.length; i++) {
    if (idx[i].s.indexOf(q) !== -1) {
      results.push(idx[i].e);
    }
    if (results.length >= 80) break;
  }
  return results;
}

/**
 * Build and return an emoji picker element.
 *
 * @param {object} opts
 *   onSelect(emoji)  — called when user picks an emoji
 *   onRemove()       — if provided, shows a "Remove" button
 *   headerLabel      — string shown in header (default "Choose Icon")
 */
export function buildEmojiPicker(opts) {
  var onSelect = opts.onSelect || function () {};
  var onRemove = opts.onRemove || null;
  var headerLabel = opts.headerLabel || "Choose Icon";

  var picker = document.createElement("div");
  picker.className = "emoji-picker";
  picker.addEventListener("click", function (e) { e.stopPropagation(); });

  // Header
  var header = document.createElement("div");
  header.className = "emoji-picker-header";
  header.textContent = headerLabel;
  if (onRemove) {
    var removeBtn = document.createElement("button");
    removeBtn.className = "emoji-picker-remove";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      onRemove();
    });
    header.appendChild(removeBtn);
  }
  picker.appendChild(header);

  // Search input
  var searchWrap = document.createElement("div");
  searchWrap.className = "emoji-picker-search-wrap";
  var searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search emoji…";
  searchInput.className = "emoji-picker-search";
  searchInput.setAttribute("autocomplete", "off");
  searchInput.setAttribute("spellcheck", "false");
  searchWrap.appendChild(searchInput);
  picker.appendChild(searchWrap);

  // Tab bar (hidden during search)
  var tabBar = document.createElement("div");
  tabBar.className = "emoji-picker-tabs";
  var tabBtns = [];
  picker.appendChild(tabBar);

  // Scroll + grid
  var scrollArea = document.createElement("div");
  scrollArea.className = "emoji-picker-scroll";
  var grid = document.createElement("div");
  grid.className = "emoji-picker-grid";
  scrollArea.appendChild(grid);
  picker.appendChild(scrollArea);

  var noResults = document.createElement("div");
  noResults.className = "emoji-picker-no-results";
  noResults.textContent = "No results";
  noResults.style.display = "none";
  scrollArea.appendChild(noResults);

  var currentCatIdx = 0;

  function buildGrid(emojis) {
    grid.innerHTML = "";
    noResults.style.display = "none";
    if (!emojis || emojis.length === 0) {
      noResults.style.display = "block";
      return;
    }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < emojis.length; i++) {
      (function (emoji) {
        var btn = document.createElement("button");
        btn.className = "emoji-picker-item";
        btn.textContent = emoji;
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          onSelect(emoji);
        });
        frag.appendChild(btn);
      })(emojis[i]);
    }
    grid.appendChild(frag);
    parseEmojis(grid);
    scrollArea.scrollTop = 0;
  }

  function switchCategory(idx) {
    currentCatIdx = idx;
    for (var j = 0; j < tabBtns.length; j++) {
      tabBtns[j].classList.toggle("active", j === idx);
    }
    if (_byGroup) {
      buildGrid(_byGroup[GROUP_META[idx].g] || []);
    }
  }

  function showSearchResults(query) {
    tabBar.style.display = "none";
    buildGrid(searchEmojis(query));
  }

  function showCategory() {
    tabBar.style.display = "";
    switchCategory(currentCatIdx);
  }

  // Debounced search
  var searchTimer = null;
  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimer);
    var q = searchInput.value;
    searchTimer = setTimeout(function () {
      if (q.trim()) {
        showSearchResults(q);
      } else {
        showCategory();
      }
    }, 150);
  });

  // Load data, then populate tabs + initial grid
  loadEmojiData().then(function () {
    // Build tabs
    for (var t = 0; t < GROUP_META.length; t++) {
      (function (meta, idx) {
        var tab = document.createElement("button");
        tab.className = "emoji-picker-tab" + (idx === 0 ? " active" : "");
        tab.textContent = meta.icon;
        tab.title = meta.label;
        tab.addEventListener("click", function (e) {
          e.stopPropagation();
          searchInput.value = "";
          showCategory();
          switchCategory(idx);
        });
        tabBar.appendChild(tab);
        tabBtns.push(tab);
      })(GROUP_META[t], t);
    }
    parseEmojis(tabBar);
    switchCategory(0);
  });

  return picker;
}
