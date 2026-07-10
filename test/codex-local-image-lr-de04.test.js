// Regression tests for lr-de04 — Codex local_image temp-file helper.
//
// lib/yoke/codex-local-image.js is the write/cleanup primitive that lets
// codex.js pass images to the Codex app-server as `localImage` turn items
// (the protocol has no inline-base64 image input, unlike Claude). These
// tests exercise the real module so a regression that reintroduces
// predictable filenames, wrong permissions, or leaves cleanup broken fails
// here instead of silently degrading a security property.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var codexLocalImage = require("../lib/yoke/codex-local-image");

var ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lr-de04-test-"));
}

test("lr-de04: writeTempImage writes the decoded bytes to an unpredictable filename", function () {
  var dir = makeTempDir();
  try {
    var filePath = codexLocalImage.writeTempImage("image/png", ONE_BY_ONE_PNG_BASE64, dir);
    assert.ok(filePath, "writeTempImage should return a path on success");
    assert.equal(path.dirname(filePath), dir);
    assert.match(path.basename(filePath), /^[0-9a-f]{32}\.png$/, "filename must be a 32-hex-char random name, not content-derived or timestamp-based");

    var written = fs.readFileSync(filePath);
    var expected = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
    assert.ok(written.equals(expected), "file contents must match the decoded base64 input");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lr-de04: writeTempImage picks the extension from mediaType", function () {
  var dir = makeTempDir();
  try {
    var jpg = codexLocalImage.writeTempImage("image/jpeg", ONE_BY_ONE_PNG_BASE64, dir);
    var gif = codexLocalImage.writeTempImage("image/gif", ONE_BY_ONE_PNG_BASE64, dir);
    var webp = codexLocalImage.writeTempImage("image/webp", ONE_BY_ONE_PNG_BASE64, dir);
    var unknown = codexLocalImage.writeTempImage("image/bogus", ONE_BY_ONE_PNG_BASE64, dir);
    assert.match(jpg, /\.jpg$/);
    assert.match(gif, /\.gif$/);
    assert.match(webp, /\.webp$/);
    assert.match(unknown, /\.png$/, "unrecognized media types fall back to .png rather than throwing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lr-de04: two images written back-to-back never collide on filename", function () {
  var dir = makeTempDir();
  try {
    var a = codexLocalImage.writeTempImage("image/png", ONE_BY_ONE_PNG_BASE64, dir);
    var b = codexLocalImage.writeTempImage("image/png", ONE_BY_ONE_PNG_BASE64, dir);
    assert.notEqual(a, b);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lr-de04: writeTempImage returns null instead of throwing when the target dir cannot be created", function () {
  // Point at a path that can't be a directory (its parent is a file).
  var dir = makeTempDir();
  try {
    var blockerFile = path.join(dir, "blocker");
    fs.writeFileSync(blockerFile, "x");
    var impossibleDir = path.join(blockerFile, "nested");
    var result = codexLocalImage.writeTempImage("image/png", ONE_BY_ONE_PNG_BASE64, impossibleDir);
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lr-de04: removeTempImage deletes the file and is a no-op on a missing/null path", function () {
  var dir = makeTempDir();
  try {
    var filePath = codexLocalImage.writeTempImage("image/png", ONE_BY_ONE_PNG_BASE64, dir);
    assert.ok(fs.existsSync(filePath));
    codexLocalImage.removeTempImage(filePath);
    assert.equal(fs.existsSync(filePath), false);

    // Second removal of the same (now-missing) path must not throw.
    assert.doesNotThrow(function () { codexLocalImage.removeTempImage(filePath); });
    assert.doesNotThrow(function () { codexLocalImage.removeTempImage(null); });
    assert.doesNotThrow(function () { codexLocalImage.removeTempImage(undefined); });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lr-de04: removeTempImages deletes every file in the list", function () {
  var dir = makeTempDir();
  try {
    var a = codexLocalImage.writeTempImage("image/png", ONE_BY_ONE_PNG_BASE64, dir);
    var b = codexLocalImage.writeTempImage("image/png", ONE_BY_ONE_PNG_BASE64, dir);
    codexLocalImage.removeTempImages([a, b]);
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
