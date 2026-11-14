// input-list-menu.js - joins an input autocomplete list (mention, slash command,
// @agent) to the open-menu registry for one-open only.
//
// A list is tied to the text box, not to a click, so it keeps its own keyboard
// navigation, selection and Escape. The registry only enforces that a list and a
// menu are never open together: opening a list closes any open menu, and opening
// a menu closes the list (through onClose, which clears the list's own state).
//
// The existing registry options carry the rest, no new concept:
//  - opener: the text box, so a click in it is not an outside click;
//  - onEscape returning true: the registry's document Escape leaves the list to
//    the text box's own Escape handler;
//  - retain: the node lives in the page, so it is hidden, not removed.
// The passive option is not used: a passive entry sits outside the one-open
// stack and would stay open beside a menu.

import { openMenu, closeMenu } from "./overlay-registry.js";

function keepOpen() { return true; }

/**
 * @param {Element} listEl the list's node.
 * @param {?Element} inputEl the text box the list belongs to.
 * @param {function()} onClose clears the list's own state; runs when the registry
 *   closes the list (another menu opened, an outside click, back).
 */
export function openInputList(listEl, inputEl, onClose) {
  if (!listEl) return;
  // The registry hides a retained node with "hidden"; a list shows by "visible".
  listEl.classList.remove("hidden");
  openMenu(listEl, { opener: inputEl || null, retain: true, onClose: onClose, onEscape: keepOpen });
}

/** The list closed itself: let the registry forget it. */
export function closeInputList(listEl) {
  if (listEl) closeMenu(listEl);
}
