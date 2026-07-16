// lib/cli/tui.js
//
// Terminal UI primitives for bin/cli.js: ANSI helpers, the startup logo, and
// the interactive prompt widgets (toggle / PIN / text / select / multi-select).
// Pure functions + callbacks — no shared mutable state beyond the
// `isBasicTerm` terminal-capability flag, which is fixed for the process
// lifetime. Extracted verbatim from bin/cli.js (lr-4e49 Part 1), no behavior
// change.

var fs = require("fs");
var path = require("path");
var REAL_HOME = require("../config").REAL_HOME;

// --- ANSI helpers ---
var isBasicTerm = process.env.TERM_PROGRAM === "Apple_Terminal";
var a = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  indigo: isBasicTerm ? "\x1b[34m" : "\x1b[38;2;88;87;252m",   // #5857FC Indigo — active interaction
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function gradient(text) {
  if (isBasicTerm) {
    return a.yellow + text + a.reset;
  }
  // Terracotta (#FE7150) → Warm brown (#D09558) gradient
  var r0 = 254, g0 = 113, b0 = 80;
  var r1 = 208, g1 = 149, b1 = 88;
  var out = "";
  var len = text.length;
  for (var i = 0; i < len; i++) {
    var t = len > 1 ? i / (len - 1) : 0;
    var r = Math.round(r0 + (r1 - r0) * t);
    var g = Math.round(g0 + (g1 - g0) * t);
    var b = Math.round(b0 + (b1 - b0) * t);
    out += "\x1b[38;2;" + r + ";" + g + ";" + b + "m" + text[i];
  }
  return out + a.reset;
}

var sym = {
  pointer: a.indigo + "◆" + a.reset,
  done: a.green + "◇" + a.reset,
  bar: a.dim + "│" + a.reset,
  end: a.dim + "└" + a.reset,
  warn: a.yellow + "▲" + a.reset,
};

function log(s) { console.log("  " + s); }

function clearUp(n) {
  for (var i = 0; i < n; i++) {
    process.stdout.write("\x1b[1A\x1b[2K");
  }
}

// --- Logo ---
function printLogo() {
  var r = a.reset;
  // Clagentic: Console — startup banner (lr-5e26)
  var lines = [
    "  ____ _        _    ____ _____ _   _ _____ ___ ____  ",
    " / ___| |      / \\  / ___| ____| \\ | |_   _|_ _/ ___| ",
    "| |   | |     / _ \\| |  _|  _| |  \\| | | |  | | |     ",
    "| |___| |___ / ___ \\ |_| | |___| |\\  | | |  | | |___  ",
    " \\____|_____/_/   \\_\\____|_____|_| \\_| |_| |___\\____| ",
    "                                          : Console     ",
  ];
  console.log("");
  if (isBasicTerm) {
    for (var i = 0; i < lines.length; i++) {
      console.log(a.green + lines[i] + r);
    }
    return;
  }
  // Tri-accent vertical gradient: Green (#09E5A3) → Indigo (#5857FC) → Terracotta (#FE7150)
  var stops = [
    [9, 229, 163],
    [88, 87, 252],
    [254, 113, 80],
  ];
  for (var i = 0; i < lines.length; i++) {
    var t = lines.length > 1 ? i / (lines.length - 1) : 0;
    var cr, cg, cb;
    if (t <= 0.5) {
      var s = t * 2;
      cr = Math.round(stops[0][0] + (stops[1][0] - stops[0][0]) * s);
      cg = Math.round(stops[0][1] + (stops[1][1] - stops[0][1]) * s);
      cb = Math.round(stops[0][2] + (stops[1][2] - stops[0][2]) * s);
    } else {
      var s = (t - 0.5) * 2;
      cr = Math.round(stops[1][0] + (stops[2][0] - stops[1][0]) * s);
      cg = Math.round(stops[1][1] + (stops[2][1] - stops[1][1]) * s);
      cb = Math.round(stops[1][2] + (stops[2][2] - stops[1][2]) * s);
    }
    console.log("\x1b[38;2;" + cr + ";" + cg + ";" + cb + "m" + lines[i] + r);
  }
}

// --- Interactive prompts ---
function promptToggle(title, desc, defaultValue, callback) {
  var value = defaultValue || false;

  function renderToggle() {
    var yes = value
      ? a.green + a.bold + "● Yes" + a.reset
      : a.dim + "○ Yes" + a.reset;
    var no = !value
      ? a.green + a.bold + "● No" + a.reset
      : a.dim + "○ No" + a.reset;
    return yes + a.dim + " / " + a.reset + no;
  }

  var lines = 2;
  log(sym.pointer + "  " + a.bold + title + a.reset);
  if (desc) {
    log(sym.bar + "  " + a.dim + desc + a.reset);
    lines = 3;
  }
  process.stdout.write("  " + sym.bar + "  " + renderToggle());

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", function onToggle(ch) {
    if (ch === "\x1b[D" || ch === "\x1b[C" || ch === "\t") {
      value = !value;
      process.stdout.write("\x1b[2K\r  " + sym.bar + "  " + renderToggle());
    } else if (ch === "y" || ch === "Y") {
      value = true;
      process.stdout.write("\x1b[2K\r  " + sym.bar + "  " + renderToggle());
    } else if (ch === "n" || ch === "N") {
      value = false;
      process.stdout.write("\x1b[2K\r  " + sym.bar + "  " + renderToggle());
    } else if (ch === "\r" || ch === "\n") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onToggle);
      process.stdout.write("\n");
      clearUp(lines);
      var result = value ? a.green + "Yes" + a.reset : a.dim + "No" + a.reset;
      log(sym.done + "  " + title + " " + a.dim + "·" + a.reset + " " + result);
      callback(value);
    } else if (ch === "\x03") {
      process.stdout.write("\n");
      clearUp(lines);
      log(sym.end + "  " + a.dim + "Cancelled" + a.reset);
      process.exit(0);
    }
  });
}

function promptPin(callback) {
  log(sym.pointer + "  " + a.bold + "PIN protection" + a.reset);
  log(sym.bar + "  " + a.dim + "Require a 6-digit PIN to access the web UI. Enter to skip." + a.reset);
  process.stdout.write("  " + sym.bar + "  ");

  var pin = "";
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", function onPin(ch) {
    if (ch === "\r" || ch === "\n") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onPin);
      process.stdout.write("\n");

      if (pin !== "" && !/^\d{6}$/.test(pin)) {
        clearUp(3);
        log(sym.done + "  PIN protection " + a.red + "Must be exactly 6 digits" + a.reset);
        log(sym.end);
        process.exit(1);
        return;
      }

      clearUp(3);
      if (pin) {
        log(sym.done + "  PIN protection " + a.dim + "·" + a.reset + " " + a.green + "Enabled" + a.reset);
      } else {
        log(sym.done + "  PIN protection " + a.dim + "· Skipped" + a.reset);
      }
      log(sym.bar);
      callback(pin || null);
    } else if (ch === "\x03") {
      process.stdout.write("\n");
      clearUp(3);
      log(sym.end + "  " + a.dim + "Cancelled" + a.reset);
      process.exit(0);
    } else if (ch === "\x7f" || ch === "\b") {
      if (pin.length > 0) {
        pin = pin.slice(0, -1);
        process.stdout.write("\b \b");
      }
    } else if (/\d/.test(ch) && pin.length < 6) {
      pin += ch;
      process.stdout.write(a.indigo + "●" + a.reset);
    }
  });
}

/**
 * Text input prompt with placeholder and Tab directory completion.
 * title: prompt label, placeholder: dimmed hint, callback(value)
 * Enter with empty input returns placeholder value.
 * Tab completes directory paths.
 */
function promptText(title, placeholder, callback, opts) {
  var prefix = "  " + sym.bar + "  ";
  var hintLine = "";
  var lineCount = 2;
  var escHint = (!title || (opts && opts.noEsc)) ? "" : "  " + a.dim + "(esc to go back)" + a.reset;
  log(sym.pointer + "  " + a.bold + title + a.reset + escHint);
  process.stdout.write(prefix + a.dim + placeholder + a.reset);
  // Move cursor to start of placeholder
  process.stdout.write("\r" + prefix);

  var text = "";
  var showingPlaceholder = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  function redrawInput() {
    process.stdout.write("\x1b[2K\r" + prefix + text);
  }

  function clearHint() {
    if (hintLine) {
      // Erase the hint line below
      process.stdout.write("\n\x1b[2K\x1b[1A");
      hintLine = "";
      lineCount = 2;
    }
  }

  function showHint(msg) {
    clearHint();
    hintLine = msg;
    lineCount = 3;
    // Print hint below, then move cursor back up
    process.stdout.write("\n" + prefix + a.dim + msg + a.reset + "\x1b[1A");
    redrawInput();
  }

  function tabComplete() {
    var current = text || "";
    if (!current) current = "/";

    // Resolve ~ to home
    if (current.charAt(0) === "~") {
      current = REAL_HOME + current.substring(1);
    }

    var resolved = path.resolve(current);
    var dir, partial;

    try {
      var st = fs.statSync(resolved);
      if (st.isDirectory()) {
        // Current text is a full directory — list its children
        dir = resolved;
        partial = "";
      } else {
        dir = path.dirname(resolved);
        partial = path.basename(resolved);
      }
    } catch (e) {
      // Path doesn't exist — complete from parent
      dir = path.dirname(resolved);
      partial = path.basename(resolved);
    }

    var entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      return; // Can't read directory
    }

    // Filter to directories only, matching partial prefix
    var matches = [];
    var lowerPartial = partial.toLowerCase();
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].charAt(0) === "." && !partial.startsWith(".")) continue;
      if (lowerPartial && entries[i].toLowerCase().indexOf(lowerPartial) !== 0) continue;
      try {
        var full = path.join(dir, entries[i]);
        if (fs.statSync(full).isDirectory()) {
          matches.push(entries[i]);
        }
      } catch (e) {}
    }

    if (matches.length === 0) return;

    if (matches.length === 1) {
      // Single match — complete it
      var completed = path.join(dir, matches[0]) + path.sep;
      text = completed;
      showingPlaceholder = false;
      clearHint();
      redrawInput();
    } else {
      // Multiple matches — find longest common prefix and show candidates
      var common = matches[0];
      for (var m = 1; m < matches.length; m++) {
        var k = 0;
        while (k < common.length && k < matches[m].length && common.charAt(k) === matches[m].charAt(k)) k++;
        common = common.substring(0, k);
      }

      if (common.length > partial.length) {
        // Extend to common prefix
        text = path.join(dir, common);
        showingPlaceholder = false;
      }

      // Show candidates as hint
      var display = matches.slice(0, 6).join("  ");
      if (matches.length > 6) display += "  " + a.dim + "+" + (matches.length - 6) + " more" + a.reset;
      showHint(display);
    }
  }

  process.stdin.on("data", function onText(ch) {
    if (ch === "\r" || ch === "\n") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onText);
      var result = text || placeholder;
      clearHint();
      process.stdout.write("\n");
      clearUp(2);
      log(sym.done + "  " + title + " " + a.dim + "·" + a.reset + " " + result);
      callback(result);
    } else if (ch === "\x1b" || ch === "\x03") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onText);
      clearHint();
      process.stdout.write("\n");
      clearUp(2);
      if (ch === "\x03") {
        log(sym.end + "  " + a.dim + "Cancelled" + a.reset);
        process.exit(0);
      }
      callback(null);
    } else if (ch === "\t") {
      if (showingPlaceholder) {
        // Accept placeholder first
        text = placeholder;
        showingPlaceholder = false;
        redrawInput();
      }
      tabComplete();
    } else if (ch === "\x7f" || ch === "\b") {
      if (text.length > 0) {
        text = text.slice(0, -1);
        clearHint();
        if (text.length === 0) {
          // Re-show placeholder
          showingPlaceholder = true;
          process.stdout.write("\x1b[2K\r" + prefix + a.dim + placeholder + a.reset);
          process.stdout.write("\r" + prefix);
        } else {
          redrawInput();
        }
      }
    } else if (ch >= " ") {
      if (showingPlaceholder) {
        showingPlaceholder = false;
      }
      clearHint();
      text += ch;
      redrawInput();
    }
  });
}

/**
 * Select menu: arrow keys to navigate, enter to select.
 * items: [{ label, value, desc? }]
 */
function promptSelect(title, items, callback, opts) {
  var idx = 0;
  // Build hotkeys map: { key: handler }
  var hotkeys = {};
  if (opts && opts.key && opts.onKey) {
    hotkeys[opts.key] = opts.onKey;
  }
  if (opts && opts.keys) {
    for (var ki = 0; ki < opts.keys.length; ki++) {
      hotkeys[opts.keys[ki].key] = opts.keys[ki].onKey;
    }
  }
  var hintLines = null;
  if (opts && opts.hint) {
    hintLines = Array.isArray(opts.hint) ? opts.hint : [opts.hint];
  }

  function render() {
    var out = "";
    for (var i = 0; i < items.length; i++) {
      var prefix = i === idx
        ? a.green + a.bold + "  ● " + a.reset
        : a.dim + "  ○ " + a.reset;
      out += "  " + sym.bar + prefix + items[i].label + "\n";
    }
    return out;
  }

  log(sym.pointer + "  " + a.bold + title + a.reset);
  process.stdout.write(render());

  // Render hint lines below the menu tree
  var hintBoxLines = 0;
  if (hintLines) {
    log(sym.end);
    for (var h = 0; h < hintLines.length; h++) {
      log("   " + gradient(hintLines[h]));
    }
    hintBoxLines = 1 + hintLines.length;  // sym.end + lines
  }

  var lineCount = items.length + 1 + hintBoxLines;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", function onSelect(ch) {
    if (ch === "\x1b[A") { // up
      if (idx > 0) idx--;
    } else if (ch === "\x1b[B") { // down
      if (idx < items.length - 1) idx++;
    } else if (ch === "\r" || ch === "\n") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onSelect);
      clearUp(lineCount);
      log(sym.done + "  " + title + " " + a.dim + "·" + a.reset + " " + items[idx].label);
      callback(items[idx].value);
      return;
    } else if (ch === "\x03") {
      process.stdout.write("\n");
      process.exit(0);
    } else if (hotkeys[ch]) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onSelect);
      clearUp(lineCount);
      hotkeys[ch]();
      return;
    } else if (ch === "\x7f" || ch === "\b") {
      // Backspace — trigger "back" if available
      for (var bi = 0; bi < items.length; bi++) {
        if (items[bi].value === "back") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onSelect);
          clearUp(lineCount);
          log(sym.done + "  " + title + " " + a.dim + "·" + a.reset + " " + items[bi].label);
          callback("back");
          return;
        }
      }
      return;
    } else {
      return;
    }
    // Redraw
    clearUp(items.length + hintBoxLines);
    process.stdout.write(render());
    // Re-render hint lines
    if (hintLines) {
      log(sym.end);
      for (var rh = 0; rh < hintLines.length; rh++) {
        log("   " + gradient(hintLines[rh]));
      }
    }
  });
}

/**
 * Multi-select menu: space to toggle, enter to confirm.
 * items: [{ label, value, checked? }]
 * callback(selectedValues[])
 */
function promptMultiSelect(title, items, callback) {
  var selected = [];
  for (var si = 0; si < items.length; si++) {
    selected.push(items[si].checked !== false);
  }
  var idx = 0;

  function render() {
    var out = "";
    for (var i = 0; i < items.length; i++) {
      var cursor = i === idx ? a.indigo + ">" + a.reset : " ";
      var check = selected[i]
        ? a.green + a.bold + "■" + a.reset
        : a.dim + "□" + a.reset;
      out += "  " + sym.bar + " " + cursor + " " + check + " " + items[i].label + "\n";
    }
    out += "  " + sym.bar + "  " + a.dim + "space: toggle · enter: confirm" + a.reset + "\n";
    return out;
  }

  log(sym.pointer + "  " + a.bold + title + a.reset);
  process.stdout.write(render());

  var lineCount = items.length + 2; // title + items + hint

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", function onMulti(ch) {
    if (ch === "\x1b[A") { // up
      if (idx > 0) idx--;
    } else if (ch === "\x1b[B") { // down
      if (idx < items.length - 1) idx++;
    } else if (ch === " ") { // toggle
      selected[idx] = !selected[idx];
    } else if (ch === "a" || ch === "A") { // toggle all
      var allSelected = selected.every(function (s) { return s; });
      for (var ai = 0; ai < selected.length; ai++) selected[ai] = !allSelected;
    } else if (ch === "\r" || ch === "\n") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onMulti);
      clearUp(lineCount);
      var result = [];
      var labels = [];
      for (var ri = 0; ri < items.length; ri++) {
        if (selected[ri]) {
          result.push(items[ri].value);
          labels.push(items[ri].label);
        }
      }
      var summary = result.length === items.length
        ? "All (" + result.length + ")"
        : result.length + " of " + items.length;
      log(sym.done + "  " + title + " " + a.dim + "·" + a.reset + " " + summary);
      callback(result);
      return;
    } else if (ch === "\x03") {
      process.stdout.write("\n");
      process.exit(0);
    } else if (ch === "\x1b") {
      // Escape — select none
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onMulti);
      clearUp(lineCount);
      log(sym.done + "  " + title + " " + a.dim + "· Skipped" + a.reset);
      callback([]);
      return;
    } else {
      return;
    }
    // Redraw
    clearUp(items.length + 1); // items + hint (not title)
    process.stdout.write(render());
  });
}

module.exports = {
  isBasicTerm: isBasicTerm,
  a: a,
  gradient: gradient,
  sym: sym,
  log: log,
  clearUp: clearUp,
  printLogo: printLogo,
  promptToggle: promptToggle,
  promptPin: promptPin,
  promptText: promptText,
  promptSelect: promptSelect,
  promptMultiSelect: promptMultiSelect,
};
