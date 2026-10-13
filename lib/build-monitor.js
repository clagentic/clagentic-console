'use strict';

// build-monitor.js — turns repeated build assessments into at most one
// announcement per genuinely stale installed build.
//
// It only reports. Nothing here restarts anything; the one actuator is the
// operator's confirmed click handled in lib/build-update-restart.js.
//
// Two guards keep the signal honest:
//  - A stale verdict must be seen for the same installed build on
//    `confirmations` consecutive checks before it is announced, so a poll that
//    lands in the middle of an install (files half-replaced) never offers a
//    restart for a build that is not there yet.
//  - An adopted verdict clears the announcement, so a later genuine update is
//    announced again.

var DEFAULT_CONFIRMATIONS = 2;
// A confirmed stale build is repeated in the journal at this many checks, so a
// reader of the log sees it without it filling the log every minute.
var DEFAULT_REMINDER_EVERY = 30;

/**
 * @param {object} o
 * @param {function(): object} o.assess — returns an assessBuild() result
 * @param {function(object): void} o.onStale — first confirmed stale verdict for an installed build
 * @param {function(): void} [o.onAdopted] — the condition cleared after an announcement
 * @param {function(string): void} [o.log]
 * @param {number} [o.confirmations]
 * @param {number} [o.reminderEvery]
 */
function createBuildMonitor(o) {
  var confirmations = o.confirmations > 0 ? o.confirmations : DEFAULT_CONFIRMATIONS;
  var reminderEvery = o.reminderEvery > 0 ? o.reminderEvery : DEFAULT_REMINDER_EVERY;
  var log = typeof o.log === 'function' ? o.log : function () {};

  var pendingKey = null;
  var seen = 0;
  var announcedKey = null;
  var sinceAnnounce = 0;
  var lastInconclusive = null;
  var current = null;

  function keyOf(a) { return a.installedBuildSha + ':' + a.installedContentHash; }

  function check() {
    var a = o.assess();
    current = a;

    if (a.state === 'inconclusive') {
      // Unknown is not stale: keep what was announced and say so once per reason.
      if (lastInconclusive !== a.reason) {
        lastInconclusive = a.reason;
        log('Build check inconclusive (' + a.reason + '): ' + a.detail);
      }
      return a;
    }
    lastInconclusive = null;

    if (a.state === 'adopted') {
      pendingKey = null;
      seen = 0;
      if (announcedKey !== null) {
        announcedKey = null;
        sinceAnnounce = 0;
        if (typeof o.onAdopted === 'function') o.onAdopted();
      }
      return a;
    }

    var key = keyOf(a);
    if (key !== pendingKey) {
      pendingKey = key;
      seen = 1;
    } else {
      seen += 1;
    }
    if (seen < confirmations) return a;

    if (announcedKey !== key) {
      announcedKey = key;
      sinceAnnounce = 0;
      o.onStale(a);
    } else {
      sinceAnnounce += 1;
      if (sinceAnnounce % reminderEvery === 0) {
        log('Still serving build ' + a.loadedBuildSha + '; build ' + a.installedBuildSha +
          ' is installed. The Clagentic: Console UI offers the restart.');
      }
    }
    return a;
  }

  return {
    check: check,
    /** The last assessment, or null before the first check. */
    current: function () { return current; },
    /** True once a stale installed build has been confirmed and announced. */
    isConfirmedStale: function () { return announcedKey !== null; },
  };
}

module.exports = { createBuildMonitor: createBuildMonitor, DEFAULT_CONFIRMATIONS: DEFAULT_CONFIRMATIONS };
