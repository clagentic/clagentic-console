// collapsible-text.js - one-line collapsed view of a multi-line prompt, with a
// real expand/collapse button. Shared by the pending scheduled-input card and a
// fired scheduled message, so the two cannot drift apart. The stored text is
// never cut: the preview carries the first line and CSS truncates it with an
// ellipsis; the full text stays in the DOM and is only hidden while collapsed.
// State lives in the closure, so it is per card and gone on reload.

// A fired message collapses only when it is long: more than one line, or over
// this many characters.
export var COLLAPSE_CHAR_LIMIT = 280;

// The turn initiators a scheduled input fires under (lib/turn-initiator.js).
export function isScheduledInitiator(initiator) {
  return initiator === "scheduled" || initiator === "scheduled-now";
}

export function needsCollapse(text) {
  var s = String(text == null ? "" : text).trim();
  return s.indexOf("\n") !== -1 || s.length > COLLAPSE_CHAR_LIMIT;
}

// First non-empty line, for the collapsed preview.
export function firstLine(text) {
  var lines = String(text == null ? "" : text).split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") return lines[i];
  }
  return "";
}

// Builds { el, button }. `el` holds the preview and the full text; `button`
// toggles it and is placed by the caller, beside the card's other actions.
// opts.collapsed: initial state (default true).
// opts.onChange(collapsed): lets the caller mirror the state on its own
// container; called once at build and on every toggle.
export function buildCollapsibleText(text, opts) {
  var collapsed = !(opts && opts.collapsed === false);

  var el = document.createElement("span");
  el.className = "collapsible-text";

  // One line of text needs no second copy: the one node is the preview while
  // collapsed (CSS cuts it) and the whole text once expanded. Several lines get
  // a preview node and the full node, one shown at a time.
  var single = String(text == null ? "" : text).indexOf("\n") === -1;
  var preview = document.createElement("span");
  preview.className = "collapsible-preview";
  preview.textContent = single ? text : firstLine(text);
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

  function apply() {
    el.classList.toggle("is-collapsed", collapsed);
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    button.textContent = collapsed ? "Expand" : "Collapse";
    if (opts && typeof opts.onChange === "function") opts.onChange(collapsed);
  }
  button.addEventListener("click", function (e) {
    e.stopPropagation();
    collapsed = !collapsed;
    apply();
  });
  apply();

  return { el: el, button: button };
}
