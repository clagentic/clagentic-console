"use strict";

// The server's handle on the modules it shares with the browser: the answer
// codecs (ask-user-codec.js, elicitation-codec.js) and the own-key lookups.
// Each has one source, the ES module the browser is served from
// lib/public/modules/prompt-kinds/; the package.json beside them declares
// them ES modules, so every supported Node loads them as such.
//
// load() runs once, when the prompt registry is first required. Where Node
// can require() an ES module it does, so the codecs are in before any
// caller of the registry runs. Where it cannot (Node before 20.19 / 22.12),
// load() imports the same files with import(), and the daemon awaits it
// before it accepts a connection. Either way a codec that fails to load
// rejects load(), and a codec read before load() has finished throws: no
// prompt is opened or answered without one.

var path = require("path");
var { pathToFileURL } = require("url");

var SOURCE_DIR = path.join(__dirname, "..", "public", "modules", "prompt-kinds");
var FILES = {
  askUser: "ask-user-codec.js",
  elicitation: "elicitation-codec.js",
  ownKey: "own-key.js",
};
var NAMES = Object.keys(FILES);
// How a Node that cannot require() these modules refuses; they then load
// through import().
var NEEDS_IMPORT = ["ERR_REQUIRE_ESM", "ERR_REQUIRE_ASYNC_MODULE"];

var modules = null;
var loading = null;

function sourcePath(name) {
  return path.join(SOURCE_DIR, FILES[name]);
}

/** The file: URL of a shared module, as import() resolves it. */
function sourceUrl(name) {
  return pathToFileURL(sourcePath(name)).href;
}

function keep(loaded) {
  var out = {};
  NAMES.forEach(function (name, i) { out[name] = loaded[i]; });
  modules = out;
  return out;
}

function failure(err) {
  return new Error("prompt codecs could not be loaded from " + SOURCE_DIR + ": " + ((err && err.message) || err), { cause: err });
}

function loadOnce() {
  try {
    return Promise.resolve(keep(NAMES.map(function (name) { return require(sourcePath(name)); })));
  } catch (err) {
    if (NEEDS_IMPORT.indexOf(err && err.code) === -1) return Promise.reject(failure(err));
  }
  return Promise.all(NAMES.map(function (name) { return import(sourceUrl(name)); })).then(keep, function (err) {
    throw failure(err);
  });
}

/**
 * Load every shared module, once. Resolves to {askUser, elicitation,
 * ownKey}; rejects, naming the directory, when any of them fails to load.
 * @returns {Promise<object>}
 */
function load() {
  if (!loading) loading = loadOnce();
  return loading;
}

function loaded(name) {
  if (!modules) throw new Error("prompt codec " + FILES[name] + " used before load() finished");
  return modules[name];
}

function askUser() { return loaded("askUser"); }
function elicitation() { return loaded("elicitation"); }
function ownKey() { return loaded("ownKey"); }

// The own-key lookups, called through so a caller can take them by name.
function hasOwnKey(map, key) { return ownKey().hasOwnKey(map, key); }
function ownValue(map, key) { return ownKey().ownValue(map, key); }
function putOwn(map, key, value) { return ownKey().putOwn(map, key, value); }

module.exports = {
  load: load,
  sourceUrl: sourceUrl,
  askUser: askUser,
  elicitation: elicitation,
  ownKey: ownKey,
  hasOwnKey: hasOwnKey,
  ownValue: ownValue,
  putOwn: putOwn,
};
