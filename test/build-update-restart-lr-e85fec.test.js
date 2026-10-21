"use strict";

// The only path from "a newer build is installed" to "the daemon restarts":
// an operator's confirmation of an offer that is still true.

var test = require("node:test");
var assert = require("node:assert/strict");

var { createBuildUpdateRestart } = require("../lib/build-update-restart");
var { collectInterruptions, describeInterruptions, liveAgentTasks } = require("../lib/build-update-offer");

function session(localId, title, o) {
  var s = { localId: localId, title: title, queryInstance: {}, isProcessing: false, activeTaskToolIds: {} };
  return Object.assign(s, o || {});
}

function world() {
  var w = {
    projects: [{ slug: "lore", sm: { sessions: new Map() } }, { slug: "workspace", sm: { sessions: new Map() } }],
    installed: { sha: "new", hash: "h-new" },
    restarts: 0,
    announced: [],
    clock: 1000,
    add: function (slug, s) { w.projects.find(function (p) { return p.slug === slug; }).sm.sessions.set(s.localId, s); },
    remove: function (slug, id) { w.projects.find(function (p) { return p.slug === slug; }).sm.sessions.delete(id); },
  };
  w.controller = createBuildUpdateRestart({
    assess: function () {
      var stale = w.installed.sha !== "old" || w.installed.hash !== "h-old";
      return {
        state: stale ? "stale" : "adopted", reason: w.installed.sha !== "old" ? "sha" : "content", detail: "d",
        loadedBuildSha: "old", installedBuildSha: w.installed.sha, loadedContentHash: "h-old", installedContentHash: w.installed.hash,
      };
    },
    getProjects: function () { return w.projects; },
    listChanges: async function () { return { available: true, commits: [{ sha: "abc1234", subject: "fix a thing" }], truncated: false, reason: null }; },
    restart: function () { w.restarts += 1; },
    announce: function (m) { w.announced.push(m); },
    nowMs: function () { return w.clock; },
  });
  return w;
}

test("nothing to apply when the installed build is the loaded one", async function () {
  var w = world();
  w.installed = { sha: "old", hash: "h-old" };
  var r = await w.controller.request(null);
  assert.equal(r.status, "not_stale");
  assert.equal(w.restarts, 0);
});

test("asking for the offer restarts nothing and names every live session and background agent", async function () {
  var w = world();
  w.add("lore", session("s1", "HOLDEN lane", { isProcessing: true, activeTaskToolIds: { t1: true, t2: true, t3: false } }));
  w.add("workspace", session("s2", "idle one"));
  w.add("workspace", session("s3", "not live", { queryInstance: null, worker: null }));
  var r = await w.controller.request(null);
  assert.equal(r.status, "confirm");
  assert.equal(w.restarts, 0);
  var offer = r.offer;
  assert.equal(offer.loadedBuildSha, "old");
  assert.equal(offer.installedBuildSha, "new");
  assert.equal(offer.changes.commits[0].subject, "fix a thing");
  assert.equal(offer.interruptions.sessionCount, 2, "the session without a running agent process is not live");
  assert.equal(offer.interruptions.agentCount, 2, "a finished (false) task is not an agent");
  assert.deepEqual(offer.interruptions.sessions.map(function (s) { return s.slug + "/" + s.title; }), ["lore/HOLDEN lane", "workspace/idle one"]);
  assert.match(offer.interruptionText, /2 live sessions and 2 background agents/);
  assert.match(offer.interruptionText, /\[lore\] HOLDEN lane \(running a turn; background agents:/);
  assert.match(offer.interruptionText, /\[workspace\] idle one \(idle\)/);
  assert.doesNotMatch(offer.interruptionText, /second|wait|finish first/i, "the card promises no wait");
  assert.ok(offer.token);
});

test("a session with a worker and no query instance is live", async function () {
  var w = world();
  w.add("lore", session("s1", "worker", { queryInstance: null, worker: {} }));
  var r = await w.controller.request(null);
  assert.equal(r.offer.interruptions.sessionCount, 1);
});

test("the confirmed offer restarts at once, even with a turn running", async function () {
  var w = world();
  w.add("lore", session("s1", "busy", { isProcessing: true }));
  var offer = (await w.controller.request(null)).offer;
  var r = await w.controller.request(offer.token);
  assert.equal(r.status, "restarting");
  assert.equal(r.waitSeconds, undefined, "no wait is reported");
  assert.equal(w.restarts, 1, "restart was called before the confirm returned");
});

test("the restarting state is announced before the restart is performed", async function () {
  var w = world();
  var order = [];
  w.controller = createBuildUpdateRestart({
    assess: function () {
      return {
        state: "stale", reason: "sha", detail: "d", loadedBuildSha: "old", installedBuildSha: "new",
        loadedContentHash: "h-old", installedContentHash: "h-new",
      };
    },
    getProjects: function () { return w.projects; },
    listChanges: async function () { return { available: true, commits: [], truncated: false, reason: null }; },
    restart: function () { order.push("restart"); },
    onScheduled: function () { order.push("announce"); },
  });
  var offer = (await w.controller.request(null)).offer;
  await w.controller.request(offer.token);
  assert.deepEqual(order, ["announce", "restart"]);
});

test("a restart that throws leaves nothing pending", async function () {
  var w = world();
  var calls = 0;
  w.controller = createBuildUpdateRestart({
    assess: function () {
      return {
        state: "stale", reason: "sha", detail: "d", loadedBuildSha: "old", installedBuildSha: "new",
        loadedContentHash: "h-old", installedContentHash: "h-new",
      };
    },
    getProjects: function () { return w.projects; },
    listChanges: async function () { return { available: true, commits: [], truncated: false, reason: null }; },
    restart: function () { calls += 1; if (calls === 1) throw new Error("boom"); },
  });
  var offer = (await w.controller.request(null)).offer;
  await assert.rejects(w.controller.request(offer.token), /boom/);
  var again = await w.controller.request(null);
  assert.equal(again.status, "confirm", "the operator can ask again");
});

test("a token is good once", async function () {
  var w = world();
  var offer = (await w.controller.request(null)).offer;
  assert.equal((await w.controller.request(offer.token)).status, "restarting");
  var again = await w.controller.request(offer.token);
  assert.equal(again.status, "restarting", "a replayed token reports the pending restart");
  assert.equal(again.already, true);
  assert.equal(w.restarts, 1, "a replayed token must not restart a second time");
});

test("a request while a restart is pending returns the pending state: no offer, no second restart", async function () {
  var w = world();
  w.add("lore", session("s1", "busy", { isProcessing: true }));
  var scheduled = [];
  w.controller = createBuildUpdateRestart({
    assess: function () {
      return {
        state: "stale", reason: "sha", detail: "d", loadedBuildSha: "old", installedBuildSha: "new",
        loadedContentHash: "h-old", installedContentHash: "h-new",
      };
    },
    getProjects: function () { return w.projects; },
    listChanges: async function () { return { available: true, commits: [], truncated: false, reason: null }; },
    restart: function () { w.restarts += 1; },
    onScheduled: function () { scheduled.push("announced"); },
  });
  var first = (await w.controller.request(null)).offer;
  var spare = (await w.controller.request(null)).offer;
  assert.equal((await w.controller.request(first.token)).status, "restarting");
  assert.deepEqual(scheduled, ["announced"], "the pending restart is announced once");
  assert.equal(w.restarts, 1);

  var viaNoToken = await w.controller.request(null);
  assert.equal(viaNoToken.status, "restarting");
  assert.equal(viaNoToken.offer, undefined, "the restart prompt is not offered again");
  var viaStaleToken = await w.controller.request(spare.token);
  assert.equal(viaStaleToken.status, "restarting");
  assert.deepEqual(scheduled, ["announced"], "a repeat request announces nothing new");
  assert.equal(w.restarts, 1, "restart called once");
});

test("a token the daemon did not issue restarts nothing and returns a fresh offer", async function () {
  var w = world();
  var r = await w.controller.request("not-a-real-token");
  assert.equal(r.status, "confirm");
  assert.equal(w.restarts, 0);
  assert.ok(r.offer.token && r.offer.token !== "not-a-real-token");
});

test("an offer that expired is replaced, not honoured", async function () {
  var w = world();
  var offer = (await w.controller.request(null)).offer;
  w.clock += 11 * 60 * 1000;
  var r = await w.controller.request(offer.token);
  assert.equal(r.status, "confirm");
  assert.match(r.note, /expired/);
  assert.equal(w.restarts, 0);
});

// Contract change (operator ruling, lr-01293b seq 14): the confirm card is the
// consent, so a changed session set no longer refuses a confirmed restart.
test("a live session that appeared after the offer was shown still restarts on confirm", async function () {
  var w = world();
  w.add("lore", session("s1", "shown"));
  var offer = (await w.controller.request(null)).offer;
  w.add("workspace", session("s2", "appeared later"));
  var r = await w.controller.request(offer.token);
  assert.equal(r.status, "restarting");
  assert.equal(w.restarts, 1);
});

test("a background agent that started after the offer was shown still restarts on confirm", async function () {
  var w = world();
  var s = session("s1", "shown");
  w.add("lore", s);
  var offer = (await w.controller.request(null)).offer;
  s.activeTaskToolIds = { late: true };
  assert.equal((await w.controller.request(offer.token)).status, "restarting");
  assert.equal(w.restarts, 1);
});

test("a session shown as idle that starts a turn after the offer still restarts on confirm", async function () {
  var w = world();
  var s = session("s1", "shown idle");
  w.add("lore", s);
  var offer = (await w.controller.request(null)).offer;
  s.isProcessing = true;
  assert.equal((await w.controller.request(offer.token)).status, "restarting");
  assert.equal(w.restarts, 1);
});

test("a session shown as running that went idle does not invalidate the offer", async function () {
  var w = world();
  var s = session("s1", "shown busy", { isProcessing: true });
  w.add("lore", s);
  var offer = (await w.controller.request(null)).offer;
  s.isProcessing = false;
  assert.equal((await w.controller.request(offer.token)).status, "restarting");
});

test("a different build installed after the offer still restarts on confirm", async function () {
  var w = world();
  var offer = (await w.controller.request(null)).offer;
  w.installed = { sha: "newer", hash: "h-newer" };
  assert.equal((await w.controller.request(offer.token)).status, "restarting");
  assert.equal(w.restarts, 1);
});

test("sessions that finished since the offer do not invalidate it", async function () {
  var w = world();
  w.add("lore", session("s1", "a"));
  w.add("lore", session("s2", "b"));
  var offer = (await w.controller.request(null)).offer;
  w.remove("lore", "s2");
  assert.equal((await w.controller.request(offer.token)).status, "restarting");
});

test("a session that starts after the confirm does not start a second restart", async function () {
  var w = world();
  w.add("lore", session("s1", "busy", { isProcessing: true }));
  var offer = (await w.controller.request(null)).offer;
  await w.controller.request(offer.token);
  w.add("workspace", session("s9", "started after confirming"));
  var again = await w.controller.request(null);
  assert.equal(again.status, "restarting");
  assert.equal(w.restarts, 1);
  assert.equal(w.announced.length, 0);
});

test("the confirm card states that sessions starting before the restart end with it", async function () {
  var w = world();
  w.add("lore", session("s1", "shown"));
  var offer = (await w.controller.request(null)).offer;
  assert.match(offer.interruptionText, /ends these sessions and any that start before the restart happens/);
});

test("a second confirmation while a restart is pending does not restart again", async function () {
  var w = world();
  var o1 = (await w.controller.request(null)).offer;
  var o2 = (await w.controller.request(null)).offer;
  await w.controller.request(o1.token);
  var r = await w.controller.request(o2.token);
  assert.equal(r.status, "restarting");
  assert.equal(w.restarts, 1);
});

test("no offer is issued for a build that was adopted while its change list was read", async function () {
  var w = world();
  var release;
  var controller = createBuildUpdateRestart({
    assess: function () {
      var stale = w.installed.sha !== "old";
      return {
        state: stale ? "stale" : "adopted", reason: "sha", detail: "d",
        loadedBuildSha: "old", installedBuildSha: w.installed.sha, loadedContentHash: "h-old", installedContentHash: w.installed.hash,
      };
    },
    getProjects: function () { return w.projects; },
    listChanges: function () { return new Promise(function (resolve) { release = resolve; }); },
    restart: function () { w.restarts += 1; },
    announce: function () {},
  });
  var pending = controller.request(null);
  w.installed = { sha: "old", hash: "h-old" }; // the daemon is restarted by someone else meanwhile
  release({ available: true, commits: [], truncated: false, reason: null });
  var r = await pending;
  assert.equal(r.status, "not_stale");
  assert.equal(r.offer, undefined);
});

test("the offer lists a session that started while its change list was read", async function () {
  var w = world();
  w.controller = createBuildUpdateRestart({
    assess: function () {
      return {
        state: "stale", reason: "sha", detail: "d", loadedBuildSha: "old", installedBuildSha: "new",
        loadedContentHash: "h-old", installedContentHash: "h-new",
      };
    },
    getProjects: function () { return w.projects; },
    listChanges: async function () {
      w.add("lore", session("late", "started during the read"));
      return { available: true, commits: [], truncated: false, reason: null };
    },
    restart: function () {},
    announce: function () {},
  });
  var r = await w.controller.request(null);
  assert.equal(r.offer.interruptions.sessionCount, 1);
});

test("describeInterruptions says plainly when nothing is live", function () {
  assert.match(describeInterruptions(collectInterruptions([])), /No session is live/);
});

test("collectInterruptions bounds and cleans what the model or user supplied", function () {
  // The newline sits inside the first 80 characters, so truncation alone would keep it.
  var long = "first part\n\nsecond line " + "x".repeat(500);
  var i = collectInterruptions([{ slug: "p", sm: { sessions: new Map([["1", session("1", long)]]) } }]);
  assert.ok(i.sessions[0].title.length <= 80);
  assert.doesNotMatch(i.sessions[0].title, /\n/);
  assert.match(i.sessions[0].title, /^first part second line /);
  assert.equal(liveAgentTasks({ activeTaskToolIds: { a: true }, taskLabels: { a: "named\nagent" } })[0].label, "named agent");
  assert.equal(liveAgentTasks({ activeTaskToolIds: { a: true } })[0].label, "background agent");
});
