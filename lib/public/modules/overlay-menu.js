// overlay-menu.js - the anchored kinds of the shared overlay component: a menu
// or popover placed at an element or a point.
//
// Called through showOverlay (overlay.js) with kind "menu" or "popover". The
// card chrome, the layer (--z-menu) and the optional close control are drawn by
// css/overlay.css; placement is modules/popover-position.js; one-open, outside
// click and Escape are the registry (overlay-registry.js).

import { iconHtml, refreshIcons } from './icons.js';
import { positionPopover, positionAtPoint } from './popover-position.js';
import { openMenu, closeMenu, isMenuOpen } from './overlay-registry.js';

var KIND_CLASS = { menu: "", popover: "overlay-popover" };

function nextFrame(fn) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else fn();
}

function addClasses(el, names) {
  String(names || "").split(/\s+/).filter(Boolean).forEach(function (n) { el.classList.add(n); });
}

/**
 * Open a menu or popover.
 *
 * @param {object} opts
 * @param {"menu"|"popover"} opts.kind
 * @param {Element|{x:number,y:number}} [opts.anchor] an element to hang from, or a
 *   viewport point (a contextmenu event's clientX/clientY). Absent: left where
 *   the surface's own styling puts it.
 * @param {"right"|"below"|"below-right-aligned"} [opts.placement] see
 *   popover-position.js; element anchors only.
 * @param {number} [opts.gap] gap between anchor and menu; element anchors only.
 * @param {number} [opts.margin] least gap to the viewport edge.
 * @param {Element} [opts.opener] the control that toggles it; a click on it is
 *   not an outside click, so the surface's own handler can close it.
 * @param {Element} [opts.el] a node the surface built or already has: it is the
 *   card instead of a new element, and stays where it is when it already has a
 *   parent (otherwise it is appended to the body).
 * @param {boolean} [opts.retain] closing hides the node (the "hidden" class)
 *   instead of removing it: for a node that lives in the page (index.html), which
 *   the surface opens again later.
 * @param {string|Node|Node[]} [opts.content] markup the caller has already
 *   escaped, or nodes. Absent on an adopted node keeps what it holds.
 * @param {boolean} [opts.closeButton] draw the shared .overlay-close, top-right.
 * @param {string} [opts.closeLabel] the close control's accessible name.
 * @param {string} [opts.id]
 * @param {string} [opts.className] extra classes for the surface's content styling.
 * @param {Object<string,string>} [opts.attrs]
 * @param {function(Element)} [opts.onDismiss] the close control was used.
 * @param {function(Element)} [opts.onRemove] it closed, however.
 * @param {Document} [opts.doc]
 * @returns {{el: Element, close: function(): void, reposition: function(): void, isOpen: function(): boolean}}
 */
export function showMenu(opts) {
  var doc = opts.doc || document;
  var el = opts.el || doc.createElement("div");
  var anchor = opts.anchor || null;
  var isPoint = !!anchor && typeof anchor.x === "number" && typeof anchor.y === "number";

  addClasses(el, "overlay-menu " + KIND_CLASS[opts.kind] + " " + (opts.className || ""));
  if (opts.id) el.id = opts.id;
  el.setAttribute("data-overlay-kind", opts.kind);
  Object.keys(opts.attrs || {}).forEach(function (name) { el.setAttribute(name, opts.attrs[name]); });

  var content = opts.content;
  if (typeof content === "string") el.innerHTML = content;
  else if (content) [].concat(content).forEach(function (node) { el.appendChild(node); });

  function close() { closeMenu(el); }

  if (opts.closeButton && !el.querySelector(".overlay-close")) {
    var x = doc.createElement("button");
    x.className = "overlay-close";
    x.setAttribute("type", "button");
    x.setAttribute("aria-label", opts.closeLabel || "Close");
    x.innerHTML = iconHtml("x");
    x.addEventListener("click", function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      close();
      if (opts.onDismiss) opts.onDismiss(el);
    });
    el.appendChild(x);
  }

  // Registered before it is drawn so the menu it replaces is already gone.
  openMenu(el, { opener: opts.opener, retain: !!opts.retain, onClose: opts.onRemove, doc: doc });

  if (opts.retain) el.classList.remove("hidden");
  if (!el.parentNode) doc.body.appendChild(el);

  function reposition() {
    if (!anchor) return;
    if (isPoint) {
      positionAtPoint(el, anchor, { margin: opts.margin });
      return;
    }
    var place = { placement: opts.placement };
    if (typeof opts.gap === "number") place.gap = opts.gap;
    if (typeof opts.margin === "number") place.margin = opts.margin;
    positionPopover(el, anchor, place);
  }
  reposition();
  // Icons the surface draws change the card's size once they render.
  refreshIcons();
  nextFrame(function () { if (isMenuOpen(el)) reposition(); });

  return { el: el, close: close, reposition: reposition, isOpen: function () { return isMenuOpen(el); } };
}
