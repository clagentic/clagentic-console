"use strict";

// The "Avatars in session list" setting: a boolean, on by default. The daemon's
// `sessionListAvatars` setting (`clagentic-console settings`) is the default for a
// person who has not chosen in Appearance; their own choice always wins.

var DEFAULT_SESSION_LIST_AVATARS = true;

function isSessionListAvatars(value) {
  return typeof value === "boolean";
}

module.exports = {
  DEFAULT_SESSION_LIST_AVATARS: DEFAULT_SESSION_LIST_AVATARS,
  isSessionListAvatars: isSessionListAvatars,
};
