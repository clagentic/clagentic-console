"use strict";
// Fakes for the scheduled-input tests: a manual clock with its timers, a
// project holding sessions, and a session-input whose firing is scripted.
// Not a test file (no .test suffix), so the suite does not run it.

var fs = require("fs");
var os = require("os");
var path = require("path");

function makeClock(start) {
  var clock = {
    t: start === undefined ? 1700000000000 : start,
    timers: [],
    nextId: 1,
    now: function () { return clock.t; },
    setTimer: function (fn, ms) {
      var id = clock.nextId++;
      clock.timers.push({ id: id, fn: fn, at: clock.t + ms });
      return id;
    },
    clearTimer: function (id) {
      clock.timers = clock.timers.filter(function (x) { return x.id !== id; });
    },
    advance: async function (ms) {
      var target = clock.t + ms;
      for (;;) {
        var due = clock.timers.filter(function (x) { return x.at <= target; })
          .sort(function (a, b) { return a.at - b.at; })[0];
        if (!due) break;
        clock.timers = clock.timers.filter(function (x) { return x.id !== due.id; });
        clock.t = Math.max(clock.t, due.at);
        due.fn();
        await flush();
      }
      clock.t = target;
    },
  };
  return clock;
}

function flush() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function makeSession(localId, cliSessionId, extra) {
  return Object.assign({ localId: localId, cliSessionId: cliSessionId, isProcessing: false }, extra);
}

function makeProject(cwd, sessions) {
  var map = new Map();
  (sessions || []).forEach(function (s) { map.set(s.localId, s); });
  return { cwd: cwd, sm: { sessions: map } };
}

// A session-input whose fireScheduled answers from `behaviour(req)`; every
// request is kept in `calls`. The default answers like the real one: not-found
// for a session nobody holds, busy for a mid-turn session unless forced.
function makeSessionInput(project, behaviour) {
  var calls = [];
  var input = {
    calls: calls,
    fireScheduled: function (req) {
      calls.push(Object.assign({}, req));
      if (behaviour) return behaviour(req, project);
      var found = null;
      project.sm.sessions.forEach(function (s) {
        if (s.cliSessionId === req.sessionId || String(s.localId) === req.sessionId) found = s;
      });
      if (!found) return { ok: false, result: "not-found", reason: "no such session" };
      if (found.isProcessing && !req.force) return { ok: false, result: "busy", retryable: true, reason: "the session is mid-turn" };
      return { ok: true, result: "delivered" };
    },
  };
  return input;
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || "scheduled-input-"));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  makeClock: makeClock,
  flush: flush,
  makeSession: makeSession,
  makeProject: makeProject,
  makeSessionInput: makeSessionInput,
  tmpDir: tmpDir,
  removeDir: removeDir,
};
