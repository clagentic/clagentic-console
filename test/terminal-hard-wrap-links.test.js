"use strict";
// Link detection for URLs that a program hard-wraps at the last column
// (rows not marked isWrapped), plus the unchanged soft-wrap path.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");

var MOD_URL = pathToFileURL(
  path.join(__dirname, "..", "lib", "public", "modules", "terminal-links.js")
).href;

var COLS = 20;
var URL_TEXT = "https://example.test/oauth/authorize?code=abcdefghij&state=xyz";

// rows: [{ text, wrapped }]; text is padded to COLS like a real buffer row.
function fakeXterm(rows, selection) {
  var lines = rows.map(function (r) {
    return {
      isWrapped: !!r.wrapped,
      translateToString: function (trim) {
        var t = r.text;
        if (!trim) t = t + " ".repeat(Math.max(0, COLS - t.length));
        else t = t.replace(/\s+$/, "");
        return t;
      },
    };
  });
  return {
    cols: COLS,
    buffer: { active: { length: lines.length, getLine: function (y) { return lines[y]; } } },
    getSelectionPosition: function () { return selection; },
  };
}

function chunk(text, wrapped) {
  var out = [];
  for (var i = 0; i < text.length; i += COLS) {
    out.push({ text: text.slice(i, i + COLS), wrapped: wrapped && i > 0 });
  }
  return out;
}

function linksAt(mod, xterm, y) {
  var got;
  mod.createMultiLineLinkProvider(xterm).provideLinks(y, function (l) { got = l; });
  return got;
}

test("hard-wrapped URL (no isWrapped) is one link covering every row", async function () {
  var mod = await import(MOD_URL);
  var rows = [{ text: "Visit:" }].concat(chunk(URL_TEXT, false));
  var links = linksAt(mod, fakeXterm(rows), 2);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, URL_TEXT);
  assert.equal(links[0].range.start.y, 2);
  assert.equal(links[0].range.end.y, 1 + Math.ceil(URL_TEXT.length / COLS));
  assert.ok(!/[\s]/.test(links[0].text));
});

test("hard-wrapped URL is found from the row that starts it, not continuation rows", async function () {
  var mod = await import(MOD_URL);
  var xterm = fakeXterm(chunk(URL_TEXT, false));
  assert.ok(linksAt(mod, xterm, 1));
  assert.equal(linksAt(mod, xterm, 2), undefined);
});

test("a URL that ends before the last column is not joined", async function () {
  var mod = await import(MOD_URL);
  var xterm = fakeXterm([{ text: "https://short.test" }, { text: "next line text" }]);
  assert.equal(linksAt(mod, xterm, 1), undefined);
});

test("a full row ending in a URL followed by an indented row is not joined", async function () {
  var mod = await import(MOD_URL);
  var xterm = fakeXterm([{ text: "https://example.test/ab".slice(0, COLS) }, { text: "  indented text" }]);
  assert.equal(linksAt(mod, xterm, 1), undefined);
});

test("a full row of plain text is not joined to the next row", async function () {
  var mod = await import(MOD_URL);
  var xterm = fakeXterm([{ text: "x".repeat(COLS) }, { text: "yyyy" }]);
  assert.equal(linksAt(mod, xterm, 1), undefined);
});

test("soft-wrapped URL still yields one link", async function () {
  var mod = await import(MOD_URL);
  var links = linksAt(mod, fakeXterm(chunk(URL_TEXT, true)), 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, URL_TEXT);
});

test("soft-wrapped URL ending before the last column on a short row is unchanged", async function () {
  var mod = await import(MOD_URL);
  var rows = [{ text: "see https://example." }, { text: "test/x", wrapped: true }];
  var links = linksAt(mod, fakeXterm(rows), 1);
  assert.equal(links[0].text, "https://example.test/x");
});

test("hover and leave report the link to the owner", async function () {
  var mod = await import(MOD_URL);
  var seen = [];
  var provider = mod.createMultiLineLinkProvider(fakeXterm(chunk(URL_TEXT, false)), {
    onHover: function (u) { seen.push(u); },
    onLeave: function () { seen.push(null); },
  });
  var links;
  provider.provideLinks(1, function (l) { links = l; });
  links[0].hover();
  links[0].leave();
  assert.deepEqual(seen, [URL_TEXT, null]);
});

test("copy of a selection inside a hard-wrapped URL has no newline or space", async function () {
  var mod = await import(MOD_URL);
  var rows = chunk(URL_TEXT, false);
  var xterm = fakeXterm(rows, { start: { x: 0, y: 0 }, end: { x: 8, y: rows.length - 1 } });
  var selection = rows.map(function (r) { return r.text; }).join("\n");
  assert.equal(mod.copyTextForSelection(xterm, selection), URL_TEXT);
});

test("copy of a selection that is not inside a URL keeps its newlines", async function () {
  var mod = await import(MOD_URL);
  var rows = [{ text: "first line" }, { text: "second line" }];
  var xterm = fakeXterm(rows, { start: { x: 0, y: 0 }, end: { x: 5, y: 1 } });
  assert.equal(mod.copyTextForSelection(xterm, "first line\nsecond line"), "first line\nsecond line");
});

test("copy of a single-row selection is returned unchanged", async function () {
  var mod = await import(MOD_URL);
  assert.equal(mod.copyTextForSelection(fakeXterm([{ text: "abc" }]), "abc"), "abc");
});
