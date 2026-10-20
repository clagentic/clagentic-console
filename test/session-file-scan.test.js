"use strict";
// The bounded reverse scan of a session file: newest match wins, lines split
// across chunk boundaries are whole, the meta line is never offered, and a file
// far larger than one chunk is read without being held.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { findNewestEntry } = require("../lib/session-file-scan");

function withFile(lines, fn) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-filescan-"));
  try {
    var file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function isMarked(e) { return e.marked === true; }

test("a file many times larger than one chunk: the newest match is found, offering only what lies after it", function () {
  var lines = [JSON.stringify({ type: "meta", marked: true })];
  lines.push(JSON.stringify({ type: "x", marked: true, id: "old" }));
  lines.push(JSON.stringify({ type: "x", marked: true, id: "newest" }));
  for (var i = 0; i < 4000; i++) lines.push(JSON.stringify({ type: "filler", text: "f".repeat(100) + i }));
  var offered = 0;
  withFile(lines, function (file) {
    assert.ok(fs.statSync(file).size > 400 * 1024);
    var hit = findNewestEntry(file, function (e) { offered++; return isMarked(e); }, 4096);
    assert.equal(hit.id, "newest");
  });
  assert.equal(offered, 4001, "stopped at the newest match; older entries and the meta line were not offered");
});

test("a line longer than a chunk, with multibyte text over the boundaries, parses whole", function () {
  var long = "é世".repeat(5000);
  var lines = [JSON.stringify({ type: "meta" }), JSON.stringify({ type: "x", marked: true, text: long }), JSON.stringify({ type: "tail", text: "t" })];
  withFile(lines, function (file) {
    for (var size = 1; size <= 4097; size += 1024) {
      var hit = findNewestEntry(file, isMarked, size);
      assert.equal(hit.text, long, "chunk " + size);
    }
  });
});

test("the meta line is never offered, a non-JSON line is skipped, and no match gives null", function () {
  var lines = [JSON.stringify({ type: "meta", marked: true }), "not json", JSON.stringify({ type: "x" })];
  withFile(lines, function (file) {
    assert.equal(findNewestEntry(file, isMarked, 8), null);
  });
});

test("a missing file throws for the caller to decide", function () {
  assert.throws(function () { findNewestEntry(path.join(os.tmpdir(), "clagentic-no-such-file.jsonl"), isMarked); });
});
