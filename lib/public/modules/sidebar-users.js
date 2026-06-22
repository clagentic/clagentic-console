// sidebar-users.js - Human user strip, DM picker, context menus, tooltips, presence
// Human-user sidebar (replaces former mates sidebar after lr-316f removal).
// Contains only human-user functionality; all mate-specific rendering is removed.

import { userAvatarUrl } from './avatar.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { toggleTeamPanel } from './team-panel.js';

function sendWs(msg) {
  var ws = getWs();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// --- User strip state ---
var cachedAllUsers = [];
var cachedDmFavorites = [];
var cachedDmConversations = [];
var cachedDmUnread = {};
var cachedMyUserId = null;
var currentDmUserId = null;
var dmPickerOpen = false;
var cachedDmRemovedUsers = {};


// setMentionActive / clearAllMentionActive kept as no-ops for call-site
// compatibility — mentions were a mates-only feature.
export function setMentionActive(mateId, active) { /* no-op: mates removed */ }
export function clearAllMentionActive() { /* no-op: mates removed */ }

// --- Icon strip tooltip ---
var iconStripTooltip = null;

export function initSidebarUsers() {
  // Wire the permanent Teams button in the icon strip.
  var teamBtn = document.getElementById("icon-strip-team-btn");
  if (teamBtn) {
    teamBtn.addEventListener("click", function () {
      if (typeof toggleTeamPanel === "function") toggleTeamPanel();
    });
    teamBtn.addEventListener("mouseenter", function () { showIconTooltip(teamBtn, "Team"); });
    teamBtn.addEventListener("mouseleave", hideIconTooltip);
  }

  // Keep local caches in sync with the store so getCachedDm* accessors and
  // the DM picker remain accurate even though nothing renders in the icon strip.
  store.subscribe(['cachedAllUsers', 'cachedOnlineIds', 'cachedDmFavorites', 'cachedDmConversations', 'dmUnread', 'dmRemovedUsers', 'myUserId'], function (state) {
    cachedAllUsers = state.cachedAllUsers || [];
    cachedDmFavorites = state.cachedDmFavorites || [];
    cachedDmConversations = state.cachedDmConversations || [];
    cachedDmUnread = state.dmUnread || {};
    cachedDmRemovedUsers = state.dmRemovedUsers || {};
    cachedMyUserId = state.myUserId;
  });

  // Request agent list on connect/reconnect so favorites are populated.
  store.subscribe(['connected'], function (state, prev) {
    if (state.connected && !prev.connected) {
      sendWs({ type: "list_agents" });
    }
  });
}


export function showIconTooltip(el, text) {
  hideIconTooltip();
  var tip = document.createElement("div");
  tip.className = "icon-strip-tooltip";
  tip.textContent = text;
  document.body.appendChild(tip);
  iconStripTooltip = tip;

  requestAnimationFrame(function () {
    var rect = el.getBoundingClientRect();
    tip.style.top = (rect.top + rect.height / 2 - tip.offsetHeight / 2) + "px";
    tip.classList.add("visible");
  });
}

export function showIconTooltipHtml(el, html) {
  hideIconTooltip();
  var tip = document.createElement("div");
  tip.className = "icon-strip-tooltip";
  tip.style.whiteSpace = "normal";
  tip.style.maxWidth = "260px";
  tip.innerHTML = html;
  document.body.appendChild(tip);
  iconStripTooltip = tip;

  requestAnimationFrame(function () {
    var rect = el.getBoundingClientRect();
    tip.style.top = (rect.top + rect.height / 2 - tip.offsetHeight / 2) + "px";
    tip.classList.add("visible");
  });
}

export function hideIconTooltip() {
  if (iconStripTooltip) {
    iconStripTooltip.remove();
    iconStripTooltip = null;
  }
}

// closeUserCtxMenu: no-op stub retained for sidebar-projects.js and sidebar.js
// imports. The user context menu was attached to per-user icon-strip items that
// no longer exist; nothing can open it, so nothing needs to close it.
export function closeUserCtxMenu() { /* no-op: icon-strip user context menu removed */ }

var _lastSidebarPresenceIds = [];
export function renderSidebarPresence(onlineUsers) {
  var container = document.getElementById("sidebar-presence");
  if (!container) return;
  if (!onlineUsers || onlineUsers.length < 2) {
    if (_lastSidebarPresenceIds.length > 0) {
      _lastSidebarPresenceIds = [];
      container.innerHTML = "";
    }
    return;
  }
  var newIds = onlineUsers.map(function (u) { return u.id; }).sort();
  if (newIds.length === _lastSidebarPresenceIds.length && newIds.every(function (id, i) { return id === _lastSidebarPresenceIds[i]; })) return;
  _lastSidebarPresenceIds = newIds;
  container.innerHTML = "";
  var maxShow = 4;
  for (var i = 0; i < Math.min(onlineUsers.length, maxShow); i++) {
    var ou = onlineUsers[i];
    var img = document.createElement("img");
    img.className = "sidebar-presence-avatar";
    img.src = userAvatarUrl(ou, 24);
    img.alt = ou.displayName;
    img.dataset.tip = ou.displayName + " (@" + ou.username + ")";
    container.appendChild(img);
  }
  if (onlineUsers.length > maxShow) {
    var more = document.createElement("span");
    more.className = "sidebar-presence-more";
    more.textContent = "+" + (onlineUsers.length - maxShow);
    container.appendChild(more);
  }
}



export function closeDmUserPicker() {
  dmPickerOpen = false;
  var picker = document.getElementById("dm-user-picker");
  if (picker) {
    if (picker._docClickHandler) {
      document.removeEventListener("click", picker._docClickHandler, true);
    }
    picker.remove();
  }
}

export function setCurrentDmUser(userId) {
  currentDmUserId = userId;
  // Icon-strip user avatars are gone; active DM state is tracked in currentDmUserId
  // for use by the team panel and DM picker.
}

// updateDmBadge: no-op — DM unread counts are now shown only inside the team panel.
// Future: wire DM unread count to team panel badge. No-op until team panel supports per-user DM count display.
export function updateDmBadge(userId, count) { /* no-op: icon-strip user badges removed */ }

export function getCurrentDmUserId() {
  return currentDmUserId;
}

export function getCachedDmFavorites() {
  return cachedDmFavorites;
}

export function getCachedDmUnread() {
  return cachedDmUnread;
}

export function getCachedDmRemovedUsers() {
  return cachedDmRemovedUsers;
}
