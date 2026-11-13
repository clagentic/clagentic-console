// app-modals.js - the confirm, paste and image modals.
//
// Each opens through the shared overlay component as a "modal" (overlay-modal.js):
// the scrim, the card, the layer and the close control are the component's, and
// Escape, a click on the scrim and the close control all close it. Only what is
// inside the card is drawn here.

import { showOverlay } from './overlay.js';
import { iconHtml } from './icons.js';
import { copyToClipboard } from './utils.js';

// One of each is open at most; showing another replaces it.
var confirmHandle = null;
var pasteHandle = null;
var imageHandle = null;

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Open a modal and keep its handle in a slot; the slot clears when it closes.
function openInSlot(get, set, opts) {
  if (get()) get().close();
  var handle = null;
  var userRemove = opts.onRemove;
  opts.onRemove = function (node) {
    if (get() === handle) set(null);
    if (userRemove) userRemove(node);
  };
  handle = showOverlay(opts);
  set(handle);
  return handle;
}

/**
 * Ask the operator to confirm. Escape, a click on the scrim and the close control
 * all cancel: onConfirm does not run.
 *
 * @param {string} text
 * @param {function(): void} onConfirm runs after the modal has closed, so it may
 *   open another confirmation.
 * @param {string} [okLabel="Delete"]
 * @param {boolean} [destructive=true] false draws the confirming button as a
 *   plain accent button.
 */
export function showConfirm(text, onConfirm, okLabel, destructive) {
  var handle = null;
  var cancel = el("button", "confirm-btn confirm-cancel", "Cancel");
  var ok = el("button", "confirm-btn " + (destructive === false ? "confirm-ok" : "confirm-delete"), okLabel || "Delete");
  var actions = el("div", "confirm-actions");
  actions.appendChild(cancel);
  actions.appendChild(ok);
  cancel.addEventListener("click", function () { handle.close(); });
  ok.addEventListener("click", function () {
    handle.close();
    if (onConfirm) onConfirm();
  });
  handle = openInSlot(
    function () { return confirmHandle; },
    function (h) { confirmHandle = h; },
    { kind: "modal", id: "confirm-modal", content: [el("div", "confirm-text", text), actions], closeLabel: "Cancel" }
  );
}

/** Show the text the operator pasted, with a button that copies it. */
export function showPasteModal(text) {
  var copy = el("button", "paste-modal-copy");
  copy.setAttribute("type", "button");
  copy.setAttribute("title", "Copy to clipboard");
  copy.innerHTML = iconHtml("copy");
  copy.addEventListener("click", function () { copyToClipboard(text, "Copied to clipboard"); });
  var actions = el("div", "paste-modal-actions");
  actions.appendChild(copy);
  var header = el("div", "paste-modal-header");
  header.appendChild(el("span", "paste-modal-title", "Pasted content"));
  header.appendChild(actions);

  openInSlot(
    function () { return pasteHandle; },
    function (h) { pasteHandle = h; },
    { kind: "modal", id: "paste-modal", dialogClass: "paste-modal-dialog", content: [header, el("pre", "paste-modal-body", text)] }
  );
}

/** Show an image full size over the page. */
export function showImageModal(src) {
  var img = el("img", "image-modal-img");
  img.setAttribute("alt", "");
  img.setAttribute("src", src);
  openInSlot(
    function () { return imageHandle; },
    function (h) { imageHandle = h; },
    { kind: "modal", id: "image-modal", card: false, scrim: "dark", content: img }
  );
}
