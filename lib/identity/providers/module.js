"use strict";

// A user-supplied provider (for example a client of a workload identity API),
// named by identity.provider_module as an absolute path. The module exports an
// object, or a function returning one, with:
//
//   name                                   recorded on the session; plain name
//   obtainSession(definition, origin, rt, ctx)
//       returns { dir, assertion? } or a typed unavailability
//       (ctx.unavailable(code, reason, { quiet? })). `dir` is an absolute
//       directory laid out as the contract's section 6 says, either one the
//       module made or one it got from ctx.allocateDir(); `assertion`, when
//       given, is written into it as identity.jwt.
//   release(info)                          optional, called at most once when the
//       session ends; the console does not wait for it. A directory from
//       ctx.allocateDir() is removed by the console; a directory the module
//       made is the module's, and the console removes nothing in it (end it in
//       release()).
//
// ctx: { allocateDir(): string, owner: { uid, gid } | null,
//        signal: AbortSignal, unavailable(code, reason, options): object }
//
// The module runs with the console's authority: it is code the person running the
// console chose, in the same way as the rest of the console's configuration.

var path = require("path");
var url = require("url");
var contract = require("../contract");
var unavailableModule = require("../unavailable");

var unavailable = unavailableModule.unavailable;

var RESERVED_NAMES = Object.keys(contract.PROVIDERS).map(function (k) { return contract.PROVIDERS[k]; });
var DEFAULT_NAME = "module";

async function loadModule(modulePath) {
  var loaded = await import(url.pathToFileURL(path.normalize(modulePath)).href);
  var exported = loaded.default !== undefined ? loaded.default : loaded;
  if (typeof exported === "function") exported = await exported();
  if (!exported || typeof exported.obtainSession !== "function") {
    throw new Error("the module does not export obtainSession");
  }
  return exported;
}

function createModuleProvider(cfg, deps) {
  var warn = (deps && deps.warn) || console.warn;
  var loading = null;

  function load() {
    if (!loading) {
      loading = loadModule(cfg.modulePath).catch(function (err) {
        loading = null;
        warn("[identity] provider module could not be loaded: " + (err && err.message));
        return null;
      });
    }
    return loading;
  }

  // A reserved name would let a module pass its own sessions off as ones a
  // built-in provider vouched for.
  function nameOf(mod) {
    var name = mod.name;
    if (!contract.matches(contract.NAME_PATTERN, name) || RESERVED_NAMES.indexOf(name) !== -1) {
      return DEFAULT_NAME;
    }
    return name;
  }

  async function obtainSession(definition, origin, rt, ctx) {
    var mod = await load();
    if (!mod) return unavailable("module_load_failed", "the identity provider module could not be loaded");
    var result;
    try {
      result = await mod.obtainSession(definition, origin, rt, ctx);
    } catch (err) {
      warn("[identity] provider module failed: " + (err && err.message));
      return unavailable("provider_error", "the identity provider module failed");
    }
    if (unavailableModule.isUnavailable(result)) return unavailable(result.code, result.reason, { quiet: result.quiet });
    if (!result || typeof result.dir !== "string") {
      return unavailable("provider_result_invalid", "the identity provider module returned no directory");
    }
    return { provider: nameOf(mod), dir: result.dir, assertion: result.assertion };
  }

  function release(info) {
    return load().then(function (mod) {
      if (mod && typeof mod.release === "function") return mod.release(info);
      return undefined;
    });
  }

  return { name: DEFAULT_NAME, obtainSession: obtainSession, release: release };
}

module.exports = { createModuleProvider: createModuleProvider };
