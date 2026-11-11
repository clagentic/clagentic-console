"use strict";
// An ask_user or elicitation prompt shows an in-app banner through the
// notification type registry, in the approval category with the approval
// defaults. The banner closes when the prompt is answered, cancelled or
// expires, and the user's approval banner switch suppresses it.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");
var world = require("./prompt-harness-world");
var notifyTypes = require("../lib/notify/types");
var prefs = require("../lib/notification-prefs");

var client = world.client;
var ASK_INPUT = { questions: [{ question: "Which target?" }] };

// One opener per kind: runs the emitter's own path and returns the request id.
var OPENERS = {
  ask_user: function (server) {
    server.sdk({ yokeType: "tool_start", blockId: 0, toolId: "tu-q", toolName: "AskUserQuestion" });
    server.sdk({ yokeType: "tool_input_delta", blockId: 0, partialJson: JSON.stringify(ASK_INPUT) });
    server.sdk({ yokeType: "block_stop", blockId: 0 });
    server.ask("AskUserQuestion", ASK_INPUT, { toolUseID: "tu-q" });
    return "tu-q";
  },
  elicitation: function (server) {
    server.bridge.handleElicitation(server.session, { serverName: "srv", message: "Token?" }, { signal: server.issueSignal().signal });
    assert.ok(server.heldPromptIds().length >= 1);
    return server.heldPromptIds()[0];
  },
};

var ANSWERS = {
  ask_user: { answers: { 0: "prod" } },
  elicitation: { action: "decline" },
};

function observe(server) {
  var c = client();
  server.clients.add(c.ws);
  return {
    created: function (type) {
      return c.inbox.filter(function (m) { return m.type === "notification_created" && m.notification.type === type; });
    },
    dismissedIds: function () {
      return c.inbox.filter(function (m) { return m.type === "notification_dismissed"; }).reduce(function (all, m) { return all.concat(m.ids); }, []);
    },
  };
}

Object.keys(OPENERS).forEach(function (kind) {
  test(kind + " is registered with the banner surface in the approval category", function () {
    var type = notifyTypes.PROMPT_TYPES[kind];
    assert.equal(type.banner, true);
    assert.equal(type.category, "approval");
    assert.equal(prefs.categoryOfNotification(kind), "approval");
    assert.equal(prefs.defaultPrefs().banner.approval, true, "the approval banner is on by default");
  });

  // How the prompt ends: each must close the banner the prompt opened.
  var ENDINGS = {
    answered: function (server, id) { server.sm.prompts.respond(id, ANSWERS[kind]); },
    cancelled: function (server) { server.sm.prompts.cancelSession(server.session, "session_deleted", { record: false }); },
    expired: function (server, id, t) { t.mock.timers.tick(30 * 60000); },
  };

  Object.keys(ENDINGS).forEach(function (ending) {
    test("a " + kind + " prompt shows a banner under default prefs and it closes when the prompt is " + ending, async function (t) {
      await world.withServer(async function (server) {
        var seen = observe(server);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        var id = OPENERS[kind](server);
        var shown = seen.created(kind);
        assert.equal(shown.length, 1, "one banner");
        assert.equal(shown[0].notification.category, "approval");
        assert.equal(shown[0].notification.persistent, true);
        assert.equal(shown[0].notification.meta.requestId, id);
        assert.deepEqual(seen.dismissedIds(), []);

        ENDINGS[ending](server, id, t);
        assert.deepEqual(seen.dismissedIds(), [shown[0].notification.id], "the banner is dismissed");
      });
    });
  });
});

test("switching the approval banner off in the user's preferences suppresses an ask_user or elicitation banner", async function () {
  var storage = {};
  global.localStorage = { getItem: function (k) { return storage[k] || null; }, setItem: function (k, v) { storage[k] = String(v); } };
  global.document = { getElementById: function () { return null; } };
  var modules = path.join(__dirname, "..", "lib", "public", "modules");
  var mod = await import(pathToFileURL(path.join(modules, "notification-prefs.js")).href + "?c=" + Math.random());
  var all = prefs.defaultPrefs();
  mod.handleNotificationPrefs({ type: "notification_prefs", known: true, preset: "all", categories: [], presets: [], prefs: all });
  Object.keys(OPENERS).forEach(function (kind) {
    assert.equal(mod.isSurfaceWanted("banner", prefs.categoryOfNotification(kind)), true, kind + " on by default");
  });
  all.banner.approval = false;
  mod.handleNotificationPrefs({ type: "notification_prefs", known: true, preset: null, categories: [], presets: [], prefs: all });
  Object.keys(OPENERS).forEach(function (kind) {
    assert.equal(mod.isSurfaceWanted("banner", prefs.categoryOfNotification(kind)), false, kind + " suppressed");
  });
});
