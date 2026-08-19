// app-favicon.js - Favicon, IO blink, urgent blink, status/activity UI
// Extracted from app.js (PR-34)

import { refreshIcons } from './icons.js';
import { store } from './store.js';
import { getSendBtn, getStatusDot } from './dom-refs.js';
import { onThemeChange, getChatLayout } from './theme.js';
import { getActivityEl, setActivityEl, addToMessages, scrollToBottom } from './app-rendering.js';
import { getWs } from './ws-ref.js';
import { createActivityStaleBackstop } from './activity-latch.js';

// --- Module-owned state ---
var faviconLink, faviconOrigHref, faviconCanvas, faviconCtx, faviconImg, faviconImgReady;
// Clagentic brand gradient: cyan → indigo → purple → back (pulsing, not rainbow)
var BAND_COLORS = [[0,207,255],[74,127,232],[123,63,228],[74,127,232],[0,207,255],[74,127,232]];
var faviconAnimTimer = null, faviconAnimFrame = 0;
var urgentBlinkTimer = null, urgentTitleTimer = null, savedTitle = null;
var ioTimer = null;
var sessionIoTimers = {};
var crossProjectBlinkTimer = null;

export function initFavicon() {
  faviconLink = document.querySelector('link[rel="icon"]');
  faviconCanvas = document.createElement("canvas");
  faviconCanvas.width = 32;
  faviconCanvas.height = 32;
  faviconCtx = faviconCanvas.getContext("2d");
  faviconImg = null;
  faviconImgReady = false;

  // Load the banded favicon image for masking
  (function () {
    faviconImg = new Image();
    faviconImg.onload = function () { faviconImgReady = true; };
    faviconImg.src = (store.get('basePath') || "") + "favicon-banded.png";
  })();

  // Reset cached favicon href on theme change
  onThemeChange(function () { faviconOrigHref = null; });
}

export function updateFavicon(bgColor) {
  if (!faviconLink) return;
  if (!bgColor) {
    if (faviconOrigHref) { faviconLink.href = faviconOrigHref; faviconOrigHref = null; }
    return;
  }
  if (!faviconOrigHref) faviconOrigHref = faviconLink.href;
  // Simple solid-color favicon for non-animated states
  faviconCtx.clearRect(0, 0, 32, 32);
  faviconCtx.fillStyle = bgColor;
  faviconCtx.beginPath();
  faviconCtx.arc(16, 16, 14, 0, Math.PI * 2);
  faviconCtx.fill();
  faviconCtx.fillStyle = "#fff";
  faviconCtx.font = "bold 22px Nunito, sans-serif";
  faviconCtx.textAlign = "center";
  faviconCtx.textBaseline = "middle";
  faviconCtx.fillText("C", 16, 17);
  faviconLink.href = faviconCanvas.toDataURL("image/png");
}

export function drawFaviconAnimFrame() {
  if (!faviconImgReady) return;
  var S = 32;
  var bands = BAND_COLORS.length;
  var totalFrames = bands * 2;
  var offset = faviconAnimFrame % totalFrames;

  // Draw flowing color bands as background
  faviconCtx.clearRect(0, 0, S, S);
  var bandH = Math.ceil(S / bands);
  for (var i = 0; i < bands + totalFrames; i++) {
    var ci = ((i + offset) % bands + bands) % bands;
    var c = BAND_COLORS[ci];
    faviconCtx.fillStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
    faviconCtx.fillRect(0, (i - offset) * bandH, S, bandH);
  }

  // Use the banded C image as a mask -- draw it on top with destination-in
  faviconCtx.globalCompositeOperation = "destination-in";
  faviconCtx.drawImage(faviconImg, 0, 0, S, S);
  faviconCtx.globalCompositeOperation = "source-over";

  faviconLink.href = faviconCanvas.toDataURL("image/png");
  faviconAnimFrame++;
}

var _sendBtnMode = null; // track current mode to skip no-op updates

export function setSendBtnMode(mode) {
  if (mode === _sendBtnMode) return; // no-op: mode unchanged, skip innerHTML + refreshIcons
  _sendBtnMode = mode;
  var sendBtn = getSendBtn();
  if (mode === "stop") {
    sendBtn.disabled = false;
    sendBtn.classList.add("stop");
    sendBtn.innerHTML = '<i data-lucide="square"></i>';
  } else {
    sendBtn.disabled = false;
    sendBtn.classList.remove("stop");
    sendBtn.innerHTML = '<i data-lucide="arrow-up"></i>';
  }
  refreshIcons(sendBtn);
}

// Module-level refs to elements currently lit with .io — kept so the
// off-timer can clear them without re-querying the DOM, and so the
// fast-path skip is safe (same elements stay lit, just hold time extends).
var _ioDot = null, _ioSessionDot = null, _ioParentDot = null,
    _ioMobileChipDot = null, _ioMobileSessionDot = null;

function _ioOff() {
  ioTimer = null;
  if (_ioDot) { _ioDot.classList.remove("io"); _ioDot = null; }
  if (_ioSessionDot) { _ioSessionDot.classList.remove("io"); _ioSessionDot = null; }
  if (_ioParentDot) { _ioParentDot.classList.remove("io"); _ioParentDot = null; }
  if (_ioMobileChipDot) { _ioMobileChipDot.classList.remove("io"); _ioMobileChipDot = null; }
  if (_ioMobileSessionDot) { _ioMobileSessionDot.classList.remove("io"); _ioMobileSessionDot = null; }
}

export function blinkIO() {
  if (!store.get('connected')) return;
  // If the IO indicator is already lit (ioTimer pending), just extend the
  // hold time — skip all DOM queries and classList mutations. During
  // streaming this fires hundreds of times per second; without this guard
  // every call does 5-8 querySelector scans + clearTimeout/setTimeout churn
  // with no visible difference since the dot is already "io".
  if (ioTimer) {
    clearTimeout(ioTimer);
    ioTimer = setTimeout(_ioOff, 80);
    return;
  }

  var dot = getStatusDot();
  if (dot) { dot.classList.add("io"); _ioDot = dot; }
  // Also blink the active session's processing dot in sidebar (project or mate)
  var sessionDot = document.querySelector(".session-item.active .session-processing") ||
                   document.querySelector(".mate-session-item.active .session-processing");
  if (sessionDot) { sessionDot.classList.add("io"); _ioSessionDot = sessionDot; }
  // If active project is a worktree, also blink the parent project dot
  var activeWt = document.querySelector("#icon-strip-projects .icon-strip-wt-item.active");
  if (activeWt) {
    var group = activeWt.closest(".icon-strip-group");
    var parentDot = group ? group.querySelector(".folder-header .icon-strip-status") : null;
    if (parentDot) { parentDot.classList.add("io"); _ioParentDot = parentDot; }
  }
  // Mobile chat chip dot + mobile session dot
  var _s = store.snap();
  var mobileChipDot = document.querySelector('.mobile-chat-chip[data-slug="' + _s.currentSlug + '"] .mobile-chat-chip-dot');
  if (mobileChipDot) { mobileChipDot.classList.add("io"); _ioMobileChipDot = mobileChipDot; }
  var mobileSessionDot = document.querySelector('.mobile-session-item.active .mobile-session-dot');
  if (mobileSessionDot) { mobileSessionDot.classList.add("io"); _ioMobileSessionDot = mobileSessionDot; }

  ioTimer = setTimeout(_ioOff, 80);
}

export function blinkSessionDot(sessionId) {
  var el = document.querySelector('.session-item[data-session-id="' + sessionId + '"] .session-processing');
  if (!el) return;
  el.classList.add("io");
  clearTimeout(sessionIoTimers[sessionId]);
  sessionIoTimers[sessionId] = setTimeout(function () {
    el.classList.remove("io");
    delete sessionIoTimers[sessionId];
  }, 80);
}

export function updateCrossProjectBlink() {
  if (crossProjectBlinkTimer) { clearTimeout(crossProjectBlinkTimer); crossProjectBlinkTimer = null; }
  function doBlink() {
    var dots = document.querySelectorAll("#icon-strip-projects .icon-strip-item:not(.active) .icon-strip-status.processing, #icon-strip-projects .icon-strip-wt-item:not(.active) .icon-strip-status.processing");
    // Also blink mobile chat chip dots (same icon-strip-status class inside chips)
    var mobileDots = document.querySelectorAll(".mobile-chat-chip .icon-strip-status.processing");
    var allDots = [];
    for (var i = 0; i < dots.length; i++) allDots.push(dots[i]);
    for (var m = 0; m < mobileDots.length; m++) allDots.push(mobileDots[m]);
    if (allDots.length === 0) { crossProjectBlinkTimer = null; return; }
    for (var i2 = 0; i2 < allDots.length; i2++) { allDots[i2].classList.add("io"); }
    setTimeout(function () {
      for (var j = 0; j < allDots.length; j++) { allDots[j].classList.remove("io"); }
      crossProjectBlinkTimer = setTimeout(doBlink, 150 + Math.random() * 350);
    }, 80);
  }
  crossProjectBlinkTimer = setTimeout(doBlink, 50);
}

export function startUrgentBlink() {
  if (urgentBlinkTimer) return;
  savedTitle = document.title;
  if (!faviconOrigHref && faviconLink) faviconOrigHref = faviconLink.href;
  faviconAnimFrame = 0;
  // Color flow animation at ~4fps — imperceptible vs 12fps for a static alert,
  // eliminates 2/3 of the synchronous toDataURL calls on the main thread.
  urgentBlinkTimer = setInterval(drawFaviconAnimFrame, 250);
  // Title blink separately
  var titleTick = 0;
  urgentTitleTimer = setInterval(function () {
    document.title = titleTick % 2 === 0 ? "\u26A0 Input needed" : savedTitle;
    titleTick++;
  }, 500);
}

export function stopUrgentBlink() {
  if (!urgentBlinkTimer) return;
  clearInterval(urgentBlinkTimer);
  clearInterval(urgentTitleTimer);
  urgentBlinkTimer = null;
  urgentTitleTimer = null;
  faviconAnimFrame = 0;
  updateFavicon(null);
  if (savedTitle) document.title = savedTitle;
  savedTitle = null;
}

export function setActivity(text) {
  if (text) {
    if (!getActivityEl()) {
      var _actEl = document.createElement("div");
      _actEl.className = "activity-inline";
      _actEl.innerHTML =
        '<div class="thinking-dots"><span></span><span></span><span></span></div>';
      setActivityEl(_actEl);
      addToMessages(_actEl);
    }
    scrollToBottom();
  } else {
    if (getActivityEl()) {
      getActivityEl().remove();
      setActivityEl(null);
    }
  }
}

// lr-6e20f7: the reactive clear setActivity's own removal branch (above) was
// designed for but never wired up — lr-66c118 deleted all 15 manual clear
// call sites (including every clear of this widget) on the assumption that
// "the widget's own reactive clear" would replace them, but no such
// subscriber was ever added. The widget was raised once at input.js's
// optimistic call and then never cleared again short of a full DOM wipe
// (resetClientState / prependOlderHistory), so it visibly stranded on-screen
// and was indistinguishable from the .thinking-item's own presence spinner —
// two indicators live at once (this task's SYMPTOM B).
//
// This subscriber makes the footer a DERIVED render of the same boolean the
// bottom bar/icon-strip status dot already uses (store.processing —
// app-connection.js's setStatus(), flipped true by the server's
// {type:"status", status:"processing"} at turn-start and false at
// done/auth_required/disconnect). That boolean already covers "literally
// anything" for THIS client's own turn: Claude has turn-wide isProcessing
// coverage for ordinary tools (sdk-message-processor.js module header), and
// status:"processing" is sent once at turn-start and stays true for the
// whole turn including any backgrounded Task/subagent activity — it only
// flips false at genuine turn-end (done) or auth_required/disconnect, all of
// which are real "nothing is happening" states. Subscribing here — rather
// than re-deriving from scratch — reuses the exact boolean already proven
// correct for the icon-strip dot instead of inventing a second one that
// could disagree with it.
//
// Gated to bubble layout only (mirrors input.js's optimistic-raise gate and
// showClaudePreThinking's channel-only gate in app-rendering.js) — the two
// footer renderers are mutually exclusive by design (wide-view <=> channel,
// theme.js getChatLayout/setChatLayout), so this must not fight
// .channel-pre-thinking for the same bottom-of-transcript slot in channel
// layout.
// Client-side staleness backstop, mirroring sdk-bridge.js's server-side
// ACTIVITY_STALE_MS (5 min) sweep for the registry. That server sweep can
// never repair THIS client-local latch — it sweeps the (already-correct)
// server registry, not any client state. Session-scoping the status/done/
// auth_required writers and reconciling on every session_switched snapshot
// (both elsewhere in this fix) close the known trigger paths; this is the
// backstop for an edge this fix's authors did not anticipate — a single
// timer, armed only on the 0->1 transition and disarmed on every 1->0
// transition, so it never polls per-tick and never accumulates more than
// one in-flight timer regardless of how many turns a session runs. On
// fire, it re-sends the EXISTING switch_session request for the
// currently-focused session (same message every sidebar click already
// sends) rather than inventing a new wire message — the server always
// answers with a fresh session_switched carrying the authoritative
// isProcessing (lib/sessions.js switchSession), which the reconciliation in
// app-messages.js's session_switched handler then applies. Bound: at most
// one re-request per ACTIVITY_STALE_BACKSTOP_MS per session-focus-duration,
// never a recurring poll — the timer is one-shot and only re-arms on a
// fresh 0->1 transition (a genuinely new turn), not on a fixed interval.
// Decision logic (arm/clear/one-shot-never-stacks) lives in the pure,
// directly-unit-tested activity-latch.js module — see its header comment
// for why (app-favicon.js's own import graph is not importable in a plain
// Node test process, so the behavioral proof lives against the pure
// module instead of this DOM-driving glue).
var _activityStaleBackstop = createActivityStaleBackstop({
  onFire: function () {
    // Only re-request if the latch is STILL true when the timer fires —
    // a legitimate long-running turn re-arms nothing extra here (the
    // request is one-shot, not a recurring poll); if the turn already
    // ended, the 1->0 transition already cleared this timer, so reaching
    // this callback at all means 'processing' has been true, unbroken,
    // for the full backstop window.
    if (!store.get('processing')) return;
    var sid = store.get('activeSessionId');
    var ws = getWs();
    if (sid == null || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "switch_session", id: sid }));
  },
});

export function initActivityFooter() {
  store.subscribe(['processing'], function (state, prev) {
    if (state.processing === prev.processing) return;
    _activityStaleBackstop.onTransition(state.processing);
    if (getChatLayout() !== "channel") {
      if (state.processing) {
        setActivity("thinking");
      } else {
        setActivity(null);
      }
    }
  });
}

