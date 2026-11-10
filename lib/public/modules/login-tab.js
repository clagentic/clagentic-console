// Ties one login terminal to its sign-in panel. Only the terminal marked as a
// login tab gets one of these, so no other terminal's output is ever read for
// a URL or code. Parsing is client-side over the terminal's own buffer; the
// server sees nothing but the code the user types, through the same terminal
// input message as every other keystroke.

import { bufferLogicalLines } from './terminal-links.js';
import { compileLoginPatterns, parseLoginLines } from './login-parser.js';
import { createLoginPanel } from './login-panel.js';

// Rows of recent output read per update; a sign-in screen is a few lines.
var SCAN_ROWS = 200;

/**
 * @param {object} opts
 * @param {object} opts.patterns     the vendor's loginPatterns (or null)
 * @param {string} opts.vendorName
 * @param {string} opts.identity     "os-users", "shared" or ""
 * @param {function(string):void} opts.sendCode   types into this terminal only
 * @param {function(object):void} opts.mount      puts the panel element in the page
 * @param {function(string):void} opts.copy
 * @param {function(string):void} opts.openLink
 * @returns {{feed: function, setActive: function, close: function}}
 */
export function createLoginTab(opts) {
  var compiled = compileLoginPatterns(opts.patterns);
  var panel = null;
  var dismissed = false;
  var active = true;

  function ensurePanel() {
    if (panel || dismissed) return panel;
    panel = createLoginPanel({
      vendorName: opts.vendorName,
      identity: opts.identity,
      sendCode: opts.sendCode,
      copy: opts.copy,
      openLink: opts.openLink,
      onDismiss: function () { dismissed = true; panel = null; },
    });
    opts.mount(panel.element);
    panel.setHidden(!active);
    return panel;
  }

  return {
    /** Call after output was written to the terminal. */
    feed: function (xterm) {
      if (!compiled || dismissed || !xterm || !xterm.buffer) return;
      var lines = bufferLogicalLines(xterm.buffer.active, xterm.cols, SCAN_ROWS);
      var parsed = parseLoginLines(lines, compiled);
      if (!parsed) return;
      ensurePanel().update(parsed);
    },
    setActive: function (isActive) {
      active = !!isActive;
      if (panel) panel.setHidden(!active);
    },
    /** The terminal exited or closed: drop the panel and everything it held. */
    close: function () {
      if (panel) panel.remove();
      panel = null;
      dismissed = true;
    },
  };
}
