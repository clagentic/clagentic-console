// app-favicon.js - Favicon, IO blink, urgent blink, status/activity UI
// Extracted from app.js (PR-34)

import { refreshIcons } from './icons.js';
import { store } from './store.js';
import { getSendBtn, getStatusDot } from './dom-refs.js';
import { onThemeChange, getChatLayout } from './theme.js';
import { getActivityEl, setActivityEl, addToMessages, scrollToBottom } from './app-rendering.js';

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
// This subscriber makes the footer a DERIVED render of store.processing —
// which lr-5edd64 turned into a pure PROJECTION of server-authoritative
// per-session state (app-messages.js's session_list/session_switched
// handlers derive it via activity-state.js's sessionActivity(), nothing
// writes it independently anymore). Previously this boolean was a
// client-local edge latch (app-connection.js's setStatus(), flipped by the
// server's {type:"status"}/done/auth_required sends) with no reconciliation
// path — MILLER's lr-5edd64 diagnosis: two independent state sources
// (this latch, and the server's per-session session.isProcessing) could
// disagree, and neither renderer that read one could self-correct from the
// other. There is now exactly one source; this subscriber and the
// project-icon dot (sidebar-projects.js) both derive from it.
//
// Gated to bubble layout only (mirrors input.js's optimistic-raise gate and
// showClaudePreThinking's channel-only gate in app-rendering.js) — the two
// footer renderers are mutually exclusive by design (wide-view <=> channel,
// theme.js getChatLayout/setChatLayout), so this must not fight
// .channel-pre-thinking for the same bottom-of-transcript slot in channel
// layout. (lr-5edd64 comment #3: in channel layout this subscriber's raise/
// clear is inert by this same gate — the channel footer's own presence
// widget, .channel-pre-thinking, is driven separately and unaffected by
// this change.)
export function initActivityFooter() {
  store.subscribe(['processing'], function (state, prev) {
    if (state.processing === prev.processing) return;
    reconcileActivityFooter();
  });
}

// lr-5edd64 (9th recurrence, PEACHES BLOCKING on PR #410 + HOLDEN trace):
// the footer's DOM ref (app-rendering.js's activityEl, via getActivityEl/
// setActivityEl) must not depend on a store.processing VALUE TRANSITION to
// get repaired. resetClientState() (app-projects.js) nulls the ref
// independently of any value change — a session switch where the outgoing
// AND incoming session are both isProcessing=true never fires the
// ['processing'] subscriber above (store.js's changed-flag bounding: the
// value is true before and after), so the widget could never be
// re-raised, leaving the footer stuck OFF for that session and every
// later broadcast carrying the same unchanged true value (identical
// mechanism, inverse edge, to the finding-1 stuck-OFF this same task
// already fixed once for false->true).
//
// FIX SHAPE (not another ordering tweak — see this task's dispatch note):
// this is an explicit, unconditional "render the footer from current
// store.processing now" call. Callers invoke it directly, right after
// applying a 'processing' projection (app-messages.js's session_list and
// session_switched handlers) — not gated on whether that store.set()
// actually changed the value. This is safe to call redundantly (setActivity
// itself no-ops when the DOM already matches the requested state via its
// own getActivityEl() presence check), and it does not touch
// lr-9bcd7b's changed-flag bounding on store.set()/the subscriber above,
// which still exists to suppress spurious re-renders on unrelated store
// updates that happen to carry the same 'processing' value along for the
// ride.
export function reconcileActivityFooter() {
  if (getChatLayout() !== "channel") {
    if (store.get('processing')) {
      setActivity("thinking");
    } else {
      setActivity(null);
    }
  }
}

