// settings-access.js — who may open which settings area, in one place.
//
// Desktop and phone answer these questions the same way. Nothing here touches
// the DOM at import time, so the rules run under plain Node.

// Project Settings is open to everyone except a user whose permissions turn it
// off. No permissions object (single-user mode, not yet loaded) means open.
export function canOpenProjectSettings(permissions) {
  return !permissions || permissions.projectSettings !== false;
}

/**
 * The settings areas a user is offered, in display order.
 *
 *   permissions  the user's permission object (or null)
 *   isAdmin      true when the Server Settings gear is shown to this user
 *   currentSlug  the open project's slug, or null when no project is open
 *
 * Every user has their own settings. Project Settings needs an open project
 * and the project-settings permission; Server Settings needs the same
 * administrator check that shows the gear button on desktop.
 */
export function settingsAreaIds(state) {
  var ids = ["user"];
  if (state.currentSlug && canOpenProjectSettings(state.permissions)) ids.push("project");
  if (state.isAdmin) ids.push("server");
  return ids;
}

// The phone layout: the breakpoint at which the tab bar replaces the sidebar
// and the settings panels fill the screen.
export function isPhoneSettingsLayout() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 768px)").matches;
}
