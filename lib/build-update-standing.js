'use strict';

// build-update-standing.js — the one standing "newer build installed" offer.
//
// It holds what late-connecting clients are shown, and keeps it equal to the
// CURRENT assessment: an offer is announced only while the build it names is
// still the stale one, and is retracted from every client the moment the
// installed build is adopted or replaced. It announces and retracts; it never
// restarts anything (that is lib/build-update-restart.js, on a confirmed click).

var SOURCE = 'build-update';

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
  var diagnostic = null;
  // Bumped on every announcement and every withdrawal. A change-list result
  // belongs to the generation that asked for it and is dropped otherwise.
  var generation = 0;

  function retractIfShown() {
    if (diagnostic === null) return;
    diagnostic = null;
    o.broadcast({ type: 'diagnostic_retract', source: SOURCE });
  }

  function stillCurrent(asked, announced) {
    if (asked !== generation) return false;
    var now = o.currentAssessment();
    return !!now && now.state === 'stale'
      && now.loadedBuildSha === announced.loadedBuildSha
      && now.installedBuildSha === announced.installedBuildSha
      && now.installedContentHash === announced.installedContentHash;
  }

  /** A stale verdict was confirmed for `assessment`. */
  function announce(assessment) {
    var asked = ++generation;
    retractIfShown(); // an offer for another installed build is no longer true
    return o.listChanges({ fromSha: assessment.loadedBuildSha, toSha: assessment.installedBuildSha }).then(function (changes) {
      if (!stillCurrent(asked, assessment)) {
        log('Discarded a build-update offer: the installed build changed while its change list was read.');
        return;
      }
      diagnostic = o.compose(assessment, changes);
      o.broadcast(diagnostic);
    });
  }

  /** The installed build is the loaded one again: nothing is left to offer. */
  function withdraw() {
    generation += 1;
    diagnostic = null;
    // Sent even when no standing offer exists: a client may still hold the
    // confirmation offer that one click produced.
    o.broadcast({ type: 'diagnostic_retract', source: SOURCE });
  }

  return {
    announce: announce,
    withdraw: withdraw,
    /** What a client that connects now should be shown, or null. */
    current: function () { return diagnostic; },
  };
}

module.exports = { createStandingOffer: createStandingOffer, SOURCE: SOURCE };
