// overlay-registry.js - the one registry of open menus and popovers.
//
// At most one menu is open, plus the menus it owns: a dropdown that a popover
// opens (a task list inside the scheduler's create popover) is registered with
// that popover as its parent and does not close it. Opening any other menu
// closes the lot. One document click handler (capture phase) and one Escape
// handler close what is open, so no surface carries its own document listener to
// dismiss a menu. The registry closes menus only: a toast or banner is never in
// it, and Escape here never reaches one.
//
// A menu is any element: one the component built (overlay-menu.js), or one a
// surface already has in the page (a node in index.html), which the registry
// hides with the "hidden" class instead of removing.

// The open menus, outermost first; the last is the innermost.
// Each: { el, opener, onClose, onEscape, retain, doc }.
var stack = [];
// Documents that already carry the two handlers, so each gets them once.
var wired = new WeakSet();

function indexOf(el) {
  for (var i = 0; i < stack.length; i++) if (stack[i].el === el) return i;
  return -1;
}

// Close the innermost menu. Its close hook may open or close others.
function finishTop() {
  var c = stack.pop();
  if (!c) return;
  if (c.retain) c.el.classList.add("hidden");
  else c.el.remove();
  if (c.onClose) c.onClose(c.el);
}

// Close every menu from the innermost down to, and including, stack[index].
function finishFrom(index) {
  while (stack.length > index && stack.length > 0) finishTop();
}

function onDocumentClick(e) {
  if (!stack.length) return;
  var target = e && e.target;
  if (!target) { finishFrom(0); return; }
  // The innermost menu the click is in, or on the opener of: that menu and the
  // ones around it stay; the ones it owns close.
  var keep = -1;
  for (var i = stack.length - 1; i >= 0; i--) {
    var c = stack[i];
    // The opener toggles its own menu; closing here too would reopen it.
    if (c.el.contains(target) || (c.opener && c.opener.contains(target))) { keep = i; break; }
  }
  finishFrom(keep + 1);
}

function onDocumentKeydown(e) {
  if (!stack.length || !e || e.key !== "Escape") return;
  var top = stack[stack.length - 1];
  // A surface with something inside to dismiss first (an open accordion) takes
  // the key; returning true leaves the menu open.
  if (top.onEscape && top.onEscape(e) === true) return;
  finishTop();
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
 * @param {Element} [opts.parent] the open menu this one belongs to (a dropdown
 *   inside a popover): opening it leaves that menu open, a click inside the
 *   parent but outside this one closes only this one, and closing the parent
 *   closes this one. Not open: ignored.
 * @param {boolean} [opts.retain] close by adding "hidden" and keep the element
 *   (a node that lives in the page); absent, closing removes it.
 * @param {function(Element)} [opts.onClose] called once when it closes, however.
 * @param {function(Event): boolean} [opts.onEscape] called on Escape while this
 *   is the innermost menu; returning true means the key was spent on something
 *   inside it and the menu stays open.
 * @param {Document} [opts.doc] defaults to the page's document.
 */
export function openMenu(el, opts) {
  var o = opts || {};
  var doc = o.doc || document;
  var entry = { el: el, opener: o.opener || null, onClose: o.onClose || null, onEscape: o.onEscape || null, retain: !!o.retain, doc: doc };
  var at = indexOf(el);
  if (at !== -1) {
    // Refresh in place; whatever it owns is closed so it starts clean.
    finishFrom(at + 1);
    stack[at] = entry;
  } else {
    var parentAt = o.parent ? indexOf(o.parent) : -1;
    finishFrom(parentAt + 1);
    stack.push(entry);
  }
  wire(doc);
}

/**
 * Close a menu if it is open, and the menus it owns. Safe to call twice, or for
 * a menu that a later one already replaced.
 * @param {Element} el
 */
export function closeMenu(el) {
  var at = indexOf(el);
  if (at !== -1) finishFrom(at);
}

/** Close whichever menus are open. */
export function closeOpenMenu() {
  finishFrom(0);
}

/**
 * @param {Element} el
 * @returns {boolean} whether it is open.
 */
export function isMenuOpen(el) {
  return indexOf(el) !== -1;
}

/** @returns {?Element} the innermost open menu. */
export function getOpenMenu() {
  return stack.length ? stack[stack.length - 1].el : null;
}
