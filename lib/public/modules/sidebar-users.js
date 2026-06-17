// sidebar-users.js - Human user strip, DM picker, context menus, tooltips, presence
// Human-user sidebar (replaces former mates sidebar after lr-316f removal).
// Contains only human-user functionality; all mate-specific rendering is removed.

import { userAvatarUrl } from './avatar.js';
import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { closeProjectCtxMenu } from './sidebar-projects.js';
import { spawnDustParticles } from './sidebar.js';
import { openDm } from './app-dm.js';

function sendWs(msg) {
  var ws = getWs();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// --- User strip state ---
var cachedAllUsers = [];
var cachedOnlineUserIds = [];
var cachedDmFavorites = [];
var cachedDmConversations = [];
var cachedDmUnread = {};
var cachedMyUserId = null;
var currentDmUserId = null;
var dmPickerOpen = false;
var cachedDmRemovedUsers = {};

// --- Agent favorites state ---
var cachedAgentFavorites = [];

// Small palette of muted background colors keyed by first letter of agent name.
var AGENT_COLORS = [
  "#3d4a6b", "#4a3d6b", "#3d6b4a", "#6b4a3d", "#3d5f6b",
  "#5f6b3d", "#6b3d5f", "#3d6b5f", "#6b5f3d", "#4a6b3d",
];

function agentColor(name) {
  if (!name) return AGENT_COLORS[0];
  var code = 0;
  for (var i = 0; i < name.length; i++) code += name.charCodeAt(i);
  return AGENT_COLORS[code % AGENT_COLORS.length];
}

// setMentionActive / clearAllMentionActive kept as no-ops for call-site
// compatibility — mentions were a mates-only feature.
export function setMentionActive(mateId, active) { /* no-op: mates removed */ }
export function clearAllMentionActive() { /* no-op: mates removed */ }

var _lastUserStripJson = "";

// --- Icon strip tooltip ---
var iconStripTooltip = null;

// --- DM user context menu ---
var userCtxMenu = null;

export function initSidebarUsers() {
  // Reactive UI sync for user strip
  store.subscribe(['cachedAllUsers', 'cachedOnlineIds', 'cachedDmFavorites', 'cachedDmConversations', 'dmUnread', 'dmRemovedUsers', 'myUserId'], function (state, prev) {
    if (state.cachedAllUsers !== prev.cachedAllUsers ||
        state.cachedOnlineIds !== prev.cachedOnlineIds ||
        state.cachedDmFavorites !== prev.cachedDmFavorites ||
        state.cachedDmConversations !== prev.cachedDmConversations ||
        state.dmUnread !== prev.dmUnread ||
        state.dmRemovedUsers !== prev.dmRemovedUsers ||
        state.myUserId !== prev.myUserId) {
      renderUserStrip();
    }
  });

  // Request agent list on connect/reconnect so favorites are populated.
  store.subscribe(['connected'], function (state, prev) {
    if (state.connected && !prev.connected) {
      sendWs({ type: "list_agents" });
    }
  });
}

// Handle agents_list WS message — extract favorites and re-render the team strip.
export function handleAgentsList(msg) {
  cachedAgentFavorites = (msg && msg.favorites) ? msg.favorites : [];
  renderAgentFavorites();
}

var MAX_AGENT_ICONS = 5;

function renderAgentFavorites() {
  var container = document.getElementById("icon-strip-team");
  if (!container) return;

  // Remove any existing agent icons before re-rendering.
  var existing = container.querySelectorAll(".icon-strip-agent");
  for (var i = 0; i < existing.length; i++) existing[i].remove();

  var favorites = cachedAgentFavorites.slice(0, MAX_AGENT_ICONS);
  for (var ai = 0; ai < favorites.length; ai++) {
    (function (agentName) {
      var el = document.createElement("div");
      el.className = "icon-strip-agent";
      el.style.background = agentColor(agentName);

      // First letter or emoji — a single grapheme cluster covers simple emoji
      var firstChar = Array.from(agentName)[0] || "?";
      var label = document.createElement("span");
      label.className = "icon-strip-agent-label";
      label.textContent = firstChar;
      el.appendChild(label);

      el.addEventListener("mouseenter", function () { showIconTooltip(el, agentName); });
      el.addEventListener("mouseleave", hideIconTooltip);

      container.appendChild(el);
    })(favorites[ai]);
  }
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

export function closeUserCtxMenu() {
  if (userCtxMenu) {
    userCtxMenu.remove();
    userCtxMenu = null;
  }
  document.removeEventListener("click", handleUserCtxOutsideClick, true);
}

function showUserCtxMenu(anchorEl, user) {
  closeUserCtxMenu();
  if (closeProjectCtxMenu) closeProjectCtxMenu();

  var menu = document.createElement("div");
  menu.className = "project-ctx-menu";

  var removeItem = document.createElement("button");
  removeItem.className = "project-ctx-item project-ctx-delete";
  removeItem.innerHTML = iconHtml("user-minus") + " <span>Remove from favorites</span>";
  removeItem.addEventListener("click", function (e) {
    e.stopPropagation();
    var iconRect = anchorEl.getBoundingClientRect();
    if (spawnDustParticles) spawnDustParticles(iconRect.left + iconRect.width / 2, iconRect.top + iconRect.height / 2);
    closeUserCtxMenu();
    cachedDmRemovedUsers[user.id] = true;
    var dr = Object.assign({}, store.get('dmRemovedUsers')); dr[user.id] = true; store.set({ dmRemovedUsers: dr });
    sendWs({ type: "dm_remove_favorite", targetUserId: user.id });
  });
  menu.appendChild(removeItem);

  document.body.appendChild(menu);
  userCtxMenu = menu;
  refreshIcons();

  requestAnimationFrame(function () {
    var rect = anchorEl.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.left = (rect.right + 6) + "px";
    menu.style.top = rect.top + "px";
    var menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 8) {
      menu.style.left = (rect.left - menuRect.width - 6) + "px";
    }
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = (window.innerHeight - menuRect.height - 8) + "px";
    }
  });

  setTimeout(function () {
    document.addEventListener("click", handleUserCtxOutsideClick, true);
  }, 0);
}

function handleUserCtxOutsideClick(e) {
  if (userCtxMenu && !userCtxMenu.contains(e.target)) {
    closeUserCtxMenu();
  }
}

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

// renderUserStrip: call with no args to read from store (subscriber pattern).
export function renderUserStrip(allUsers, onlineUserIds, myUserId, dmFavorites, dmConversations, dmUnread, dmRemovedUsers) {
  if (arguments.length === 0) {
    var s = store.snap();
    allUsers = s.cachedAllUsers;
    onlineUserIds = s.cachedOnlineIds;
    myUserId = s.myUserId;
    dmFavorites = s.cachedDmFavorites;
    dmConversations = s.cachedDmConversations;
    dmUnread = s.dmUnread;
    dmRemovedUsers = s.dmRemovedUsers;
  }

  var fingerprint = JSON.stringify([allUsers, onlineUserIds, dmFavorites, dmConversations, dmUnread, dmRemovedUsers]);
  if (fingerprint === _lastUserStripJson) return;
  _lastUserStripJson = fingerprint;

  cachedAllUsers = allUsers || [];
  cachedOnlineUserIds = onlineUserIds || [];
  cachedDmFavorites = dmFavorites || [];
  cachedDmConversations = dmConversations || [];
  cachedDmUnread = dmUnread || {};
  cachedDmRemovedUsers = dmRemovedUsers || {};
  cachedMyUserId = myUserId;

  var container = document.getElementById("icon-strip-team");
  if (!container) return;

  var allOthers = cachedAllUsers.filter(function (u) { return u.id !== myUserId; });

  // Hide section if no other users
  if (allOthers.length === 0) {
    container.innerHTML = "";
    container.classList.add("hidden");
    return;
  }

  // Show only favorites + users with unread + users with DM conversations
  var others = allOthers.filter(function (u) {
    if (cachedDmRemovedUsers[u.id]) return false;
    if (cachedDmFavorites.indexOf(u.id) !== -1) return true;
    if (cachedDmUnread[u.id] && cachedDmUnread[u.id] > 0) return true;
    if (cachedDmConversations.indexOf(u.id) !== -1) return true;
    return false;
  });

  container.classList.remove("hidden");
  container.innerHTML = "";

  for (var i = 0; i < others.length; i++) {
    (function (u) {
      var el = document.createElement("div");
      el.className = "icon-strip-user";
      el.dataset.userId = u.id;
      if (u.id === currentDmUserId) el.classList.add("active");
      if (onlineUserIds.indexOf(u.id) !== -1) el.classList.add("online");

      var pill = document.createElement("span");
      pill.className = "icon-strip-pill";
      el.appendChild(pill);

      var avatar = document.createElement("img");
      avatar.className = "icon-strip-user-avatar";
      avatar.src = userAvatarUrl(u, 34);
      avatar.alt = u.displayName;
      el.appendChild(avatar);

      var onlineDot = document.createElement("span");
      onlineDot.className = "icon-strip-user-online";
      el.appendChild(onlineDot);

      var badge = document.createElement("span");
      badge.className = "icon-strip-user-badge";
      badge.dataset.userId = u.id;
      el.appendChild(badge);

      var unreadCount = cachedDmUnread[u.id] || 0;
      if (unreadCount > 0 && u.id !== currentDmUserId) {
        badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
        badge.classList.add("has-unread");
      }

      el.addEventListener("mouseenter", function () { showIconTooltip(el, u.displayName); });
      el.addEventListener("mouseleave", hideIconTooltip);

      el.addEventListener("click", function () {
        if (openDm) openDm(u.id);
      });

      el.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        e.stopPropagation();
        showUserCtxMenu(el, u);
      });

      container.appendChild(el);
    })(others[i]);
  }

  // Add user (+) button — only shown in multi-user mode
  if (store.get('isMultiUserMode')) {
    var addBtn = document.createElement("button");
    addBtn.className = "icon-strip-invite";
    addBtn.innerHTML = iconHtml("user-plus");
    addBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleDmUserPicker(addBtn);
    });
    addBtn.addEventListener("mouseenter", function () { showIconTooltip(addBtn, "Add user"); });
    addBtn.addEventListener("mouseleave", hideIconTooltip);
    container.appendChild(addBtn);
    refreshIcons();
  }
}

function toggleDmUserPicker(anchorEl) {
  if (dmPickerOpen) {
    closeDmUserPicker();
    return;
  }
  dmPickerOpen = true;

  var picker = document.createElement("div");
  picker.className = "dm-user-picker";
  picker.id = "dm-user-picker";

  var searchInput = document.createElement("input");
  searchInput.className = "dm-user-picker-search";
  searchInput.type = "text";
  searchInput.placeholder = "Search users...";
  picker.appendChild(searchInput);

  var usersLabel = document.createElement("div");
  usersLabel.className = "dm-user-picker-section";
  usersLabel.textContent = "Users";
  picker.appendChild(usersLabel);

  var listEl = document.createElement("div");
  listEl.className = "dm-user-picker-list";
  picker.appendChild(listEl);

  document.body.appendChild(picker);
  var rect = anchorEl.getBoundingClientRect();
  picker.style.left = (rect.right + 8) + "px";
  picker.style.bottom = (window.innerHeight - rect.bottom) + "px";

  function renderPickerList(filter) {
    listEl.innerHTML = "";
    var allOthers = cachedAllUsers.filter(function (u) { return u.id !== cachedMyUserId; });
    var available = allOthers.filter(function (u) {
      return cachedDmFavorites.indexOf(u.id) === -1;
    });
    if (filter) {
      var lf = filter.toLowerCase();
      available = available.filter(function (u) {
        return (u.displayName && u.displayName.toLowerCase().indexOf(lf) !== -1) ||
               (u.username && u.username.toLowerCase().indexOf(lf) !== -1);
      });
    }
    if (available.length === 0) {
      var emptyEl = document.createElement("div");
      emptyEl.className = "dm-user-picker-empty";
      emptyEl.textContent = filter ? "No users found" : "No more users to add";
      listEl.appendChild(emptyEl);
      return;
    }
    for (var i = 0; i < available.length; i++) {
      (function (u) {
        var item = document.createElement("div");
        item.className = "dm-user-picker-item";

        var av = document.createElement("img");
        av.className = "dm-user-picker-avatar";
        av.src = userAvatarUrl(u, 28);
        av.alt = u.displayName;
        item.appendChild(av);

        var name = document.createElement("span");
        name.className = "dm-user-picker-name";
        name.textContent = u.displayName;
        item.appendChild(name);

        item.addEventListener("click", function () {
          sendWs({ type: "dm_add_favorite", targetUserId: u.id });
          closeDmUserPicker();
        });

        listEl.appendChild(item);
      })(available[i]);
    }
  }

  renderPickerList("");
  searchInput.addEventListener("input", function () {
    renderPickerList(searchInput.value);
  });

  setTimeout(function () { searchInput.focus(); }, 50);

  function onDocClick(e) {
    if (!picker.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
      closeDmUserPicker();
      document.removeEventListener("click", onDocClick, true);
    }
  }
  setTimeout(function () {
    document.addEventListener("click", onDocClick, true);
  }, 10);
  picker._docClickHandler = onDocClick;
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
  // Update active state on icon strip items
  var items = document.querySelectorAll("#icon-strip-team .icon-strip-user");
  for (var i = 0; i < items.length; i++) {
    if (items[i].dataset.userId === userId) {
      items[i].classList.add("active");
    } else {
      items[i].classList.remove("active");
    }
  }
}

export function updateDmBadge(userId, count) {
  var badge = document.querySelector("#icon-strip-team .icon-strip-user-badge[data-user-id='" + userId + "']");
  if (!badge) return;
  if (count && count > 0) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.add("has-unread");
  } else {
    badge.textContent = "";
    badge.classList.remove("has-unread");
  }
}

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
