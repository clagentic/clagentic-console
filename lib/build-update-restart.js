'use strict';

// build-update-restart.js — the only path from "a newer build is installed" to
// "the daemon restarts", and it starts only from an operator's confirmed click.
//
// Two steps, both initiated by the operator over the admin WebSocket:
//   1. request() with no token answers with the offer: both builds, the commits
//      between them, and the live sessions and background agents a restart now
//      would end. It restarts nothing.
//   2. request(token) with the token from that offer. A known, unexpired,
//      unspent token schedules the restart. The confirm card is the consent and
//      says that sessions and turns starting before the restart end with it, so
//      a changed session set is journaled and does not refuse the click.
// The confirmed restart fires at once. The second step's card already names the
// sessions and agents it ends, so that card is the guard; there is no further
// wait. From the confirm until the process exits the restart is pending and a
// repeat request returns that state instead of offering again.

var crypto = require('crypto');

var { collectInterruptions, buildOffer } = require('./build-update-offer');

var OFFER_TTL_MS = 10 * 60 * 1000;
var MAX_OUTSTANDING_OFFERS = 20;

/**
 * @param {object} o
 * @param {function(): object} o.assess — fresh assessBuild() result
 * @param {function(): Array<{slug: string, sm: object}>} o.getProjects
 * @param {function(object): Promise<object>} o.listChanges — ({fromSha, toSha}) -> changes
 * @param {function(): void} o.restart — performs the restart; called only after confirmation
 * @param {function(): void} [o.onScheduled] — called once, just before the restart
 *   is performed, so clients can swap the offer for the restarting state
 * @param {function(string): void} [o.log]
 * @param {function(): number} [o.nowMs]
 */
function createBuildUpdateRestart(o) {
  var log = typeof o.log === 'function' ? o.log : function () {};
  var now = typeof o.nowMs === 'function' ? o.nowMs : Date.now;
  var offers = new Map(); // token -> { keys, installedKey, expires }
  var restarting = false;

  function installedKeyOf(a) { return a.installedBuildSha + ':' + a.installedContentHash; }

  function prune() {
    var t = now();
    offers.forEach(function (v, token) { if (v.expires <= t) offers.delete(token); });
    while (offers.size >= MAX_OUTSTANDING_OFFERS) offers.delete(offers.keys().next().value);
  }

  async function issueOffer(assessment, note) {
    var changes;
    try {
      changes = await o.listChanges({ fromSha: assessment.loadedBuildSha, toSha: assessment.installedBuildSha });
    } catch (e) {
      changes = { available: false, commits: [], truncated: false, reason: 'the change list failed' };
      log('Could not list changes for the build-update offer: ' + (e && e.message ? e.message : e));
    }
    // Reading the change list takes time. The offer reflects the build and the
    // live sessions as they are now, not as they were when it was asked for.
    var fresh = o.assess();
    if (fresh.state !== 'stale' || installedKeyOf(fresh) !== installedKeyOf(assessment)) {
      return { status: 'not_stale', assessment: fresh };
    }
    var interruptions = collectInterruptions(o.getProjects());
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
      token: token,
    });
    return { status: 'confirm', offer: offer, note: note || null };
  }

  // Names what differs between the offer the operator saw and now, for the journal.
  function describeChange(offered, assessment) {
    var parts = [];
    if (installedKeyOf(assessment) !== offered.installedKey) parts.push('a different build was installed');
    var was = new Set(offered.keys);
    var nowKeys = collectInterruptions(o.getProjects()).keys;
    var is = new Set(nowKeys);
    var added = nowKeys.filter(function (k) { return !was.has(k); });
    var gone = offered.keys.filter(function (k) { return !is.has(k); });
    if (added.length) parts.push('now live and not offered: ' + added.join(', '));
    if (gone.length) parts.push('offered and no longer live: ' + gone.join(', '));
    return parts.join('; ');
  }

  /**
   * @param {?string} token — the token of an offer the operator was shown
   * @returns {Promise<{status: string, offer?: object, note?: string}>}
   *   status: 'not_stale' | 'confirm' | 'restarting'
   */
  async function request(token) {
    // A restart is a one-way door: once confirmed, any further request (a second
    // tab, a card that was still on screen, a replayed frame) gets the pending
    // state back. It never issues another offer, so the operator is not asked to
    // confirm twice, and it never restarts a second time.
    if (restarting) {
      offers.delete(token);
      log('Restart request ignored: a confirmed restart is already pending');
      return { status: 'restarting', already: true };
    }
    var assessment = o.assess();
    if (assessment.state !== 'stale') {
      return { status: 'not_stale', assessment: assessment };
    }

    if (!token) return issueOffer(assessment, null);

    var offered = offers.get(token);
    offers.delete(token); // one confirmation per offer
    // A confirmation that restarts nothing must leave a journal line: without
    // one, a click answered by a fresh offer is indistinguishable from a click
    // that never arrived.
    if (!offered || offered.expires <= now()) {
      log('Restart confirmation not applied: the offer was unknown or expired; issuing a fresh one');
      return issueOffer(assessment, 'That offer expired. Review the current one.');
    }
    restarting = true;
    // The confirm card is the consent, and it says sessions and turns that start
    // before the restart end with it. A changed set is journaled, never refused.
    var changed = describeChange(offered, assessment);
    if (changed) log('Restart confirmed after the offer changed (' + changed + '); proceeding');
    log('Operator confirmed restart to adopt build ' + assessment.installedBuildSha +
      '; restarting now');

    // Everyone's restart card is withdrawn and replaced by the one pending state
    // before the restart begins.
    if (typeof o.onScheduled === 'function') {
      try {
        o.onScheduled();
      } catch (e) {
        log('Could not announce the pending restart: ' + (e && e.message ? e.message : e));
      }
    }
    // The pending guard stays set until the process exits. A restart that throws
    // leaves nothing pending, so the operator can ask again.
    try {
      o.restart();
    } catch (e) {
      restarting = false;
      throw e;
    }
    return { status: 'restarting' };
  }

  return { request: request };
}

module.exports = { createBuildUpdateRestart: createBuildUpdateRestart, OFFER_TTL_MS: OFFER_TTL_MS };
