'use strict';

// build-update-standing.js — the one standing "newer build installed" offer.
//
// It holds what late-connecting clients are shown, and keeps it equal to the
// CURRENT assessment. While the build is genuinely stale an actionable offer is
// always visible:
//  - the offer is shown at once, with its change list marked unavailable, and
//    refreshed in place when the read succeeds; a slow, failed or rejected read
//    never removes or withholds the restart action;
//  - announcing the same loaded/installed build again keeps the standing offer
//    and only refreshes it;
//  - it is retracted only when the build is adopted or another build is stale.
// It announces and retracts; it never restarts anything (that is
// lib/build-update-restart.js, on a confirmed click).

var SOURCE = 'build-update';

var READING = 'the change list is still being read';
var READ_FAILED = 'the change list could not be read';

function unavailable(reason) {
  return { available: false, commits: [], truncated: false, reason: reason };
}

function keyOf(a) {
  return a.loadedBuildSha + ':' + a.installedBuildSha + ':' + a.installedContentHash;
}

/**
 * @param {object} o
 * @param {function(object): Promise<object>} o.listChanges — ({fromSha, toSha}) -> changes
 * @param {function(object, object): object} o.compose — (assessment, changes) -> diagnostic message
 * @param {function(object): void} o.broadcast — sends a message to every connected client
 * @param {function(): ?object} o.currentAssessment — the latest assessment, or null
 * @param {function(string): void} [o.log]
 */
function createStandingOffer(o) {
  var log = typeof o.log === 'function' ? o.log : function () {};
  // {key, diagnostic, listed, abandoned} while an offer is standing.
  var shown = null;
  // Bumped on every announcement and every withdrawal. A change-list result
  // belongs to the generation that asked for it and is dropped otherwise.
  var generation = 0;

  function retractIfShown() {
    if (shown === null) return;
    shown = null;
    o.broadcast({ type: 'diagnostic_retract', source: SOURCE });
  }

  function stillCurrent(announced) {
    var now = o.currentAssessment();
    return !!now && now.state === 'stale' && keyOf(now) === keyOf(announced);
  }

  function readChanges(a) {
    // A synchronous throw from the reader is a failed read like a rejection.
    try {
      return Promise.resolve(o.listChanges({ fromSha: a.loadedBuildSha, toSha: a.installedBuildSha }));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** Show the offer for `a` with `changes`, in place of any offer for the same build. */
  function show(a, changes, refresh) {
    var message = o.compose(a, changes);
    shown = { key: keyOf(a), diagnostic: message, listed: !!(changes && changes.available), abandoned: false };
    // `refresh` tells a client to update the entry it holds instead of adding a
    // second one, and not to bring back one the operator dismissed. The stored
    // copy, replayed to a client that connects later, is a plain diagnostic.
    o.broadcast(refresh ? Object.assign({}, message, { refresh: true }) : message);
  }

  /** A stale verdict was confirmed for `assessment`. */
  function announce(assessment) {
    var asked = ++generation;
    var key = keyOf(assessment);
    if (shown !== null && shown.key !== key) retractIfShown(); // an offer for another build is no longer true
    if (shown === null) show(assessment, unavailable(READING));
    else shown.abandoned = false; // a fresh read is in flight for the standing offer

    return readChanges(assessment).then(function (changes) {
      if (asked !== generation) return; // superseded by a newer announcement or a withdrawal
      if (!stillCurrent(assessment)) {
        // The offer stays (unknown is not adopted), but its change list was not
        // applied; flag it so the next stale confirmation refreshes it.
        if (shown !== null && shown.key === key) shown.abandoned = true;
        log('Discarded a change list for the build-update offer: the verdict moved while it was read.');
        return;
      }
      show(assessment, changes, true);
    }, function (err) {
      if (asked !== generation) return;
      log('Could not read the changes for the build-update offer: ' + (err && err.message ? err.message : err));
      if (!stillCurrent(assessment)) {
        if (shown !== null && shown.key === key) shown.abandoned = true;
        return;
      }
      // Keep a change list already shown; otherwise say why there is none.
      if (shown !== null && shown.key === key && shown.listed) return;
      show(assessment, unavailable(READ_FAILED), true);
    });
  }

  /** The installed build is the loaded one again: nothing is left to offer. */
  function withdraw() {
    generation += 1;
    shown = null;
    // Sent even when no standing offer exists: a client may still hold the
    // confirmation offer that one click produced.
    o.broadcast({ type: 'diagnostic_retract', source: SOURCE });
  }

  return {
    announce: announce,
    withdraw: withdraw,
    /** True while a complete, non-abandoned offer for this assessment's build is shown. */
    isShownFor: function (a) { return shown !== null && shown.key === keyOf(a) && !shown.abandoned; },
    /** What a client that connects now should be shown, or null. */
    current: function () { return shown === null ? null : shown.diagnostic; },
  };
}

module.exports = { createStandingOffer: createStandingOffer, SOURCE: SOURCE };
