// note-order.js - a sticky note's place in the note layer.
//
// The server keeps a bring-to-front counter per note (lib/notes.js); css/sticky-notes.css
// adds it to --z-note. The counter is clamped here so the note band (--z-note up to
// +99) stays under the nav: notes past 99 tie at the top and DOM order decides
// between them.

export var NOTE_ORDER_MAX = 99;

/**
 * @param {*} zIndex the note's counter as the server sent it.
 * @returns {number} a whole number from 0 to NOTE_ORDER_MAX.
 */
export function noteLayerOrder(zIndex) {
  var n = Math.floor(Number(zIndex));
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(NOTE_ORDER_MAX, n));
}
