// app-favicon.js - Favicon, IO blink, urgent blink, status/activity UI
// Extracted from app.js (PR-34)

import { refreshIcons } from './icons.js';
import { store } from './store.js';
import { getSendBtn, getStatusDot } from './dom-refs.js';
import { onThemeChange } from './theme.js';
import { getActivityEl, setActivityEl, addToMessages, scrollToBottom } from './app-rendering.js';

// --- Module-owned state ---
var faviconLink, faviconOrigHref, faviconCanvas, faviconCtx, faviconImg, faviconImgReady;
var BAND_COLORS = [[0,235,160],[0,200,220],[30,100,255],[88,50,255],[200,60,180],[255,90,50]];
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
    var dots = document.querySelectorAll("#icon-strip-projects .icon-strip-item:not(.active) .icon-strip-status.processing, #icon-strip-projects .icon-strip-wt-item:not(.active) .icon-strip-status.processing, #icon-strip-users .icon-strip-mate:not(.active) .icon-strip-status.processing");
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
  // Color flow animation at ~12fps
  urgentBlinkTimer = setInterval(drawFaviconAnimFrame, 83);
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
        '<div class="mate-thinking-dots"><span></span><span></span><span></span></div>';
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
