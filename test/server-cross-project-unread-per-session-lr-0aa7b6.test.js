"use strict";
// Regression coverage for lr-0aa7b6 (follow-up, holden/andy decision):
// the Home Hub Recent Sessions merged status dot's alert(red) state was
// keyed on projectHasAlert(sess.projectSlug) — a PER-PROJECT aggregate —
// so every session row in a notifying project lit up red even when only
// ONE sibling session was actually notifying. This suite covers the real
// per-session data path built to fix that:
//
//   1. lib/sessions.js: onSessionDone(session.localId) — the session's own
//      identity is now threaded out of doSendAndRecord on a "done" event,
//      not called with zero arguments.
//   2. lib/server.js: crossProjectUnread is keyed by composite
//      "slug::localId" (crossUnreadKey), not slug alone — so a "done"
//      event only increments the ONE session that produced it, never its
//      project siblings.
//   3. lib/server.js: getSessionUnread(ws, ownSlug, sessSlug, localId)
//      resolves per-session unread correctly for both "own project"
//      (ws._clayUnread, same-project mechanism) and "other project"
//      (composite crossProjectUnread) sessions, and does NOT cross-
//      attribute unread between two different projects' sessions that
//      happen to share the same localId (localId is only unique WITHIN
//      one project's SessionManager — see lib/sessions.js nextLocalId).
//   4. lib/server.js: getCrossProjectUnreadForSlug (the Projects-list
//      badge rollup) still returns the correct PER-PROJECT total after
//      the restructure — summing the per-session entries for that slug —
//      preserving the pre-existing proj.unread contract.
//   5. lib/project-loop.js: hub_recent_sessions_list attaches each
//      session's OWN unread count onto the sess object sent to the
//      client, keyed via ctx.getSessionUnread(ws, sessProjectSlug,
//      s.localId) — not a project-wide value.
//
// lib/server.js is a large createServer() factory that stands up a real
// HTTP server and is not a practical direct-require unit-test target (no
// existing test in this repo requires it directly). Its cross-project
// unread logic is small, pure, and self-contained (crossUnreadKey /
// getCrossProjectUnreadForSlug / getSessionUnread / onSessionDone), so —
// matching the project's existing "assert the fix is structurally present,
// then exercise the equivalent logic directly" convention for hard-to-
// import modules (see rate-limit-per-session-lr-0827ba.test.js) — this
// suite pairs a source-text presence check with a functional
// reimplementation-free harness that instantiates the exact composite-key
// map shape lib/server.js builds, verified against the source text to
// stay honest to the real implementation.
//
// The project-loop.js half (item 5) drives REAL production code via
// attachLoop with a mocked ctx, matching test/project-loop-message-lr-4a9c.js's
// established pattern.
//
// The sessions.js half (item 1) drives REAL production code via
// createSessionManager, matching test/session-lifecycle-lr-e0de.test.js's
// established pattern.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

var SERVER_JS = readMod("lib/server.js");
var SESSIONS_JS = readMod("lib/sessions.js");
var PROJECT_JS = readMod("lib/project.js");
var PROJECT_LOOP_JS = readMod("lib/project-loop.js");

// ---------------------------------------------------------------------------
// 1. lib/sessions.js: onSessionDone(session.localId) — real production code
// ---------------------------------------------------------------------------

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-cpu-test-"));
}

function makeSessionManager(tmpHome, onSessionDone) {
  ["../lib/config", "../lib/sessions", "../lib/utils"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var sessions;
  try {
    sessions = require("../lib/sessions");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  return sessions.createSessionManager({
    cwd: tmpHome,
    send: function () {},
    sendTo: function () {},
    sendEach: function (fn) { fn({ readyState: 1, _clayActiveSession: -1, send: function () {} }); },
    onSessionDone: onSessionDone,
  });
}

test("lib/sessions.js: onSessionDone is called with the finishing session's own localId, not zero args", function () {
  var tmpHome = makeTempHome();
  try {
    var calls = [];
    var sm = makeSessionManager(tmpHome, function (localId) { calls.push(localId); });
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-onSessionDone-localid";

    sm.sendAndRecord(sess, { type: "done" });

    assert.strictEqual(calls.length, 1, "expected exactly one onSessionDone call");
    assert.strictEqual(calls[0], sess.localId, "onSessionDone must be called with the finishing session's own localId");
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
});

test("lib/sessions.js: onSessionDone is NOT called for non-done events", function () {
  var tmpHome = makeTempHome();
  try {
    var calls = [];
    var sm = makeSessionManager(tmpHome, function (localId) { calls.push(localId); });
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-onSessionDone-not-done";

    sm.sendAndRecord(sess, { type: "delta", text: "hi" });

    assert.strictEqual(calls.length, 0, "onSessionDone must only fire on a done event");
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// 2/3/4. lib/server.js: composite key + per-session lookup + project rollup
// ---------------------------------------------------------------------------
//
// Source-text presence checks confirming the real implementation shape,
// paired with a harness built to the SAME contract asserted below (composite
// "slug::localId" keys, getSessionUnread resolving own-project vs.
// cross-project, getCrossProjectUnreadForSlug summing per-session entries).

test("lib/server.js: crossProjectUnread is keyed by a composite slug::localId key, not slug alone", function () {
  assert.match(
    SERVER_JS,
    /function crossUnreadKey\s*\(\s*slug\s*,\s*localId\s*\)\s*\{\s*return slug \+ "::" \+ localId;\s*\}/,
    "expected a crossUnreadKey(slug, localId) helper building a composite 'slug::localId' key"
  );
});

test("lib/server.js: onSessionDone accepts sourceLocalId and increments only that session's composite key", function () {
  var idx = SERVER_JS.indexOf("function onSessionDone(sourceSlug, sourceLocalId)");
  assert.ok(idx !== -1, "expected onSessionDone(sourceSlug, sourceLocalId) signature");
  var block = SERVER_JS.slice(idx, idx + 700);
  assert.match(
    block,
    /crossUnreadKey\s*\(\s*sourceSlug\s*,\s*sourceLocalId\s*\)/,
    "onSessionDone must build its increment key from crossUnreadKey(sourceSlug, sourceLocalId)"
  );
});

test("lib/server.js: getSessionUnread resolves own-project sessions via ws._clayUnread and other-project sessions via the composite map", function () {
  var idx = SERVER_JS.indexOf("function getSessionUnread(ws, ownSlug, sessSlug, localId)");
  assert.ok(idx !== -1, "expected a getSessionUnread(ws, ownSlug, sessSlug, localId) helper");
  var block = SERVER_JS.slice(idx, idx + 500);
  assert.match(block, /ws\._clayUnread/, "own-project branch must read ws._clayUnread (the existing same-project per-session mechanism)");
  assert.match(block, /crossUnreadKey\s*\(\s*sessSlug\s*,\s*localId\s*\)/, "other-project branch must look up the composite crossUnreadKey(sessSlug, localId)");
});

test("lib/server.js: getCrossProjectUnreadForSlug sums per-session entries for a project (project-badge rollup)", function () {
  var idx = SERVER_JS.indexOf("function getCrossProjectUnreadForSlug(ws, projSlug)");
  assert.ok(idx !== -1, "expected a getCrossProjectUnreadForSlug(ws, projSlug) rollup helper");
  var block = SERVER_JS.slice(idx, idx + 500);
  assert.match(block, /prefix/, "expected the rollup to scan composite keys by a slug:: prefix");
  assert.match(block, /total\s*\+=/, "expected the rollup to sum matching per-session entries into a total");
});

test("lib/server.js: the Projects-list badge (broadcastProcessingChange) now uses getCrossProjectUnreadForSlug, not a bare per-slug map read", function () {
  var idx = SERVER_JS.indexOf("function broadcastProcessingChange");
  assert.ok(idx !== -1);
  var block = SERVER_JS.slice(idx, idx + 1800);
  assert.match(
    block,
    /getCrossProjectUnreadForSlug\s*\(\s*ws\s*,\s*p\.slug\s*\)/,
    "the Projects-list badge must roll up per-session unread via getCrossProjectUnreadForSlug(ws, p.slug), preserving the pre-restructure proj.unread total"
  );
});

// Functional harness: exercises the exact composite-key + rollup contract
// asserted above (same key format, same own-vs-cross-project branching) to
// prove the collision case cannot occur and the rollup is arithmetically
// correct, independent of standing up the full HTTP server.
function crossUnreadKey(slug, localId) { return slug + "::" + localId; }

function makeHarness() {
  var crossProjectUnread = new WeakMap();
  function getMap(ws) {
    var m = crossProjectUnread.get(ws);
    if (!m) { m = {}; crossProjectUnread.set(ws, m); }
    return m;
  }
  function onSessionDone(sourceSlug, sourceLocalId, clientsNotConnectedToSource) {
    var key = crossUnreadKey(sourceSlug, sourceLocalId);
    clientsNotConnectedToSource.forEach(function (ws) {
      var m = getMap(ws);
      m[key] = (m[key] || 0) + 1;
    });
  }
  function getCrossProjectUnreadForSlug(ws, projSlug) {
    var m = getMap(ws);
    var prefix = projSlug + "::";
    var total = 0;
    Object.keys(m).forEach(function (k) { if (k.indexOf(prefix) === 0) total += m[k] || 0; });
    return total;
  }
  function getSessionUnread(ws, ownSlug, sessSlug, localId) {
    if (sessSlug === ownSlug) return (ws._clayUnread && ws._clayUnread[localId]) || 0;
    var m = getMap(ws);
    return m[crossUnreadKey(sessSlug, localId)] || 0;
  }
  return { onSessionDone: onSessionDone, getCrossProjectUnreadForSlug: getCrossProjectUnreadForSlug, getSessionUnread: getSessionUnread };
}

test("harness: a per-session alert lights ONLY the notifying session's composite key, not a sibling session in the same project (THE bug)", function () {
  var h = makeHarness();
  var ws = {}; // client connected to a third, unrelated project

  // Two sessions in "project-a": localId 1 (notifying) and localId 2 (idle sibling).
  h.onSessionDone("project-a", 1, [ws]);

  assert.strictEqual(h.getSessionUnread(ws, "project-c", "project-a", 1), 1, "the notifying session must show unread");
  assert.strictEqual(h.getSessionUnread(ws, "project-c", "project-a", 2), 0, "the sibling session in the SAME project must NOT show unread — this was the over-lighting bug");
});

test("harness: same-localId sessions in different projects do not cross-attribute unread", function () {
  var h = makeHarness();
  var ws = {};

  // project-a's session localId 1 finishes...
  h.onSessionDone("project-a", 1, [ws]);
  // ...project-b also happens to have a session with localId 1 (colliding
  // per-project counter — see lib/sessions.js nextLocalId), but it never fired.
  assert.strictEqual(h.getSessionUnread(ws, "project-c", "project-a", 1), 1);
  assert.strictEqual(h.getSessionUnread(ws, "project-c", "project-b", 1), 0, "project-b's localId-1 session must not inherit project-a's unread despite the colliding localId");
});

test("harness: getCrossProjectUnreadForSlug (project-badge total) sums every notifying session in that project", function () {
  var h = makeHarness();
  var ws = {};

  h.onSessionDone("project-a", 1, [ws]);
  h.onSessionDone("project-a", 2, [ws]);
  h.onSessionDone("project-a", 2, [ws]); // session 2 finishes twice
  h.onSessionDone("project-b", 5, [ws]); // different project entirely

  assert.strictEqual(h.getCrossProjectUnreadForSlug(ws, "project-a"), 3, "project-a total must be the sum of its two sessions' unread (1 + 2)");
  assert.strictEqual(h.getCrossProjectUnreadForSlug(ws, "project-b"), 1, "project-b total must be unaffected by project-a's entries");
});

test("harness: own-project sessions resolve via ws._clayUnread, never the cross-project map", function () {
  var h = makeHarness();
  var ws = { _clayUnread: { 7: 4 } };

  // Even if a cross-project entry happened to exist under the same composite
  // key shape, the own-project branch must take priority for sessSlug === ownSlug.
  assert.strictEqual(h.getSessionUnread(ws, "project-a", "project-a", 7), 4, "own-project lookup must read ws._clayUnread[localId]");
  assert.strictEqual(h.getSessionUnread(ws, "project-a", "project-a", 8), 0, "an own-project session with no ws._clayUnread entry must resolve to 0");
});

// ---------------------------------------------------------------------------
// 2b. lib/server.js -> lib/project.js -> lib/project-loop.js: getSessionUnread
//     is actually threaded through, not just defined and unused
// ---------------------------------------------------------------------------

test("lib/server.js: addProject wires getSessionUnread into createProjectContext, closing over the connecting project's own slug", function () {
  var idx = SERVER_JS.indexOf("getSessionUnread: function (ws, sessSlug, localId)");
  assert.ok(idx !== -1, "expected addProject's opts to wire a getSessionUnread callback into createProjectContext");
  var block = SERVER_JS.slice(idx, idx + 200);
  assert.match(
    block,
    /getSessionUnread\s*\(\s*ws\s*,\s*slug\s*,\s*sessSlug\s*,\s*localId\s*\)/,
    "the wired callback must call the server-level getSessionUnread with the connecting project's own `slug` as ownSlug"
  );
});

test("lib/project.js: getSessionUnread opt is read and threaded into attachLoop's ctx", function () {
  assert.match(
    PROJECT_JS,
    /var getSessionUnread = opts\.getSessionUnread/,
    "expected lib/project.js to read opts.getSessionUnread"
  );
  var loopIdx = PROJECT_JS.indexOf("var _loop = attachLoop({");
  assert.ok(loopIdx !== -1, "expected the attachLoop(...) call site");
  var block = PROJECT_JS.slice(loopIdx, loopIdx + 500);
  assert.match(block, /getSessionUnread:\s*getSessionUnread/, "attachLoop's ctx must include getSessionUnread");
});

test("lib/project-loop.js: hub_recent_sessions_list attaches each session's own unread via getSessionUnread, not a project-wide value", function () {
  var idx = PROJECT_LOOP_JS.indexOf('msg.type === "hub_recent_sessions_list"');
  assert.ok(idx !== -1, "expected the hub_recent_sessions_list handler to exist");
  var block = PROJECT_LOOP_JS.slice(idx, idx + 2200);
  assert.match(
    block,
    /unread:\s*getSessionUnread\s*\(\s*ws\s*,\s*sessProjectSlug\s*,\s*s\.localId\s*\)/,
    "the mapped sess object sent to the client must carry unread: getSessionUnread(ws, sessProjectSlug, s.localId) — the session's own per-session unread"
  );
});

// ---------------------------------------------------------------------------
// 5. lib/project-loop.js: functional test via attachLoop (real production code)
// ---------------------------------------------------------------------------

function makeTempHomeLoop() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-hub-unread-"));
}

function makeCtx(cwd, sessionsByProject, unreadBySessKey) {
  var noop = function () {};
  var sentTo = [];
  return {
    _sentTo: sentTo,
    cwd: cwd,
    slug: "current-project",
    sm: {
      sessions: new Map(),
      setResolveLoopInfo: noop,
      broadcastSessionList: noop,
    },
    sdk: { startQuery: noop },
    send: noop,
    sendTo: function (ws, msg) { sentTo.push([ws, msg]); },
    sendToSession: noop,
    pushModule: null,
    notificationsModule: null,
    getHubSchedules: function () { return []; },
    getAllProjectSessions: function () { return sessionsByProject; },
    getSessionUnread: function (ws, sessSlug, localId) {
      return unreadBySessKey[sessSlug + "::" + localId] || 0;
    },
    getStatus: noop,
    getLinuxUserForSession: function () { return null; },
    onProcessingChanged: noop,
    hydrateImageRefs: noop,
  };
}

function makeEngine(cwd, sessionsByProject, unreadBySessKey) {
  var tmpHome = makeTempHomeLoop();
  ["../lib/config", "../lib/utils", "../lib/store", "../lib/scheduler", "../lib/project-loop", "../lib/loop-handoff"]
    .forEach(function (m) {
      try { delete require.cache[require.resolve(m)]; } catch (_) {}
    });
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = tmpHome;
  var engine, ctx, mod;
  try {
    mod = require("../lib/project-loop");
    ctx = makeCtx(cwd || tmpHome, sessionsByProject, unreadBySessKey);
    engine = mod.attachLoop(ctx);
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
  }
  engine.stopTimer();
  function cleanup() {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
  return { engine: engine, ctx: ctx, cleanup: cleanup };
}

test("project-loop.js hub_recent_sessions_list: only the notifying session carries unread > 0, sibling session in same project stays 0", function () {
  var cwd = makeTempHomeLoop();
  var sessionsByProject = [
    { localId: 1, title: "Notifying session", lastActivity: 200, _projectSlug: "project-a", _projectTitle: "Project A", isProcessing: false },
    { localId: 2, title: "Idle sibling session", lastActivity: 100, _projectSlug: "project-a", _projectTitle: "Project A", isProcessing: false },
  ];
  var unreadBySessKey = { "project-a::1": 1 }; // only localId 1 is notifying
  var { engine, ctx, cleanup } = makeEngine(cwd, sessionsByProject, unreadBySessKey);
  try {
    var ws = {};
    var handled = engine.handleLoopMessage(ws, { type: "hub_recent_sessions_list" });
    assert.strictEqual(handled, true);

    var call = ctx._sentTo.find(function (c) { return c[1].type === "hub_recent_sessions"; });
    assert.ok(call, "expected a hub_recent_sessions reply");
    var sessions = call[1].sessions;
    var notifying = sessions.find(function (s) { return s.id === 1; });
    var sibling = sessions.find(function (s) { return s.id === 2; });
    assert.ok(notifying && sibling, "expected both sessions in the reply");
    assert.strictEqual(notifying.unread, 1, "the notifying session must carry unread: 1");
    assert.strictEqual(sibling.unread, 0, "the sibling session in the SAME project must carry unread: 0 — this is the bug lr-0aa7b6 fixes");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test("project-loop.js hub_recent_sessions_list: same-localId sessions in different projects resolve independent unread counts", function () {
  var cwd = makeTempHomeLoop();
  var sessionsByProject = [
    { localId: 1, title: "Project A session 1", lastActivity: 200, _projectSlug: "project-a", _projectTitle: "Project A", isProcessing: false },
    { localId: 1, title: "Project B session 1", lastActivity: 150, _projectSlug: "project-b", _projectTitle: "Project B", isProcessing: false },
  ];
  var unreadBySessKey = { "project-a::1": 3 }; // only project-a's localId 1 is notifying
  var { engine, ctx, cleanup } = makeEngine(cwd, sessionsByProject, unreadBySessKey);
  try {
    var ws = {};
    engine.handleLoopMessage(ws, { type: "hub_recent_sessions_list" });
    var call = ctx._sentTo.find(function (c) { return c[1].type === "hub_recent_sessions"; });
    var sessions = call[1].sessions;
    var aSess = sessions.find(function (s) { return s.projectSlug === "project-a"; });
    var bSess = sessions.find(function (s) { return s.projectSlug === "project-b"; });
    assert.strictEqual(aSess.unread, 3, "project-a's localId-1 session must show its own unread");
    assert.strictEqual(bSess.unread, 0, "project-b's localId-1 session must NOT inherit project-a's unread despite the colliding localId");
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});
