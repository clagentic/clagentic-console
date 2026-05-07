// app-dm.js - DM mode (human users only, mates removed per lr-316f)
// Extracted from app.js (PR-24)

import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { getMessagesEl, getInputEl } from './dom-refs.js';
import { userAvatarUrl } from './avatar.js';
import { renderProjectList } from './app-projects.js';
import { scrollToBottom } from './app-rendering.js';
import { autoResize } from './input.js';
import { hideHomeHub } from './app-home-hub.js';
import { hideNotes } from './sticky-notes.js';
import { closeFileViewer } from './filebrowser.js';
import { isSchedulerOpen, closeScheduler } from './scheduler.js';
import { syncResizeHandles } from './sidebar.js';
import { updateDmBadge, setCurrentDmUser, closeDmUserPicker } from './sidebar-users.js';
import { openMobileSheet } from './sidebar-mobile.js';

var dmTypingTimer = null;

export function initDm() {
  // Reactive UI sync for dmMode
  store.subscribe(function (state, prev) {
    if (state.dmMode !== prev.dmMode) {
      var mainCol = document.getElementById("main-column");
      var sidebarCol = document.getElementById("sidebar-column");
      var resizeHandle = document.getElementById("sidebar-resize-handle");
      if (state.dmMode) {
        if (mainCol) mainCol.classList.add("dm-mode");
        if (sidebarCol) sidebarCol.classList.add("dm-mode");
        if (resizeHandle) resizeHandle.classList.add("dm-mode");
      } else {
        if (mainCol) mainCol.classList.remove("dm-mode");
        if (sidebarCol) sidebarCol.classList.remove("dm-mode");
        if (resizeHandle) resizeHandle.classList.remove("dm-mode");
      }
    }
  });

  // Mobile DM back/more handlers
  var mobileBack = document.getElementById("mate-mobile-back");
  var mobileMore = document.getElementById("mate-mobile-more");
  var mobileTitle = document.getElementById("mate-mobile-title");
  if (mobileBack) {
    mobileBack.addEventListener("click", function (e) {
      e.stopPropagation();
      exitDmMode();
    });
  }
  if (mobileMore) {
    mobileMore.addEventListener("click", function (e) {
      e.stopPropagation();
      openMobileSheet("mate-profile");
    });
  }
  if (mobileTitle) {
    mobileTitle.addEventListener("click", function () {
      openMobileSheet("mate-profile");
    });
  }
}

export function openDm(targetUserId) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  try { localStorage.setItem("clay-active-dm", targetUserId); } catch (e) {}
  ws.send(JSON.stringify({ type: "dm_open", targetUserId: targetUserId }));
}

export function enterDmMode(key, targetUser, messages) {
  store.set({ dmMode: true, dmKey: key, dmTargetUser: targetUser });

  // Clear unread for this user
  if (targetUser) {
    var unread = Object.assign({}, store.get('dmUnread'));
    unread[targetUser.id] = 0;
    store.set({ dmUnread: unread });
    updateDmBadge(targetUser.id, 0);
  }

  setCurrentDmUser(targetUser ? targetUser.id : null);
  var activeProj = document.querySelector("#icon-strip-projects .icon-strip-item.active");
  if (activeProj) activeProj.classList.remove("active");
  var homeIcon = document.querySelector(".icon-strip-home");
  if (homeIcon) homeIcon.classList.remove("active");
  renderProjectList();

  hideHomeHub();
  hideNotes();
  if (isSchedulerOpen()) closeScheduler();

  setTimeout(function () { syncResizeHandles(); }, 50);

  // Hide user-island in DM mode
  var userIsland = document.getElementById("user-island");
  if (userIsland) userIsland.classList.add("dm-hidden");

  // Populate DM header bar
  if (targetUser) {
    var dmHeaderBar = document.getElementById("dm-header-bar");
    var dmAvatar = document.getElementById("dm-header-avatar");
    var dmName = document.getElementById("dm-header-name");
    if (dmHeaderBar) dmHeaderBar.style.display = "";
    if (dmAvatar) dmAvatar.src = userAvatarUrl(targetUser, 28);
    if (dmName) dmName.textContent = targetUser.displayName;
    if (dmHeaderBar && targetUser.avatarColor) {
      dmHeaderBar.style.background = targetUser.avatarColor;
    }
  }

  // Render DM messages
  store.set({ dmMessageCache: messages ? messages.slice() : [] });
  var messagesEl = getMessagesEl();
  messagesEl.innerHTML = "";
  if (messages && messages.length > 0) {
    for (var i = 0; i < messages.length; i++) {
      appendDmMessage(messages[i]);
    }
  }
  scrollToBottom();

  var inputEl = getInputEl();
  if (inputEl) {
    var targetName = targetUser ? (targetUser.displayName || "") : "";
    inputEl.placeholder = "Message " + targetName;
    inputEl.focus();
  }
}

export function exitDmMode(skipProjectSwitch) {
  if (!store.get('dmMode')) return;
  store.set({ dmMode: false, dmKey: null, dmTargetUser: null });
  try { localStorage.removeItem("clay-active-dm"); } catch (e) {}
  setCurrentDmUser(null);

  setTimeout(function () { syncResizeHandles(); }, 100);
  if (isSchedulerOpen()) closeScheduler();

  // Reset terminal button visibility
  var termBtn = document.getElementById("terminal-toggle-btn");
  if (termBtn) termBtn.style.display = "";

  // Reset DM header
  var dmHeaderBar = document.getElementById("dm-header-bar");
  if (dmHeaderBar) {
    dmHeaderBar.style.display = "";
    dmHeaderBar.style.background = "";
  }

  // Restore user-island
  var userIsland = document.getElementById("user-island");
  if (userIsland) userIsland.classList.remove("dm-hidden");

  var inputEl = getInputEl();
  if (inputEl) inputEl.placeholder = "";

  // Re-request state from main project
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "switch_session", id: store.get('activeSessionId') }));
    ws.send(JSON.stringify({ type: "note_list_request" }));
  }
  renderProjectList();
}

export function appendDmMessage(msg) {
  var s = store.snap();
  if (s.dmMode && s.dmMessageCache) s.dmMessageCache.push(msg);
  var isMe = msg.from === s.myUserId;
  var d = new Date(msg.ts);
  var timeStr = d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");

  var messagesEl = getMessagesEl();
  var prev = messagesEl.lastElementChild;
  var compact = false;
  if (prev && prev.dataset.from === msg.from) {
    var prevTs = parseInt(prev.dataset.ts || "0", 10);
    if (msg.ts - prevTs < 300000) compact = true;
  }

  var div = document.createElement("div");
  div.className = "dm-msg" + (compact ? " dm-msg-compact" : "");
  div.dataset.from = msg.from;
  div.dataset.ts = msg.ts;

  if (compact) {
    var hoverTime = document.createElement("span");
    hoverTime.className = "dm-msg-hover-time";
    hoverTime.textContent = timeStr;
    div.appendChild(hoverTime);

    var body = document.createElement("div");
    body.className = "dm-msg-body";
    body.textContent = msg.text;
    div.appendChild(body);
  } else {
    var avatar = document.createElement("img");
    avatar.className = "dm-msg-avatar";
    if (isMe) {
      var myUser = (s.cachedAllUsers || []).find(function (u) { return u.id === s.myUserId; });
      avatar.src = userAvatarUrl(myUser || { id: s.myUserId }, 36);
    } else if (s.dmTargetUser) {
      avatar.src = userAvatarUrl(s.dmTargetUser, 36);
    }
    div.appendChild(avatar);

    var content = document.createElement("div");
    content.className = "dm-msg-content";

    var header = document.createElement("div");
    header.className = "dm-msg-header";

    var name = document.createElement("span");
    name.className = "dm-msg-name";
    if (isMe) {
      var mu = (s.cachedAllUsers || []).find(function (u) { return u.id === s.myUserId; });
      name.textContent = mu ? mu.displayName : "Me";
    } else {
      name.textContent = s.dmTargetUser ? s.dmTargetUser.displayName : "User";
    }
    header.appendChild(name);

    var time = document.createElement("span");
    time.className = "dm-msg-time";
    time.textContent = timeStr;
    header.appendChild(time);

    content.appendChild(header);

    var body = document.createElement("div");
    body.className = "dm-msg-body";
    body.textContent = msg.text;
    content.appendChild(body);

    div.appendChild(content);
  }

  messagesEl.appendChild(div);
}

export function showDmTypingIndicator(typing) {
  var existing = document.getElementById("dm-typing-indicator");
  if (!typing) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  var dmTargetUser = store.get('dmTargetUser');
  if (!dmTargetUser) return;

  var div = document.createElement("div");
  div.id = "dm-typing-indicator";
  div.className = "dm-msg dm-typing-indicator";

  var avatar = document.createElement("img");
  avatar.className = "dm-msg-avatar";
  avatar.src = userAvatarUrl(dmTargetUser, 36);
  div.appendChild(avatar);

  var dots = document.createElement("div");
  dots.className = "dm-typing-dots";
  dots.innerHTML = "<span></span><span></span><span></span>";
  div.appendChild(dots);

  var messagesEl = getMessagesEl();
  messagesEl.appendChild(div);
  scrollToBottom();

  clearTimeout(dmTypingTimer);
  dmTypingTimer = setTimeout(function () {
    showDmTypingIndicator(false);
  }, 5000);
}

export function handleDmSend() {
  var s = store.snap();
  var inputEl = getInputEl();
  if (!s.dmMode || !s.dmKey || !inputEl) return false;
  var text = inputEl.value.trim();
  if (!text) return false;
  var ws = getWs();
  ws.send(JSON.stringify({ type: "dm_send", dmKey: s.dmKey, text: text }));
  inputEl.value = "";
  autoResize();
  return true;
}
