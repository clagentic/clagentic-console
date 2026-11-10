// agent-avatar.js - the one place that decides which avatar an agent shows.
//
// Every place the console draws an agent (the Team view roster, the Agent
// messages section, an injected message's sender, a sub-agent's label in the
// transcript) asks here, by the agent's key as the roster records it. The
// server's roster (lib/agent-roster.js) holds the operator's choices and sends
// them to every client as agent_roster; handleAgentRoster in agent-roster.js
// feeds them to setAgentAvatars, and refreshAgentAvatars redraws every avatar
// already on the page.
//
// A choice is {style, seed} (a built-in style from avatar.js) or {custom} (a
// slug in the global custom-icon store, served by /api/custom-emoji, the same
// store project icons use). With no choice the caller's default shows, or the
// seeded robot. A custom icon that is deleted, or fails to load, falls back to
// that default: no broken image, no error.
//
// DOM-free except createAgentAvatar / bindAgentAvatar / refreshAgentAvatars.

import { AVATAR_STYLES, avatarUrl } from "./avatar.js";
import { customIconUrl, isCustomIconSlug } from "./project-icon.js";

// The robot every agent falls back to, seeded by its key.
export var ROBOT_STYLE = "bottts";

var choices = Object.create(null);
var listeners = [];

function knownStyle(style) {
  for (var i = 0; i < AVATAR_STYLES.length; i++) if (AVATAR_STYLES[i].id === style) return true;
  return false;
}

/** The seeded robot URL for a key: what an agent shows when nothing else applies. */
export function robotAvatarUrl(key, size) {
  return avatarUrl(ROBOT_STYLE, key, size);
}

function urlOfChoice(choice, key, size) {
  if (choice.custom !== undefined) return isCustomIconSlug(choice.custom) ? customIconUrl(choice.custom) : null;
  if (!knownStyle(choice.style)) return null;
  return avatarUrl(choice.style, choice.seed || key, size);
}

/**
 * Replace the known choices with the roster's: agents is the agent_roster
 * message's list ({key, avatar}). Entries with no avatar hold no choice.
 */
export function setAgentAvatars(agents) {
  var next = Object.create(null);
  (Array.isArray(agents) ? agents : []).forEach(function (a) {
    if (a && typeof a.key === "string" && a.avatar && typeof a.avatar === "object") next[a.key] = a.avatar;
  });
  choices = next;
  listeners.slice().forEach(function (fn) { fn(); });
}

/** The operator's choice for a key ({style, seed} or {custom}), or null. */
export function agentAvatarChoice(key) {
  return (typeof key === "string" && choices[key]) || null;
}

/** Calls fn after every setAgentAvatars. Returns a function that stops it. */
export function onAgentAvatarsChanged(fn) {
  listeners.push(fn);
  return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
}

/**
 * Resolve the avatar for an agent key.
 *   defaultUrl  what the agent shows with no choice (an existing mate or agent
 *               avatar, say); the seeded robot when absent.
 * Returns { url, fallbackUrl, custom }: url is what to show, fallbackUrl what to
 * show when url fails to load, custom the slug when url is a custom icon.
 */
export function resolveAgentAvatar(key, size, defaultUrl) {
  var fallbackUrl = defaultUrl || robotAvatarUrl(key, size);
  var choice = agentAvatarChoice(key);
  var chosen = choice ? urlOfChoice(choice, key, size) : null;
  if (!chosen) return { url: fallbackUrl, fallbackUrl: fallbackUrl, custom: null };
  return { url: chosen, fallbackUrl: fallbackUrl, custom: choice.custom !== undefined ? choice.custom : null };
}

/**
 * The roster key of an injected sender, or null when it names no agent. The same
 * rule as senderKey in lib/agent-roster.js: an extracted sender is keyed by its
 * agent name (its fromName is the "<agent or vendor>@<project>" label), a
 * declared one by the name it gave.
 */
export function senderAgentKey(injected) {
  if (!injected) return null;
  if (injected.senderKind === "extracted") return injected.senderAgent || injected.fromName || null;
  if (injected.senderKind === "declared") return injected.fromName || null;
  return null;
}

function paint(img) {
  var key = img.dataset.agentKey;
  var size = Number(img.dataset.agentSize) || 64;
  var resolved = resolveAgentAvatar(key, size, img._agentDefaultUrl);
  img._agentFallbackUrl = resolved.fallbackUrl;
  img._agentFellBack = false;
  img.src = resolved.url;
}

/**
 * Make img show the avatar for key, and keep it current: refreshAgentAvatars
 * repaints it when the roster changes, and a custom icon that fails to load
 * (deleted from the store) is replaced by the default.
 */
export function bindAgentAvatar(img, key, size, defaultUrl) {
  img.dataset.agentKey = key;
  img.dataset.agentSize = String(size);
  img._agentDefaultUrl = defaultUrl || null;
  if (!img._agentErrorBound) {
    img._agentErrorBound = true;
    img.addEventListener("error", function () {
      // One swap only: a default that also fails must not loop.
      if (img._agentFellBack || !img._agentFallbackUrl || img.src === img._agentFallbackUrl) return;
      img._agentFellBack = true;
      img.src = img._agentFallbackUrl;
    });
  }
  paint(img);
  return img;
}

/** A new <img> showing the avatar for key. */
export function createAgentAvatar(key, size, className, defaultUrl) {
  var img = document.createElement("img");
  if (className) img.className = className;
  img.alt = "";
  img.width = size;
  img.height = size;
  return bindAgentAvatar(img, key, size, defaultUrl);
}

/**
 * Show an identity from injected-identity.js on img: bound to its agent when it
 * names one, otherwise the plain avatar it resolved.
 */
export function applyIdentityAvatar(img, identity, size) {
  if (identity.agentKey) return bindAgentAvatar(img, identity.agentKey, size, identity.defaultAvatarUrl);
  img.src = identity.avatarUrl;
  return img;
}

/** Repaint every avatar under root (default: the page) from the current choices. */
export function refreshAgentAvatars(root) {
  var scope = root || (typeof document !== "undefined" ? document.body : null);
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  var imgs = scope.querySelectorAll("img[data-agent-key]");
  for (var i = 0; i < imgs.length; i++) paint(imgs[i]);
}
