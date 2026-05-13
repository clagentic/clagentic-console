// app-rendering.js - Message rendering, streaming, scroll management, system messages
// Extracted from app.js (PR-28)

import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { getMessagesEl, getInputEl, getSendBtn } from './dom-refs.js';
import { escapeHtml, copyToClipboard } from './utils.js';
import { renderMarkdown, renderMarkdownAsync, highlightCodeBlocks, renderMermaidBlocks } from './markdown.js';
import { iconHtml, refreshIcons } from './icons.js';
import { userAvatarUrl } from './avatar.js';
import { closeToolGroup } from './tools.js';
import { showImageModal, showPasteModal } from './app-misc.js';
import { sendMessage, hasSendableContent } from './input.js';
import { getChatLayout } from './theme.js';
import { getScheduledMsgEl } from './app-rate-limit.js';

export var VENDOR_AVATARS = {
  claude: "/claude-code-avatar.png",
  codex: "/codex-avatar.png",
};
export var VENDOR_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
};
var NEW_MSG_BTN_DEFAULT = "\u2193 Latest";
var NEW_MSG_BTN_ACTIVITY = "\u2193 New activity";

// --- Module-owned state (not in store) ---
var turnCounter = 0;
var prependAnchor = null;
var activityEl = null;
var highlightTimer = null;
var streamBuffer = "";
var streamDrainTimer = null;
var streamRenderLen = 0; // length of currentFullText at last innerHTML render
var streamRenderPending = false; // true while worker parse is in flight
var currentFullTextLocal = ""; // module-local accumulator — not in store during streaming

export function resetCurrentFullText(v) {
  currentFullTextLocal = v || "";
}
var isUserScrolledUp = false;
var scrollThreshold = 150;

// --- Sticky-bottom mode ---
// While armed, a ResizeObserver re-pins #messages to scrollHeight on every
// height change so deferred content (tools, syntax highlighting, images,
// IntersectionObserver-driven reflows) doesn't strand the user mid-page.
// The scroll listener in app.js consults getStickyBottom() and ignores
// growth-induced scroll events while armed.
//
// Disarm rules:
//   - Real user input (wheel / touchmove / PageUp / Home / ArrowUp): immediate.
//   - Quiet detector: armStickyBottom(durationMs) treats durationMs as the
//     QUIET WINDOW, not a hard timer. Each ResizeObserver callback resets
//     a debounce timer; sticky-bottom only disarms after no resize for
//     durationMs. Long-settling sessions (large todo widgets, slow code
//     highlighting) keep extending the window naturally.
//   - Hard ceiling: a separate cap prevents pathological lock-in.
var stickyBottom = false;
var stickyBottomQuietTimer = null;
var stickyBottomCeilingTimer = null;
var stickyBottomQuietMs = 750;
var stickyBottomCeilingMs = 8000;
var stickyBottomResizeObs = null;
var stickyBottomInputBound = false;

export function getStickyBottom() { return stickyBottom; }

function pinToBottomNow() {
  var messagesEl = getMessagesEl();
  if (!messagesEl) return;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function ensureStickyInfrastructure() {
  var messagesEl = getMessagesEl();
  if (!messagesEl) return;
  if (!stickyBottomResizeObs && typeof ResizeObserver !== "undefined") {
    stickyBottomResizeObs = new ResizeObserver(function () {
      if (!stickyBottom) return;
      // Re-pin on every layout change while armed.
      pinToBottomNow();
      // Reset the quiet timer — settling has not finished yet.
      if (stickyBottomQuietTimer) clearTimeout(stickyBottomQuietTimer);
      stickyBottomQuietTimer = setTimeout(disarmStickyBottom, stickyBottomQuietMs);
    });
    // Observe the scroller itself. Child elements are picked up via
    // MutationObserver below so we never accumulate O(n) observations
    // across hundreds of messages — that caused a ResizeObserver callback
    // storm on every autoResize() (textarea height change) on desktop.
    stickyBottomResizeObs.observe(messagesEl);
  }
  // NOTE: We intentionally do NOT observe individual child elements of
  // #messages. The ResizeObserver on #messages itself fires whenever the
  // container's scrollHeight changes (image loads, tool expansions, syntax
  // highlighting all change child heights which flow up to the scroller).
  // Observing each child individually accumulates O(n messages) observations
  // over a session's lifetime. When the textarea grows (autoResize) and the
  // flex layout recalculates, the browser fires a ResizeObserver callback for
  // every observed element — 50+ no-op callbacks per keypress in a long
  // session. The container-level observer is sufficient for sticky-bottom
  // purposes and costs a single callback per layout change.
  if (!stickyBottomInputBound) {
    stickyBottomInputBound = true;
    var disarmOnUserScroll = function () { disarmStickyBottom(); };
    messagesEl.addEventListener("wheel", disarmOnUserScroll, { passive: true });
    messagesEl.addEventListener("touchmove", disarmOnUserScroll, { passive: true });
    document.addEventListener("keydown", function (e) {
      if (!stickyBottom) return;
      if (e.key === "PageUp" || e.key === "Home" || e.key === "ArrowUp") {
        disarmStickyBottom();
      }
    });
  }
}

export function armStickyBottom(durationMs) {
  if (prependAnchor) return; // never fight pagination
  ensureStickyInfrastructure();
  stickyBottom = true;
  isUserScrolledUp = false;
  var newMsgBtn = document.getElementById("new-msg-btn");
  if (newMsgBtn) {
    newMsgBtn.classList.add("hidden");
    newMsgBtn.textContent = NEW_MSG_BTN_DEFAULT;
  }
  pinToBottomNow();
  // Quiet window: callers pass intended quiet duration; ResizeObserver
  // resets this each time layout changes, so the actual armed duration
  // stretches to "no resize for durationMs".
  stickyBottomQuietMs = durationMs || 750;
  if (stickyBottomQuietTimer) clearTimeout(stickyBottomQuietTimer);
  stickyBottomQuietTimer = setTimeout(disarmStickyBottom, stickyBottomQuietMs);
  // Hard ceiling so we never lock the scroller indefinitely if some
  // animation/observer keeps firing forever.
  if (stickyBottomCeilingTimer) clearTimeout(stickyBottomCeilingTimer);
  stickyBottomCeilingTimer = setTimeout(disarmStickyBottom, stickyBottomCeilingMs);
}

export function disarmStickyBottom() {
  if (!stickyBottom) return; // already disarmed — skip timer ops
  stickyBottom = false;
  if (stickyBottomQuietTimer) { clearTimeout(stickyBottomQuietTimer); stickyBottomQuietTimer = null; }
  if (stickyBottomCeilingTimer) { clearTimeout(stickyBottomCeilingTimer); stickyBottomCeilingTimer = null; }
}

export function initRendering() {
  // Update input placeholder when vendor changes
  store.subscribe(function (state, prev) {
    if (state.currentVendor !== prev.currentVendor) {
      var inputEl = document.getElementById("input");
      if (inputEl) {
        inputEl.placeholder = "Message " + (VENDOR_NAMES[state.currentVendor] || VENDOR_NAMES.claude) + "...";
      }
    }
  });
}

// --- State accessors (module-local, not in store) ---
export function getTurnCounter() { return turnCounter; }
export function setTurnCounter(v) { turnCounter = v; }
export function getPrependAnchor() { return prependAnchor; }
export function setPrependAnchor(v) { prependAnchor = v; }
export function getActivityEl() { return activityEl; }
export function setActivityEl(v) { activityEl = v; }
export function getIsUserScrolledUp() { return isUserScrolledUp; }
export function setIsUserScrolledUp(v) { isUserScrolledUp = v; }

// --- Rendering functions ---

export function addToMessages(el) {
  var messagesEl = getMessagesEl();
  if (prependAnchor) messagesEl.insertBefore(el, prependAnchor);
  else messagesEl.appendChild(el);
  var _sme = getScheduledMsgEl();
  if (_sme && el !== _sme && _sme.parentNode === messagesEl) {
    messagesEl.appendChild(_sme);
  }
}

export function scrollToBottom() {
  if (prependAnchor) return;
  var newMsgBtn = document.getElementById("new-msg-btn");
  if (isUserScrolledUp) {
    newMsgBtn.textContent = NEW_MSG_BTN_ACTIVITY;
    newMsgBtn.classList.remove("hidden");
    return;
  }
  var messagesEl = getMessagesEl();
  requestAnimationFrame(function () {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

export function forceScrollToBottom(quietMs) {
  if (prependAnchor) return;
  // Arm sticky-bottom mode so deferred layout (tool widgets, code highlighting,
  // image loads) can't strand the user partway down — single-rAF pin captures
  // a stale scrollHeight, then growth below pushes the bottom further away.
  // The quiet detector extends the window automatically while layout shifts.
  armStickyBottom(quietMs || 750);
}

export function getMsgTime() {
  var _ts = store.get('currentMsgTs');
  var d = _ts ? new Date(_ts) : new Date();
  var time = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  var now = new Date();
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return time;
  }
  return (d.getMonth() + 1) + "/" + d.getDate() + " " + time;
}

export function shouldGroupMessage(senderClass) {
  var _s = store.snap();
  if (_s.replayingHistory && !_s.currentMsgTs) return false;
  var prev = getMessagesEl().lastElementChild;
  if (!prev || !prev.classList.contains(senderClass)) return false;
  var prevTime = prev.querySelector(".dm-bubble-time");
  if (!prevTime) return false;
  return prevTime.textContent === getMsgTime();
}

export function ensureAssistantBlock() {
  var _el = store.get('currentMsgEl');
  if (!_el) {
    _el = document.createElement("div");
    _el.className = "msg-assistant";
    _el.dataset.turn = turnCounter;

    var grouped = shouldGroupMessage("msg-assistant");
    if (grouped) _el.classList.add("grouped");

    var vendor = store.get('currentVendor') || "claude";
    var avi = document.createElement("img");
    avi.className = "dm-bubble-avatar dm-bubble-avatar-mate";
    avi.src = VENDOR_AVATARS[vendor] || VENDOR_AVATARS.claude;
    _el.appendChild(avi);

    var contentWrap = document.createElement("div");
    contentWrap.className = "dm-bubble-content";

    var header = document.createElement("div");
    header.className = "dm-bubble-header";
    var nameSpan = document.createElement("span");
    nameSpan.className = "dm-bubble-name";
    nameSpan.textContent = VENDOR_NAMES[vendor] || VENDOR_NAMES.claude;
    header.appendChild(nameSpan);
    var timeSpan = document.createElement("span");
    timeSpan.className = "dm-bubble-time";
    timeSpan.textContent = getMsgTime();
    header.appendChild(timeSpan);
    contentWrap.appendChild(header);

    var mdDiv = document.createElement("div");
    mdDiv.className = "md-content";
    mdDiv.dir = "auto";
    contentWrap.appendChild(mdDiv);
    _el.appendChild(contentWrap);
    addToMessages(_el);
    currentFullTextLocal = "";
    store.set({ currentMsgEl: _el, currentFullText: "" });
  }
  return _el;
}

// Single document-level click handler shared across all copy handlers.
// Replaces per-message document.addEventListener to prevent listener leak
// (previously grew unbounded with conversation length).
var _primedCopyEl = null;
var _primedCopyReset = null;
document.addEventListener("click", function (e) {
  if (_primedCopyEl && !_primedCopyEl.contains(e.target)) {
    if (_primedCopyReset) _primedCopyReset();
  }
});

export function addCopyHandler(msgEl, rawText) {
  var primed = false;
  var resetTimer = null;

  var isTouchDevice = "ontouchstart" in window;

  var hint = document.createElement("div");
  hint.className = "msg-copy-hint";
  hint.textContent = (isTouchDevice ? "Tap" : "Click") + " to grab this";
  msgEl.appendChild(hint);

  function reset() {
    primed = false;
    if (_primedCopyEl === msgEl) { _primedCopyEl = null; _primedCopyReset = null; }
    msgEl.classList.remove("copy-primed", "copy-done");
    hint.textContent = (isTouchDevice ? "Tap" : "Click") + " to grab this";
  }

  msgEl.addEventListener("click", function (e) {
    if (e.target.closest("a, pre, code")) return;
    var sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;

    if (!primed) {
      primed = true;
      _primedCopyEl = msgEl;
      _primedCopyReset = reset;
      msgEl.classList.add("copy-primed");
      hint.textContent = isTouchDevice ? "Tap again to grab" : "Click again to grab";
      clearTimeout(resetTimer);
      resetTimer = setTimeout(reset, 3000);
    } else {
      clearTimeout(resetTimer);
      copyToClipboard(rawText).then(function () {
        msgEl.classList.remove("copy-primed");
        msgEl.classList.add("copy-done");
        hint.textContent = "Grabbed!";
        resetTimer = setTimeout(reset, 1500);
      });
    }
  });
}

export function appendDelta(text) {
  ensureAssistantBlock();
  streamBuffer += text;
  if (!streamDrainTimer) {
    streamDrainTimer = requestAnimationFrame(drainStreamTick);
  }
}

// Minimum number of new characters required before we re-render innerHTML.
// Smaller = more responsive to short bursts; larger = fewer layout thrashes.
// 30 chars is roughly half a typical word-wrapped line and imperceptible
// as a rendering delay at normal streaming speeds.
var STREAM_RENDER_MIN_DELTA = 30;

function drainStreamTick() {
  streamDrainTimer = null;
  var msgEl = store.get('currentMsgEl');
  if (!msgEl || streamBuffer.length === 0) return;

  // If a worker parse is already in flight, wait — the completion callback
  // will reschedule the drain so nothing is lost.
  if (streamRenderPending) return;

  var n;
  var len = streamBuffer.length;
  if (len > 200) { n = Math.ceil(len / 4); }
  else if (len > 80) { n = 8; }
  else if (len > 30) { n = 5; }
  else if (len > 10) { n = 2; }
  else { n = 1; }

  var chunk = streamBuffer.slice(0, n);
  streamBuffer = streamBuffer.slice(n);
  // Accumulate into module-local var — no store.set here.
  // store.currentFullText is only written at flush/finalize so external
  // callers (save/restore in app-header, app-projects, app-messages) see a
  // consistent value at rest. Eliminates 11 subscriber invocations +
  // a full Object.assign state copy on every animation frame tick.
  currentFullTextLocal += chunk;

  // Only re-render markdown when enough new content has arrived so we
  // avoid a full innerHTML replacement + Highlight.js debounce on every
  // animation frame. The difference is invisible at normal streaming
  // speeds but halves layout work on long responses.
  if (currentFullTextLocal.length - streamRenderLen >= STREAM_RENDER_MIN_DELTA || streamBuffer.length === 0) {
    streamRenderLen = currentFullTextLocal.length;
    var textSnapshot = currentFullTextLocal;
    var contentEl = msgEl.querySelector(".md-content");

    streamRenderPending = true;
    renderMarkdownAsync(textSnapshot).then(function (html) {
      // Use setTimeout(0) rather than applying inline in the microtask.
      // Microtasks run before the browser can process pending input events,
      // so an innerHTML write here would block keypress handling. A task
      // (setTimeout 0) lets the browser drain the input event queue first,
      // eliminating contention between stream renders and typing.
      setTimeout(function () {
        streamRenderPending = false;
        // Only apply if this message is still the active one
        var currentMsgEl = store.get('currentMsgEl');
        if (currentMsgEl && currentMsgEl === msgEl && contentEl.isConnected) {
          contentEl.innerHTML = html;
          if (highlightTimer) clearTimeout(highlightTimer);
          highlightTimer = setTimeout(function () {
            highlightCodeBlocks(contentEl);
          }, 150);
          scrollToBottom();
        }
        // Drain any buffer that accumulated while we were waiting for the worker
        if (streamBuffer.length > 0 && !streamDrainTimer) {
          streamDrainTimer = requestAnimationFrame(drainStreamTick);
        }
      }, 0);
    });
  } else if (streamBuffer.length > 0) {
    streamDrainTimer = requestAnimationFrame(drainStreamTick);
  }
}

export function flushStreamBuffer() {
  if (streamDrainTimer) { cancelAnimationFrame(streamDrainTimer); streamDrainTimer = null; }
  streamRenderPending = false;
  if (streamBuffer.length > 0) {
    currentFullTextLocal += streamBuffer;
    streamBuffer = "";
  }
  streamRenderLen = 0;
  // Sync accumulated text back to the store so external callers see the
  // final value (save/restore paths in app-header, app-projects, app-messages).
  store.set({ currentFullText: currentFullTextLocal });
}

export function finalizeAssistantBlock() {
  flushStreamBuffer();
  var msgEl = store.get('currentMsgEl');
  var textToRender = currentFullTextLocal;

  // Clear state before async work — subsequent messages must not inherit
  // this block's el or text.
  currentFullTextLocal = "";
  store.set({ currentMsgEl: null, currentFullText: "" });

  if (msgEl) {
    var contentEl = msgEl.querySelector(".md-content");
    // Async final render: the heaviest parse of the whole response.
    // Moves marked.parse() off the main thread for the end-of-response
    // spike that caused the "builds up then catches up" stall.
    if (contentEl && textToRender) {
      renderMarkdownAsync(textToRender).then(function (html) {
        setTimeout(function () {
          if (contentEl.isConnected) {
            contentEl.innerHTML = html;
            highlightCodeBlocks(contentEl);
            renderMermaidBlocks(contentEl);
            // Re-pin after the last-message expansion — this fires after the
            // initial history_done arm may have already expired on mobile.
            armStickyBottom(500);
          }
        }, 0);
      });
    } else if (contentEl) {
      highlightCodeBlocks(contentEl);
      renderMermaidBlocks(contentEl);
    }
    if (textToRender) {
      addCopyHandler(msgEl, textToRender);
    }
    closeToolGroup();
  }
}

export function addUserMessage(text, images, pastes, fromUserId, fromUserName) {
  if (!text && (!images || images.length === 0) && (!pastes || pastes.length === 0)) return;
  var myUserId = store.get('myUserId');
  // Only treat as "other user" if we're in multi-user mode AND myUserId is
  // already known AND the message is from a different user. If myUserId is
  // null (init race — /api/me hasn't returned yet), assume the message is
  // from the local user to prevent avatar/name bleed-through in bubble view.
  var isMultiUser = store.get('isMultiUserMode');
  var isOtherUser = isMultiUser && myUserId && fromUserId && fromUserId !== myUserId;
  var div = document.createElement("div");
  div.className = "msg-user" + (isOtherUser ? " msg-user-other" : "");
  div.dataset.turn = ++turnCounter;
  if (shouldGroupMessage("msg-user")) div.classList.add("grouped");
  var bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.dir = "auto";

  if (images && images.length > 0) {
    var imgRow = document.createElement("div");
    imgRow.className = "bubble-images";
    for (var i = 0; i < images.length; i++) {
      var img = document.createElement("img");
      if (images[i].url) {
        img.src = images[i].url;
      } else if (images[i].data) {
        img.src = "data:" + images[i].mediaType + ";base64," + images[i].data;
      }
      img.loading = "lazy";
      img.className = "bubble-img";
      img.addEventListener("click", function () { showImageModal(this.src); });
      img.addEventListener("error", function () {
        var placeholder = document.createElement("div");
        placeholder.className = "bubble-img-expired";
        placeholder.textContent = "Image deleted";
        this.parentNode.replaceChild(placeholder, this);
      });
      imgRow.appendChild(img);
    }
    bubble.appendChild(imgRow);
  }

  if (pastes && pastes.length > 0) {
    var pasteRow = document.createElement("div");
    pasteRow.className = "bubble-pastes";
    for (var p = 0; p < pastes.length; p++) {
      (function (pasteText) {
        var chip = document.createElement("div");
        chip.className = "bubble-paste";
        var preview = pasteText.substring(0, 60).replace(/\n/g, " ");
        if (pasteText.length > 60) preview += "...";
        chip.innerHTML = '<span class="bubble-paste-preview">' + escapeHtml(preview) + '</span><span class="bubble-paste-label">PASTED</span>';
        chip.addEventListener("click", function (e) {
          e.stopPropagation();
          showPasteModal(pasteText);
        });
        pasteRow.appendChild(chip);
      })(pastes[p]);
    }
    bubble.appendChild(pasteRow);
  }

  if (text) {
    var textEl = document.createElement("span");
    textEl.textContent = text;
    bubble.appendChild(textEl);
  }


  var cachedAllUsers = store.get('cachedAllUsers');
  var _targetUser;
  var _displayName;
  if (isOtherUser) {
    _targetUser = cachedAllUsers.find(function (u) { return u.id === fromUserId; });
    _displayName = fromUserName || (_targetUser && (_targetUser.displayName || _targetUser.username)) || "User";
  } else {
    _targetUser = cachedAllUsers.find(function (u) { return u.id === myUserId; });
    if (!_targetUser) {
      try { _targetUser = JSON.parse(localStorage.getItem("clagentic_my_user") || localStorage.getItem("clay_my_user") || "null"); } catch(e) {}
    }
    _displayName = document.body.dataset.myDisplayName || "";
    if (!_displayName) {
      _displayName = (_targetUser && (_targetUser.displayName || _targetUser.username)) || "Me";
    }
  }

  var avi = document.createElement("img");
  avi.className = "dm-bubble-avatar" + (isOtherUser ? " dm-bubble-avatar-other" : " dm-bubble-avatar-me");
  avi.src = isOtherUser
    ? userAvatarUrl(_targetUser || { id: fromUserId }, 36)
    : (document.body.dataset.myAvatarUrl || userAvatarUrl(_targetUser || { id: myUserId }, 36));
  div.appendChild(avi);

  var contentWrap = document.createElement("div");
  contentWrap.className = "dm-bubble-content";

  var header = document.createElement("div");
  header.className = "dm-bubble-header";
  var nameSpan = document.createElement("span");
  nameSpan.className = "dm-bubble-name";
  nameSpan.textContent = _displayName;
  header.appendChild(nameSpan);
  var timeSpan = document.createElement("span");
  timeSpan.className = "dm-bubble-time";
  timeSpan.textContent = getMsgTime();
  header.appendChild(timeSpan);
  contentWrap.appendChild(header);
  contentWrap.appendChild(bubble);
  div.appendChild(contentWrap);

  var actions = document.createElement("div");
  actions.className = "msg-actions";
  actions.innerHTML =
    '<span class="msg-action-time">' + getMsgTime() + '</span>' +
    '<button class="msg-action-btn msg-action-copy" type="button" title="Copy">' + iconHtml("copy") + '</button>' +
    '<button class="msg-action-btn msg-action-fork" type="button" title="Fork">' + iconHtml("git-branch") + '</button>' +
    (((store.get('vendorCapabilities') || {}).rewind !== false) ? '<button class="msg-action-btn msg-action-rewind msg-user-rewind-btn" type="button" title="Rewind">' + iconHtml("rotate-ccw") + '</button>' : '') +
    '<button class="msg-action-btn msg-action-hidden msg-action-edit" type="button" title="Edit">' + iconHtml("pencil") + '</button>';
  div.appendChild(actions);

  actions.querySelector(".msg-action-copy").addEventListener("click", function () {
    var self = this;
    copyToClipboard(text || "");
    self.innerHTML = iconHtml("check");
    refreshIcons(actions);
    setTimeout(function () { self.innerHTML = iconHtml("copy"); refreshIcons(actions); }, 1200);
  });

  addToMessages(div);
  refreshIcons(div);
  forceScrollToBottom();
}

export function addSystemMessage(text, isError) {
  var div = document.createElement("div");
  div.className = "sys-msg" + (isError ? " error" : "");
  div.innerHTML = '<span class="sys-text"></span>';
  div.querySelector(".sys-text").textContent = text;
  addToMessages(div);
  scrollToBottom();
}

export function addConflictMessage(msg) {
  var div = document.createElement("div");
  div.className = "conflict-msg";
  var header = document.createElement("div");
  header.className = "conflict-header";
  header.textContent = msg.text || "Another Claude Code process is already running.";
  div.appendChild(header);

  var hint = document.createElement("div");
  hint.className = "conflict-hint";
  hint.textContent = "Kill the conflicting process to continue, or use the existing Claude Code session.";
  div.appendChild(hint);

  for (var i = 0; i < msg.processes.length; i++) {
    var p = msg.processes[i];
    var row = document.createElement("div");
    row.className = "conflict-process";

    var info = document.createElement("span");
    info.className = "conflict-pid";
    info.textContent = "PID " + p.pid;
    row.appendChild(info);

    var cmd = document.createElement("code");
    cmd.className = "conflict-cmd";
    cmd.textContent = p.command.length > 80 ? p.command.substring(0, 80) + "..." : p.command;
    cmd.title = p.command;
    row.appendChild(cmd);

    var killBtn = document.createElement("button");
    killBtn.className = "conflict-kill-btn";
    killBtn.textContent = "Kill Process";
    killBtn.setAttribute("data-pid", p.pid);
    killBtn.addEventListener("click", function() {
      var pid = parseInt(this.getAttribute("data-pid"), 10);
      getWs().send(JSON.stringify({ type: "kill_process", pid: pid }));
      this.disabled = true;
      this.textContent = "Killing...";
    });
    row.appendChild(killBtn);
    div.appendChild(row);
  }

  addToMessages(div);
  scrollToBottom();
}

export function addContextOverflowMessage(msg) {
  var div = document.createElement("div");
  div.className = "context-overflow-msg";

  var header = document.createElement("div");
  header.className = "context-overflow-header";
  header.textContent = msg.text || "Conversation too long to continue.";
  div.appendChild(header);

  var hint = document.createElement("div");
  hint.className = "context-overflow-hint";
  hint.textContent = "The conversation has exceeded the model's context limit. Please start a new conversation to continue.";
  div.appendChild(hint);

  var btn = document.createElement("button");
  btn.className = "context-overflow-btn";
  btn.textContent = "New Conversation";
  btn.addEventListener("click", function() {
    getWs().send(JSON.stringify({ type: "new_session" }));
  });
  div.appendChild(btn);

  addToMessages(div);
  scrollToBottom();
}

// --- Pre-thinking (instant dots before server responds) ---

export function showClaudePreThinking() {
  if (getChatLayout() !== "channel") return;
  removePreThinking();
  var vendor = store.get('currentVendor') || "claude";
  var vendorAvatar = VENDOR_AVATARS[vendor] || VENDOR_AVATARS.claude;
  var vendorName = VENDOR_NAMES[vendor] || VENDOR_NAMES.claude;
  doShowPreThinking(vendorName, vendorAvatar);
}

export function removePreThinking() {
  var messagesEl = getMessagesEl();
  if (!messagesEl) return;
  var els = messagesEl.querySelectorAll(".channel-pre-thinking");
  for (var i = 0; i < els.length; i++) {
    els[i].remove();
  }
}

function doShowPreThinking(name, avatar) {
  var _el = document.createElement("div");
  _el.className = "thinking-item channel-thinking channel-pre-thinking";
  _el.innerHTML =
    '<img class="dm-bubble-avatar" src="' + escapeHtml(avatar) + '" alt="" style="display:block">' +
    '<div class="dm-bubble-content">' +
    '<div class="dm-bubble-header"><span class="dm-bubble-name">' + escapeHtml(name) + '</span></div>' +
    '<div class="thinking-dots"><span></span><span></span><span></span></div>' +
    '</div>';
  if (activityEl && activityEl.parentNode) {
    activityEl.parentNode.insertBefore(_el, activityEl);
  } else {
    addToMessages(_el);
  }
  refreshIcons(_el);
  scrollToBottom();
}

// --- Ghost suggestion (prompt recommendation as ghost text) ---

var _ghostSuggestionText = "";

export function getGhostSuggestion() {
  return _ghostSuggestionText;
}

export function showSuggestionChips(suggestion) {
  if (!suggestion || store.get('processing')) return;
  // Only show ghost text when there is no sendable content — typed text,
  // pending pastes, pending images, or pending files all suppress the
  // suggestion so Enter can't accidentally send it instead of the user's
  // actual attached content.
  if (hasSendableContent()) return;
  _ghostSuggestionText = suggestion;
  var ghostEl = document.getElementById("ghost-suggestion");
  if (!ghostEl) return;
  ghostEl.innerHTML = escapeHtml(suggestion) +
    ' <span class="ghost-hint"><kbd>Enter</kbd> to send</span>';
  ghostEl.classList.remove("hidden");
  // Toggle class on wrap so CSS avoids :has() recalc on every keypress (Firefox perf)
  var wrap = document.getElementById("input-textarea-wrap");
  if (wrap) wrap.classList.add("ghost-active");
}

export function hideSuggestionChips() {
  if (!_ghostSuggestionText) return; // already hidden, skip DOM touch
  _ghostSuggestionText = "";
  var ghostEl = document.getElementById("ghost-suggestion");
  if (ghostEl) {
    ghostEl.innerHTML = "";
    ghostEl.classList.add("hidden");
  }
  // Remove class from wrap to match CSS selector change (no :has() recalc)
  var wrap = document.getElementById("input-textarea-wrap");
  if (wrap) wrap.classList.remove("ghost-active");
}
