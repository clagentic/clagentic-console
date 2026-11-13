// info-panel.js - opens one of the panels that index.html keeps in #info-panels
// (usage, status, diagnostics) through the shared overlay component.
//
// The panels stack in one column that the container lays out, so each is adopted
// as its own node (the container also holds the context panel, which is not a
// menu and stays open beside whichever panel is). The component hides a panel
// on close (retain), draws the shared close control and tracks it in the
// open-menu registry: opening one closes any other menu, and outside click and
// Escape close it.

import { showOverlay } from './overlay.js';

/**
 * @param {Element} el the panel node.
 * @param {object} opts
 * @param {string} opts.label the close control's accessible name.
 * @param {Element} [opts.opener] the control that toggles the panel.
 * @param {function(Element)} [opts.onRemove] it closed, however.
 * @param {function(Event): boolean} [opts.onEscape] Escape is about to close it;
 *   return false (or nothing) to let it close.
 * @param {function(Element)} [opts.onDismiss] the close control closed it.
 * @returns {{el: Element, close: function(): void, isOpen: function(): boolean}}
 */
export function openInfoPanel(el, opts) {
  return showOverlay({
    kind: "popover", el: el, retain: true, inline: true,
    closeButton: true, closeLabel: opts.label,
    opener: opts.opener, onRemove: opts.onRemove,
    onEscape: opts.onEscape, onDismiss: opts.onDismiss,
  });
}
