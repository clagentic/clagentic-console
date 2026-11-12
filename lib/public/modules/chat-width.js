// chat-width.js - the conversation width, stored and applied the way the theme
// is: cached in localStorage for first paint, saved on the server so it follows
// the person to another device, applied without a reload.
//
// The step is the data-chat-width attribute on <html>; css/base.css turns it into
// --content-width, which every message type and the composer read. index.html's
// first-paint script sets the same attribute from the same key before any
// module loads; change both together.

import {
  normalizeWidth, isChatWidth, resolveStoredWidth
} from './chat-width-prefs.js';

var WIDTH_KEY = "clagentic-chat-width";
// The key the retired bubble/channel switch used.
var LEGACY_KEY = "clagentic-wide-view";

var currentWidth = normalizeWidth(null);
var changeCallbacks = [];
// A choice made on this page outranks a profile reply that was already in flight.
var chosenThisPage = false;

// Storage can be unavailable (private mode, quota); the choice then lasts for
// the page only, which is the right degradation.
function lsGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}

function lsRemove(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}

export function getChatWidth() {
  return currentWidth;
}

// Returns a function that removes the listener again.
export function onChatWidthChange(fn) {
  changeCallbacks.push(fn);
  return function () {
    var at = changeCallbacks.indexOf(fn);
    if (at !== -1) changeCallbacks.splice(at, 1);
  };
}

// Applies a step to the page and tells the listeners. Nothing is stored or sent.
export function applyChatWidth(width) {
  var next = normalizeWidth(width);
  currentWidth = next;
  document.documentElement.setAttribute("data-chat-width", next);
  for (var i = 0; i < changeCallbacks.length; i++) {
    try { changeCallbacks[i](next); } catch (e) {}
  }
}

// Choose a step: applied at once, cached, and saved on the server (best effort;
// the next profile load reconciles).
export function setChatWidth(width) {
  if (!isChatWidth(width)) return false;
  chosenThisPage = true;
  lsSet(WIDTH_KEY, width);
  applyChatWidth(width);
  fetch("/api/user/chat-width", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatWidth: width }),
  }).catch(function () {});
  return true;
}

// The server is authoritative once the profile loads, so a choice made on
// another device wins. `server` is { chatWidth } from /api/profile.
export function applyServerChatWidth(server) {
  var width = server && server.chatWidth;
  if (!isChatWidth(width) || chosenThisPage) return;
  lsSet(WIDTH_KEY, width);
  if (width !== currentWidth) applyChatWidth(width);
}

// Applies the saved step from this browser, migrating the retired layout key
// once, then asks the server for the person's own choice so another device's
// setting applies at load without opening Settings.
export function initChatWidth() {
  var resolved = resolveStoredWidth({ width: lsGet(WIDTH_KEY), legacy: lsGet(LEGACY_KEY) });
  if (lsGet(LEGACY_KEY) !== null) {
    lsSet(WIDTH_KEY, resolved.width);
    lsRemove(LEGACY_KEY);
  }
  applyChatWidth(resolved.width);

  return fetch("/api/profile").then(function (res) {
    return res.ok ? res.json() : null;
  }).then(function (profile) {
    if (profile) applyServerChatWidth(profile);
  }).catch(function () {});
}
