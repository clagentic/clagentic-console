// note-order.js - a sticky note's place in the note layer.
//
// The server keeps a bring-to-front counter per note (lib/notes.js); css/sticky-notes.css
// adds it to --z-note. The layer has to stay inside --z-note + 0..99 so it sits under the
// nav, but the counter only grows. While every counter fits the band it is used as is;
// once one passes it, the open notes are dense-ranked from the top, so the order between
// them survives and the most recently raised note is strictly on top.

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

/**
 * @param {Array} zIndexes the counters of every open note, as the server sent them.
 * @returns {number[]} one whole number from 0 to NOTE_ORDER_MAX per input, in input
 *   order, keeping the relative order of the counters.
 */
export function noteLayerOrders(zIndexes) {
  var raw = zIndexes.map(function (z) {
    var n = Math.floor(Number(z));
    return isFinite(n) ? Math.max(0, n) : 0;
  });
  var top = raw.reduce(function (a, b) { return Math.max(a, b); }, 0);
  if (top <= NOTE_ORDER_MAX) return raw;
  var distinct = raw.filter(function (n, i) { return raw.indexOf(n) === i; })
    .sort(function (a, b) { return a - b; });
  return raw.map(function (n) {
    var fromTop = distinct.length - 1 - distinct.indexOf(n);
    return Math.max(0, NOTE_ORDER_MAX - fromTop);
  });
}
