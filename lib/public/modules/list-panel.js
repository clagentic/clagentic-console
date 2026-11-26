// list-panel.js - the one list panel behind the Notifications and Diagnostics
// buttons.
//
// Both buttons open the same panel in the same place (the #info-panels column):
// a header with the title, a "Clear all" control and the shared close control; a
// list of rows; a fixed empty-state line. It is opened through the shared menu
// registry (info-panel.js, overlay-registry.js), so a second press closes it,
// opening any other menu closes it, and outside click and Escape close it. A use
// differs only in its options and in what its rows hold. A variant is an option,
// never a second component.

import { iconHtml, refreshIcons } from './icons.js';
import { openInfoPanel } from './info-panel.js';
import { closeMenu, isMenuOpen } from './overlay-registry.js';

var openerToggles = new WeakMap();

/**
 * @param {object} opts
 * @param {string} opts.id id of the panel node; a node with that id in the page
 *   is adopted, else one is made and put in the #info-panels column.
 * @param {string} opts.title the header text and the region's accessible name.
 * @param {string} opts.emptyText the line shown while there are no rows.
 * @param {string} opts.clearLabel the accessible name of the clear-all control.
 * @param {string} opts.closeLabel the accessible name of the close control.
 * @param {Element} [opts.opener] the button that toggles the panel.
 * @param {function(object): (string|number)} opts.rowKey a row's identity: a row
 *   whose key is still listed is kept as it is (its own state, such as a button
 *   waiting for an answer, survives a refresh), a new key is drawn.
 * @param {function(object): Element} opts.renderRow draws one row.
 * @param {function(): void} opts.onClear the clear-all control was used.
 * @param {boolean} [opts.newestLast] rows arrive at the end of the list and the
 *   list scrolls to them; absent, the newest row is first.
 * @param {Document} [opts.doc]
 * @returns {{el: Element, listEl: Element, open: function(): void, close: function(): void,
 *   toggle: function(): void, isOpen: function(): boolean, sync: function(object[]): void,
 *   count: function(): number}}
 */
export function createListPanel(opts) {
  var doc = opts.doc || document;
  var opener = opts.opener || null;
  var el = doc.getElementById(opts.id);
  if (!el) {
    el = doc.createElement("div");
    el.id = opts.id;
    var host = doc.getElementById("info-panels");
    // Without the column the node waits unattached: opening it puts it in the body.
    if (host) host.appendChild(el);
  }
  // An adopted node starts empty, so a second init never doubles its header.
  el.innerHTML = "";
  el.classList.add("list-panel", "hidden");
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", opts.title);
  el.setAttribute("tabindex", "-1");

  var header = doc.createElement("div");
  header.className = "usage-panel-header";
  var titleEl = doc.createElement("span");
  titleEl.textContent = opts.title;
  var actions = doc.createElement("div");
  actions.className = "list-panel-actions";
  var clearBtn = doc.createElement("button");
  clearBtn.className = "list-panel-clear-all";
  clearBtn.setAttribute("type", "button");
  clearBtn.setAttribute("aria-label", opts.clearLabel);
  clearBtn.textContent = "Clear all";
  actions.appendChild(clearBtn);
  header.appendChild(titleEl);
  header.appendChild(actions);

  var body = doc.createElement("div");
  body.className = "usage-panel-body list-panel-body";
  var listEl = doc.createElement("div");
  listEl.className = "list-panel-list";
  body.appendChild(listEl);
  el.appendChild(header);
  el.appendChild(body);

  var emptyEl = doc.createElement("div");
  emptyEl.className = "list-panel-empty";
  emptyEl.textContent = opts.emptyText;

  var rows = new Map();

  function detach(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function sync(items) {
    var wanted = {};
    var order = items.map(function (item) {
      var key = String(opts.rowKey(item));
      wanted[key] = true;
      if (!rows.has(key)) rows.set(key, opts.renderRow(item));
      return rows.get(key);
    });
    var added = false;
    Array.from(rows.keys()).forEach(function (key) {
      if (wanted[key]) return;
      detach(rows.get(key));
      rows.delete(key);
    });
    detach(emptyEl);
    order.forEach(function (node, i) {
      if (listEl.children[i] === node) return;
      if (!node.parentNode) added = true;
      listEl.insertBefore(node, listEl.children[i] || null);
    });
    if (!order.length) listEl.appendChild(emptyEl);
    refreshIcons();
    if (added && opts.newestLast) listEl.scrollTop = listEl.scrollHeight;
  }

  // However the panel closed, its state follows. Focus returns to the opener
  // (WCAG 2.1 2.4.3) only when the operator dismissed this panel (Escape or its
  // close control): when another menu opened or a click landed on another
  // control, focus belongs to that one.
  var escapeDismiss = false;

  function focusOpener() {
    if (opener) opener.focus();
  }

  function onClosed() {
    var restore = escapeDismiss;
    escapeDismiss = false;
    if (!opener) return;
    opener.setAttribute("aria-expanded", "false");
    opener.classList.remove("active");
    if (restore) opener.focus();
  }

  function open() {
    escapeDismiss = false;
    openInfoPanel(el, {
      label: opts.closeLabel, opener: opener,
      onRemove: onClosed,
      onEscape: function () { escapeDismiss = true; return false; },
      onDismiss: focusOpener,
    });
    if (opener) {
      opener.setAttribute("aria-expanded", "true");
      opener.classList.add("active");
    }
    el.focus();
  }

  function close() { closeMenu(el); }
  function isOpen() { return isMenuOpen(el); }
  function toggle() { if (isOpen()) close(); else open(); }

  clearBtn.addEventListener("click", function () {
    opts.onClear();
    var closeBtn = el.querySelector(".overlay-close");
    if (closeBtn) closeBtn.focus();
  });
  if (opener) {
    opener.setAttribute("aria-expanded", "false");
    // A re-init replaces the opener's listener: two would open and at once close.
    var previous = openerToggles.get(opener);
    if (previous) opener.removeEventListener("click", previous);
    openerToggles.set(opener, toggle);
    opener.addEventListener("click", toggle);
  }

  sync([]);
  return { el: el, listEl: listEl, open: open, close: close, toggle: toggle, isOpen: isOpen, sync: sync, count: function () { return rows.size; } };
}

/**
 * A row's own dismiss control, the same in every list: top-right of the row.
 * @param {object} o
 * @param {string} o.label accessible name.
 * @param {function(): void} o.onClick
 * @param {string} [o.className] an extra class the row's owner finds it by.
 * @param {Document} [o.doc]
 * @returns {Element}
 */
export function rowDismissButton(o) {
  var doc = o.doc || document;
  var btn = doc.createElement("button");
  btn.className = "list-panel-row-dismiss" + (o.className ? " " + o.className : "");
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-label", o.label);
  btn.innerHTML = iconHtml("x");
  btn.addEventListener("click", function (e) {
    if (e && e.stopPropagation) e.stopPropagation();
    o.onClick();
  });
  return btn;
}
