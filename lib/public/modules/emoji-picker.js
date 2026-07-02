// emoji-picker.js — Shared emoji picker with search, backed by emoji-data.json
// Replaces hand-curated EMOJI_CATEGORIES in sidebar-projects.js / project-settings.js

import { parseEmojis } from './markdown.js';
import { showToast } from './utils.js';
import { slugifyFilename, fetchCustomIconList, uploadCustomIcon, deleteCustomIcon, matchesCustomIconQuery } from './custom-icons.js';

// Group metadata matching emojibase-data group numbers.
// "custom" is a string key (not a numeric group) so it never collides with emojibase groups.
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
  { g: "custom", icon: "🖼", label: "Custom" },
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

  // customMatches (optional) — custom-icon {slug, url} entries to render as
  // image tiles alongside plain-text emoji results (lr-0847: search previously
  // never included custom icons at all, so "console" could never find
  // ":clagentic-console:" regardless of query). Appended after the emoji
  // results, reusing the same select-on-click behavior as the Custom tab.
  function buildGrid(emojis, customMatches) {
    grid.innerHTML = "";
    noResults.style.display = "none";
    var hasEmojis = emojis && emojis.length > 0;
    var hasCustom = customMatches && customMatches.length > 0;
    if (!hasEmojis && !hasCustom) {
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
    if (hasCustom) {
      for (var ci = 0; ci < customMatches.length; ci++) {
        (function (entry) {
          var btn = document.createElement("button");
          btn.className = "emoji-picker-item emoji-picker-item-custom";
          btn.title = ":" + entry.slug + ":";
          var img = document.createElement("img");
          img.src = entry.url;
          img.alt = ":" + entry.slug + ":";
          img.className = "emoji-picker-custom-img";
          btn.appendChild(img);
          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            onSelect(":" + entry.slug + ":");
          });
          frag.appendChild(btn);
        })(customMatches[ci]);
      }
    }
    grid.appendChild(frag);
    parseEmojis(grid);
    scrollArea.scrollTop = 0;
  }

  // --- Custom emoji panel ---

  // Cached list of uploads from GET /api/custom-emoji
  var customList = null; // null = not fetched yet

  function fetchCustomList(cb) {
    fetchCustomIconList().then(function (list) {
      customList = list;
      if (cb) cb(customList);
    });
  }

  function buildCustomPanel() {
    grid.innerHTML = "";
    noResults.style.display = "none";

    var panel = document.createElement("div");
    panel.className = "emoji-picker-custom-panel";

    // Hidden file input (opened by upload tile click)
    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png,image/jpeg,image/gif,image/webp";
    fileInput.style.display = "none";
    panel.appendChild(fileInput);

    // Slug confirm dialog (shown inline before upload)
    var slugConfirm = document.createElement("div");
    slugConfirm.className = "emoji-picker-slug-confirm hidden";
    slugConfirm.innerHTML =
      '<label class="emoji-picker-slug-label">Slug</label>' +
      '<input type="text" class="emoji-picker-slug-input" maxlength="64" spellcheck="false" autocomplete="off">' +
      '<div class="emoji-picker-slug-actions">' +
        '<button class="emoji-picker-slug-cancel">Cancel</button>' +
        '<button class="emoji-picker-slug-ok primary">Upload</button>' +
      '</div>';
    panel.appendChild(slugConfirm);

    var slugInput = slugConfirm.querySelector(".emoji-picker-slug-input");
    var slugOk = slugConfirm.querySelector(".emoji-picker-slug-ok");
    var slugCancel = slugConfirm.querySelector(".emoji-picker-slug-cancel");
    var pendingFile = null;

    function showSlugConfirm(file) {
      pendingFile = file;
      slugInput.value = slugifyFilename(file.name);
      slugConfirm.classList.remove("hidden");
      slugInput.focus();
      slugInput.select();
    }

    function hideSlugConfirm() {
      slugConfirm.classList.add("hidden");
      pendingFile = null;
    }

    function doUpload() {
      // Both early returns below used to be silent — the control (rendered
      // by showSlugConfirm) is only reachable once a file is already
      // selected, but a defensive check that fires with zero user feedback
      // is indistinguishable from the picker doing nothing at all. Surface
      // both via the same toast used for server-side upload failures (line
      // ~285) so "nothing happened" never happens silently again.
      if (!pendingFile) {
        showToast("Couldn't add custom emoji", "warn");
        return;
      }
      var slug = slugInput.value.trim().toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
      if (!slug || !/^[a-z0-9_-]{1,64}$/.test(slug)) {
        showToast("Enter a valid name", "warn");
        return;
      }

      // Check for duplicate in the already-fetched list
      var existing = customList || [];
      var hasDup = existing.some(function (e) { return e.slug === slug; });

      function proceed() {
        hideSlugConfirm();
        uploadCustomIcon(slug, pendingFile).then(function (result) {
          if (!result.ok) {
            // lr-0847: the picker previously swallowed upload failures here
            // (bare `return`), so a failed upload looked identical to a
            // successful one from the user's perspective — nothing happened,
            // no icon appeared, no explanation. Settings surfaces the same
            // uploadCustomIcon() failure via window.alert; use the app's
            // shared toast here since the picker is a transient popover, not
            // a modal dialog.
            showToast(result.error || "Upload failed", "warn");
            return;
          }
          // Refresh the custom grid after upload. buildCustomPanel() already
          // repaints the grid it just (re)built via its own fresh
          // renderCustomGrid closure (see below) — calling the outer
          // renderCustomGrid here re-renders the ORPHANED grid captured by
          // this closure at the time doUpload's panel was built, which is
          // detached from the DOM the moment buildCustomPanel() runs again.
          customList = null;
          fetchCustomList(function () { buildCustomPanel(); });
        });
      }

      if (hasDup) {
        // Confirm overwrite
        if (window.confirm(":" + slug + ": already exists — overwrite?")) {
          proceed();
        } else {
          hideSlugConfirm();
        }
      } else {
        proceed();
      }
    }

    slugOk.addEventListener("click", function (e) { e.stopPropagation(); doUpload(); });
    slugCancel.addEventListener("click", function (e) { e.stopPropagation(); hideSlugConfirm(); });
    slugInput.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); doUpload(); }
      if (e.key === "Escape") { e.preventDefault(); hideSlugConfirm(); }
    });
    // Prevent slug input clicks from bubbling to the picker's document-click close handler
    slugInput.addEventListener("click", function (e) { e.stopPropagation(); });

    fileInput.addEventListener("change", function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = ""; // reset so same file can be re-selected
      if (!file) return;
      showSlugConfirm(file);
    });

    // Grid of existing uploads
    var customGrid = document.createElement("div");
    customGrid.className = "emoji-picker-grid";
    panel.appendChild(customGrid);

    function renderCustomGrid() {
      customGrid.innerHTML = "";

      // Upload tile (always first)
      var uploadTile = document.createElement("button");
      uploadTile.className = "emoji-picker-item emoji-picker-upload-tile";
      uploadTile.title = "Upload image";
      uploadTile.textContent = "+";
      uploadTile.addEventListener("click", function (e) {
        e.stopPropagation();
        fileInput.click();
      });
      customGrid.appendChild(uploadTile);

      var list = customList || [];
      for (var ci = 0; ci < list.length; ci++) {
        (function (entry) {
          var tile = document.createElement("div");
          tile.className = "emoji-picker-custom-tile";

          var img = document.createElement("img");
          img.src = entry.url;
          img.alt = ":" + entry.slug + ":";
          img.className = "emoji-picker-custom-img";
          img.title = ":" + entry.slug + ":";
          img.addEventListener("click", function (e) {
            e.stopPropagation();
            onSelect(":" + entry.slug + ":");
          });
          tile.appendChild(img);

          var delBtn = document.createElement("button");
          delBtn.className = "emoji-picker-custom-delete";
          delBtn.title = "Delete";
          delBtn.textContent = "×";
          delBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            deleteCustomIcon(entry.slug).then(function () {
              // Same stale-closure hazard as the upload success path above:
              // buildCustomPanel() already repaints via its own fresh
              // renderCustomGrid; the closure captured here is orphaned
              // once buildCustomPanel() rebuilds the panel.
              customList = null;
              fetchCustomList(function () { buildCustomPanel(); });
            });
          });
          tile.appendChild(delBtn);

          customGrid.appendChild(tile);
        })(list[ci]);
      }

      if (list.length === 0) {
        var emptyHint = document.createElement("div");
        emptyHint.className = "emoji-picker-custom-empty";
        emptyHint.textContent = "No custom icons yet — click + to upload";
        emptyHint.style.gridColumn = "1 / -1";
        customGrid.appendChild(emptyHint);
      }
    }

    // Attach renderCustomGrid to the panel so switchCategory can re-invoke it
    panel._renderCustomGrid = renderCustomGrid;

    if (customList !== null) {
      renderCustomGrid();
    } else {
      fetchCustomList(function () { renderCustomGrid(); });
    }

    grid.appendChild(panel);
    scrollArea.scrollTop = 0;
  }

  function switchCategory(idx) {
    currentCatIdx = idx;
    for (var j = 0; j < tabBtns.length; j++) {
      tabBtns[j].classList.toggle("active", j === idx);
    }
    var meta = GROUP_META[idx];
    if (meta.g === "custom") {
      buildCustomPanel();
    } else if (_byGroup) {
      buildGrid(_byGroup[meta.g] || []);
    }
  }

  function matchingCustomIcons(query) {
    var list = customList || [];
    var matches = [];
    for (var i = 0; i < list.length; i++) {
      if (matchesCustomIconQuery(list[i].slug, query)) matches.push(list[i]);
    }
    return matches;
  }

  function showSearchResults(query) {
    tabBar.style.display = "none";
    var emojiMatches = searchEmojis(query);
    if (customList === null) {
      // Custom list not fetched yet (user hasn't opened the Custom tab this
      // session) — show emoji matches immediately, then re-render with
      // custom-icon matches once the list arrives so search never blocks on it.
      buildGrid(emojiMatches, []);
      fetchCustomList(function () {
        if (searchInput.value.trim() === query.trim()) {
          buildGrid(emojiMatches, matchingCustomIcons(query));
        }
      });
      return;
    }
    buildGrid(emojiMatches, matchingCustomIcons(query));
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
