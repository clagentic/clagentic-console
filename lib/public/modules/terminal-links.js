// Link detection for the console terminal, kept free of DOM and app imports so
// it can be unit-tested against a fake xterm buffer.
//
// xterm's WebLinksAddon only sees one row. This provider rebuilds "logical
// lines" and detects URLs that span rows in two cases:
//   1. soft wrap: xterm marked the continuation row isWrapped.
//   2. hard wrap: a program printed the URL itself across rows, so xterm did
//      not mark isWrapped. Joined only when the row is full to the last column
//      and ends inside a URL, and the next row starts with a non-space char.

var URL_CHAR_CLASS = "[^\\s'\"\\]>)}{]";
var URL_RE_SOURCE = "https?:\\/\\/" + URL_CHAR_CLASS + "+";
var URL_AT_ROW_END_RE = new RegExp(URL_RE_SOURCE + "$");
var URL_CHAR_RE = new RegExp("^" + URL_CHAR_CLASS);

function rowText(buffer, y, trimRight) {
  var line = buffer.getLine(y);
  return line ? line.translateToString(trimRight) : null;
}

// The row's last token is a URL (has a scheme), or the whole row is one token
// continuing a URL that was itself hard-wrapped from the row above.
function rowEndsInsideUrl(buffer, y, text, cols) {
  var token = text.match(/\S+$/);
  if (!token) return false;
  if (URL_AT_ROW_END_RE.test(text)) return true;
  return token[0].length === cols && y > 0 && isHardWrapped(buffer, y - 1, cols);
}

// True when row y fills to the last column inside a URL and row y+1 continues
// it without being marked as a soft-wrapped row.
function isHardWrapped(buffer, y, cols) {
  var next = buffer.getLine(y + 1);
  if (!next || next.isWrapped) return false;
  var text = rowText(buffer, y, false);
  if (text === null || text.length < cols) return false;
  if (!rowEndsInsideUrl(buffer, y, text, cols)) return false;
  var nextText = rowText(buffer, y + 1, false);
  return nextText !== null && URL_CHAR_RE.test(nextText.charAt(0));
}

function continuesOnNextRow(buffer, y, cols) {
  var next = buffer.getLine(y + 1);
  if (!next) return false;
  return next.isWrapped || isHardWrapped(buffer, y, cols);
}

function getLogicalLine(buffer, y, cols) {
  var startY = y;
  while (startY > 0) {
    var line = buffer.getLine(startY);
    if (!line) break;
    if (!line.isWrapped && !isHardWrapped(buffer, startY - 1, cols)) break;
    startY--;
  }

  var endY = startY;
  while (endY < buffer.length - 1 && continuesOnNextRow(buffer, endY, cols)) {
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
