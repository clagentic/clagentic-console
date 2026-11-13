// overlay-modal.js - the modal and sheet kinds of the shared overlay component: a
// scrim over the page with one dialog card on it.
//
// Called through showOverlay (overlay.js) with kind "modal" (a centred dialog) or
// "sheet" (a panel rising from the bottom edge). The scrim, the card, the layer
// (--z-modal) and the close control are drawn by css/overlay.css; open modals are
// tracked, and closed by Escape, by the registry (overlay-registry.js). The
// scrim closes the modal too, and so does the shared close control, top-right.
//
// A modal is built here from its content, or adopts a node the page already has
// (opts.el): that node carries a .overlay-modal-backdrop and a
// .overlay-modal-dialog of its own, and the component keeps it hidden between
// uses.

import { iconHtml, refreshIcons } from './icons.js';
import { openModal, closeModal, dismissModal, isModalOpen } from './overlay-registry.js';

// Scrims already listening, so a node opened again is not wired twice.
var wired = new WeakSet();

function addClasses(el, names) {
  String(names || "").split(/\s+/).filter(Boolean).forEach(function (n) { el.classList.add(n); });
}

function fill(el, content) {
  if (typeof content === "string") el.innerHTML = content;
  else if (content) [].concat(content).forEach(function (node) { el.appendChild(node); });
}

/**
 * Open a modal or sheet.
 *
 * @param {object} opts
 * @param {"modal"|"sheet"} opts.kind
 * @param {string|Node|Node[]} [opts.content] markup the caller has already
 *   escaped, or nodes, for the dialog. Absent on an adopted node keeps what it holds.
 * @param {Element} [opts.el] a node the page already has, kept in place and hidden
 *   (the "hidden" class) when it closes; it holds the scrim and the dialog.
 * @param {boolean} [opts.dismissible=true] false: no close control, and neither
 *   Escape nor the scrim closes it.
 * @param {boolean} [opts.card=true] false draws the dialog without card chrome (a
 *   lightbox, where the content is the picture); its close control then hangs from
 *   the viewport corner.
 * @param {"dark"} [opts.scrim] a darker scrim.
 * @param {boolean} [opts.navSheet] a sheet a bottom-nav button opens: it stops
 *   above the nav so the nav stays in view and usable.
 * @param {{className: string, ms: number}} [opts.exit] a class that plays the exit
 *   animation before the node is hidden or removed after ms.
 * @param {string} [opts.closeLabel] the close control's accessible name.
 * @param {string} [opts.id]
 * @param {string} [opts.className] extra classes for the surface's content styling.
 * @param {string} [opts.dialogClass] extra classes for the dialog card.
 * @param {Object<string,string>} [opts.attrs]
 * @param {function(Element)} [opts.onDismiss] the operator closed it (Escape, the
 *   scrim or the close control). A confirmation resolves as cancel here.
 * @param {function(Element)} [opts.onRemove] it closed, however.
 * @param {Document} [opts.doc]
 * @returns {{el: Element, dialog: ?Element, close: function(object=): void, isOpen: function(): boolean}}
 */
export function showModal(opts) {
  var doc = opts.doc || document;
  var isSheet = opts.kind === "sheet";
  var dismissible = opts.dismissible !== false;
  var el = opts.el || doc.createElement("div");
  var backdrop;
  var dialog;

  addClasses(el, "overlay-modal " + (isSheet ? "overlay-sheet " : "") + (opts.scrim === "dark" ? "overlay-scrim-dark " : "") +
    (opts.navSheet ? "overlay-nav-sheet " : "") + (opts.className || ""));
  if (opts.id) el.id = opts.id;
  el.setAttribute("data-overlay-kind", opts.kind);
  Object.keys(opts.attrs || {}).forEach(function (name) { el.setAttribute(name, opts.attrs[name]); });

  if (opts.el) {
    backdrop = el.querySelector(".overlay-modal-backdrop");
    dialog = el.querySelector(".overlay-modal-dialog");
    if (opts.content) fill(dialog || el, opts.content);
  } else {
    backdrop = doc.createElement("div");
    backdrop.className = "overlay-modal-backdrop";
    dialog = doc.createElement("div");
    dialog.className = "overlay-modal-dialog";
    fill(dialog, opts.content);
    el.appendChild(backdrop);
    el.appendChild(dialog);
  }
  if (dialog) {
    if (isSheet) dialog.classList.add("overlay-sheet-dialog");
    if (opts.card === false) dialog.classList.add("overlay-modal-bare");
    addClasses(dialog, opts.dialogClass);
  }

  if (dismissible && dialog && !dialog.querySelector(".overlay-close")) {
    var x = doc.createElement("button");
    x.className = "overlay-close";
    x.setAttribute("type", "button");
    x.setAttribute("aria-label", opts.closeLabel || "Close");
    x.innerHTML = iconHtml("x");
    x.addEventListener("click", function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      dismissModal(el);
    });
    dialog.appendChild(x);
  }
  // The listener asks the registry, which holds the current options, so a node
  // opened again with other hooks is still handled by the one listener.
  if (backdrop && !wired.has(backdrop)) {
    wired.add(backdrop);
    backdrop.addEventListener("click", function () { dismissModal(el); });
  }

  openModal(el, { onClose: opts.onRemove, onDismiss: opts.onDismiss, dismissible: dismissible, retain: !!opts.el, exit: opts.exit, doc: doc });

  if (opts.el) el.classList.remove("hidden");
  if (!el.parentNode) doc.body.appendChild(el);
  refreshIcons();

  return {
    el: el,
    dialog: dialog,
    close: function (closeOpts) { closeModal(el, closeOpts); },
    isOpen: function () { return isModalOpen(el); },
  };
}
