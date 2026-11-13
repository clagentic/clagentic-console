// mobile-action-sheet.js - the phone's short list of actions for one thing (the
// project actions behind the Chat sheet's "..." button).
//
// It opens through the shared overlay component as a "sheet": the scrim, the
// layer, the close control, and closing on Escape or a tap on the scrim are the
// component's. Only the rows are drawn here.

import { showOverlay } from './overlay.js';
import { iconHtml } from './icons.js';

/**
 * @param {object} opts
 * @param {{icon: string, label: string, handler: function(): void}[]} opts.actions
 *   in the order shown. Choosing one closes the sheet, then runs its handler.
 * @param {string} [opts.cancelLabel="Cancel"] the last row, which only closes it.
 * @param {Document} [opts.doc]
 * @returns {{el: Element, close: function(object=): void, isOpen: function(): boolean}}
 */
export function showActionSheet(opts) {
  var doc = opts.doc || document;
  var handle = null;
  var rows = [];

  opts.actions.forEach(function (action) {
    var btn = doc.createElement("button");
    btn.className = "mobile-action-sheet-item";
    btn.innerHTML = iconHtml(action.icon);
    var label = doc.createElement("span");
    label.textContent = action.label;
    btn.appendChild(label);
    btn.addEventListener("click", function () {
      handle.close();
      action.handler();
    });
    rows.push(btn);
  });

  var cancel = doc.createElement("button");
  cancel.className = "mobile-action-sheet-cancel";
  cancel.textContent = opts.cancelLabel || "Cancel";
  cancel.addEventListener("click", function () { handle.close(); });
  rows.push(cancel);

  handle = showOverlay({ kind: "sheet", doc: doc, dialogClass: "mobile-action-sheet", content: rows, closeLabel: "Close" });
  return handle;
}
