// team-view.js - The Team view: a registry of sections plus the desktop view
// that hosts them. A section registers an id, a title, a render(container)
// and an optional isAvailable(). Sections know nothing about each other, so
// adding one touches no existing section. The desktop view (#team-view) and
// the mobile Team tab both draw through renderTeamSections().

import { refreshIcons } from './icons.js';
import { isMobileViewport } from './popover-position.js';

// Registration order is display order.
var sections = [];
var selectedId = null;

var viewEl = null;
var bodyEl = null;
var openedAutomatically = false;

// --- Registry ---

/**
 * Register a section. Registering an id that already exists replaces it in
 * place, so a module that is loaded twice does not list itself twice.
 *
 * @param {{id: string, title: string, render: function(HTMLElement): void,
 *          isAvailable?: function(): boolean}} section
 */
export function registerTeamSection(section) {
  if (!section || typeof section.id !== "string" || !section.id) {
    throw new Error("team section needs a string id");
  }
  if (typeof section.title !== "string" || !section.title) {
    throw new Error("team section " + section.id + " needs a title");
  }
  if (typeof section.render !== "function") {
    throw new Error("team section " + section.id + " needs a render(container) function");
  }
  var entry = {
    id: section.id,
    title: section.title,
    render: section.render,
    isAvailable: typeof section.isAvailable === "function" ? section.isAvailable : null,
  };
  for (var i = 0; i < sections.length; i++) {
    if (sections[i].id === entry.id) {
      sections[i] = entry;
      return;
    }
  }
  sections.push(entry);
}

export function unregisterTeamSection(id) {
  sections = sections.filter(function (s) { return s.id !== id; });
  if (selectedId === id) selectedId = null;
}

/** Sections that have something to show right now, in registration order. */
export function listTeamSections() {
  return sections.filter(function (s) { return !s.isAvailable || s.isAvailable(); });
}

// --- Rendering (shared by desktop and mobile) ---

function buildEmptyState() {
  var empty = document.createElement("div");
  empty.className = "team-empty-state";

  var title = document.createElement("p");
  title.textContent = "Nothing active";
  empty.appendChild(title);

  var hint = document.createElement("p");
  hint.className = "team-empty-hint";
  hint.textContent = "Agent activity appears here while it is running. Start a session with Agent Teams enabled to see live team activity.";
  empty.appendChild(hint);

  return empty;
}

function buildTabs(available, active, onSelect) {
  var tabs = document.createElement("div");
  tabs.className = "team-view-tabs";
  tabs.setAttribute("role", "tablist");

  available.forEach(function (s) {
    var tab = document.createElement("button");
    tab.className = "team-view-tab" + (s === active ? " active" : "");
    tab.setAttribute("role", "tab");
    tab.setAttribute("data-section-id", s.id);
    tab.textContent = s.title;
    tab.addEventListener("click", function () { onSelect(s.id); });
    tabs.appendChild(tab);
  });

  return tabs;
}

/**
 * Draw the available sections into container: a tab strip when there is more
 * than one, the selected section's content, or the empty state when none is
 * available. Replaces whatever the container held.
 */
export function renderTeamSections(container) {
  container.innerHTML = "";

  var available = listTeamSections();
  if (available.length === 0) {
    container.appendChild(buildEmptyState());
    return;
  }

  var active = available[0];
  for (var i = 0; i < available.length; i++) {
    if (available[i].id === selectedId) { active = available[i]; break; }
  }
  selectedId = active.id;

  if (available.length > 1) {
    container.appendChild(buildTabs(available, active, function (id) {
      selectedId = id;
      renderTeamSections(container);
    }));
  }

  var content = document.createElement("div");
  content.className = "team-view-section";
  content.setAttribute("data-section-id", active.id);
  active.render(content);
  container.appendChild(content);
}

// --- Desktop view ---

export function initTeamView() {
  viewEl = document.getElementById("team-view");
  bodyEl = document.getElementById("team-view-body");
  if (!viewEl) return;

  var closeBtn = document.getElementById("team-view-close");
  if (closeBtn) closeBtn.addEventListener("click", closeTeamView);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isTeamViewOpen()) closeTeamView();
  });
}

export function isTeamViewOpen() {
  return !!viewEl && !viewEl.classList.contains("hidden");
}

function setTeamButtonActive(on) {
  var btn = document.getElementById("icon-strip-team-btn");
  if (!btn) return;
  if (on) btn.classList.add("active");
  else btn.classList.remove("active");
}

/**
 * Open the view. A no-op on a phone viewport, where the Team tab is the entry.
 * opts.auto marks an open the client made on its own (a section announcing
 * live activity); a view the user already had open stays the user's.
 */
export function openTeamView(opts) {
  if (!viewEl || !bodyEl || isMobileViewport()) return;
  if (!isTeamViewOpen()) openedAutomatically = !!(opts && opts.auto);
  viewEl.classList.remove("hidden");
  setTeamButtonActive(true);
  renderTeamSections(bodyEl);
  refreshIcons();
}

export function closeTeamView() {
  if (!viewEl) return;
  viewEl.classList.add("hidden");
  openedAutomatically = false;
  setTeamButtonActive(false);
}

/**
 * Close the view only when the client opened it on its own, so the chat comes
 * back when the activity that opened it ends. A view the user opened stays.
 */
export function closeTeamViewIfAutoOpened() {
  if (openedAutomatically) closeTeamView();
}

export function toggleTeamView() {
  if (isTeamViewOpen()) closeTeamView();
  else openTeamView();
}

/** Re-render in place after a section's data changed; a no-op while closed. */
export function refreshTeamView() {
  if (!isTeamViewOpen()) return;
  renderTeamSections(bodyEl);
}
