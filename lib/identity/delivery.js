"use strict";

// The local delivery directory of the Identity Assertion contract (section 6):
//
//   <dir>/            mode 0700, owned by the holder's user
//     identity.jwt    the assertion, one compact JWS, a regular file
//     tmp/            scratch for the holder
//
// This module creates such a directory, writes the assertion into it, checks a
// directory a provider handed back before the console passes it on, and removes
// the directories it created itself when the session ends. It never follows a
// symlink and never removes, unlinks or traverses anything it did not create: a
// directory a provider made is the provider's, and ends through its release.
//
// The console may run privileged, and a directory it created for another user is
// chowned to that user, who can then change its content. The console therefore
// never walks such a tree itself: the content is removed by a child process that
// runs as that user, and the console only rmdirs the then-empty directory (which
// sits in the console's own root, writable by nobody else) without recursion.

var fs = require("fs");
var childProcess = require("child_process");
var path = require("path");
var crypto = require("crypto");
var contract = require("./contract");

var NAME_PATTERN = /^cc-[0-9a-f]{32}$/;
var BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
// A directory this old cannot hold a valid assertion any more (twelve hours of
// lifetime plus an hour of slack), so it is an orphan of a crashed process.
var STALE_MS = (contract.MAX_LIFETIME_SECONDS + 3600) * 1000;

var REMOVE_TIMEOUT_MS = 10000;
// Runs inside the child, as the directory's owner: empties dir, leaves dir itself.
var EMPTY_DIR_SCRIPT = [
  "var fs = require('fs'), path = require('path');",
  "var dir = process.argv[1];",
  "fs.readdirSync(dir).forEach(function (n) { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); });",
].join(" ");

var swept = new Set();

function deliveryError(code, message) {
  var err = new Error(message);
  err.identityCode = code;
  return err;
}

function supported() {
  return process.platform !== "win32" && typeof process.getuid === "function";
}

// `owner` is the session's { uid, gid }. When it is another user than the console,
// that user must be able to traverse the root to reach its own directory beneath
// it, whatever the umask that created the root or the mode it already has.
function ensureRoot(root, owner) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw deliveryError("spawn_root_invalid", "the identity spawn root is not an absolute path");
  }
  // Traversable by other users; listing is owner-only. The mode is passed through
  // the umask, so it is enforced below rather than trusted here.
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
  if (owner && owner.uid !== process.getuid() && (st.mode & 0o001) === 0) {
    // Only a root the console owns is changed (checked above); a root it does not
    // own was refused before reaching this line.
    fs.chmodSync(root, (st.mode & 0o7777) | 0o001);
  }
}

function sweepStale(root, spawner) {
  if (swept.has(root)) return;
  swept.add(root);
  var names;
  try { names = fs.readdirSync(root); } catch (e) { return; }
  var cutoff = Date.now() - STALE_MS;
  names.forEach(function (name) {
    if (!contract.matches(NAME_PATTERN, name)) return;
    var full = path.join(root, name);
    try {
      var st = fs.lstatSync(full);
      if (st.isDirectory() && st.mtimeMs < cutoff) removeOwnDir(full, spawner);
    } catch (e) {
      // An orphan that cannot be removed now is tried again on the next start.
    }
  });
}

// Creates an empty delivery directory under root. `owner` is { uid, gid } of the
// user the session runs as; absent or equal to the console's own user, the
// directory stays with the console.
function allocateDir(root, owner, spawner) {
  ensureRoot(root, owner);
  sweepStale(root, spawner);
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
    try { removeOwnDir(dir, spawner); } catch (cleanupError) {
      // What cannot be removed now is an orphan the next start's sweep retries.
    }
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

// One segment of a compact JWS: unpadded base64url. Node's decoder is lenient
// (it skips characters it does not know), so the syntax is checked first.
function isBase64UrlSegment(segment) {
  return contract.matches(BASE64URL_PATTERN, segment) && segment.length % 4 !== 1;
}

function decodeClaims(token) {
  var parts = token.split(".");
  if (parts.length !== 3 || !parts.every(isBase64UrlSegment)) return null;
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
    // O_NONBLOCK so a FIFO planted at this name fails the regular-file check below
    // instead of blocking the open (and the daemon's event loop) until a writer appears.
    fd = fs.openSync(
      path.join(dir, contract.IDENTITY_FILE),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
  } catch (e) {
    throw deliveryError("delivery_invalid", "the provider left no readable assertion file");
  }
  var content;
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw deliveryError("delivery_invalid", "the assertion file is not a regular file within the size limit");
    }
    // The size is not trusted: the file's owner can enlarge it after any check,
    // so at most one byte more than the limit is ever read, and one more is refused.
    var buffer = Buffer.alloc(contract.MAX_FILE_BYTES + 1);
    var filled = 0;
    var n;
    do {
      n = fs.readSync(fd, buffer, filled, buffer.length - filled, null);
      filled += n;
    } while (n > 0 && filled < buffer.length);
    if (filled > contract.MAX_FILE_BYTES) {
      throw deliveryError("delivery_invalid", "the assertion file is not a regular file within the size limit");
    }
    content = buffer.toString("utf8", 0, filled);
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

// Removes a directory the console created under its own spawn root. Owned by the
// console's user, nobody else could put anything in it, so it goes whole. Owned by
// another user (chowned for the session), its content is theirs to change: it is
// emptied by a child running as that user, and the console rmdirs the empty
// directory only, never recursively. One that cannot be emptied that way is left
// for the next sweep. The spawner is injectable for tests.
function removeOwnDir(dir, spawner) {
  var st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  if (st.uid === process.getuid()) {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
  var run = spawner || childProcess.spawnSync;
  var result = run(process.execPath, ["-e", EMPTY_DIR_SCRIPT, dir], {
    uid: st.uid,
    gid: st.gid,
    timeout: REMOVE_TIMEOUT_MS,
    stdio: "ignore",
    // The console's working directory and environment mean nothing to the owner and
    // may not be reachable by them.
    cwd: path.parse(dir).root,
    env: {},
  });
  if (!result || result.error || result.status !== 0) return false;
  try {
    fs.rmdirSync(dir);
  } catch (e) {
    if (e.code === "ENOTEMPTY" || e.code === "EEXIST") return false;
    throw e;
  }
  return true;
}

// Removes a delivery directory the console created, at the end of a session, on its
// name and its owner. Anything else is not the console's and is never touched.
// Never throws.
function removeDelivery(dir, expectedUid, spawner) {
  try {
    if (typeof dir !== "string" || !path.isAbsolute(dir) || path.dirname(dir) === path.parse(dir).root) return false;
    if (!contract.matches(NAME_PATTERN, path.basename(dir))) return false;
    var st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== expectedUid) return false;
    return removeOwnDir(dir, spawner);
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
