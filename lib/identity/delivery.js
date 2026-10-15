"use strict";

// The local delivery directory of the Identity Assertion contract (section 6):
//
//   <dir>/            mode 0700, owned by the holder's user
//     identity.jwt    the assertion, one compact JWS, a regular file
//     tmp/            scratch for the holder
//
// This module creates such a directory, writes the assertion into it, checks a
// directory a provider handed back before the console passes it on, and removes
// it when the session ends. It never follows a symlink and never removes a path
// it did not check first.

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var contract = require("./contract");

var NAME_PATTERN = /^cc-[0-9a-f]{32}$/;
// A directory this old cannot hold a valid assertion any more (twelve hours of
// lifetime plus an hour of slack), so it is an orphan of a crashed process.
var STALE_MS = (contract.MAX_LIFETIME_SECONDS + 3600) * 1000;

var swept = new Set();

function deliveryError(code, message) {
  var err = new Error(message);
  err.identityCode = code;
  return err;
}

function supported() {
  return process.platform !== "win32" && typeof process.getuid === "function";
}

function ensureRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw deliveryError("spawn_root_invalid", "the identity spawn root is not an absolute path");
  }
  // Traversable by other users so a session running as another OS user can reach
  // its own 0700 directory beneath it; listing is owner-only.
  fs.mkdirSync(root, { recursive: true, mode: 0o711 });
  var st = fs.lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw deliveryError("spawn_root_invalid", "the identity spawn root is not a directory");
  }
  if (st.uid !== process.getuid()) {
    throw deliveryError("spawn_root_invalid", "the identity spawn root is not owned by the console user");
  }
  if (st.mode & 0o022) {
    throw deliveryError("spawn_root_invalid", "the identity spawn root is writable by group or other");
  }
}

function sweepStale(root) {
  if (swept.has(root)) return;
  swept.add(root);
  var names;
  try { names = fs.readdirSync(root); } catch (e) { return; }
  var cutoff = Date.now() - STALE_MS;
  names.forEach(function (name) {
    if (!NAME_PATTERN.test(name)) return;
    var full = path.join(root, name);
    try {
      var st = fs.lstatSync(full);
      if (st.isDirectory() && st.mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
    } catch (e) {
      // An orphan that cannot be removed now is tried again on the next start.
    }
  });
}

// Creates an empty delivery directory under root. `owner` is { uid, gid } of the
// user the session runs as; absent or equal to the console's own user, the
// directory stays with the console.
function allocateDir(root, owner) {
  ensureRoot(root);
  sweepStale(root);
  var dir = path.join(root, "cc-" + crypto.randomBytes(16).toString("hex"));
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    var tmp = path.join(dir, contract.IDENTITY_TMP_DIR);
    fs.mkdirSync(tmp, { mode: 0o700 });
    if (owner && owner.uid !== process.getuid()) {
      fs.chownSync(dir, owner.uid, owner.gid);
      fs.chownSync(tmp, owner.uid, owner.gid);
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw deliveryError("spawn_dir_failed", "the identity directory could not be created");
  }
  return dir;
}

// Writes the assertion as identity.jwt: into tmp first, then renamed over, so a
// reader never sees a partial file.
function writeAssertion(dir, token, owner) {
  if (typeof token !== "string" || Buffer.byteLength(token) > contract.MAX_FILE_BYTES) {
    throw deliveryError("assertion_invalid", "the assertion is missing or larger than the contract allows");
  }
  var staging = path.join(dir, contract.IDENTITY_TMP_DIR, "w-" + crypto.randomBytes(8).toString("hex"));
  fs.writeFileSync(staging, token, { flag: "wx", mode: 0o600 });
  if (owner && owner.uid !== process.getuid()) fs.chownSync(staging, owner.uid, owner.gid);
  fs.renameSync(staging, path.join(dir, contract.IDENTITY_FILE));
}

function decodeClaims(token) {
  var parts = token.split(".");
  if (parts.length !== 3 || parts.some(function (p) { return !p; })) return null;
  try {
    var claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch (e) {
    return null;
  }
}

// The delivery checks a consumer makes (contract section 6), plus the shape of
// the claims the console records. The console is not the verifier: it does not
// check the signature, it refuses only a directory or file no consumer could
// accept. Returns the claims, or throws an error carrying `identityCode`.
function inspect(dir, expectedUid) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw deliveryError("delivery_invalid", "the provider's directory is not an absolute path");
  }
  var st;
  try { st = fs.lstatSync(dir); } catch (e) {
    throw deliveryError("delivery_invalid", "the provider's directory does not exist");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw deliveryError("delivery_invalid", "the provider's directory is a link or not a directory");
  }
  if (st.uid !== expectedUid || (st.mode & 0o077) !== 0) {
    throw deliveryError("delivery_invalid", "the provider's directory is not private to the session's user");
  }
  var fd;
  try {
    fd = fs.openSync(path.join(dir, contract.IDENTITY_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    throw deliveryError("delivery_invalid", "the provider left no readable assertion file");
  }
  var content;
  try {
    var fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.size > contract.MAX_FILE_BYTES) {
      throw deliveryError("delivery_invalid", "the assertion file is not a regular file within the size limit");
    }
    content = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  var claims = decodeClaims(content.replace(/\n$/, ""));
  if (!claims) throw deliveryError("assertion_invalid", "the assertion is not a compact JWS with a JSON claim set");
  if (claims.cia !== contract.CONTRACT_MAJOR) {
    throw deliveryError("assertion_invalid", "the assertion is not of a contract version the console supports");
  }
  if (typeof claims.dir !== "string" || path.normalize(claims.dir) !== path.normalize(dir)) {
    throw deliveryError("assertion_invalid", "the assertion is not bound to its delivery directory");
  }
  if (contract.GRADES.indexOf(claims.grade) === -1 || contract.ORIGINS.indexOf(claims.origin) === -1) {
    throw deliveryError("assertion_invalid", "the assertion carries an unknown grade or origin");
  }
  if (!Number.isInteger(claims.exp) || claims.exp * 1000 <= Date.now()) {
    throw deliveryError("assertion_invalid", "the assertion has already expired");
  }
  return claims;
}

// Removes a delivery directory at the end of a session. A directory the console
// created itself is removed on its name and ownership; one a provider created is
// removed only when it still holds an assertion, so a wrong path is never taken
// for one. Never throws.
function removeDelivery(dir, expectedUid, consoleCreated) {
  try {
    if (typeof dir !== "string" || !path.isAbsolute(dir) || path.dirname(dir) === path.parse(dir).root) return false;
    var st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== expectedUid) return false;
    if (consoleCreated ? !NAME_PATTERN.test(path.basename(dir)) : !fs.lstatSync(path.join(dir, contract.IDENTITY_FILE)).isFile()) {
      return false;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  supported: supported,
  allocateDir: allocateDir,
  writeAssertion: writeAssertion,
  inspect: inspect,
  removeDelivery: removeDelivery,
  decodeClaims: decodeClaims,
};
