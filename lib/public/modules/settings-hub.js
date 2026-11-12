// settings-hub.js — the phone Settings list: More, Settings, a section.
//
// One screen lists every settings area the user may use (their own, the open
// project's, the server's) with that area's sections. Choosing a section opens
// the area's panel on it; the panel's Back bar returns here, and this screen's
// own Back leaves Settings.
//
// What an area offers is decided in settings-access.js, and its sections are
// read from the area's desktop section list, so the phone never shows a route
// or a name that desktop does not.

import { store } from './store.js';
import { pushOverlayState, popOverlayState } from './overlay-history.js';
import { checkAdminAccess } from './admin.js';
import { settingsAreaIds } from './settings-access.js';
import { readNavGroups, renderSettingsNav, mountSettingsBack } from './settings-nav.js';
import { openUserSettings } from './user-settings.js';
import { openProjectSettings } from './project-settings.js';
import { openServerSettings } from './server-settings.js';
import { getCachedProjectList, getCachedCurrentSlug } from './sidebar-projects.js';

var CATEGORY = ".settings-nav-category";

// Per-area options for the shared navigation: where the desktop section list is
// and how to read it.
var AREAS = {
  user: {
    title: "Personal",
    nav: "#user-settings .us-modal-nav-items",
    read: { itemSelector: ".us-nav-item", separatorSelector: ".us-nav-separator", dangerClass: "us-nav-danger" },
  },
  project: {
    title: "Project",
    nav: "#project-settings .server-settings-nav-items",
    read: { categorySelector: CATEGORY },
  },
  server: {
    title: "Server",
    nav: "#server-settings .server-settings-nav-items",
    read: { categorySelector: CATEGORY },
  },
};

var hubEl = null;

function currentProject() {
  var slug = store.get("currentSlug") || getCachedCurrentSlug();
  if (!slug || store.get("dmMode")) return null;
  var list = getCachedProjectList() || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].slug === slug) return list[i];
  }
  return null;
}

function openArea(areaId, section) {
  if (areaId === "user") {
    openUserSettings(section);
  } else if (areaId === "project") {
    var project = currentProject();
    if (!project) return;
    openProjectSettings(project.slug, {
      slug: project.slug,
      name: project.name,
      icon: project.icon,
      projectOwnerId: store.get("currentProjectOwnerId"),
      ownerLocked: store.get("ownerLocked"),
    }, section);
  } else if (areaId === "server") {
    openServerSettings(section);
  }
}

function buildAreas(isAdmin) {
  var project = currentProject();
  var ids = settingsAreaIds({
    permissions: store.get("permissions"),
    isAdmin: isAdmin,
    currentSlug: project ? project.slug : null,
  });
  var areas = [];
  ids.forEach(function (id) {
    var def = AREAS[id];
    var navEl = document.querySelector(def.nav);
    if (!navEl) return;
    var groups = readNavGroups(navEl, Object.assign({ isAdmin: isAdmin }, def.read));
    if (!groups.length) return;
    areas.push({ id: id, title: def.title, subtitle: id === "project" && project ? project.name : null, groups: groups });
  });
  return areas;
}

function ensureMounted() {
  if (hubEl) return true;
  hubEl = document.getElementById("settings-hub");
  if (!hubEl) return false;
  mountSettingsBack(hubEl, { title: "Settings", onBack: closeSettingsHub });
  return true;
}

export function isSettingsHubOpen() {
  return !!hubEl && !hubEl.classList.contains("hidden");
}

// Opens the Settings list. Resolves once it is on screen.
export function openSettingsHub() {
  if (!ensureMounted()) return Promise.resolve(false);
  return checkAdminAccess().then(function (isAdmin) {
    renderSettingsNav(document.getElementById("settings-hub-body"), {
      areas: buildAreas(isAdmin),
      onSelect: openArea,
    });
    if (!isSettingsHubOpen()) {
      pushOverlayState();
      hubEl.classList.remove("hidden");
    }
    return true;
  });
}

export function closeSettingsHub() {
  if (!isSettingsHubOpen()) return;
  hubEl.classList.add("hidden");
  popOverlayState();
}
