// Codex local_image temp-file helper (lr-de04)
// ---------------------------------------------
// The Codex app-server protocol accepts image input only as a `localImage`
// turn item (`{ type: "localImage", path: "..." }`) — it does not accept
// inline base64 data the way the Claude adapter does. This module writes an
// incoming base64 image to an unpredictably-named temp file so the codex.js
// adapter can reference it by path, and removes those files once the codex
// process no longer needs them (end of turn / end of query).
//
// Kept separate from codex.js (which is already large) so the write/cleanup
// logic is independently testable without spinning up an app-server.

var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");

var EXT_BY_MEDIA_TYPE = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function extForMediaType(mediaType) {
  return EXT_BY_MEDIA_TYPE[mediaType] || ".png";
}

// Per-process scratch dir for Codex local_image temp files. Deliberately not
// the persistent, HTTP-served chat-images dir (lib/project-image.js) — these
// files exist only for the lifetime of a single turn/query and are never
// served to the browser.
function defaultTempDir() {
  return path.join(os.tmpdir(), "clagentic-codex-images-" + process.pid);
}

// Writes one base64 image to an unpredictably-named temp file.
// Returns the absolute path, or null if the write failed (caller decides
// how to surface that — see codex.js pushMessage, which must not silently
// drop the image on write failure either).
function writeTempImage(mediaType, base64Data, tempDir) {
  var dir = tempDir || defaultTempDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return null;
  }
  var randomName = crypto.randomBytes(16).toString("hex") + extForMediaType(mediaType);
  var filePath = path.join(dir, randomName);
  try {
    fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"), { mode: 0o600 });
    return filePath;
  } catch (e) {
    return null;
  }
}

// Best-effort delete; never throws. Missing files are not an error (the
// caller may race a cleanup against process teardown).
function removeTempImage(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (e) {}
}

function removeTempImages(filePaths) {
  if (!filePaths) return;
  for (var i = 0; i < filePaths.length; i++) {
    removeTempImage(filePaths[i]);
  }
}

module.exports = {
  defaultTempDir: defaultTempDir,
  writeTempImage: writeTempImage,
  removeTempImage: removeTempImage,
  removeTempImages: removeTempImages,
};
