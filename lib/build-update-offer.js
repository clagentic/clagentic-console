'use strict';

// build-update-offer.js — what the operator is told before a restart to adopt
// an installed build: which build is running, which is installed, and exactly
// what the restart will end.
//
// "Live" is the same notion the shutdown path uses: a session that holds a
// running agent process (queryInstance or worker). That process dies with the
// daemon, and with it any background agent the session dispatched.

var SESSION_TITLE_MAX = 80;
var liveAgentTasks = require('./session-reclaim').liveAgentTasks;

function oneLine(text, max, fallback) {
  if (typeof text !== 'string') return fallback;
  var line = text.replace(/\s+/g, ' ').trim();
  if (!line) return fallback;
  return line.length > max ? line.slice(0, max - 3) + '...' : line;
}

function isLive(session) {
  return !!(session && (session.queryInstance || session.worker));
}

/**
 * Everything a restart now would end, across every project.
 *
 * @param {Array<{slug: string, sm: {sessions: Map}}>} projects
 * @returns {{sessions: Array<object>, sessionCount: number, processingCount: number, agentCount: number, keys: string[]}}
 */
function collectInterruptions(projects) {
  var sessions = [];
  var keys = [];
  var agentCount = 0;
  var processingCount = 0;
  (projects || []).forEach(function (proj) {
    if (!proj || !proj.sm || !proj.sm.sessions) return;
    proj.sm.sessions.forEach(function (session) {
      if (!isLive(session)) return;
      var key = proj.slug + '#' + session.localId;
      var agents = liveAgentTasks(session);
      var processing = !!session.isProcessing;
      keys.push(key);
      agents.forEach(function (a) { keys.push(key + '#' + a.id); });
      agentCount += agents.length;
      if (processing) processingCount += 1;
      sessions.push({
        key: key,
        slug: proj.slug,
        localId: session.localId,
        title: oneLine(session.title, SESSION_TITLE_MAX, 'Untitled session'),
        processing: processing,
        agents: agents.map(function (a) { return a.label; }),
      });
    });
  });
  return {
    sessions: sessions,
    sessionCount: sessions.length,
    processingCount: processingCount,
    agentCount: agentCount,
    keys: keys,
  };
}

/** True when every key in `current` was already in `offered`. */
function coveredBy(current, offered) {
  var have = new Set(offered);
  return current.every(function (k) { return have.has(k); });
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

/** The operator-facing statement of what a restart ends. */
function describeInterruptions(i, waitSeconds) {
  if (i.sessionCount === 0) {
    return 'No session is live, so the restart ends nothing that is running.';
  }
  var lines = [
    'Restarting Clagentic: Console now ends ' + plural(i.sessionCount, 'live session') +
      (i.agentCount > 0 ? ' and ' + plural(i.agentCount, 'background agent') : '') + '.',
  ];
  i.sessions.forEach(function (s) {
    var state = s.processing ? 'running a turn' : 'idle';
    var agents = s.agents.length > 0
      ? '; background agents: ' + s.agents.map(function (l) { return '"' + l + '"'; }).join(', ')
      : '';
    lines.push('- [' + s.slug + '] ' + s.title + ' (' + state + agents + ')');
  });
  lines.push('Running turns and agents get up to ' + waitSeconds + ' seconds to finish first. ' +
    'Ended sessions resume when you send them a message.');
  return lines.join('\n');
}

/**
 * The offer shown for a stale build. `interruptions` is included only for the
 * admin who is about to confirm; the version that goes to every connected
 * client leaves it out because session titles and agent names are session
 * content.
 */
function buildOffer(o) {
  var a = o.assessment;
  var offer = {
    loadedBuildSha: a.loadedBuildSha,
    installedBuildSha: a.installedBuildSha,
    reason: a.reason,
    changes: o.changes || { available: false, commits: [], truncated: false, reason: null },
  };
  if (o.interruptions) {
    offer.interruptions = {
      sessions: o.interruptions.sessions,
      sessionCount: o.interruptions.sessionCount,
      agentCount: o.interruptions.agentCount,
    };
    offer.interruptionText = describeInterruptions(o.interruptions, o.waitSeconds);
  }
  if (o.token) offer.token = o.token;
  return offer;
}

/** One line naming both builds, for the notice and the log. */
function summarizeOffer(a) {
  var short = function (s) { return s ? s.slice(0, 12) : '(unknown)'; };
  return a.reason === 'content'
    ? 'Build ' + short(a.installedBuildSha) + ' is installed with different files than the running process loaded.'
    : 'Running build ' + short(a.loadedBuildSha) + '; installed build ' + short(a.installedBuildSha) + '.';
}

module.exports = {
  collectInterruptions: collectInterruptions,
  coveredBy: coveredBy,
  describeInterruptions: describeInterruptions,
  buildOffer: buildOffer,
  summarizeOffer: summarizeOffer,
  liveAgentTasks: liveAgentTasks,
};
