"use strict";

// The one owner of everything a single begin() call yields (lib/identity/index.js).
//
// A provider may create directories through the console (ctx.allocateDir), create
// its own, or answer late or never. Whatever it does, every way the call can end
// goes through this object, and the invariant is kept in one place:
//
//   - A directory the console created is removed at once, whatever the provider
//     does or does not answer. Nothing waits on a provider's promise.
//   - A directory the provider created is the provider's: the console never
//     removes, unlinks or traverses anything in it. It ends through the provider's
//     release and otherwise the issuer's own reaper.
//   - The provider's release is called at most once for the session it yielded,
//     after the removal above, and is never awaited: it is advisory and bounded.
//
// States: open -> abandoned (the console stopped waiting: new directories are
// refused and the ones made are removed) -> ended (the session, if any, was
// settled). end() is settle-once; abandon() may precede it.

var delivery = require("./delivery");

var RELEASE_TIMEOUT_MS = 10000;

// options: { provider, spawnRoot, warn, releaseTimeoutMs }
function createHolder(options) {
  var made = new Set();
  var abandoned = false;
  var ended = false;
  var releaseTimeoutMs = options.releaseTimeoutMs > 0 ? options.releaseTimeoutMs : RELEASE_TIMEOUT_MS;

  function allocateDir() {
    if (abandoned || ended) throw new Error("the console no longer waits for this identity session");
    var dir = delivery.allocateDir(options.spawnRoot);
    made.add(dir);
    return dir;
  }

  function removeMade() {
    made.forEach(function (dir) { delivery.removeDelivery(dir, process.getuid()); });
  }

  // Asks the provider to end the session, without waiting for it. A release that
  // throws, rejects or hangs only produces a warning.
  function callRelease(session) {
    if (typeof options.provider.release !== "function") return;
    var timer;
    var limit = new Promise(function (resolve) {
      timer = setTimeout(function () {
        options.warn("[identity] provider release did not finish in time");
        resolve();
      }, releaseTimeoutMs);
      if (timer.unref) timer.unref();
    });
    var call = Promise.resolve().then(function () {
      return options.provider.release({ provider: session.provider, dir: session.dir });
    });
    Promise.race([call, limit])
      .catch(function (err) { options.warn("[identity] provider release failed: " + (err && err.message)); })
      .then(function () { clearTimeout(timer); });
  }

  // The console stops waiting for the provider.
  function abandon() {
    abandoned = true;
    removeMade();
  }

  // Ends the call: `session` is what the provider yielded, or null when it yielded
  // nothing (it was unavailable, failed, or answered nothing usable).
  function end(session) {
    if (ended) return;
    ended = true;
    removeMade();
    if (!session) return;
    callRelease(session);
  }

  return {
    allocateDir: allocateDir,
    abandon: abandon,
    end: end,
    isAbandoned: function () { return abandoned; },
  };
}

module.exports = { createHolder: createHolder };
