'use strict';

// build-monitor.js — turns repeated build assessments into a confirmed verdict
// and the journal lines that go with it.
//
// It only observes and logs. It does not talk to clients and it does not know
// whether an offer is shown: the offer is derived from `confirmedStale()` by
// lib/build-update-standing.js after every poll. Nothing here restarts anything;
// the one actuator is the operator's confirmed click handled in
// lib/build-update-restart.js.
//
// Rules:
//  - A stale verdict must be seen for the same installed build on
//    `confirmations` consecutive checks before it is confirmed, so a poll that
//    lands in the middle of an install (files half-replaced) never offers a
//    restart for a build that is not there yet.
//  - An inconclusive poll always breaks a streak that is not yet confirmed,
//    even while an older build stays confirmed. It never touches the confirmed
//    verdict: it neither clears it nor counts toward a reminder.
//  - An adopted verdict clears the confirmation.
//  - The journal gets a warning when a streak is first confirmed and a reminder
//    every `reminderEvery` stale checks for the same build, from a counter of
//    its own.

var DEFAULT_CONFIRMATIONS = 2;
// A confirmed stale build is repeated in the journal at this many checks, so a
// reader of the log sees it without it filling the log every minute.
var DEFAULT_REMINDER_EVERY = 30;

/**
 * @param {object} o
 * @param {function(): object} o.assess — returns an assessBuild() result
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
  var confirmedKey = null;
  var confirmed = null;
  var sinceConfirm = 0;
  var lastInconclusive = null;
  var current = null;

  function keyOf(a) { return a.installedBuildSha + ':' + a.installedContentHash; }

  function check() {
    var a = o.assess();
    current = a;

    if (a.state === 'inconclusive') {
      // Unknown is not stale and not adopted. Samples on either side of it are
      // not consecutive evidence, so the unconfirmed candidate is always dropped.
      // The confirmed verdict and its reminder counter are not touched.
      pendingKey = null;
      seen = 0;
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
      if (confirmedKey !== null) {
        confirmedKey = null;
        confirmed = null;
        sinceConfirm = 0;
        log('The installed build is the one this process loaded.');
      }
      return a;
    }

    var key = keyOf(a);
    if (key === confirmedKey) {
      // Still the confirmed build: keep its latest assessment and count a reminder.
      pendingKey = key;
      seen = confirmations;
      confirmed = a;
      sinceConfirm += 1;
      if (sinceConfirm % reminderEvery === 0) {
        log('Still serving build ' + a.loadedBuildSha + '; build ' + a.installedBuildSha +
          ' is installed. The Clagentic: Console UI offers the restart.');
      }
      return a;
    }

    if (key !== pendingKey) {
      pendingKey = key;
      seen = 1;
    } else {
      seen += 1;
    }
    if (seen >= confirmations) {
      confirmedKey = key;
      confirmed = a;
      sinceConfirm = 0;
      log('WARNING: this process is serving STALE code: ' + a.detail + '.');
      log('WARNING: restarting is your decision. Use "Restart to apply update" in the Clagentic: Console UI, or restart the service yourself.');
    }
    return a;
  }

  return {
    check: check,
    /** The last assessment, or null before the first check. */
    current: function () { return current; },
    /**
     * The confirmed stale assessment, or null when none is confirmed. This is
     * the desired offer state: it survives inconclusive polls and is replaced
     * only by adoption or by another confirmed stale build.
     */
    confirmedStale: function () { return confirmed; },
  };
}

module.exports = { createBuildMonitor: createBuildMonitor, DEFAULT_CONFIRMATIONS: DEFAULT_CONFIRMATIONS };
