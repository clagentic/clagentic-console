"use strict";

// The conversation width a person can choose in Appearance. One list for every
// server-side reader (the per-user preference, the profile reply, the settings
// verb); the browser keeps its own copy in lib/public/modules/chat-width-prefs.js
// and a test holds the two together. The pixel sizes live in the stylesheet
// (css/base.css), not here.

var CHAT_WIDTHS = ["compact", "comfortable", "wide", "full"];
var DEFAULT_CHAT_WIDTH = "comfortable";

// The retired bubble/channel layout choice, mapped once onto the width that
// looks closest: bubble was the centred column, channel the full pane.
var LEGACY_LAYOUT_WIDTH = { bubble: "comfortable", channel: "full" };

function isChatWidth(value) {
  return typeof value === "string" && CHAT_WIDTHS.indexOf(value) !== -1;
}

/** The width a retired layout value maps to, or null when it is not one. */
function widthFromLegacyLayout(layout) {
  if (typeof layout !== "string") return null;
  return Object.prototype.hasOwnProperty.call(LEGACY_LAYOUT_WIDTH, layout) ? LEGACY_LAYOUT_WIDTH[layout] : null;
}

module.exports = {
  CHAT_WIDTHS: CHAT_WIDTHS,
  DEFAULT_CHAT_WIDTH: DEFAULT_CHAT_WIDTH,
  isChatWidth: isChatWidth,
  widthFromLegacyLayout: widthFromLegacyLayout,
};
