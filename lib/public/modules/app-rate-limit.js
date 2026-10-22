// app-rate-limit.js - Rate limit UI, scheduled messages, fast mode indicator
// Extracted from app.js (PR-26)

import { iconHtml, refreshIcons } from './icons.js';
import { store } from './store.js';
import { addToMessages, scrollToBottom } from './app-rendering.js';
import { userAvatarUrl } from './avatar.js';
import { clearScheduleDelay, setScheduleDelayForSession, clearScheduleDelayForSession, restoreScheduleDelayUi, refreshScheduleControls } from './input.js';
import { isSonnetModel, isOpusModel } from './model-families.js';
import {
  getRateLimitResetsAt, setRateLimitResetsAt,
  getRateLimitResetTimer, setRateLimitResetTimer,
  getRateLimitResetState,
  setScheduledInputs, getScheduledInputs,
  clearSession as clearSessionRateLimitState,
} from './rate-limit-state.js';
import { countdownText } from './schedule-time.js';
import { sendScheduledNow, cancelScheduledInput, requestScheduledInputList } from './scheduled-input-actions.js';

// --- Module-owned state ---
// lr-0827ba: rateLimitResetsAt / rateLimitResetTimer / rateLimitResetState /
// the session's scheduled inputs are now owned per-session by
// rate-limit-state.js (see imports above) — arming one project's rate-limit
// auto-schedule no longer clobbers another project's armed state. The
// variables below remain module-scoped because they are references to the
// single visible DOM element/timer for whichever session is currently
// focused; they get rebuilt/rebound whenever the focused session changes.
var rateLimitCountdownTimer = null;
var rateLimitIndicatorEl = null;
var rateLimitUsageEl = null;
var rateLimitTickTimer = null;
var _rateLimitUsageLastHtml = null; // guard against redundant innerHTML + refreshIcons()
// The scheduled-message bubbles of the session on screen share one container;
// each has a countdown the one interval below keeps current.
var scheduledMsgEl = null;
var scheduledCountdownTimer = null;
var scheduledCountdowns = [];
var fastModeIndicatorEl = null;

function currentSessionId() {
  return store.get('activeSessionId');
}

// --- Internal helpers ---

function getVendorUsageMeta(vendor) {
  if (vendor === "codex") {
    return {
      icon: "/codex-avatar.png",
      alt: "Codex",
      href: "https://chatgpt.com/admin/usage",
      title: "Check usage on ChatGPT",
    };
  }
  return {
    icon: "/claude-code-avatar.png",
    alt: "Claude Code",
    href: "https://claude.ai/settings/usage",
    title: "Check usage on claude.ai",
  };
}

function rateLimitTypeLabel(type) {
  if (!type) return "Usage";
  var labels = {
    "five_hour": "5-hour",
    "seven_day": "7-day",
    "seven_day_opus": "7-day Opus",
    "seven_day_sonnet": "7-day Sonnet",
    "overage": "Overage",
  };
  return labels[type] || type;
}

function startRateLimitCountdown(el, resetsAt, cardEl) {
  if (rateLimitCountdownTimer) clearInterval(rateLimitCountdownTimer);

  function tick() {
    var remaining = resetsAt - Date.now();
    if (remaining <= 0) {
      clearInterval(rateLimitCountdownTimer);
      rateLimitCountdownTimer = null;
      clearRateLimitIndicator();
      return;
    }
    // Update pill text with countdown
    if (rateLimitIndicatorEl) {
      var pillText = rateLimitIndicatorEl.querySelector(".header-pill-text");
      if (pillText) {
        var mins = Math.floor(remaining / 60000);
        var secs = Math.floor((remaining % 60000) / 1000);
        if (mins >= 60) {
          var hrs = Math.floor(mins / 60);
          mins = mins % 60;
          pillText.textContent = hrs + "h " + mins + "m";
        } else {
          pillText.textContent = mins + "m " + secs + "s";
        }
      }
    }
  }

  tick();
  rateLimitCountdownTimer = setInterval(tick, 1000);
}

function updateRateLimitIndicator(msg) {
  var statusArea = document.querySelector(".title-bar-content .status");
  if (!statusArea) return;

  if (!rateLimitIndicatorEl) {
    rateLimitIndicatorEl = document.createElement("span");
    rateLimitIndicatorEl.className = "header-rate-limit-wrap";
    statusArea.insertBefore(rateLimitIndicatorEl, statusArea.firstChild);
  }

  var isRejected = msg.status === "rejected";
  var pillClass = "header-rate-limit" + (isRejected ? " rejected" : " warning");
  var label = isRejected ? "Rate limited" : "Rate warning";
  // lr-872f94: render the vendor-reported usedPercent in the pill itself
  // (previously only surfaced in the transient warning popover text).
  // Applies to both providers -- Codex's account/rateLimits/updated and
  // Claude's rate_limit_info both carry `utilization` (0-1 fraction) through
  // the same yokeType: "rate_limit" event shape (lib/sdk-message-processor.js).
  var pct = typeof msg.utilization === "number" ? Math.round(msg.utilization * 100) : null;
  var pctHtml = pct != null ? '<span class="header-pill-pct">' + pct + "%</span>" : "";
  // lr-872f94 fold-in: this link was hardcoded to Claude's usage page even
  // for Codex-triggered warnings/rejections. getVendorUsageMeta already
  // exists for exactly this (used by the rate_limit_usage widget below).
  var vendorMeta = getVendorUsageMeta(store.get('currentVendor') || "claude");
  rateLimitIndicatorEl.innerHTML =
    '<span class="' + pillClass + '">' +
      iconHtml("alert-triangle") +
      '<span class="header-pill-text">' + label + "</span>" +
      pctHtml +
      '<a href="' + vendorMeta.href + '" target="_blank" rel="noopener" class="rate-limit-link">' +
        iconHtml("external-link") +
      "</a>" +
    "</span>";
  refreshIcons();
}

function showRateLimitPopover(text, isRejected) {
  if (!rateLimitIndicatorEl) return;
  // Remove existing popover
  var old = rateLimitIndicatorEl.querySelector(".rate-limit-popover");
  if (old) old.remove();

  var pop = document.createElement("div");
  pop.className = "rate-limit-popover" + (isRejected ? " rejected" : "");
  pop.textContent = text;
  rateLimitIndicatorEl.appendChild(pop);

  // Auto-dismiss after 5s
  setTimeout(function () {
    pop.classList.add("fade-out");
    setTimeout(function () { if (pop.parentNode) pop.remove(); }, 300);
  }, 5000);
}

function clearRateLimitIndicator() {
  if (rateLimitIndicatorEl) {
    rateLimitIndicatorEl.remove();
    rateLimitIndicatorEl = null;
  }
}

function formatResetTime(resetsAt) {
  if (!resetsAt) return "";
  var d = new Date(resetsAt);
  var now = new Date();
  var diff = resetsAt - now.getTime();
  if (diff <= 0) return "";
  var hrs = Math.floor(diff / 3600000);
  var mins = Math.floor((diff % 3600000) / 60000);
  if (hrs > 0) return hrs + "h " + mins + "m";
  return mins + "m";
}

function rateLimitTypeShortLabel(type) {
  if (type === "five_hour") return "5h";
  if (type === "seven_day") return "7d";
  if (type === "seven_day_opus") return "7d opus";
  if (type === "seven_day_sonnet") return "7d sonnet";
  return type || "";
}

function tickRateLimitUsage() {
  if (!rateLimitUsageEl) return;
  var parts = [];
  var types = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];
  var resetState = getRateLimitResetState(currentSessionId());
  for (var i = 0; i < types.length; i++) {
    var entry = resetState[types[i]];
    if (!entry || !entry.resetsAt) continue;
    var timeStr = formatResetTime(entry.resetsAt);
    if (!timeStr) { delete resetState[types[i]]; continue; }
    parts.push(rateLimitTypeShortLabel(types[i]) + " resets " + timeStr);
  }
  var newHtml;
  if (parts.length === 0) {
    if (rateLimitTickTimer) { clearInterval(rateLimitTickTimer); rateLimitTickTimer = null; }
    newHtml = iconHtml("activity") + '<span>Check usage</span>' + iconHtml("external-link");
  } else {
    newHtml = iconHtml("activity") + '<span>' + parts.join(" · ") + '</span>' + iconHtml("external-link");
  }
  if (newHtml !== _rateLimitUsageLastHtml) {
    _rateLimitUsageLastHtml = newHtml;
    rateLimitUsageEl.innerHTML = newHtml;
    refreshIcons();
  }
}

// --- Exported functions ---

export function initRateLimit() {
  store.subscribe(['currentVendor'], function(state, prev) {
    if (state.currentVendor !== prev.currentVendor) {
      if (state.currentVendor && state.currentVendor !== "claude") clearScheduleDelay();
      // Re-stamp the usage link href whenever vendor changes so the link always
      // points to the correct provider's usage page after a project switch.
      if (rateLimitUsageEl) {
        var meta = getVendorUsageMeta(state.currentVendor || "claude");
        rateLimitUsageEl.href = meta.href;
        rateLimitUsageEl.title = meta.title;
      }
    }
  });
}

export function handleRateLimitEvent(msg) {
  var isRejected = msg.status === "rejected";
  var typeLabel = rateLimitTypeLabel(msg.rateLimitType);
  var popoverText = "";

  // lr-0827ba: the event's own session (server-stamped localId) is the one
  // that gets its schedule armed, NOT necessarily the currently-focused
  // session — a rate limit hit in a background session must still arm that
  // session's auto-schedule and keep its reset timer running, exactly like
  // the server's per-session scheduled inputs do. Fall back to the
  // active session for events from servers/replays that predate the localId
  // stamp (older recorded history entries).
  var eventSessionId = msg.localId != null ? msg.localId : currentSessionId();
  var isActiveSession = eventSessionId === currentSessionId();

  if (isRejected && msg.resetsAt) {
    // Check if already expired (history replay) — skip popover
    if (msg.resetsAt < Date.now()) {
      if (isActiveSession) updateRateLimitIndicator(msg);
      return;
    }
    if (isActiveSession) {
      popoverText = typeLabel + " limit exceeded";
      updateRateLimitIndicator(msg);
      startRateLimitCountdown(null, msg.resetsAt, null);
    }
    // Track rate limit reset time for the event's own session.
    setRateLimitResetsAt(eventSessionId, msg.resetsAt);
    var existingTimer = getRateLimitResetTimer(eventSessionId);
    if (existingTimer) clearTimeout(existingTimer);
    // Auto-switch input to schedule mode: any message typed will be queued for after reset.
    // Model-aware: a seven_day_sonnet rejection should not schedule when the user is on Opus
    // (and vice-versa), since those messages would send fine against the other model's quota.
    var delayUntilReset = msg.resetsAt - Date.now();
    var currentVendor = store.get('currentVendor') || "claude";
    var shouldSchedule = false;
    if (delayUntilReset > 0 && currentVendor === "claude") {
      if (typeof msg.blocksCurrentModel === "boolean") {
        shouldSchedule = msg.blocksCurrentModel;
      } else {
        // Legacy fallback: server didn't ship the resolved boolean.
        var currentModel = store.get('currentModel') || "";
        if (msg.rateLimitType === "seven_day_sonnet") {
          shouldSchedule = isSonnetModel(currentModel);
        } else if (msg.rateLimitType === "seven_day_opus") {
          shouldSchedule = isOpusModel(currentModel);
        } else {
          // five_hour, seven_day, or unknown vendor-wide types — always schedule
          shouldSchedule = true;
        }
      }
      if (shouldSchedule) {
        setScheduleDelayForSession(eventSessionId, delayUntilReset + 60000); // +1min buffer after reset
      }
    }
    // Only arm the reset timer when we actually entered schedule mode; otherwise we'd
    // clear unrelated scheduled state on reset.
    if (shouldSchedule) {
      setRateLimitResetTimer(eventSessionId, setTimeout(function () {
        setRateLimitResetsAt(eventSessionId, null);
        setRateLimitResetTimer(eventSessionId, null);
        // Clear schedule mode when rate limit resets — for the event's own
        // session, whether or not it's the one currently focused.
        clearScheduleDelayForSession(eventSessionId);
      }, msg.resetsAt - Date.now() + 1000));
    }
  } else if (isActiveSession) {
    var pct = msg.utilization ? Math.round(msg.utilization * 100) : null;
    popoverText = typeLabel + " warning" + (pct ? " (" + pct + "% used)" : "");
    updateRateLimitIndicator(msg);
  }

  showRateLimitPopover(popoverText, isRejected);
}

export function updateRateLimitUsage(msg) {
  // lr-0827ba: rate_limit_usage is a project-wide broadcast (account-wide
  // usage, not session content), but only repaint the top-bar widget when
  // the event belongs to the session currently in view, so a background
  // session's usage tick doesn't visibly flicker the widget for whatever
  // session the user is actually looking at. Reset-time bookkeeping itself
  // is still tracked per-session (via rate-limit-state.js) so switching back
  // into that session redraws with its own latest data.
  var eventSessionId = msg.localId != null ? msg.localId : currentSessionId();
  var resetState = getRateLimitResetState(eventSessionId);
  if (msg.rateLimitType && msg.resetsAt) {
    resetState[msg.rateLimitType] = { resetsAt: msg.resetsAt, status: msg.status };
  }
  if (eventSessionId !== currentSessionId()) return;

  var topBarActions = document.querySelector("#top-bar .top-bar-actions");
  if (!topBarActions) return;

  if (!rateLimitUsageEl) {
    rateLimitUsageEl = document.createElement("a");
    rateLimitUsageEl.id = "rate-limit-usage-link";
    rateLimitUsageEl.className = "top-bar-pill pill-dim usage-check-link";
    rateLimitUsageEl.target = "_blank";
    rateLimitUsageEl.rel = "noopener";
    var ref = document.getElementById("skip-perms-pill");
    topBarActions.insertBefore(rateLimitUsageEl, ref);
  }

  // Build label from available reset times
  var parts = [];
  var types = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];
  for (var i = 0; i < types.length; i++) {
    var entry = resetState[types[i]];
    if (!entry || !entry.resetsAt) continue;
    var timeStr = formatResetTime(entry.resetsAt);
    if (!timeStr) continue;
    parts.push(rateLimitTypeShortLabel(types[i]) + " resets " + timeStr);
  }

  var label = parts.length > 0 ? parts.join(" · ") : "Check usage";
  var vendor = store.get('currentVendor') || "claude";
  var meta = getVendorUsageMeta(vendor);
  rateLimitUsageEl.href = meta.href;
  rateLimitUsageEl.title = meta.title;
  var newHtml =
    '<img src="' + meta.icon + '" class="usage-check-vendor-icon" alt="' + meta.alt + '">' +
    '<span>' + label + '</span>' +
    iconHtml("external-link");
  // Skip DOM write + full lucide scan when label hasn't changed.
  // rate_limit_usage fires on every Claude rate-limit event; the label only
  // changes when the reset time crosses a display boundary (~minutes).
  if (newHtml !== _rateLimitUsageLastHtml) {
    _rateLimitUsageLastHtml = newHtml;
    rateLimitUsageEl.innerHTML = newHtml;
    refreshIcons();
  }

  // Start or stop live countdown tick
  if (parts.length > 0 && !rateLimitTickTimer) {
    rateLimitTickTimer = setInterval(tickRateLimitUsage, 30000);
  } else if (parts.length === 0 && rateLimitTickTimer) {
    clearInterval(rateLimitTickTimer);
    rateLimitTickTimer = null;
  }
}

// The server's list of a session's armed scheduled inputs is the only source of
// the bubbles, the panel list and the clock button's state. msg.localId names
// the session the list belongs to (lr-0827ba): it may not be the one on screen,
// so it is stored either way and switching back in finds it, and only the
// session on screen is drawn, never into another session's message list.
export function applyScheduledInputList(msg) {
  var targetSessionId = msg.localId != null ? msg.localId : currentSessionId();
  setScheduledInputs(targetSessionId, msg.inputs, msg.limit);
  refreshScheduleControls();
  if (targetSessionId === currentSessionId()) renderScheduledBubbles(targetSessionId);
}

// Draws one bubble per armed input of the session on screen, in one container
// so the message list keeps them together at its end.
function renderScheduledBubbles(sessionId) {
  removeScheduledMessageBubble();
  var inputs = getScheduledInputs(sessionId);
  if (inputs.length === 0) return;
  var container = document.createElement("div");
  container.className = "scheduled-msgs";
  inputs.forEach(function (input) {
    var built = buildScheduledBubble(input);
    container.appendChild(built.wrap);
    scheduledCountdowns.push({ el: built.countdownEl, input: input });
  });
  addToMessages(container);
  scheduledMsgEl = container;
  scrollToBottom();
  updateScheduledCountdowns();
  scheduledCountdownTimer = setInterval(updateScheduledCountdowns, 1000);
}

function updateScheduledCountdowns() {
  var now = Date.now();
  scheduledCountdowns.forEach(function (c) { c.el.textContent = countdownText(c.input, now); });
}

// One bubble: the scheduled text, when it goes, and send now / cancel for it.
function buildScheduledBubble(input) {
  var text = input.text;
  var isChannel = document.body.classList.contains("wide-view");
  var wrap = document.createElement("div");
  wrap.className = "msg-user scheduled-msg-wrap";
  wrap.setAttribute("data-id", input.id);

  var countdownEl;
  var cancelBtn;

  if (isChannel) {
    // Channel mode: avatar + header with scheduled badge + message
    var _me = store.get('cachedAllUsers').find(function (u) { return u.id === store.get('myUserId'); });
    if (!_me) { try { _me = JSON.parse(localStorage.getItem("clagentic_my_user") || localStorage.getItem("clay_my_user") || "null"); } catch(e) {} }
    var _myName = document.body.dataset.myDisplayName || (_me && (_me.displayName || _me.username)) || "Me";

    var avi = document.createElement("img");
    avi.className = "dm-bubble-avatar dm-bubble-avatar-me";
    avi.src = document.body.dataset.myAvatarUrl || userAvatarUrl(_me || { id: store.get('myUserId') }, 36);
    wrap.appendChild(avi);

    var content = document.createElement("div");
    content.className = "dm-bubble-content";

    var header = document.createElement("div");
    header.className = "dm-bubble-header";

    var nameSpan = document.createElement("span");
    nameSpan.className = "dm-bubble-name";
    nameSpan.textContent = _myName;
    header.appendChild(nameSpan);

    var badge = document.createElement("span");
    badge.className = "scheduled-msg-badge";
    badge.innerHTML = iconHtml("clock");
    countdownEl = document.createElement("span");
    countdownEl.className = "scheduled-msg-countdown";
    badge.appendChild(countdownEl);
    header.appendChild(badge);

    var actions = document.createElement("span");
    actions.className = "scheduled-msg-actions";

    var sendNowBtn = document.createElement("button");
    sendNowBtn.className = "scheduled-msg-send-now";
    sendNowBtn.textContent = "Send now";
    sendNowBtn.addEventListener("click", function () { sendScheduledNow(input.id); });
    actions.appendChild(sendNowBtn);

    var sep = document.createElement("span");
    sep.className = "scheduled-msg-sep";
    sep.textContent = "\u00b7";
    actions.appendChild(sep);

    cancelBtn = document.createElement("button");
    cancelBtn.className = "scheduled-msg-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function () { cancelScheduledInput(input.id); });
    actions.appendChild(cancelBtn);

    header.appendChild(actions);

    content.appendChild(header);

    var bubble = document.createElement("div");
    bubble.className = "bubble scheduled-msg-bubble";
    var textEl = document.createElement("span");
    textEl.textContent = text;
    bubble.appendChild(textEl);
    content.appendChild(bubble);

    wrap.appendChild(content);
  } else {
    // Bubble mode: original layout
    var bubble = document.createElement("div");
    bubble.className = "bubble scheduled-msg-bubble";

    var textEl = document.createElement("span");
    textEl.textContent = text;
    bubble.appendChild(textEl);

    var metaEl = document.createElement("div");
    metaEl.className = "scheduled-msg-meta";

    var clockIcon = document.createElement("span");
    clockIcon.className = "scheduled-msg-icon";
    clockIcon.innerHTML = iconHtml("clock");
    metaEl.appendChild(clockIcon);

    countdownEl = document.createElement("span");
    countdownEl.className = "scheduled-msg-countdown";
    metaEl.appendChild(countdownEl);

    var sendNowBtn2 = document.createElement("button");
    sendNowBtn2.className = "scheduled-msg-send-now";
    sendNowBtn2.textContent = "Send now";
    sendNowBtn2.addEventListener("click", function () { sendScheduledNow(input.id); });
    metaEl.appendChild(sendNowBtn2);

    var sep2 = document.createElement("span");
    sep2.className = "scheduled-msg-sep";
    sep2.textContent = "\u00b7";
    metaEl.appendChild(sep2);

    cancelBtn = document.createElement("button");
    cancelBtn.className = "scheduled-msg-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function () { cancelScheduledInput(input.id); });
    metaEl.appendChild(cancelBtn);

    wrap.appendChild(bubble);
    wrap.appendChild(metaEl);
  }

  return { wrap: wrap, countdownEl: countdownEl };
}

// Clears the visible DOM bubbles and their countdown only; the per-session
// list is untouched. Used when re-drawing for the same session and when the
// view moves to another project.
export function removeScheduledMessageBubble() {
  if (scheduledMsgEl) {
    scheduledMsgEl.remove();
    scheduledMsgEl = null;
  }
  scheduledCountdowns = [];
  if (scheduledCountdownTimer) {
    clearInterval(scheduledCountdownTimer);
    scheduledCountdownTimer = null;
  }
}

export function handleFastModeState(state) {
  var statusArea = document.querySelector(".title-bar-content .status");
  if (!statusArea) return;

  if (state === "off") {
    if (fastModeIndicatorEl) {
      fastModeIndicatorEl.remove();
      fastModeIndicatorEl = null;
    }
    return;
  }

  if (!fastModeIndicatorEl) {
    fastModeIndicatorEl = document.createElement("span");
    statusArea.insertBefore(fastModeIndicatorEl, statusArea.firstChild);
  }

  if (state === "cooldown") {
    fastModeIndicatorEl.className = "header-fast-mode cooldown";
    fastModeIndicatorEl.innerHTML = iconHtml("timer") + '<span class="header-pill-text">Cooldown</span>';
  } else if (state === "on") {
    fastModeIndicatorEl.className = "header-fast-mode active";
    fastModeIndicatorEl.innerHTML = iconHtml("zap") + '<span class="header-pill-text">Fast mode</span>';
  }
  refreshIcons();
}

export function getScheduledMsgEl() { return scheduledMsgEl; }

// lr-0827ba: this used to also null out the bare module-scoped
// rateLimitResetsAt/rateLimitResetTimer/rateLimitResetState variables —
// which meant switching projects silently canceled the OUTGOING session's
// rate-limit reset timer and armed schedule, exactly the bug this task
// fixes. Reset timers and armed state are per-session now (rate-limit-state.js)
// and must keep running in the background regardless of focus, mirroring the
// server's scheduled inputs. This function now only tears down
// the visible DOM/UI-timer for whichever session was previously focused —
// it does not touch any session's persisted arming state. Callers switching
// into a different session must call restoreRateLimitStateForSession() for
// the new session afterward to redraw its own state (see app-messages.js
// session_switched handler).
export function resetRateLimitState() {
  clearRateLimitIndicator();
  if (rateLimitCountdownTimer) { clearInterval(rateLimitCountdownTimer); rateLimitCountdownTimer = null; }
  if (rateLimitTickTimer) { clearInterval(rateLimitTickTimer); rateLimitTickTimer = null; }
  // Remove the usage link element entirely so it is rebuilt fresh for the new
  // project (correct vendor href, correct reset times).
  if (rateLimitUsageEl) { rateLimitUsageEl.remove(); rateLimitUsageEl = null; }
  if (fastModeIndicatorEl) { fastModeIndicatorEl.remove(); fastModeIndicatorEl = null; }
  removeScheduledMessageBubble();
}

// Called when a session is actually destroyed/removed (not merely
// unfocused) so its background reset timer is canceled and its entry is
// dropped instead of leaking forever. Wired from app-messages.js's
// session_deleted handler (server-stamped ids from lib/sessions.js'
// broadcastSessionDeleted, lr-0827ba PEACHES follow-up).
export function forgetSessionRateLimitState(sessionId) {
  clearSessionRateLimitState(sessionId);
}

// lr-0827ba: "redraw on switch-in" — restores the newly-focused session's
// already-armed indicator/schedule-button/scheduled-message-bubble state
// instead of relying on the unreliable chat-history-replay side effect that
// happened to repaint these before. Call after resetRateLimitState() once
// the new session is focused (store.activeSessionId already updated).
export function restoreRateLimitStateForSession(sessionId) {
  restoreScheduleDelayUi();
  refreshScheduleControls();
  var resetsAt = getRateLimitResetsAt(sessionId);
  if (resetsAt && resetsAt > Date.now()) {
    updateRateLimitIndicator({ status: "rejected", resetsAt: resetsAt });
    startRateLimitCountdown(null, resetsAt, null);
  }
  renderScheduledBubbles(sessionId);
  // The list held here may be older than the server's; ask for the current one.
  requestScheduledInputList();
}
