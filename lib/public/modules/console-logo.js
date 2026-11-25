// console-logo.js — start/stop control for the connect overlay's logo draw-in.
// The icon markup ships in index.html and the keyframes live in
// css/overlays.css; the overlay carries .logo-running in the served page so the
// draw-in plays from first paint, before this module loads. This module only
// toggles that class.

var RUNNING_CLASS = "logo-running";

function overlayEl() {
  return document.getElementById("connect-overlay");
}

// Re-applying the class restarts the CSS cycle from its first frame; the
// forced style flush between remove and add makes the browser see the change.
export function startLogoAnimation() {
  var overlay = overlayEl();
  if (!overlay) return;
  overlay.classList.remove(RUNNING_CLASS);
  if (typeof overlay.getBoundingClientRect === "function") overlay.getBoundingClientRect();
  overlay.classList.add(RUNNING_CLASS);
}

export function stopLogoAnimation() {
  var overlay = overlayEl();
  if (overlay) overlay.classList.remove(RUNNING_CLASS);
}
