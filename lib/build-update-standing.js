'use strict';

// build-update-standing.js — the one standing "newer build installed" offer.
//
// The offer is level-triggered. After every build poll the daemon calls
// reconcile() with the DESIRED state (the confirmed stale assessment, or null),
// and this module changes only the difference between that and what clients
// were last shown: show, refresh in place, or retract. Calling it again with the
// same input changes nothing and broadcasts nothing. There are no announce and
// retract events for another module to keep in step with.
//
// While the build is genuinely stale an actionable offer is always visible: it
// is shown at once, with its change list marked unavailable, and refreshed in
// place when a read succeeds. A slow, failed or throwing read never removes or
// withholds the restart action.
//
// It broadcasts; it never restarts anything (that is
// lib/build-update-restart.js, on a confirmed click).

var SOURCE = 'build-update';

var READING = 'the change list is still being read';
var FAILED_REASON = 'the change list could not be read';

// What the change list looks like to a client, ordered by what can change it.
var PENDING = 'pending';
var LISTED = 'listed';
var FAILED = 'failed';

function unavailable(reason) {
  return { available: false, commits: [], truncated: false, reason: reason };
}

function offerKeyOf(a) {
  return a.loadedBuildSha + ':' + a.installedBuildSha + ':' + a.installedContentHash;
}

// The change list depends only on the two builds, not on the content hash.
function readKeyOf(a) {
  return a.loadedBuildSha + ':' + a.installedBuildSha;
}

/**
 * @param {object} o
 * @param {function(object): Promise<object>} o.listChanges — ({fromSha, toSha}) -> changes
 * @param {function(object, object): object} o.compose — (assessment, changes) -> diagnostic message
 * @param {function(object): void} o.broadcast — sends a message to every connected client
 * @param {function(): ?object} o.desired — the CURRENT desired assessment (confirmed stale) or null
 * @param {number} [o.retryAfterMs] — minimum time between retries of a failed read
 * @param {function(): number} [o.now]
 * @param {function(string): void} [o.log]
 */
function createStandingOffer(o) {
  var log = typeof o.log === 'function' ? o.log : function () {};
  var now = typeof o.now === 'function' ? o.now : Date.now;
  var retryAfterMs = o.retryAfterMs >= 0 ? o.retryAfterMs : 30 * 60 * 1000;

  // What clients were last shown: {offerKey, changeListStatus, message}, set only
  // after the broadcast succeeded.
  var shown = null;
  // readKey -> {status, changes, reason, failedAt, inFlight}
  var reads = {};

  function describe(e) { return e && e.message ? e.message : String(e); }

  function readChanges(a) {
    // A synchronous throw from the reader is a failed read like a rejection.
    try {
      return Promise.resolve(o.listChanges({ fromSha: a.loadedBuildSha, toSha: a.installedBuildSha }));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function startRead(a, key) {
    var entry = reads[key] || { status: PENDING, changes: null, reason: null, failedAt: 0, inFlight: false };
    reads[key] = entry;
    entry.inFlight = true;
    readChanges(a).then(function (changes) {
      entry.inFlight = false;
      entry.status = LISTED;
      entry.changes = changes;
    }, function (err) {
      entry.inFlight = false;
      // A list already read stays; otherwise the failure and its reason are cached.
      if (entry.status !== LISTED) {
        entry.status = FAILED;
        entry.reason = FAILED_REASON;
      }
      entry.failedAt = now();
      // The detail stays in the journal; clients get only the reason class.
      log('Could not read the changes for the build-update offer: ' + describe(err));
    }).then(function () {
      // Always against the LATEST desired state, never the one this read started
      // under, so an obsolete result cannot restore an offer.
      var latest;
      try {
        latest = o.desired();
      } catch (e) {
        log('Could not read the current build assessment: ' + describe(e));
        return;
      }
      reconcile(latest);
    });
  }

  function changesFor(entry) {
    if (entry.status === LISTED) return entry.changes;
    if (entry.status === FAILED) return unavailable(entry.reason);
    return unavailable(READING);
  }

  function retract() {
    o.broadcast({ type: 'diagnostic_retract', source: SOURCE });
    shown = null;
  }

  function prune(keepKey) {
    Object.keys(reads).forEach(function (k) {
      if (k !== keepKey && !reads[k].inFlight) delete reads[k];
    });
  }

  function reconcileUnsafe(desired) {
    if (!desired) {
      if (shown !== null) retract();
      prune(null);
      return;
    }
    var offerKey = offerKeyOf(desired);
    var readKey = readKeyOf(desired);
    var entry = reads[readKey];
    if (!entry) {
      startRead(desired, readKey);
      entry = reads[readKey];
    } else if (!entry.inFlight && entry.status === FAILED && now() - entry.failedAt >= retryAfterMs) {
      startRead(desired, readKey);
    }

    var summary = { offerKey: offerKey, changeListStatus: entry.status };
    if (shown !== null && shown.offerKey === summary.offerKey && shown.changeListStatus === summary.changeListStatus) {
      prune(readKey);
      return;
    }

    var message = o.compose(desired, changesFor(entry));
    // A different build replaces the offer; the same build is refreshed in place
    // (never retracted first, so the restart action does not flicker).
    var refresh = shown !== null && shown.offerKey === summary.offerKey;
    if (shown !== null && !refresh) retract();
    // The stored copy, replayed to a client that connects later, is a plain
    // diagnostic; `refresh` tells a client already holding the entry to update it
    // and not to bring back one the operator dismissed.
    o.broadcast(refresh ? Object.assign({}, message, { refresh: true }) : message);
    shown = { offerKey: summary.offerKey, changeListStatus: summary.changeListStatus, message: message };
    prune(readKey);
  }

  /**
   * Bring what clients see in line with `desired`. Idempotent; never throws:
   * the poll loop that calls it must survive a compose or broadcast failure,
   * and the next poll retries because nothing is recorded as shown until the
   * broadcast has succeeded.
   */
  function reconcile(desired) {
    try {
      reconcileUnsafe(desired);
    } catch (e) {
      log('Could not reconcile the build-update offer: ' + describe(e));
    }
  }

  return {
    reconcile: reconcile,
    /** What a client that connects now should be shown, or null when no offer stands. */
    current: function () { return shown === null ? null : shown.message; },
    /** The state to send a client on connect: the held offer, or an explicit "no offer". */
    forNewClient: function () {
      return shown === null ? { type: 'diagnostic_retract', source: SOURCE } : shown.message;
    },
  };
}

module.exports = { createStandingOffer: createStandingOffer, SOURCE: SOURCE };
