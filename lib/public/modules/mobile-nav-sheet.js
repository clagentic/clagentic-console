// mobile-nav-sheet.js - the one rule for every sheet a phone bottom-nav button opens.
//
// Projects, Chat, Team and More each show their list in the page's #mobile-sheet
// (and a sheet that one of them opens, such as Files from More, is the same node).
// It opens through the shared overlay component as a "sheet" that stops above the
// nav, so the nav stays in view and tappable:
//   - the same nav button closes the sheet;
//   - another nav button switches the sheet to its own list;
//   - the close control, Escape and the scrim close it.
// The middle button's full-screen view is not a nav sheet and is not handled here.

import { showOverlay } from './overlay.js';

var SHEET_ID = "mobile-sheet";

// The sheet each nav button opens, by the button's data-tab.
var NAV_SHEETS = { projects: "projects", chat: "sessions", team: "team", more: "more" };

// Matches the slide-down animation of #mobile-sheet.closing in css/mobile-nav.css.
export var NAV_SHEET_EXIT_MS = 230;

var handle = null;
var openType = null;

/**
 * Open the nav sheet, or keep it open and change what it shows. The caller fills
 * the sheet's title and list.
 *
 * @param {string} type projects, sessions, team, more or files.
 * @param {object} [opts]
 * @param {function(Element)} [opts.onClose] the sheet closed, however.
 * @param {Document} [opts.doc]
 * @returns {?{el: Element, close: function(object=): void, isOpen: function(): boolean}}
 */
export function showNavSheet(type, opts) {
  var o = opts || {};
  var doc = o.doc || document;
  var el = doc.getElementById(SHEET_ID);
  if (!el) return null;
  openType = type;
  handle = showOverlay({
    kind: "sheet", el: el, doc: doc, navSheet: true, closeLabel: "Close",
    exit: { className: "closing", ms: NAV_SHEET_EXIT_MS },
    onRemove: function (node) {
      openType = null;
      if (o.onClose) o.onClose(node);
    },
  });
  return handle;
}

/**
 * Close the nav sheet.
 * @param {object} [opts]
 * @param {boolean} [opts.immediate] skip the slide-down.
 */
export function closeNavSheet(opts) {
  if (handle) handle.close(opts);
}

/** @returns {boolean} whether the nav sheet is open. */
export function isNavSheetOpen() {
  return !!handle && handle.isOpen();
}

/** @returns {?string} what the open nav sheet shows, or null when it is closed. */
export function navSheetType() {
  return isNavSheetOpen() ? openType : null;
}

/**
 * What a tap on a nav button does now.
 * @param {string} tab the button's data-tab.
 * @returns {?{action: "open", type: string}|{action: "close"}} null for a button
 *   that opens no nav sheet.
 */
export function navTabAction(tab) {
  var type = NAV_SHEETS[tab];
  if (!type) return null;
  return navSheetType() === type ? { action: "close" } : { action: "open", type: type };
}

/**
 * Wire the nav buttons: the button of the open sheet closes it, any other opens
 * its own sheet in place of it.
 *
 * @param {Element[]} tabs the buttons, each with a data-tab.
 * @param {object} hooks
 * @param {function(string, string): void} hooks.open show the sheet for (type, tab).
 * @param {function(): void} hooks.close close the sheet.
 */
export function wireNavTabs(tabs, hooks) {
  for (var i = 0; i < tabs.length; i++) {
    (function (tab) {
      tab.addEventListener("click", function () {
        var name = tab.dataset.tab;
        var act = navTabAction(name);
        if (!act) return;
        if (act.action === "close") hooks.close();
        else hooks.open(act.type, name);
      });
    })(tabs[i]);
  }
}
