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
import { openModal, closeModal, dismissModal, isModalOpen, isPanelBlocked } from './overlay-registry.js';
import { pushOverlayState, popOverlayState, releaseOverlayState } from './overlay-history.js';

// Scrims already listening, so a node opened again is not wired twice.
var wired = new WeakSet();
// Panels that hold an entry in the browser history right now: one entry each,
// however many times the panel is opened while it is open.
var holding = new WeakSet();

// Whether a panel opening now holds a history entry: on by default, or as the
// caller's option (a boolean, or a function asked at each open).
function wantsHistoryEntry(opts) {
  if (typeof opts.history === "function") return !!opts.history();
  return opts.history !== false;
}

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
 * @param {"dark"|"solid"} [opts.scrim] dark: a darker scrim. solid: the page's own
 *   background, so nothing under it shows (a screen the operator must finish).
 * @param {boolean} [opts.navSheet] a sheet a bottom-nav button opens: it stops
 *   above the nav so the nav stays in view and usable.
 * @param {boolean} [opts.panel] a panel (a modal only): a full-page surface on
 *   the panel layer (--z-panel), under the dialogs a panel opens. Escape, the
 *   scrim and the shared close control close it as they close a modal, and it
 *   holds an entry in the browser history so a back swipe closes it too
 *   (overlay-history.js, routed by closeTopHeldPanel). The dialog fills the page;
 *   a surface that is a card or a drop-down sizes its own dialogClass. A panel is
 *   refused while a dialog is open: the returned handle has refused: true and
 *   isOpen() false, and the caller does nothing more.
 * @param {boolean|function(): boolean} [opts.history=true] a panel only: whether
 *   it holds a history entry. A function is asked at each open (a panel that is
 *   a page of the phone Settings list holds one on a phone only).
 * @param {{className: string, ms: number}} [opts.exit] a class that plays the exit
 *   animation before the node is hidden or removed after ms.
 * @param {string} [opts.closeLabel] the close control's accessible name.
 * @param {string} [opts.id]
 * @param {string} [opts.className] extra classes for the surface's content styling.
 * @param {string} [opts.dialogClass] extra classes for the dialog card.
 * @param {Object<string,string>} [opts.attrs]
 * @param {function(Element)} [opts.onDismiss] the operator closed it (Escape, the
 *   scrim or the close control). A confirmation resolves as cancel here.
 * @param {function(Event): boolean} [opts.onEscape] Escape while it is the top
 *   modal; returning true means the key was spent on something inside it (a detail
 *   view stepping back to its list) and the modal stays open.
 * @param {function(Element)} [opts.onRemove] it closed, however.
 * @param {Document} [opts.doc]
 * @returns {{el: Element, dialog: ?Element, refused: (boolean|undefined), close: function({immediate: boolean, keepHistory: boolean}=): void, isOpen: function(): boolean}}
 *   close's keepHistory: a panel releases its history entry without history.back()
 *   because the page pushes an entry of its own next.
 */
export function showModal(opts) {
  var doc = opts.doc || document;
  var isSheet = opts.kind === "sheet";
  var isPanel = !!opts.panel && !isSheet;
  var dismissible = opts.dismissible !== false;
  var el = opts.el || doc.createElement("div");
  // A panel does not open while a dialog is open (overlay-registry.js isPanelBlocked):
  // nothing is drawn, no history entry is held and no hook runs. The caller sees it
  // in isOpen() and in refused.
  if (isPanel && isPanelBlocked(el)) {
    return { el: el, dialog: null, refused: true, close: function () {}, isOpen: function () { return false; } };
  }
  var backdrop;
  var dialog;

  addClasses(el, "overlay-modal " + (isSheet ? "overlay-sheet " : "") + (opts.scrim === "dark" ? "overlay-scrim-dark " : "") +
    (opts.scrim === "solid" ? "overlay-scrim-solid " : "") + (isPanel ? "overlay-panel " : "") +
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
    if (isPanel) dialog.classList.add("overlay-panel-dialog");
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

  if (isPanel && !holding.has(el) && wantsHistoryEntry(opts)) {
    pushOverlayState(el);
    holding.add(el);
  }
  // The history entry goes when the panel closes, by whatever way: Escape, the
  // close control, a back swipe (the entry is then already gone, see
  // popOverlayState) or the surface itself.
  var onClose = function (node) {
    if (holding.has(node)) {
      holding.delete(node);
      popOverlayState(node);
    }
    if (opts.onRemove) opts.onRemove(node);
  };
  openModal(el, {
    onClose: onClose, onDismiss: opts.onDismiss, onEscape: opts.onEscape, dismissible: dismissible, retain: !!opts.el, exit: opts.exit,
    panel: isPanel, held: holding.has(el), doc: doc,
  });

  if (opts.el) el.classList.remove("hidden");
  if (!el.parentNode) doc.body.appendChild(el);
  refreshIcons();

  return {
    el: el,
    dialog: dialog,
    close: function (closeOpts) {
      // The page navigates right after (it pushes its own entry): the panel's
      // entry is released without the history.back() that would race the push.
      if (closeOpts && closeOpts.keepHistory && holding.has(el)) {
        holding.delete(el);
        releaseOverlayState(el);
      }
      closeModal(el, closeOpts);
    },
    isOpen: function () { return isModalOpen(el); },
  };
}
