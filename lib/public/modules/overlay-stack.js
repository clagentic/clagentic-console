// overlay-stack.js - the one stacking manager for toasts and banners.
//
// Every toast and banner is a child of one container (css/overlay.css gives it
// a fixed column), so two of them can never share a spot: placement is the
// flow of that column, not a per-surface position. The manager owns the
// container, where a card goes in it, when a card leaves, and the lookups a
// surface needs to replace or clear its own cards.

var STACK_ID = "overlay-stack";
// Matches the exit transition in css/overlay.css.
var EXIT_MS = 300;

// Per card: its auto-dismiss timer, its removal hook, and whether it is leaving.
var records = new WeakMap();
var cached = null;

/**
 * The stack container, created on first use.
 * @param {Document} [doc] defaults to the page's document.
 * @returns {Element}
 */
export function getStack(doc) {
  var d = doc || document;
  var found = d.getElementById(STACK_ID);
  if (found) { cached = found; return found; }
  if (cached && cached.parentNode === d.body) return cached;
  var el = d.createElement("div");
  el.id = STACK_ID;
  el.className = "overlay-stack";
  d.body.appendChild(el);
  cached = el;
  return el;
}

/**
 * Put a card in the stack.
 * @param {Element} el
 * @param {object} [opts]
 * @param {Document} [opts.doc]
 * @param {boolean} [opts.first] top of the stack instead of the bottom.
 * @param {?number} [opts.timeout] ms until it leaves by itself; null or absent stays.
 * @param {?string} [opts.group] a name surfaces clear their cards by (clearGroup).
 * @param {function(Element)} [opts.onRemove] called once, when it starts to leave.
 */
export function addToStack(el, opts) {
  var o = opts || {};
  var stack = getStack(o.doc);
  var record = { timer: null, onRemove: o.onRemove || null, removing: false };
  records.set(el, record);
  if (o.group) el.setAttribute("data-overlay-group", o.group);
  if (o.first) stack.insertBefore(el, stack.firstChild);
  else stack.appendChild(el);
  if (typeof o.timeout === "number") {
    record.timer = setTimeout(function () { removeFromStack(el); }, o.timeout);
  }
}

/**
 * Take a card out: it fades, then goes. Safe to call twice.
 * @param {Element} el
 */
export function removeFromStack(el) {
  if (!el || !el.parentNode) return;
  var record = records.get(el);
  if (record) {
    if (record.removing) return;
    record.removing = true;
    clearTimeout(record.timer);
  }
  el.classList.remove("visible");
  el.classList.add("hide");
  if (record && record.onRemove) record.onRemove(el);
  setTimeout(function () {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, EXIT_MS);
}

/**
 * Take every card of one group out at once, with no fade, as a surface does when
 * it redraws all of its cards.
 * @param {string} group
 * @param {Document} [doc]
 */
export function clearGroup(group, doc) {
  var stack = getStack(doc);
  var gone = stack.querySelectorAll('[data-overlay-group="' + group + '"]');
  var hooks = [];
  for (var i = 0; i < gone.length; i++) {
    var record = records.get(gone[i]);
    if (record) {
      clearTimeout(record.timer);
      record.removing = true;
      if (record.onRemove) hooks.push([record.onRemove, gone[i]]);
    }
    if (gone[i].parentNode) gone[i].parentNode.removeChild(gone[i]);
  }
  // After every card is out, so a hook that counts the stack sees the end state.
  hooks.forEach(function (h) { h[0](h[1]); });
}

/**
 * The cards a surface raised under one source key, or under any when none is given.
 * @param {string} [source]
 * @param {Document} [doc]
 * @returns {Element[]}
 */
export function cardsBySource(source, doc) {
  var sel = source === undefined ? "[data-overlay-source]" : '[data-overlay-source="' + source + '"]';
  return Array.prototype.slice.call(getStack(doc).querySelectorAll(sel));
}
