"use strict";

// The WebSocket side of the server-wide permission settings
// (lib/permission-settings.js): one message to change them, answered to every
// client of the server so an open settings page follows the change.

var { pickSettingChanges, settingsMessage } = require("./permission-settings");

/**
 * Whether a connection may change a server-wide setting: an administrator only
 * (the server default mode is gated the same way). In single-user mode the
 * authenticated connection is the implicit administrator (projectAccess.isAdmin).
 */
function isServerAdmin(projectAccess, ws) {
  if (!projectAccess || typeof projectAccess.isAdmin !== "function") return false;
  return !!projectAccess.isAdmin(ws._clagenticUser, projectAccess.authOf(ws));
}

/**
 * ctx fields: slug, sendTo, send, opts, projectAccess,
 *   checkRequestedMode(session, mode, what) -> {ok, error}
 */
function attachPermissionSettings(ctx) {
  var opts = ctx.opts || {};

  function refuse(ws, text) {
    ctx.sendTo(ws, { type: "error", text: text });
    return true;
  }

  /** Returns true when msg was a permission-settings message (handled). */
  function handlePermissionSettingsMessage(ws, msg) {
    if (msg.type !== "set_permission_settings") return false;
    if (!isServerAdmin(ctx.projectAccess, ws)) {
      console.warn("[project-permission-settings] refused set_permission_settings in " + ctx.slug + ": caller is not an admin");
      return refuse(ws, "Only admins can change the server permission settings.");
    }
    var picked = pickSettingChanges(msg);
    if (picked.rejected.length > 0) {
      return refuse(ws, "Unknown or invalid permission setting: " + picked.rejected.join(", "));
    }
    if (picked.values.openedSessionMode !== undefined) {
      var verdict = ctx.checkRequestedMode(null, picked.values.openedSessionMode, "set_permission_settings openedSessionMode");
      if (!verdict.ok) return refuse(ws, verdict.error);
    }
    if (Object.keys(picked.values).length === 0) return true;
    if (typeof opts.onSetPermissionSettings !== "function" || typeof opts.onGetPermissionSettings !== "function") {
      return refuse(ws, "The server cannot store permission settings.");
    }
    opts.onSetPermissionSettings(picked.values);
    var announce = typeof opts.broadcastAll === "function" ? opts.broadcastAll : ctx.send;
    announce(settingsMessage(opts.onGetPermissionSettings()));
    return true;
  }

  return { handlePermissionSettingsMessage: handlePermissionSettingsMessage };
}

module.exports = { attachPermissionSettings: attachPermissionSettings, isServerAdmin: isServerAdmin };
