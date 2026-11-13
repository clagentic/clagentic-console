// collapsible-text.js - a collapsed view of long input that was pushed into a
// session, with a real expand/collapse button. The one component for every
// surface that shows such input: a delivered trigger, loop or scheduled message
// in the transcript and an armed schedule's row in the composer outbox, so they
// cannot drift apart. The stored text is never cut: the preview carries the
// first lines and CSS clamps it with an ellipsis; the full text stays in the DOM
// and is only hidden while collapsed. State lives in the closure, so it is per
// message and gone on reload.

import { iconHtml, refreshIcons } from './icons.js';

// Lines the collapsed view shows; a text of more lines collapses.
export var COLLAPSE_LINES = 3;

// A text collapses when it has more than COLLAPSE_LINES lines or is longer than
// this many characters.
export var COLLAPSE_CHAR_LIMIT = 280;

// Input pushed into a session rather than typed by the operator. The injected
// descriptor (injected-label.js injectedFromMessage) is null for the operator's
// own entry, so any descriptor means a trigger, loop, scheduled or scheduled-now
// input, or a legacy entry another process sent. The session agent's replies
// are not user input and never pass through here.
export function isNonTypedInput(injected) {
  if (!injected) return false;
  return !(injected.initiator === "human" && !injected.senderKind);
}

function lineList(text) {
  return String(text == null ? "" : text).trim().split(/\r?\n/);
}

export function needsCollapse(text) {
  var s = String(text == null ? "" : text).trim();
  return lineList(s).length > COLLAPSE_LINES || s.length > COLLAPSE_CHAR_LIMIT;
}

// The first COLLAPSE_LINES non-empty lines, for the collapsed preview.
export function previewLines(text, count) {
  var max = count > 0 ? count : COLLAPSE_LINES;
  var out = [];
  var lines = String(text == null ? "" : text).split(/\r?\n/);
  for (var i = 0; i < lines.length && out.length < max; i++) {
    if (lines[i].trim() !== "") out.push(lines[i]);
  }
  return out.join("\n");
}

// Builds { el, button }. `el` holds the preview and the full text; `button`
// toggles it and is placed by the caller, beside the card's other actions.
// opts.collapsed: initial state (default true).
// opts.onChange(collapsed): lets the caller mirror the state on its own
// container; called once at build and on every toggle.
// opts.lines: lines the collapsed view shows (default COLLAPSE_LINES).
// opts.size: "normal" (default) or "compact" (smaller text, tighter line).
// opts.controls: where the caller places the toggle. "row" (default) and
// "header" leave the toggle a word button the caller's CSS places; "inline" makes
// it an icon button with an accessible name, for a host that puts it on the
// collapsed line beside its other controls. Every option left out reproduces the
// markup of a call with no options, so existing callers are unchanged.
// The icon of an inline toggle is a placeholder the page's icon pass resolves:
// the caller runs refreshIcons over the built row.
export function buildCollapsibleText(text, opts) {
  var collapsed = !(opts && opts.collapsed === false);
  var lines = opts && opts.lines > 0 ? Math.floor(opts.lines) : COLLAPSE_LINES;
  var compact = !!opts && opts.size === "compact";
  var inline = !!opts && opts.controls === "inline";

  var el = document.createElement("span");
  el.className = "collapsible-text";
  if (compact) el.classList.add("collapsible-compact");
  if (inline) el.classList.add("collapsible-inline");

  // One line of text needs no second copy: the one node is the preview while
  // collapsed (CSS clamps it) and the whole text once expanded. Several lines get
  // a preview node and the full node, one shown at a time.
  var single = String(text == null ? "" : text).indexOf("\n") === -1;
  var preview = document.createElement("span");
  preview.className = "collapsible-preview";
  preview.textContent = single ? text : previewLines(text, lines);
  // The stylesheet clamps to COLLAPSE_LINES; another count is set on the node.
  if (lines !== COLLAPSE_LINES) {
    preview.style.webkitLineClamp = String(lines);
    preview.style.lineClamp = String(lines);
  }
  el.appendChild(preview);
  if (single) {
    el.classList.add("collapsible-single");
  } else {
    var full = document.createElement("span");
    full.className = "collapsible-full";
    full.textContent = text;
    el.appendChild(full);
  }

  var button = document.createElement("button");
  button.type = "button";
  button.className = "collapsible-toggle";

  var built = false;
  function apply() {
    el.classList.toggle("is-collapsed", collapsed);
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (inline) {
      button.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
      button.title = collapsed ? "Expand" : "Collapse";
      button.innerHTML = iconHtml(collapsed ? "chevron-down" : "chevron-up");
      // Before the caller has placed the button the caller's own pass resolves it.
      if (built) refreshIcons(button);
    } else {
      button.textContent = collapsed ? "Expand" : "Collapse";
    }
    if (opts && typeof opts.onChange === "function") opts.onChange(collapsed);
  }
  button.addEventListener("click", function (e) {
    e.stopPropagation();
    collapsed = !collapsed;
    apply();
  });
  apply();
  built = true;

  return { el: el, button: button };
}
