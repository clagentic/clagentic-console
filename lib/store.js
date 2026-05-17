/**
 * store.js — async JSON persistence with per-file write serialization.
 *
 * Provides two call patterns:
 *   readJson(name, defaultValue)         — name is bare filename, resolved against CONFIG_DIR
 *   writeJson(name, value, opts)         — same resolution; writes are queued per name
 *
 *   readJsonAt(fullPath, defaultValue)   — full path variant for per-project state
 *   writeJsonAt(fullPath, value, opts)   — same; queued per resolved path
 *
 * Writes are atomic: data goes to {path}.tmp.{pid}, then renamed to {path}.
 * After rename, chmod is applied (default 0o600).
 * Concurrent writes to the same name/path are serialized in call order.
 * Concurrent writes to different names/paths are independent.
 */

"use strict";

var fs = require("fs");
var path = require("path");
var { CONFIG_DIR } = require("./config");

// --- Per-path write queues ---
// Key: resolved absolute path. Value: Promise (tail of the chain).
var _queues = new Map();

function _enqueue(resolvedPath, fn) {
  var tail = _queues.get(resolvedPath) || Promise.resolve();
  var next = tail.then(fn, fn); // always advance the chain even if fn rejects
  _queues.set(resolvedPath, next);
  // Clean up the map entry once the chain reaches this point so the Map
  // doesn't grow unboundedly for one-shot paths.
  next.then(function () {
    if (_queues.get(resolvedPath) === next) _queues.delete(resolvedPath);
  }, function () {
    if (_queues.get(resolvedPath) === next) _queues.delete(resolvedPath);
  });
  return next;
}

// --- Core I/O ---

function _read(resolvedPath, defaultValue) {
  return fs.promises.readFile(resolvedPath, "utf8").then(function (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      process.stderr.write("[store] Warning: corrupt JSON at " + resolvedPath + " — returning default\n");
      return defaultValue;
    }
  }, function (err) {
    if (err.code === "ENOENT") return defaultValue;
    throw err;
  });
}

function _write(resolvedPath, value, mode) {
  var tmpPath = resolvedPath + ".tmp." + process.pid;
  var json;
  try {
    json = JSON.stringify(value, null, 2);
  } catch (e) {
    return Promise.reject(new Error("[store] Cannot serialize value for " + resolvedPath + ": " + e.message));
  }
  return fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true })
    .then(function () {
      return fs.promises.writeFile(tmpPath, json, { encoding: "utf8" });
    })
    .then(function () {
      return fs.promises.rename(tmpPath, resolvedPath);
    })
    .then(function () {
      if (process.platform === "win32") return;
      return fs.promises.chmod(resolvedPath, mode).catch(function () {});
    })
    .catch(function (err) {
      // Best-effort cleanup of tmp file on failure
      fs.promises.unlink(tmpPath).catch(function () {});
      throw err;
    });
}

// --- Public API ---

/**
 * Read a named JSON store from CONFIG_DIR.
 * @param {string} name - Bare filename, e.g. "users.json"
 * @param {*} defaultValue - Returned when file is missing or contains corrupt JSON
 */
function readJson(name, defaultValue) {
  if (defaultValue === undefined) defaultValue = {};
  var resolvedPath = path.join(CONFIG_DIR, name);
  return _read(resolvedPath, defaultValue);
}

/**
 * Write a named JSON store to CONFIG_DIR atomically.
 * Serializes concurrent writes to the same name in call order.
 * @param {string} name - Bare filename, e.g. "users.json"
 * @param {*} value - JSON-serializable value
 * @param {object} [opts]
 * @param {number} [opts.mode=0o600] - File permission mode after write
 */
function writeJson(name, value, opts) {
  var mode = (opts && opts.mode !== undefined) ? opts.mode : 0o600;
  var resolvedPath = path.join(CONFIG_DIR, name);
  return _enqueue(resolvedPath, function () {
    return _write(resolvedPath, value, mode);
  });
}

/**
 * Read JSON from an arbitrary full path (for per-project state files).
 * @param {string} fullPath - Absolute path to the JSON file
 * @param {*} defaultValue - Returned when file is missing or contains corrupt JSON
 */
function readJsonAt(fullPath, defaultValue) {
  if (defaultValue === undefined) defaultValue = {};
  return _read(fullPath, defaultValue);
}

/**
 * Write JSON to an arbitrary full path atomically.
 * Serializes concurrent writes to the same path in call order.
 * @param {string} fullPath - Absolute path to the JSON file
 * @param {*} value - JSON-serializable value
 * @param {object} [opts]
 * @param {number} [opts.mode=0o600] - File permission mode after write
 */
function writeJsonAt(fullPath, value, opts) {
  var mode = (opts && opts.mode !== undefined) ? opts.mode : 0o600;
  return _enqueue(fullPath, function () {
    return _write(fullPath, value, mode);
  });
}

module.exports = { readJson: readJson, writeJson: writeJson, readJsonAt: readJsonAt, writeJsonAt: writeJsonAt };
