// idle-adapter-reaper.js - gives back the agent runtimes an adapter keeps
// running while nothing uses them (the Codex adapter keeps one app-server per
// environment). The daemon ticks this on a timer; each project context
// exposes reclaimIdleAdapters, which reaches its own adapters, so the timer
// never needs to know how a project holds them.

/**
 * Ends the idle runtimes of every adapter in the map that can report them.
 * @param {object} adapters  vendor -> adapter, as a project context holds them
 * @param {number} idleMs    how long a runtime must have been quiet
 * @returns {Promise<boolean>} true when at least one runtime was ended
 */
function reclaimIdleAdapters(adapters, idleMs) {
  var pending = [];
  Object.keys(adapters || {}).forEach(function (vendor) {
    var adapter = adapters[vendor];
    if (adapter && typeof adapter.shutdownIfIdle === "function") {
      pending.push(Promise.resolve(adapter.shutdownIfIdle(idleMs)));
    }
  });
  return Promise.all(pending).then(function (results) {
    return results.some(Boolean);
  });
}

/**
 * One reaper tick over every project of a relay.
 * @param {{forEachProject: function}} relay
 * @param {number} idleMs
 * @returns {Promise<void>} settles when every project has been looked at
 */
function reapIdleAdapters(relay, idleMs) {
  if (!relay || typeof relay.forEachProject !== "function") return Promise.resolve();
  var pending = [];
  relay.forEachProject(function (ctx, slug) {
    if (!ctx || typeof ctx.reclaimIdleAdapters !== "function") return;
    var reclaimed;
    try {
      reclaimed = ctx.reclaimIdleAdapters(idleMs);
    } catch (e) {
      console.error("[daemon] Idle runtime reclaim failed for " + (slug || "a project") + ":", e && e.message ? e.message : e);
      return;
    }
    pending.push(Promise.resolve(reclaimed).catch(function (e) {
      console.error("[daemon] Idle runtime reclaim failed for " + (slug || "a project") + ":", e && e.message ? e.message : e);
    }));
  });
  return Promise.all(pending).then(function () {});
}

/**
 * Starts the periodic tick. The timer does not keep the process alive.
 * @param {function(): object} getRelay  the relay may not exist yet at first tick
 * @param {{idleMs: number, intervalMs: number}} options
 * @returns {function(): void} stop
 */
function startIdleAdapterReaper(getRelay, options) {
  var handle = setInterval(function () {
    reapIdleAdapters(getRelay(), options.idleMs);
  }, options.intervalMs);
  if (handle && typeof handle.unref === "function") handle.unref();
  return function stop() {
    clearInterval(handle);
  };
}

module.exports = {
  reclaimIdleAdapters: reclaimIdleAdapters,
  reapIdleAdapters: reapIdleAdapters,
  startIdleAdapterReaper: startIdleAdapterReaper,
};
