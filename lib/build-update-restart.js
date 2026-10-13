'use strict';

// build-update-restart.js — the only path from "a newer build is installed" to
// "the daemon restarts", and it starts only from an operator's confirmed click.
//
// Two steps, both initiated by the operator over the admin WebSocket:
//   1. request() with no token answers with the offer: both builds, the commits
//      between them, and the live sessions and background agents a restart now
//      would end. It restarts nothing.
//   2. request(token) with the token from that offer. The restart is scheduled
//      only when the offer is still true: the installed build is the one
//      offered, and nothing is live now that the operator was not shown. If
//      anything changed, a fresh offer is returned instead and the operator
//      confirms again.
// A running turn is given a bounded time to finish; when the restart finally
// fires, it re-checks the same condition and cancels if a session started
// after the operator confirmed.

var crypto = require('crypto');

var { collectInterruptions, coveredBy, buildOffer } = require('./build-update-offer');

var OFFER_TTL_MS = 10 * 60 * 1000;
var MAX_OUTSTANDING_OFFERS = 20;

/**
 * @param {object} o
 * @param {function(): object} o.assess — fresh assessBuild() result
 * @param {function(): Array<{slug: string, sm: object}>} o.getProjects
 * @param {function(object): Promise<object>} o.listChanges — ({fromSha, toSha}) -> changes
 * @param {function(): void} o.restart — performs the restart; called only after confirmation
 * @param {function(function, object): void} o.waitForIdleThenAct — build-update-check's
 * @param {function(string): void} o.announce — tells every client why a confirmed restart was cancelled
 * @param {function(string): void} [o.log]
 * @param {number} [o.waitMs] — how long running turns get to finish
 * @param {function(): number} [o.nowMs]
 */
function createBuildUpdateRestart(o) {
  var log = typeof o.log === 'function' ? o.log : function () {};
  var now = typeof o.nowMs === 'function' ? o.nowMs : Date.now;
  var waitMs = o.waitMs > 0 ? o.waitMs : 60 * 1000;
  var offers = new Map(); // token -> { keys, installedKey, expires }
  var restarting = false;

  function installedKeyOf(a) { return a.installedBuildSha + ':' + a.installedContentHash; }

  function prune() {
    var t = now();
    offers.forEach(function (v, token) { if (v.expires <= t) offers.delete(token); });
    while (offers.size >= MAX_OUTSTANDING_OFFERS) offers.delete(offers.keys().next().value);
  }

  async function issueOffer(assessment, interruptions, note) {
    var changes;
    try {
      changes = await o.listChanges({ fromSha: assessment.loadedBuildSha, toSha: assessment.installedBuildSha });
    } catch (e) {
      changes = { available: false, commits: [], truncated: false, reason: 'the change list failed' };
      log('Could not list changes for the build-update offer: ' + (e && e.message ? e.message : e));
    }
    prune();
    var token = crypto.randomBytes(16).toString('hex');
    offers.set(token, {
      keys: interruptions.keys.slice(),
      installedKey: installedKeyOf(assessment),
      expires: now() + OFFER_TTL_MS,
    });
    var offer = buildOffer({
      assessment: assessment,
      changes: changes,
      interruptions: interruptions,
      waitSeconds: Math.round(waitMs / 1000),
      token: token,
    });
    return { status: 'confirm', offer: offer, note: note || null };
  }

  function stillCovered(offered, assessment) {
    var a = assessment;
    return a.state === 'stale' && installedKeyOf(a) === offered.installedKey
      && coveredBy(collectInterruptions(o.getProjects()).keys, offered.keys);
  }

  /**
   * @param {?string} token — the token of an offer the operator was shown
   * @returns {Promise<{status: string, offer?: object, note?: string}>}
   *   status: 'not_stale' | 'confirm' | 'restarting'
   */
  async function request(token) {
    var assessment = o.assess();
    if (assessment.state !== 'stale') {
      return { status: 'not_stale', assessment: assessment };
    }
    var interruptions = collectInterruptions(o.getProjects());

    if (!token) return issueOffer(assessment, interruptions, null);

    var offered = offers.get(token);
    offers.delete(token); // one confirmation per offer
    if (!offered || offered.expires <= now()) {
      return issueOffer(assessment, interruptions, 'That offer expired. Review the current one.');
    }
    if (!stillCovered(offered, assessment)) {
      return issueOffer(assessment, interruptions,
        'Something changed since you opened the offer (a build or a live session). Review the current one.');
    }
    if (restarting) return { status: 'restarting' };
    restarting = true;
    log('Operator confirmed restart to adopt build ' + assessment.installedBuildSha +
      '; waiting up to ' + Math.round(waitMs / 1000) + 's for running turns');

    o.waitForIdleThenAct({
      getActiveCount: function () {
        var i = collectInterruptions(o.getProjects());
        return i.processingCount + i.agentCount;
      },
      timeoutMs: waitMs,
      onIdle: function () {
        var fresh = o.assess();
        if (!stillCovered(offered, fresh)) {
          restarting = false;
          log('Confirmed restart cancelled: the installed build or the live sessions changed after confirmation');
          o.announce('The restart you confirmed was cancelled because the installed build or the live ' +
            'sessions changed while it waited. Nothing was restarted. Open the update offer again to review it.');
          return;
        }
        o.restart();
      },
    });
    return { status: 'restarting', waitSeconds: Math.round(waitMs / 1000) };
  }

  return { request: request };
}

module.exports = { createBuildUpdateRestart: createBuildUpdateRestart, OFFER_TTL_MS: OFFER_TTL_MS };
