// console-logo.js — Animated SVG draw-in for the connect overlay
// Uses stroke-dashoffset to progressively reveal the console icon paths.
// Replaces the ASCII particle system (ascii-logo.js).

var svgEl = null;
var animId = null;
var running = false;
var startTime = 0;

// Total animation duration for one draw-in cycle (seconds)
var DRAW_DURATION = 1.4;
// Hold at full opacity before fading and restarting
var HOLD_DURATION = 1.2;
// Fade out duration
var FADE_DURATION = 0.6;
// Gap before next cycle
var GAP_DURATION = 0.3;
var CYCLE = DRAW_DURATION + HOLD_DURATION + FADE_DURATION + GAP_DURATION;

// Paths in the console icon, in draw order with their total lengths (px at viewBox scale).
// Lengths are computed at runtime from the live SVG elements.
var paths = null;

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}

function buildSVG() {
  if (!svgEl) return;

  svgEl.innerHTML = [
    '<defs>',
    '  <linearGradient id="cg-overlay" gradientUnits="userSpaceOnUse" x1="20" y1="16" x2="92" y2="96">',
    '    <stop offset="0%"   stop-color="#00CFFF"/>',
    '    <stop offset="50%"  stop-color="#4A7FE8"/>',
    '    <stop offset="100%" stop-color="#7B3FE4"/>',
    '  </linearGradient>',
    '</defs>',
    // Outer frame
    '<rect class="clogo-path" x="10" y="16" width="92" height="80" rx="8" ry="8"',
    '      fill="none" stroke="url(#cg-overlay)" stroke-width="5"/>',
    // Vertical divider
    '<line class="clogo-path" x1="38" y1="16" x2="38" y2="96"',
    '      stroke="url(#cg-overlay)" stroke-width="3" stroke-opacity="0.6"/>',
    // Left panel lines
    '<line class="clogo-path" x1="17" y1="34" x2="31" y2="34" stroke="url(#cg-overlay)" stroke-width="2.5" stroke-linecap="round"/>',
    '<line class="clogo-path" x1="17" y1="42" x2="29" y2="42" stroke="url(#cg-overlay)" stroke-width="2.5" stroke-linecap="round"/>',
    '<line class="clogo-path" x1="17" y1="54" x2="31" y2="54" stroke="url(#cg-overlay)" stroke-width="2.5" stroke-linecap="round"/>',
    '<line class="clogo-path" x1="17" y1="62" x2="27" y2="62" stroke="url(#cg-overlay)" stroke-width="2.5" stroke-linecap="round"/>',
    // Bottom-left square
    '<rect class="clogo-path" x="17" y="73" width="14" height="12" rx="2"',
    '      fill="none" stroke="url(#cg-overlay)" stroke-width="2.5"/>',
    // Right panel lines
    '<line class="clogo-path" x1="45" y1="30" x2="88" y2="30" stroke="url(#cg-overlay)" stroke-width="2.5" stroke-linecap="round"/>',
    '<line class="clogo-path" x1="45" y1="39" x2="80" y2="39" stroke="url(#cg-overlay)" stroke-width="2.5" stroke-linecap="round"/>',
    '<line class="clogo-path" x1="45" y1="48" x2="85" y2="48" stroke="url(#cg-overlay)" stroke-width="2.5" stroke-linecap="round"/>',
    '<line class="clogo-path" x1="45" y1="57" x2="74" y2="57" stroke="url(#cg-overlay)" stroke-width="2.5" stroke-linecap="round"/>',
    '<line class="clogo-path" x1="45" y1="66" x2="82" y2="66" stroke="url(#cg-overlay)" stroke-width="2.5" stroke-linecap="round"/>',
    '<line class="clogo-path" x1="45" y1="75" x2="88" y2="75" stroke="url(#cg-overlay)" stroke-width="2.5" stroke-linecap="round"/>',
    '<line class="clogo-path" x1="45" y1="84" x2="70" y2="84" stroke="url(#cg-overlay)" stroke-width="2.5" stroke-linecap="round"/>',
  ].join('\n');

  // Measure each path's total length
  paths = Array.prototype.slice.call(svgEl.querySelectorAll(".clogo-path"));
  for (var i = 0; i < paths.length; i++) {
    var el = paths[i];
    var len = 0;
    try { len = el.getTotalLength ? el.getTotalLength() : pathLength(el); } catch (e) {}
    if (!len) len = 200; // safe fallback
    el.style.strokeDasharray = len;
    el.style.strokeDashoffset = len;
  }
}

// Fallback length for rects/lines that don't have getTotalLength
function pathLength(el) {
  var tag = el.tagName.toLowerCase();
  if (tag === "line") {
    var dx = (parseFloat(el.getAttribute("x2")) - parseFloat(el.getAttribute("x1"))) || 0;
    var dy = (parseFloat(el.getAttribute("y2")) - parseFloat(el.getAttribute("y1"))) || 0;
    return Math.sqrt(dx * dx + dy * dy);
  }
  if (tag === "rect") {
    var w = parseFloat(el.getAttribute("width")) || 0;
    var h = parseFloat(el.getAttribute("height")) || 0;
    return 2 * (w + h);
  }
  return 200;
}

function tick(now) {
  if (!running) return;
  var elapsed = (now - startTime) / 1000;
  var t = elapsed % CYCLE;

  var opacity = 1;

  if (t < DRAW_DURATION) {
    // Draw-in phase: stagger each path
    var count = paths ? paths.length : 0;
    for (var i = 0; i < count; i++) {
      var el = paths[i];
      var delay = (i / count) * (DRAW_DURATION * 0.55);
      var localT = (t - delay) / (DRAW_DURATION * 0.65);
      localT = Math.max(0, Math.min(1, localT));
      var len = parseFloat(el.style.strokeDasharray) || 200;
      el.style.strokeDashoffset = len * (1 - easeOut(localT));
    }
    opacity = Math.min(1, t / 0.3);
  } else if (t < DRAW_DURATION + HOLD_DURATION) {
    // Hold: fully drawn, breathe slightly
    var breath = Math.sin((t - DRAW_DURATION) * Math.PI * 1.2) * 0.06;
    opacity = 0.94 + breath;
  } else if (t < DRAW_DURATION + HOLD_DURATION + FADE_DURATION) {
    // Fade out
    var ft = (t - DRAW_DURATION - HOLD_DURATION) / FADE_DURATION;
    opacity = 1 - easeInOut(ft);
  } else {
    // Gap: invisible
    opacity = 0;
    // Reset dash offsets for next cycle
    if (paths) {
      for (var i = 0; i < paths.length; i++) {
        var len = parseFloat(paths[i].style.strokeDasharray) || 200;
        paths[i].style.strokeDashoffset = len;
      }
    }
  }

  if (svgEl) svgEl.style.opacity = opacity;
  animId = requestAnimationFrame(tick);
}

export function initConsoleLogo(el) {
  svgEl = el;
  buildSVG();
}

export function startLogoAnimation() {
  if (!svgEl) return;
  if (running) {
    cancelAnimationFrame(animId);
  }
  running = true;
  startTime = performance.now();
  // Reset
  if (svgEl) svgEl.style.opacity = 0;
  animId = requestAnimationFrame(tick);
}

export function stopLogoAnimation() {
  running = false;
  if (animId) {
    cancelAnimationFrame(animId);
    animId = null;
  }
  if (svgEl) svgEl.style.opacity = 0;
}
