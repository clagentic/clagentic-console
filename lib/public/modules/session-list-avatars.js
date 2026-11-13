// session-list-avatars.js - the "Avatars in session list" preference, and the one
// element every session list draws for it.
//
// Stored and applied the way the chat width is: cached in localStorage for first
// paint, saved on the server so it follows the person to another device, applied
// without a reload. On (the default) a session run by a named agent leads its row
// with that agent's avatar; off keeps the generic agent badge.
//
// The avatar itself is the shared agent avatar (agent-avatar.js), so a change in
// the Team view repaints these rows with every other agent avatar on the page.

import { createAgentAvatar } from "./agent-avatar.js";
import { createSerializedSaver } from "./serialized-save.js";
import { loadProfilePreference } from "./preference-sync.js";

var STORAGE_KEY = "clagentic-session-list-avatars";
// The size the design gives a session-list avatar, in CSS pixels.
export var SESSION_AVATAR_SIZE = 20;

var enabled = true;
var changeCallbacks = [];
// A choice made on this page outranks a profile reply that was already in flight.
var chosenThisPage = false;
var saveEnabled = createSerializedSaver("/api/user/session-list-avatars", "sessionListAvatars");

function lsGet() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
}

function lsSet(value) {
  try { localStorage.setItem(STORAGE_KEY, value ? "1" : "0"); } catch (e) {}
}

export function sessionListAvatarsEnabled() {
  return enabled;
}

// Returns a function that removes the listener again.
export function onSessionListAvatarsChange(fn) {
  changeCallbacks.push(fn);
  return function () {
    var at = changeCallbacks.indexOf(fn);
    if (at !== -1) changeCallbacks.splice(at, 1);
  };
}

// Applies the setting to the page and tells the listeners. Nothing is stored or sent.
export function applySessionListAvatars(value) {
  enabled = value !== false;
  var listeners = changeCallbacks.slice();
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](enabled); } catch (e) {
      console.error("session list avatars listener failed:", e);
    }
  }
}

// Choose on or off: applied at once, cached, and saved on the server.
export function setSessionListAvatars(value) {
  if (typeof value !== "boolean") return false;
  chosenThisPage = true;
  lsSet(value);
  applySessionListAvatars(value);
  saveEnabled(value);
  return true;
}

// The server is authoritative once the profile loads, so a choice made on
// another device wins. `server` is { sessionListAvatars } from /api/profile.
export function applyServerSessionListAvatars(server) {
  var value = server && server.sessionListAvatars;
  if (typeof value !== "boolean" || chosenThisPage) return;
  lsSet(value);
  if (value !== enabled) applySessionListAvatars(value);
}

// Applies this browser's cached choice, then asks the server for the person's
// own so another device's setting applies at load without opening Settings.
export function initSessionListAvatars() {
  var cached = lsGet();
  if (cached === "0" || cached === "1") enabled = cached === "1";

  return loadProfilePreference("session list avatars", applyServerSessionListAvatars);
}

/**
 * The avatar a session row shows for a named agent: the shared agent avatar at
 * the list size, round (css), named by the agent for assistive tech and on hover.
 * With no picked image, or an agent outside the caller's roster, it shows the
 * agent's initial on one of four tints (the "initial" option of the shared
 * avatar), so it reveals nothing beyond the name.
 */
export function createSessionAgentAvatar(agentName) {
  var el = createAgentAvatar(agentName, SESSION_AVATAR_SIZE, "session-list-avatar", null, { initial: true });
  el.setAttribute("aria-label", agentName);
  el.title = agentName;
  return el;
}
