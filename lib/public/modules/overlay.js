// overlay.js - the one component behind every toast, banner, menu and popover.
//
// A surface describes what it shows with options; the component draws the card
// (css/overlay.css), the close control, the severity edge, the auto-dismiss and
// the keyboard dismissal, and hands the card to the stacking manager
// (overlay-stack.js). A menu or popover (kind "menu" or "popover", see
// overlay-menu.js) is anchored to an element or a point instead and tracked by
// the open-menu registry (overlay-registry.js). A variant is an option, not
// another component.

import { iconHtml, refreshIcons } from './icons.js';
import { addToStack, removeFromStack } from './overlay-stack.js';
import { showMenu } from './overlay-menu.js';

var KIND_CLASS = { toast: "overlay-toast", banner: "overlay-banner" };
// "warning" is the diagnostics wording for the same level as "warn".
var SEVERITY = { info: "info", success: "success", warn: "warn", warning: "warn", error: "error" };

function nextFrame(fn) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else fn();
}

/**
 * Draw a toast or banner in the stack, or open an anchored menu or popover
 * (options of the menu kinds: overlay-menu.js showMenu).
 *
 * @param {object} opts
 * @param {"toast"|"banner"|"menu"|"popover"} opts.kind toast: content reads top
 *   to bottom; banner: left to right (an icon, then text).
 * @param {string|Node|Node[]} [opts.content] markup the caller has already
 *   escaped, or the nodes to put in the card.
 * @param {string} [opts.severity] info, success, warn (or warning) or error: the
 *   card's left edge. None draws a neutral card.
 * @param {boolean} [opts.dismissible=true] false draws no close control and
 *   takes no key dismissal (a state the operator cannot clear, such as a page
 *   that no longer matches its server).
 * @param {string} [opts.closeLabel] the close control's accessible name.
 * @param {?number} [opts.timeout] ms until it leaves by itself; absent stays.
 * @param {string} [opts.source] key a surface finds its cards by, to replace or
 *   withdraw them (overlay-stack.js cardsBySource).
 * @param {string} [opts.group] key a surface clears all its cards by.
 * @param {string} [opts.id] element id; a surface that must never draw twice
 *   looks it up first.
 * @param {string} [opts.className] extra classes for the surface's content styling.
 * @param {Object<string,string>} [opts.attrs] extra attributes.
 * @param {boolean} [opts.first] top of the stack instead of the bottom.
 * @param {function(Element)} [opts.onDismiss] the operator closed it (the close
 *   control or a key).
 * @param {function(Element)} [opts.onRemove] it started to leave, however it was
 *   closed: the operator, its timeout, or removeFromStack.
 * @param {Document} [opts.doc] defaults to the page's document.
 * @returns {{el: Element, close: function(): void}}
 */
export function showOverlay(opts) {
  if (opts && (opts.kind === "menu" || opts.kind === "popover")) return showMenu(opts);
  if (!opts || !KIND_CLASS[opts.kind]) {
    throw new Error("showOverlay: kind must be toast or banner, or menu or popover, got " + (opts && opts.kind));
  }
  var doc = opts.doc || document;
  var dismissible = opts.dismissible !== false;

  var el = doc.createElement("div");
  el.className = ["overlay", KIND_CLASS[opts.kind], dismissible ? "overlay-dismissible" : "", opts.className || ""]
    .filter(Boolean).join(" ");
  if (opts.id) el.id = opts.id;
  el.setAttribute("data-overlay-kind", opts.kind);
  if (SEVERITY[opts.severity]) el.setAttribute("data-severity", SEVERITY[opts.severity]);
  if (typeof opts.source === "string") el.setAttribute("data-overlay-source", opts.source);
  Object.keys(opts.attrs || {}).forEach(function (name) { el.setAttribute(name, opts.attrs[name]); });

  var content = opts.content;
  if (typeof content === "string") el.innerHTML = content;
  else if (content) [].concat(content).forEach(function (node) { el.appendChild(node); });

  function dismiss() {
    removeFromStack(el);
    if (opts.onDismiss) opts.onDismiss(el);
  }

  if (dismissible) {
    var close = doc.createElement("button");
    close.className = "overlay-close";
    close.setAttribute("type", "button");
    close.setAttribute("aria-label", opts.closeLabel || "Dismiss");
    close.innerHTML = iconHtml("x");
    // The card may itself be clickable (a banner opens its session): closing is
    // not that click.
    close.addEventListener("click", function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      dismiss();
    });
    el.appendChild(close);

    // Enter and Space bubble up from the card's own buttons when they are
    // activated; that must activate the button, not close the card.
    el.addEventListener("keydown", function (e) {
      var fromButton = e.target && e.target.tagName === "BUTTON";
      if (e.key === "Escape" || ((e.key === "Enter" || e.key === " ") && !fromButton)) dismiss();
    });
  }

  addToStack(el, { doc: doc, first: opts.first, timeout: opts.timeout, group: opts.group, onRemove: opts.onRemove });
  // Draws the close icon. A surface whose own content carries icons refreshes
  // them too; the refresh is one scan per frame however many ask.
  if (dismissible) refreshIcons();
  nextFrame(function () { el.classList.add("visible"); });

  return { el: el, close: function () { removeFromStack(el); } };
}
