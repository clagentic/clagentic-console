// settings-nav.js — the shared settings navigation, one component for every
// settings surface on a phone.
//
// Three settings areas (the user's own, the open project's, the server's) each
// have a desktop section list. On a phone the same sections are reached through
// one list, and each area's panel shows a Back bar instead of a section picker.
//
//   readNavGroups(navEl, options)        the area's sections, read from the
//                                        desktop section list itself, so names,
//                                        order and grouping cannot drift
//   renderSettingsNav(container, opts)   the list: areas, their groups, rows
//   mountSettingsBack(host, opts)        the Back bar (also the list's own bar)
//
// Per-use options keep each surface a variant of one component, not a copy:
//   readNavGroups     itemSelector, categorySelector, separatorSelector,
//                     dangerClass, isAdmin
//   renderSettingsNav areas [{ id, title, subtitle, groups }], onSelect,
//                     current { area, section }
//   mountSettingsBack onBack, title, label
//
// Section and area names come from markup or project names, so every label is
// set as text.

import { refreshIcons } from './icons.js';

/**
 * Turns a flat, document-ordered list of nav entries into groups.
 *
 * An entry is { type: "category" | "separator" | "item", label, section,
 * danger, hidden }. A category starts a labelled group, a separator ends the
 * current group, hidden entries are skipped, and a group left with no visible
 * item is dropped.
 */
export function groupNavEntries(entries) {
  var groups = [];
  var current = null;
  var skipping = false;
  entries.forEach(function (entry) {
    if (entry.type === "separator") {
      current = null;
      skipping = false;
      return;
    }
    if (entry.type === "category") {
      skipping = !!entry.hidden;
      current = skipping ? null : { label: entry.label, items: [] };
      if (current) groups.push(current);
      return;
    }
    if (entry.hidden || skipping) return;
    if (!current) {
      current = { label: null, items: [] };
      groups.push(current);
    }
    current.items.push({ section: entry.section, label: entry.label, danger: !!entry.danger });
  });
  return groups.filter(function (group) { return group.items.length > 0; });
}

function isHiddenEl(el, isAdmin) {
  if (el.classList.contains("hidden")) return true;
  if (el.style && el.style.display === "none") return true;
  return el.classList.contains("settings-admin-only") && !isAdmin;
}

/**
 * Reads an area's sections from its desktop section list `navEl`. Hidden
 * entries are left out the way desktop leaves them out; administrator-only
 * entries are left out unless options.isAdmin.
 */
export function readNavGroups(navEl, options) {
  var opts = options || {};
  var item = opts.itemSelector || ".settings-nav-item";
  var category = opts.categorySelector;
  var separator = opts.separatorSelector || ".settings-nav-separator";
  var dangerClass = opts.dangerClass || "settings-nav-danger";
  var selectors = [item, separator];
  if (category) selectors.push(category);
  var nodes = navEl.querySelectorAll(selectors.join(","));
  var entries = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var hidden = isHiddenEl(el, !!opts.isAdmin);
    if (el.classList.contains(separator.slice(1))) {
      entries.push({ type: "separator", hidden: hidden });
    } else if (category && el.classList.contains(category.slice(1))) {
      entries.push({ type: "category", label: el.textContent.trim(), hidden: hidden });
    } else {
      entries.push({
        type: "item",
        section: el.dataset.section,
        label: el.textContent.trim(),
        danger: el.classList.contains(dangerClass),
        hidden: hidden,
      });
    }
  }
  return groupNavEntries(entries);
}

function textEl(tag, className, text) {
  var el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

function iconEl(name) {
  var i = document.createElement("i");
  i.setAttribute("data-lucide", name);
  return i;
}

function buildRow(areaId, item, isCurrent, onSelect) {
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "settings-nav-row" + (item.danger ? " settings-nav-row-danger" : "") + (isCurrent ? " current" : "");
  btn.dataset.area = areaId;
  btn.dataset.section = item.section;
  btn.appendChild(textEl("span", "settings-nav-row-label", item.label));
  btn.appendChild(iconEl("chevron-right"));
  btn.addEventListener("click", function () { onSelect(areaId, item.section); });
  return btn;
}

/**
 * Renders the settings list into `container`: each area under its title, each
 * group under its label (when it has one), each section as a row. Choosing a
 * row calls onSelect(areaId, sectionId).
 */
export function renderSettingsNav(container, options) {
  var opts = options || {};
  var current = opts.current || {};
  container.textContent = "";
  (opts.areas || []).forEach(function (area) {
    var wrap = document.createElement("section");
    wrap.className = "settings-nav-area";
    wrap.dataset.area = area.id;
    var heading = textEl("h2", "settings-nav-area-title", area.title);
    if (area.subtitle) heading.appendChild(textEl("span", "settings-nav-area-subtitle", area.subtitle));
    wrap.appendChild(heading);
    area.groups.forEach(function (group) {
      var box = document.createElement("div");
      box.className = "settings-nav-group";
      if (group.label) box.appendChild(textEl("h3", "settings-nav-group-title", group.label));
      group.items.forEach(function (item) {
        box.appendChild(buildRow(area.id, item, current.area === area.id && current.section === item.section, opts.onSelect));
      });
      wrap.appendChild(box);
    });
    container.appendChild(wrap);
  });
  refreshIcons(container);
}

/**
 * Adds the Back bar as the first child of `host` (nothing, when `host` is null). It is shown on a phone only
 * (CSS); desktop keeps its section list and close button. Returns { el,
 * setTitle } so the panel can show the open section's name beside the arrow.
 */
export function mountSettingsBack(host, options) {
  var opts = options || {};
  // A page without the panel's nav column has nothing to put the bar in.
  if (!host) return { el: null, setTitle: function () {} };
  var bar = document.createElement("div");
  bar.className = "settings-back-bar";
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "settings-back-btn";
  btn.setAttribute("aria-label", opts.label || "Back");
  btn.appendChild(iconEl("chevron-left"));
  btn.addEventListener("click", function () { opts.onBack(); });
  bar.appendChild(btn);
  var title = textEl("span", "settings-back-title", opts.title || "");
  bar.appendChild(title);
  host.insertBefore(bar, host.firstChild);
  refreshIcons(bar);
  return {
    el: bar,
    setTitle: function (text) { title.textContent = text; },
  };
}
