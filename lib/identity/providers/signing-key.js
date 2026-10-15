"use strict";

// The console's own signing key and the key set it publishes, for the jwks-self
// provider. The key is an Ed25519 key in a PKCS#8 PEM file; the public half is
// published as a JWKS document (contract section 5.2: no private parameters).

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var joseLoader = require("../jose");

var ALG = "EdDSA";

function keyError(code, message) {
  var err = new Error(message);
  err.identityCode = code;
  return err;
}

function readPrivateKey(keyPath) {
  var fd;
  try {
    fd = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw keyError("key_unreadable", "the identity signing key could not be opened");
  }
  try {
    var st = fs.fstatSync(fd);
    if (!st.isFile()) throw keyError("key_unsafe", "the identity signing key is not a regular file");
    if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
      throw keyError("key_unsafe", "the identity signing key must be owned by the console user and private to it");
    }
    return crypto.createPrivateKey(fs.readFileSync(fd, "utf8"));
  } catch (e) {
    if (e.identityCode) throw e;
    throw keyError("key_unreadable", "the identity signing key could not be read as a PEM private key");
  } finally {
    fs.closeSync(fd);
  }
}

var PEER_READ_ATTEMPTS = 10;
var PEER_READ_WAIT_MS = 20;

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A peer that won the exclusive create may still be writing: its file is read
// again a few times before it is called unreadable.
function readPeerKey(keyPath) {
  for (var attempt = 1; ; attempt++) {
    try {
      var key = readPrivateKey(keyPath);
      if (key) return key;
    } catch (e) {
      if (e.identityCode !== "key_unreadable" || attempt >= PEER_READ_ATTEMPTS) throw e;
    }
    if (attempt >= PEER_READ_ATTEMPTS) throw keyError("key_unreadable", "the identity signing key could not be read");
    waitSync(PEER_READ_WAIT_MS);
  }
}

// Creates the key when no file is there and returns the key that is in the file
// afterwards: when another process created it first, that process's key.
function createKeyIfAbsent(keyPath) {
  var pair = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    // The file is created private (mode at creation, exclusive) so the key is
    // never readable by anyone else, even for an instant.
    fs.writeFileSync(keyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return readPeerKey(keyPath);
  }
  return pair.privateKey;
}

function requireEd25519(key) {
  if (key.asymmetricKeyType !== "ed25519") {
    throw keyError("key_unsupported", "the identity signing key must be an Ed25519 key");
  }
}

// Writes the JWKS only when its content changed, atomically, readable by others
// (a verifier under another user reads it) and writable by the console only.
function publishJwks(jwksPath, jwks) {
  var text = JSON.stringify(jwks, null, 2) + "\n";
  try {
    if (fs.readFileSync(jwksPath, "utf8") === text) return;
  } catch (e) {
    // Not published yet, or unreadable: written below.
  }
  fs.mkdirSync(path.dirname(jwksPath), { recursive: true, mode: 0o755 });
  var staging = jwksPath + ".tmp-" + process.pid;
  fs.writeFileSync(staging, text, { flag: "w", mode: 0o644 });
  fs.renameSync(staging, jwksPath);
}

// Loads (and, for the default location, creates) the key, publishes its JWKS and
// returns what signing needs.
async function loadSigner(cfg) {
  var privateKey = readPrivateKey(cfg.signingKey);
  if (!privateKey) {
    if (!cfg.generateKey) throw keyError("key_missing", "the identity signing key does not exist");
    privateKey = createKeyIfAbsent(cfg.signingKey);
  }
  requireEd25519(privateKey);
  var jose = await joseLoader.loadJose();
  var jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  var kid = await jose.calculateJwkThumbprint(jwk);
  publishJwks(cfg.jwksPath, { keys: [Object.assign({}, jwk, { kid: kid, alg: ALG, use: "sig" })] });
  return { privateKey: privateKey, kid: kid, alg: ALG, jose: jose };
}

module.exports = { loadSigner: loadSigner, createKeyIfAbsent: createKeyIfAbsent, ALG: ALG };
