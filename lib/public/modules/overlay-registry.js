// overlay-registry.js - the one registry of open menus and popovers.
//
// At most one menu is open, plus the menus it owns: a dropdown that a popover
// opens (a task list inside the scheduler's create popover) is registered with
// that popover as its parent and does not close it. Opening any other menu
// closes the lot. One document click handler (capture phase) and one Escape
// handler close what is open, so no surface carries its own document listener to
// dismiss a menu. A toast or banner is never in it, and Escape here never reaches
// one.
//
// The registry also keeps the open modals and sheets (overlay-modal.js): Escape
// closes the top one when no menu is open, and each is numbered so a later one
// sits over an earlier one.
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

// The open modals and sheets, earliest first; the last is the top one. Kept apart
// from the menus: a modal does not close a menu or another modal by opening.
// Each: { el, onClose, onDismiss, onEscape, dismissible, retain, exit, doc }.
var modals = [];
// A modal that is leaving (its exit class is on, its node not yet hidden), with
// the timer that finishes it, so opening it again cancels the exit.
var exiting = new WeakMap();

function indexOfModal(el) {
  for (var i = 0; i < modals.length; i++) if (modals[i].el === el) return i;
  return -1;
}

// Later modals sit over earlier ones, whatever their place in the page: the modal
// layer adds this number to --z-modal (css/overlay.css).
function numberModals() {
  modals.forEach(function (c, i) { c.el.style.setProperty("--overlay-order", String(i)); });
}

function finishModal(c) {
  if (c.retain) c.el.classList.add("hidden");
  else c.el.remove();
  if (c.exit) c.el.classList.remove(c.exit.className);
}

// Passive notices (a transient popover such as the rate-limit notice): outside
// the one-open stack, so showing one never closes the menu the user has open.
// Each: { el, opener, onClose, retain, doc }.
var passives = [];

function release(c) {
  if (c.retain) c.el.classList.add("hidden");
  else c.el.remove();
  if (c.onClose) c.onClose(c.el);
}

// Close the innermost menu. Its close hook may open or close others.
function finishTop() {
  var c = stack.pop();
  if (!c) return;
  release(c);
}

function finishPassive(el) {
  for (var i = 0; i < passives.length; i++) {
    if (passives[i].el === el) {
      release(passives.splice(i, 1)[0]);
      return;
    }
  }
}

// A click outside a passive notice and its opener closes it.
function closePassivesForClick(target) {
  passives.slice().forEach(function (c) {
    if (target && (c.el.contains(target) || (c.opener && c.opener.contains(target)))) return;
    finishPassive(c.el);
  });
}

// Close every menu from the innermost down to, and including, stack[index]. The
// set to close is taken off the stack before any close hook runs, so a menu a
// hook opens is not part of this pass and stays open.
function finishFrom(index) {
  var closing = stack.splice(index);
  while (closing.length) release(closing.pop());
}

function onDocumentClick(e) {
  var target = e && e.target;
  closePassivesForClick(target);
  if (!stack.length) return;
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
  if (!e || e.key !== "Escape") return;
  // A menu is opened from the surface under it, so it yields first: Escape closes
  // the open menu, then the top modal, and a passive notice only when neither is
  // open.
  if (!stack.length) {
    if (modals.length) {
      var topModal = modals[modals.length - 1];
      // As for a menu: a modal with something inside to step back from (a detail
      // view over a list) takes the key, and returning true leaves it open.
      if (topModal.onEscape && topModal.onEscape(e) === true) return;
      dismissModal(topModal.el);
    } else if (passives.length) finishPassive(passives[passives.length - 1].el);
    return;
  }
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
 *   closes this one. A parent that is not open counts as no parent: the menu is
 *   top-level and closes every other open menu (one-open).
 * @param {boolean} [opts.retain] close by adding "hidden" and keep the element
 *   (a node that lives in the page); absent, closing removes it.
 * @param {function(Element)} [opts.onClose] called once when it closes, however.
 * @param {function(Event): boolean} [opts.onEscape] called on Escape while this
 *   is the innermost menu; returning true means the key was spent on something
 *   inside it and the menu stays open.
 * @param {boolean} [opts.passive] a transient notice, not a menu the user opened:
 *   it is kept outside the one-open stack, so showing it closes nothing and an
 *   open menu stays open. It still closes on an outside click, and on Escape when
 *   no menu is open.
 * @param {Document} [opts.doc] defaults to the page's document.
 */
export function openMenu(el, opts) {
  var o = opts || {};
  var doc = o.doc || document;
  var entry = { el: el, opener: o.opener || null, onClose: o.onClose || null, onEscape: o.onEscape || null, retain: !!o.retain, doc: doc };
  if (o.passive) {
    finishPassive(el);
    passives.push(entry);
    wire(doc);
    return;
  }
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
  else finishPassive(el);
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
  return indexOf(el) !== -1 || passives.some(function (c) { return c.el === el; });
}

/** @returns {?Element} the innermost open menu. */
export function getOpenMenu() {
  return stack.length ? stack[stack.length - 1].el : null;
}

/**
 * Make an element an open modal or sheet, on top of the others. Opening one that
 * is already open refreshes its options and keeps its place; opening one that is
 * leaving cancels the exit.
 *
 * @param {Element} el
 * @param {object} [opts]
 * @param {function(Element)} [opts.onClose] called once when it closes, however.
 * @param {function(Element)} [opts.onDismiss] called when the operator closed it
 *   (Escape, the backdrop or the close control), after it closed.
 * @param {boolean} [opts.dismissible=true] false: Escape and dismissModal leave it.
 * @param {function(Event): boolean} [opts.onEscape] called on Escape while this is
 *   the top modal; returning true means the key was spent on something inside it
 *   and the modal stays open.
 * @param {boolean} [opts.retain] close by adding "hidden" and keep the node.
 * @param {{className: string, ms: number}} [opts.exit] a class that plays the exit
 *   animation; the node is hidden or removed after ms.
 * @param {Document} [opts.doc] defaults to the page's document.
 */
export function openModal(el, opts) {
  var o = opts || {};
  var doc = o.doc || document;
  var pending = exiting.get(el);
  if (pending) {
    clearTimeout(pending.timer);
    exiting.delete(el);
    if (pending.entry.exit) el.classList.remove(pending.entry.exit.className);
  }
  var entry = {
    el: el, onClose: o.onClose || null, onDismiss: o.onDismiss || null, onEscape: o.onEscape || null, dismissible: o.dismissible !== false,
    retain: !!o.retain, exit: o.exit || null, doc: doc,
  };
  var at = indexOfModal(el);
  if (at !== -1) modals[at] = entry;
  else modals.push(entry);
  numberModals();
  wire(doc);
}

/**
 * Close a modal if it is open. Safe to call twice.
 * @param {Element} el
 * @param {object} [opts]
 * @param {boolean} [opts.immediate] skip the exit animation.
 */
export function closeModal(el, opts) {
  var at = indexOfModal(el);
  if (at === -1) return;
  var c = modals.splice(at, 1)[0];
  numberModals();
  if (c.exit && !(opts && opts.immediate)) {
    c.el.classList.add(c.exit.className);
    exiting.set(c.el, {
      entry: c,
      timer: setTimeout(function () { exiting.delete(c.el); finishModal(c); }, c.exit.ms),
    });
  } else {
    finishModal(c);
  }
  if (c.onClose) c.onClose(c.el);
}

/**
 * The operator closes a modal (Escape, the backdrop, the close control): it
 * closes and its dismiss hook runs. A modal that is not dismissible stays.
 * @param {Element} el
 */
export function dismissModal(el) {
  var at = indexOfModal(el);
  if (at === -1 || !modals[at].dismissible) return;
  var c = modals[at];
  closeModal(el);
  if (c.onDismiss) c.onDismiss(c.el);
}

/**
 * @param {Element} el
 * @returns {boolean} whether it is an open modal.
 */
export function isModalOpen(el) {
  return indexOfModal(el) !== -1;
}

/** @returns {?Element} the top open modal. */
export function getTopModal() {
  return modals.length ? modals[modals.length - 1].el : null;
}