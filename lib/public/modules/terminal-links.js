// Link detection for the console terminal, kept free of DOM and app imports so
// it can be unit-tested against a fake xterm buffer.
//
// xterm's WebLinksAddon only sees one row. This provider rebuilds "logical
// lines" and detects URLs that span rows in two cases:
//   1. soft wrap: xterm marked the continuation row isWrapped.
//   2. hard wrap: a program printed the URL itself across rows, so xterm did
//      not mark isWrapped. Joined only when the row is full to the last column
//      and ends inside a URL, and the next row is nothing but URL text: one
//      whitespace-free token, with only padding after it.
//
// Remaining ambiguity: a real newline right after a URL that ends exactly at
// the last column, followed by a single-token line (for example "Done"), looks
// the same as a hard wrap and is joined. A following line with more than one
// word is never joined.

var URL_CHAR_CLASS = "[^\\s'\"\\]>)}{]";
var URL_RE_SOURCE = "https?:\\/\\/" + URL_CHAR_CLASS + "+";
var URL_AT_ROW_END_RE = new RegExp(URL_RE_SOURCE + "$");
var URL_CONTINUATION_RE = new RegExp("^" + URL_CHAR_CLASS + "+$");

function rowText(buffer, y, trimRight) {
  var line = buffer.getLine(y);
  return line ? line.translateToString(trimRight) : null;
}

// A URL longer than this many rows is cut here: joining stops and the row past
// the bound is treated as not continued. Far above any sign-in URL, and it
// keeps every lookup linear in a fixed window instead of in buffer length.
export var MAX_LINK_ROWS = 64;

// Row y fills to the last column and row y+1 is URL text alone, not marked as
// a soft-wrapped row. Looks at two rows only.
function hardWrapCandidate(buffer, y, cols) {
  var next = buffer.getLine(y + 1);
  if (!next || next.isWrapped) return false;
  var text = rowText(buffer, y, false);
  if (text === null || text.length < cols) return false;
  var nextText = rowText(buffer, y + 1, true);
  return nextText !== null && URL_CONTINUATION_RE.test(nextText);
}

// hard[i] is true when row lo+i continues onto the next row by a hard wrap.
// One forward pass: a row qualifies when it ends in a URL, or when it is one
// full-width token continuing a hard wrap from the row above. The row before
// lo is assumed not to continue, which is the cut at the bound.
function hardWrapFlags(buffer, lo, hi, cols) {
  var flags = [];
  var prev = false;
  for (var y = lo; y <= hi; y++) {
    var flag = false;
    if (hardWrapCandidate(buffer, y, cols)) {
      var text = rowText(buffer, y, false);
      var token = text.match(/\S+$/);
      flag = !!token && (URL_AT_ROW_END_RE.test(text) || (token[0].length === cols && prev));
    }
    flags.push(flag);
    prev = flag;
  }
  return flags;
}

function getLogicalLine(buffer, y, cols) {
  var lo = Math.max(0, y - MAX_LINK_ROWS);
  var hi = Math.min(buffer.length - 1, y + MAX_LINK_ROWS);
  var hard = hardWrapFlags(buffer, lo, hi, cols);

  var startY = y;
  while (startY > lo && y - startY < MAX_LINK_ROWS - 1) {
    var line = buffer.getLine(startY);
    if (!line) break;
    if (!line.isWrapped && !hard[startY - 1 - lo]) break;
    startY--;
  }

  var endY = startY;
  while (endY < hi && endY - startY < MAX_LINK_ROWS - 1) {
    var next = buffer.getLine(endY + 1);
    if (!next || !(next.isWrapped || hard[endY - lo])) break;
    endY++;
  }

  var text = "";
  var rowOffsets = []; // { y, startOffset, length }
  for (var row = startY; row <= endY; row++) {
    var t = rowText(buffer, row, row === endY); // trim trailing spaces on the last row only
    if (t === null) break;
    rowOffsets.push({ y: row, startOffset: text.length, length: t.length });
    text += t;
  }

  return { text: text, startY: startY, endY: endY, rowOffsets: rowOffsets };
}

function offsetToBufferPos(rowOffsets, offset) {
  for (var i = 0; i < rowOffsets.length; i++) {
    var ro = rowOffsets[i];
    if (offset < ro.startOffset + ro.length) {
      return { x: offset - ro.startOffset + 1, y: ro.y + 1 }; // 1-based
    }
  }
  var last = rowOffsets[rowOffsets.length - 1];
  return { x: last.length + 1, y: last.y + 1 };
}

// Every URL in the logical line that crosses a row boundary.
function findMultiRowUrls(logical) {
  var re = new RegExp(URL_RE_SOURCE, "g");
  var found = [];
  var match;
  while ((match = re.exec(logical.text)) !== null) {
    var start = offsetToBufferPos(logical.rowOffsets, match.index);
    var end = offsetToBufferPos(logical.rowOffsets, match.index + match[0].length - 1);
    if (start.y !== end.y) found.push({ url: match[0], start: start, end: end });
  }
  return found;
}

// opts.onHover(url) / opts.onLeave() let the owner remember the link under
// the pointer, for a copy-link action.
export function createMultiLineLinkProvider(xterm, opts) {
  opts = opts || {};
  return {
    provideLinks: function (y, callback) {
      var buffer = xterm.buffer.active;
      var bufferY = y - 1; // provideLinks is 1-based
      var logical = getLogicalLine(buffer, bufferY, xterm.cols);

      if (logical.startY === logical.endY || bufferY !== logical.startY) {
        callback(undefined);
        return;
      }

      var links = findMultiRowUrls(logical).map(function (hit) {
        return {
          range: { start: hit.start, end: hit.end },
          text: hit.url,
          activate: function () {
            window.open(hit.url, "_blank", "noopener");
          },
          hover: function () {
            if (opts.onHover) opts.onHover(hit.url);
          },
          leave: function () {
            if (opts.onLeave) opts.onLeave();
          },
        };
      });

      callback(links.length > 0 ? links : undefined);
    },
  };
}

// getSelection() joins rows with a newline. When the whole selection sits
// inside one multi-row URL, return the selected part of the URL with the row
// breaks removed; otherwise return the selection unchanged.
export function copyTextForSelection(xterm, selection) {
  if (!selection || !/[\r\n]/.test(selection)) return selection;
  var pos = xterm.getSelectionPosition && xterm.getSelectionPosition();
  if (!pos) return selection;
  var buffer = xterm.buffer.active;
  var logical = getLogicalLine(buffer, pos.start.y, xterm.cols);
  if (logical.endY < pos.end.y) return selection;
  var joined = selection.replace(/[\r\n]+/g, "");
  var urls = findMultiRowUrls(logical);
  for (var i = 0; i < urls.length; i++) {
    var hit = urls[i];
    if (pos.start.y >= hit.start.y - 1 && pos.end.y <= hit.end.y - 1 &&
        hit.url.indexOf(joined) !== -1) {
      return joined;
    }
  }
  return selection;
}
