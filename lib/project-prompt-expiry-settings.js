"use strict";

// The WebSocket side of the prompt expiry setting (lib/prompt-expiry-settings.js):
// one message to change it, admin only, answered to every client of the server
// so an open settings page follows the change. A refused request saves nothing.
//
// ctx fields: slug, sendTo, send, opts (onGetPromptExpirySettings,
//   onSetPromptExpirySettings, broadcastAll), projectAccess, sm, getSessionForWs

var promptExpirySettings = require("./prompt-expiry-settings");
var { isServerAdmin } = require("./project-permission-settings");

function attachPromptExpirySettings(ctx) {
  var opts = ctx.opts || {};

  function refuse(ws, text) {
    ctx.sendTo(ws, { type: "error", text: text });
    return true;
  }

  // The viewed session's own expiry, in place of the daemon-wide one for the
  // prompts it raises. Admin only, like the daemon-wide value. Saved with the
  // session; the reply goes to the requester with the session's value.
  function handleSessionExpiry(ws, msg) {
    if (!isServerAdmin(ctx.projectAccess, ws)) {
      console.warn("[project-prompt-expiry-settings] refused set_session_prompt_expiry in " + ctx.slug + ": caller is not an admin");
      return refuse(ws, "Only admins can change the prompt expiry.");
    }
    var picked = promptExpirySettings.pickSessionChange(msg);
    if (!picked.ok) return refuse(ws, picked.reason);
    var session = typeof ctx.getSessionForWs === "function" ? ctx.getSessionForWs(ws) : null;
    if (!session) return refuse(ws, "There is no session to set the prompt expiry on.");
    if (picked.minutes === null) delete session.promptExpiryMinutes;
    else session.promptExpiryMinutes = picked.minutes;
    ctx.sm.saveSessionFile(session);
    var base = typeof opts.onGetPromptExpirySettings === "function" ? opts.onGetPromptExpirySettings() : { type: "prompt_expiry_settings" };
    ctx.sendTo(ws, Object.assign({}, base, { sessionPromptExpiryMinutes: picked.minutes }));
    return true;
  }

  /** Returns true when msg was a prompt-expiry message (handled). */
  function handlePromptExpiryMessage(ws, msg) {
    if (msg.type === "set_session_prompt_expiry") return handleSessionExpiry(ws, msg);
    if (msg.type !== "set_prompt_expiry_settings") return false;
    if (!isServerAdmin(ctx.projectAccess, ws)) {
      console.warn("[project-prompt-expiry-settings] refused set_prompt_expiry_settings in " + ctx.slug + ": caller is not an admin");
      return refuse(ws, "Only admins can change the prompt expiry.");
    }
    var picked = promptExpirySettings.pickSettingChange(msg);
    if (!picked.ok) return refuse(ws, picked.reason);
    if (typeof opts.onSetPromptExpirySettings !== "function" || typeof opts.onGetPromptExpirySettings !== "function") {
      return refuse(ws, "The server cannot store the prompt expiry.");
    }
    opts.onSetPromptExpirySettings(picked.minutes);
    var announce = typeof opts.broadcastAll === "function" ? opts.broadcastAll : ctx.send;
    announce(opts.onGetPromptExpirySettings());
    return true;
  }

  return { handlePromptExpiryMessage: handlePromptExpiryMessage };
}

module.exports = { attachPromptExpirySettings: attachPromptExpirySettings };
