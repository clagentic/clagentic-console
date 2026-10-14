"use strict";
// A browser resume_session that fails leaves a journal line naming the project,
// the session and the reason, as well as the error the client is sent.

var test = require("node:test");
var assert = require("node:assert/strict");
var world = require("./prompt-harness-world");

test("a failed resume_session logs project, session and reason, and still tells the client", async function (t) {
  var errors = [];
  t.mock.method(console, "error", function () { errors.push(Array.prototype.join.call(arguments, " ")); });
  await world.withServer(async function (server) {
    // Required here: the harness re-evaluates lib/ on start, and project-sessions
    // looks session-resume up at call time.
    t.mock.method(require("../lib/session-resume"), "resumeStoredSession", function () {
      return Promise.reject(new Error("meta record\nFORGED line is gone"));
    });
    var c = world.client();
    server.connect(c.ws);
    server.handlers.handleSessionsMessage(c.ws, { type: "resume_session", cliSessionId: "cli-abc-123" });
    await world.flush();

    var lines = errors.filter(function (l) { return l.indexOf("[project-sessions] resume_session failed") === 0; });
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "[project-sessions] resume_session failed: project=harness session=cli-abc-123 reason=meta record FORGED line is gone");
    var sent = c.inbox.filter(function (m) { return m.type === "error"; });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /^Could not resume this session: /);
  });
});
