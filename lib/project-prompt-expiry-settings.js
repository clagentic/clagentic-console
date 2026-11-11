"use strict";

// The WebSocket side of the prompt expiry setting (lib/prompt-expiry-settings.js):
// one message to change it, admin only, answered to every client of the server
// so an open settings page follows the change. A refused request saves nothing.
//
// ctx fields: slug, sendTo, send, opts (onGetPromptExpirySettings,
//   onSetPromptExpirySettings, broadcastAll), projectAccess

var promptExpirySettings = require("./prompt-expiry-settings");
var { isServerAdmin } = require("./project-permission-settings");

function attachPromptExpirySettings(ctx) {
  var opts = ctx.opts || {};

  function refuse(ws, text) {
    ctx.sendTo(ws, { type: "error", text: text });
    return true;
  }

  /** Returns true when msg was a prompt-expiry message (handled). */
  function handlePromptExpiryMessage(ws, msg) {
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
