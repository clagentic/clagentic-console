import { showOverlay } from './overlay.js';

export function showToast(message, level, detail) {
  var text = document.createElement("div");
  text.className = "overlay-text";
  text.textContent = message;
  var content = [text];
  if (detail) {
    var detailEl = document.createElement("div");
    detailEl.className = "overlay-detail";
    detailEl.textContent = detail.split("\n")[0];
    content.push(detailEl);
  }
  // "warn" and "error" toasts carry actionable failure text (e.g. the
  // worktree-remove "not a valid working tree" error, lr-76fbc3) that a
  // 1500ms toast dismisses before it can be read. Give both levels the same
  // longer window; plain success/info toasts keep the short default.
  var duration = (level === "warn" || level === "error") ? 5000 : 1500;
  // A plain toast leaves by itself, so it draws no close control.
  showOverlay({ kind: "toast", severity: level, content: content, dismissible: false, timeout: duration });
}

var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function copyToClipboard(text) {
  var p;
  if (isIOS) {
    // iOS Safari URL-encodes clipboard text that contains colons via the
    // Clipboard API. Use textarea + execCommand to copy raw text instead.
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    document.execCommand("copy");
    document.body.removeChild(ta);
    p = Promise.resolve();
  } else if (navigator.clipboard && navigator.clipboard.writeText) {
    p = navigator.clipboard.writeText(text);
  } else {
    var ta2 = document.createElement("textarea");
    ta2.value = text;
    ta2.style.cssText = "position:fixed;left:-9999px;opacity:0";
    document.body.appendChild(ta2);
    ta2.focus();
    ta2.setSelectionRange(0, ta2.value.length);
    document.execCommand("copy");
    document.body.removeChild(ta2);
    p = Promise.resolve();
  }
  return p.then(function () { showToast("Copied to clipboard"); });
}

export { escapeHtml } from './escape-html.js';
export { relativeTime } from './relative-time.js';
