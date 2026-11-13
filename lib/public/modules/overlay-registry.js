// overlay-registry.js - the one registry of open menus and popovers.
//
// At most one menu is open. Opening another closes the first; one document
// click handler (capture phase) and one Escape handler close the open menu, so
// no surface carries its own document listener to dismiss a menu. The registry
// closes menus only: a toast or banner is never in it, and Escape here never
// reaches one.
//
// A menu is any element: one the component built (overlay-menu.js), or one a
// surface already has in the page (a node in index.html), which the registry
// hides with the "hidden" class instead of removing.

// The open menu, or null: { el, opener, onClose, retain, doc }.
var current = null;
// Documents that already carry the two handlers, so each gets them once.
var wired = new WeakSet();

function finish() {
  var c = current;
  current = null;
  if (!c) return;
  if (c.retain) c.el.classList.add("hidden");
  else c.el.remove();
  if (c.onClose) c.onClose(c.el);
}

function onDocumentClick(e) {
  if (!current) return;
  var target = e && e.target;
  if (target && current.el.contains(target)) return;
  // The opener toggles its own menu; closing here too would reopen it.
  if (target && current.opener && current.opener.contains(target)) return;
  finish();
}

function onDocumentKeydown(e) {
  if (current && e && e.key === "Escape") finish();
}

function wire(doc) {
  if (wired.has(doc)) return;
  wired.add(doc);
  // Capture: a menu's opener or an item may stop the click from bubbling.
  doc.addEventListener("click", onDocumentClick, true);
  doc.addEventListener("keydown", onDocumentKeydown);
}

/**
 * Make an element the open menu, closing any other. Opening the one that is
 * already open only refreshes its options.
 *
 * @param {Element} el
 * @param {object} [opts]
 * @param {Element} [opts.opener] the control that opens it; a click on it is not
 *   an outside click.
 * @param {boolean} [opts.retain] close by adding "hidden" and keep the element
 *   (a node that lives in the page); absent, closing removes it.
 * @param {function(Element)} [opts.onClose] called once when it closes, however.
 * @param {Document} [opts.doc] defaults to the page's document.
 */
export function openMenu(el, opts) {
  var o = opts || {};
  var doc = o.doc || document;
  if (current && current.el !== el) finish();
  current = { el: el, opener: o.opener || null, onClose: o.onClose || null, retain: !!o.retain, doc: doc };
  wire(doc);
}

/**
 * Close a menu if it is the open one. Safe to call twice, or for a menu that a
 * later one already replaced.
 * @param {Element} el
 */
export function closeMenu(el) {
  if (current && current.el === el) finish();
}

/** Close whichever menu is open. */
export function closeOpenMenu() {
  finish();
}

/**
 * @param {Element} el
 * @returns {boolean} whether it is the open menu.
 */
export function isMenuOpen(el) {
  return !!current && current.el === el;
}

/** @returns {?Element} the open menu. */
export function getOpenMenu() {
  return current ? current.el : null;
}
