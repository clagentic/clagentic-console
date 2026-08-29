"use strict";
// Regression coverage for lr-13c047 (MILLER diagnosis, two independent
// phantom-notification-badge bugs bounced to AMoS):
//
// BADGE A — Projects-tab cross-project unread rollup (lib/server.js
// crossProjectUnread, keyed "slug::localId" per lr-0aa7b6). Before this fix
// the map was increment-only: onSessionDone() incremented a client's entry
// for every notifying session, and the ONLY clear paths were (1) connecting
// to the notifying project (prefix zero at connect time) or (2) same-project
// switchSession zeroing ws._clagenticUnread[localId]. If the notifying session
// was deleted before any client ever reconnected to its project, the entry
// became permanently unreachable — a phantom that inflates the badge
// forever. This suite covers the two additions:
//
//   1. lib/sessions.js: deleteSession / deleteSessionQuiet (the latter also
//      used by deleteSessionsBulk) now fire opts.onSessionDeleted(localId) —
//      real production code, driven via createSessionManager.
//   2. lib/server.js: onSessionDeleted(sourceSlug, sourceLocalId) prunes the
//      crossUnreadKey(sourceSlug, sourceLocalId) entry from every connected
//      client's crossProjectUnread map.
//   3. lib/server.js: markCrossProjectRead(ws, projSlug) zeros every
//      crossProjectUnread entry for a project slug, for one client, without
//      requiring that client to switch into the project — the "mark
//      cross-project read" non-switch clear path.
//   4. lib/ws-schema.js / lib/project-sessions.js: a client-initiated
//      "mark_cross_project_read" WS message reaches markCrossProjectRead.
//
// BADGE B — header terminal-count badge (#terminal-count, counts PTY tabs
// where !exited). The count itself was already correct at the instant a
// term_exited/term_list message was reconciled client-side (both handlers
// call renderTabBar() -> updateTerminalBadge()). The actual phantom-lingering
// bug MILLER cited is server-side: an exited PTY session had NO automatic
// removal path from lib/terminal-manager.js's `terminals` Map — only an
// explicit term_close (user action) ever called terminals.delete(id) — so a
// dead tab (and its stale term_list entry) could linger indefinitely until a
// user noticed and manually closed it. Fix: auto-close a session a short
// grace period after its PTY exits.
//
//   5. lib/terminal-manager.js: pty.onExit schedules an auto-close timer
//      (EXITED_AUTOCLOSE_MS) that calls close(id, null), removing the
//      session from `terminals` — so list()/term_list eventually stop
//      including it without requiring a manual term_close.
//   6. lib/terminal-manager.js: close() clears any pending auto-close timer,
//      so a manual close before the grace window elapses does not leave a
//      stray timer that later calls close() again with nothing to act on.
//
// lib/server.js is a large createServer() factory that stands up a real HTTP
// server and is not a practical direct-require unit-test target (matching
// the established convention in test/server-cross-project-unread-per-
// session-lr-0aa7b6.test.js) — its Badge A additions are covered via a
// source-text presence check plus a functional harness built to the exact
// same contract asserted against the source. lib/sessions.js and
// lib/terminal-manager.js additions are small, self-contained factories that
// ARE practical to require directly, so those are driven as real production
// code (matching test/session-lifecycle-lr-e0de.test.js's established
// pattern).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var os = require("os");

function readMod(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

var SERVER_JS = readMod("lib/server.js");
var PROJECT_JS = readMod("lib/project.js");
var WS_SCHEMA_JS = readMod("lib/ws-schema.js");
var PROJECT_SESSIONS_JS = readMod("lib/project-sessions.js");

// ---------------------------------------------------------------------------
// 1. lib/sessions.js: onSessionDeleted fires on delete — real production code
// ---------------------------------------------------------------------------

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-lr13c047-"));
}

function makeSessionManager(tmpHome, onSessionDeleted) {
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
    sendEach: function (fn) { fn({ readyState: 1, _clagenticActiveSession: -1, send: function () {} }); },
    onSessionDeleted: onSessionDeleted,
  });
}

test("lib/sessions.js: deleteSession fires onSessionDeleted with the removed session's own localId", function () {
  var tmpHome = makeTempHome();
  try {
    var calls = [];
    var sm = makeSessionManager(tmpHome, function (localId) { calls.push(localId); });
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-delete-onSessionDeleted";
    var localId = sess.localId;

    sm.deleteSession(localId, null);

    assert.strictEqual(calls.length, 1, "expected exactly one onSessionDeleted call");
    assert.strictEqual(calls[0], localId, "onSessionDeleted must be called with the deleted session's own localId");
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
});

test("lib/sessions.js: deleteSessionsBulk fires onSessionDeleted once per deleted session (via deleteSessionQuiet)", function () {
  var tmpHome = makeTempHome();
  try {
    var calls = [];
    var sm = makeSessionManager(tmpHome, function (localId) { calls.push(localId); });
    var sessA = sm.createSessionRaw({});
    sessA.cliSessionId = "sess-bulk-a";
    var sessB = sm.createSessionRaw({});
    sessB.cliSessionId = "sess-bulk-b";
    var idA = sessA.localId;
    var idB = sessB.localId;

    sm.deleteSessionsBulk([idA, idB], null);

    assert.strictEqual(calls.length, 2, "expected onSessionDeleted once per bulk-deleted session");
    assert.ok(calls.indexOf(idA) !== -1 && calls.indexOf(idB) !== -1, "both deleted localIds must have fired onSessionDeleted");
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
});

test("lib/sessions.js: onSessionDeleted defaults to a no-op when not supplied (no crash)", function () {
  var tmpHome = makeTempHome();
  try {
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
    var sm = sessions.createSessionManager({
      cwd: tmpHome,
      send: function () {},
      sendTo: function () {},
      sendEach: function () {},
    });
    var sess = sm.createSessionRaw({});
    sess.cliSessionId = "sess-no-callback";
    assert.doesNotThrow(function () { sm.deleteSession(sess.localId, null); });
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// 2/3/4. lib/server.js: prune-on-delete + non-switch "mark read" clear path
// ---------------------------------------------------------------------------

test("lib/server.js: onSessionDeleted(sourceSlug, sourceLocalId) exists and deletes the composite crossUnreadKey entry", function () {
  var idx = SERVER_JS.indexOf("function onSessionDeleted(sourceSlug, sourceLocalId)");
  assert.ok(idx !== -1, "expected an onSessionDeleted(sourceSlug, sourceLocalId) helper");
  var block = SERVER_JS.slice(idx, idx + 700);
  assert.match(
    block,
    /crossUnreadKey\s*\(\s*sourceSlug\s*,\s*sourceLocalId\s*\)/,
    "onSessionDeleted must build the same composite key as onSessionDone/getSessionUnread"
  );
  assert.match(block, /delete map\[key\]/, "onSessionDeleted must delete the composite-key entry, not merely zero it, so a subsequent same-id session can't inherit a stale zeroed entry");
});

test("lib/server.js: markCrossProjectRead(ws, projSlug) exists and zeros every composite entry under that project's prefix", function () {
  var idx = SERVER_JS.indexOf("function markCrossProjectRead(ws, projSlug)");
  assert.ok(idx !== -1, "expected a markCrossProjectRead(ws, projSlug) helper");
  var block = SERVER_JS.slice(idx, idx + 700);
  assert.match(block, /prefix/, "expected markCrossProjectRead to scan composite keys by a slug:: prefix, matching getCrossProjectUnreadForSlug's convention");
  assert.match(block, /map\[keys\[i\]\]\s*=\s*0/, "expected markCrossProjectRead to zero (not delete) matching entries — a zeroed entry is still a valid 'no unread' record for that session");
});

test("lib/server.js: addProject wires onSessionDeleted and markCrossProjectRead into createProjectContext, closing over the connecting project's own slug", function () {
  var deletedIdx = SERVER_JS.indexOf("onSessionDeleted: function (localId) { onSessionDeleted(slug, localId); }");
  assert.ok(deletedIdx !== -1, "expected addProject's opts to wire an onSessionDeleted callback closing over `slug`");

  var markIdx = SERVER_JS.indexOf("markCrossProjectRead: function (ws, projSlug) { markCrossProjectRead(ws, projSlug); }");
  assert.ok(markIdx !== -1, "expected addProject's opts to wire a markCrossProjectRead callback");
});

test("lib/project.js: onSessionDeleted opt is read and threaded into createSessionManager", function () {
  assert.match(
    PROJECT_JS,
    /var onSessionDeleted = opts\.onSessionDeleted/,
    "expected lib/project.js to read opts.onSessionDeleted"
  );
  var smIdx = PROJECT_JS.indexOf("var sm = createSessionManager({");
  assert.ok(smIdx !== -1, "expected the createSessionManager(...) call site");
  var block = PROJECT_JS.slice(smIdx, smIdx + 700);
  assert.match(block, /onSessionDeleted:\s*onSessionDeleted/, "createSessionManager's opts must include onSessionDeleted");
});

test("lib/ws-schema.js: mark_cross_project_read is registered as a c2s message handled by lib/project-sessions.js", function () {
  assert.match(
    WS_SCHEMA_JS,
    /"mark_cross_project_read":\s*\{\s*direction:\s*"c2s",\s*handler:\s*"lib\/project-sessions\.js"/,
    "expected mark_cross_project_read registered in the WS schema registry"
  );
});

test("lib/project-sessions.js: mark_cross_project_read handler calls opts.markCrossProjectRead(ws, msg.slug)", function () {
  var idx = PROJECT_SESSIONS_JS.indexOf('msg.type === "mark_cross_project_read"');
  assert.ok(idx !== -1, "expected a mark_cross_project_read handler branch");
  var block = PROJECT_SESSIONS_JS.slice(idx, idx + 500);
  assert.match(
    block,
    /opts\.markCrossProjectRead\s*\(\s*ws\s*,\s*msg\.slug\s*\)/,
    "the handler must forward to opts.markCrossProjectRead(ws, msg.slug)"
  );
});

// Functional harness: exercises the exact prune + non-switch-clear contract
// asserted above (same composite key format as lr-0aa7b6's onSessionDone),
// proving both fixes are arithmetically correct independent of standing up
// the full HTTP server.
function crossUnreadKey(slug, localId) { return slug + "::" + localId; }

function makeHarness() {
  var crossProjectUnread = new WeakMap();
  function getMap(ws) {
    var m = crossProjectUnread.get(ws);
    if (!m) { m = {}; crossProjectUnread.set(ws, m); }
    return m;
  }
  function onSessionDone(sourceSlug, sourceLocalId, clients) {
    var key = crossUnreadKey(sourceSlug, sourceLocalId);
    clients.forEach(function (ws) {
      var m = getMap(ws);
      m[key] = (m[key] || 0) + 1;
    });
  }
  function onSessionDeleted(sourceSlug, sourceLocalId, clients) {
    var key = crossUnreadKey(sourceSlug, sourceLocalId);
    clients.forEach(function (ws) {
      var m = getMap(ws);
      delete m[key];
    });
  }
  function markCrossProjectRead(ws, projSlug) {
    var m = getMap(ws);
    var prefix = projSlug + "::";
    Object.keys(m).forEach(function (k) {
      if (k.indexOf(prefix) === 0) m[k] = 0;
    });
  }
  function getCrossProjectUnreadForSlug(ws, projSlug) {
    var m = getMap(ws);
    var prefix = projSlug + "::";
    var total = 0;
    Object.keys(m).forEach(function (k) { if (k.indexOf(prefix) === 0) total += m[k] || 0; });
    return total;
  }
  return {
    onSessionDone: onSessionDone,
    onSessionDeleted: onSessionDeleted,
    markCrossProjectRead: markCrossProjectRead,
    getCrossProjectUnreadForSlug: getCrossProjectUnreadForSlug,
  };
}

test("harness: deleting the notifying session prunes its unread contribution from the Projects-tab rollup (THE Badge A bug)", function () {
  var h = makeHarness();
  var ws = {};

  h.onSessionDone("project-a", 1, [ws]);
  assert.strictEqual(h.getCrossProjectUnreadForSlug(ws, "project-a"), 1, "unread should accrue before delete");

  // The notifying session is deleted before this client ever reconnects to
  // project-a — prior to the fix, this entry was permanently unreachable.
  h.onSessionDeleted("project-a", 1, [ws]);

  assert.strictEqual(h.getCrossProjectUnreadForSlug(ws, "project-a"), 0, "deleting the notifying session must prune its unread contribution, not leave a phantom");
});

test("harness: deleting one session does not affect a sibling session's unread in the same project", function () {
  var h = makeHarness();
  var ws = {};

  h.onSessionDone("project-a", 1, [ws]);
  h.onSessionDone("project-a", 2, [ws]);
  assert.strictEqual(h.getCrossProjectUnreadForSlug(ws, "project-a"), 2);

  h.onSessionDeleted("project-a", 1, [ws]);

  assert.strictEqual(h.getCrossProjectUnreadForSlug(ws, "project-a"), 1, "only the deleted session's contribution should be pruned");
});

test("harness: markCrossProjectRead zeros every unread entry for a project slug without requiring a switch/connect", function () {
  var h = makeHarness();
  var ws = {};

  h.onSessionDone("project-a", 1, [ws]);
  h.onSessionDone("project-a", 2, [ws]);
  h.onSessionDone("project-b", 9, [ws]);
  assert.strictEqual(h.getCrossProjectUnreadForSlug(ws, "project-a"), 2);
  assert.strictEqual(h.getCrossProjectUnreadForSlug(ws, "project-b"), 1);

  h.markCrossProjectRead(ws, "project-a");

  assert.strictEqual(h.getCrossProjectUnreadForSlug(ws, "project-a"), 0, "project-a's badge must clear");
  assert.strictEqual(h.getCrossProjectUnreadForSlug(ws, "project-b"), 1, "project-b must be unaffected by marking project-a read");
});

// ---------------------------------------------------------------------------
// 5/6. lib/terminal-manager.js: exited PTY sessions are auto-pruned —
//      real production code
// ---------------------------------------------------------------------------

function requireFreshTerminalManager() {
  // NOTE: bust lib/terminal-manager's own cache entry only. lib/terminal's
  // cache entry must NOT be busted here — withStubbedPty below patches its
  // cached `.exports` in place specifically so that busting-then-refreshing
  // it wouldn't discard the stub before terminal-manager.js's own
  // `require("./terminal")` call picks it up.
  try { delete require.cache[require.resolve("../lib/terminal-manager")]; } catch (_) {}
  return require("../lib/terminal-manager");
}

// Stub out lib/terminal's createTerminal so no real PTY/child process is
// spawned — the manager only needs an object shaped like { onData, onExit,
// write, resize, kill } to exercise its own bookkeeping. Patches the cached
// module's `.exports` in place (rather than busting the cache) so that
// lib/terminal-manager.js's `require("./terminal")` — resolved fresh inside
// requireFreshTerminalManager() below — picks up the stub instead of
// re-executing the real module (which would try to load @lydell/node-pty).
function withStubbedPty(fn) {
  var terminalModPath = require.resolve("../lib/terminal");
  var real = require(terminalModPath);
  var stubExitHandlers = [];
  var stub = Object.assign({}, real, {
    createTerminal: function () {
      var dataHandlers = [];
      return {
        onData: function (h) { dataHandlers.push(h); },
        onExit: function (h) { stubExitHandlers.push(h); },
        write: function () {},
        resize: function () {},
        kill: function () {},
      };
    },
  });
  require.cache[terminalModPath].exports = stub;
  try {
    return fn(function fireExit(exitCode) {
      stubExitHandlers.forEach(function (h) { h({ exitCode: exitCode == null ? 0 : exitCode }); });
    });
  } finally {
    require.cache[terminalModPath].exports = real;
  }
}

test("lib/terminal-manager.js: an exited session is auto-pruned from list() after the grace window, without a manual term_close", function (t) {
  return withStubbedPty(function (fireExit) {
    return new Promise(function (resolve) {
      var tm = requireFreshTerminalManager();
      var realSetTimeout = global.setTimeout;
      var scheduled = null;
      // Capture the auto-close timer instead of letting a real 30s timer run
      // in the test process; invoke it synchronously once we control the moment.
      global.setTimeout = function (fn, ms) {
        if (ms >= 1000) { scheduled = fn; return { unref: function () {} }; }
        return realSetTimeout(fn, ms);
      };
      try {
        var mgr = tm.createTerminalManager({ cwd: "/tmp", send: function () {}, sendTo: function () {} });
        var session = mgr.create(80, 24, null, null);
        assert.ok(session, "expected a created terminal session");
        assert.strictEqual(mgr.list(null).length, 1, "session should be listed while alive");

        fireExit(0);

        assert.strictEqual(mgr.list(null)[0].exited, true, "list() must reflect exited: true immediately on PTY exit");
        assert.ok(scheduled, "expected pty.onExit to schedule an auto-close timer");

        // Simulate the grace window elapsing.
        scheduled();

        assert.strictEqual(mgr.list(null).length, 0, "the exited session must be auto-pruned from list() once the grace window elapses — it must not linger forever as a phantom entry");
        resolve();
      } finally {
        global.setTimeout = realSetTimeout;
      }
    });
  });
});

test("lib/terminal-manager.js: a manual close() before the grace window elapses cancels the pending auto-close timer (no double-close crash)", function () {
  return withStubbedPty(function (fireExit) {
    var realSetTimeout = global.setTimeout;
    var realClearTimeout = global.clearTimeout;
    var cleared = [];
    var scheduledId = { id: "fake-timer" };
    global.setTimeout = function (fn, ms) {
      if (ms >= 1000) return scheduledId;
      return realSetTimeout(fn, ms);
    };
    global.clearTimeout = function (t) { cleared.push(t); return realClearTimeout(t); };
    try {
      var tm = requireFreshTerminalManager();
      var mgr = tm.createTerminalManager({ cwd: "/tmp", send: function () {}, sendTo: function () {} });
      var session = mgr.create(80, 24, null, null);

      fireExit(0);
      assert.strictEqual(mgr.list(null).length, 1, "session still listed immediately after exit (grace window not elapsed)");

      // User manually closes the exited tab before the grace window fires.
      mgr.close(session.id, null);

      assert.strictEqual(mgr.list(null).length, 0, "manual close must remove the session");
      assert.ok(cleared.indexOf(scheduledId) !== -1, "manual close must clear the pending auto-close timer to avoid a stray later close() call");
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
  });
});
