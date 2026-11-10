"use strict";

// The WebKit push contract over the service worker's push handler: iOS and
// desktop Safari need every push event to show a notification. Runs
// handlePush per user agent, per scenario, against a fake registration that
// fails any push that showed nothing.

var test = require("node:test");
var assert = require("node:assert/strict");

var payloads = require("../lib/notify/payload");
var { createTypeRegistry } = require("../lib/notify/type-registry");
var { registerBuiltins } = require("../lib/notify/types");
var contract = require("./helpers/webkit-push-contract");

var registry = registerBuiltins(createTypeRegistry());
var TARGET = { slug: "p", sessionId: 3, requestId: "r1" };
var MATE_TARGET = { peerId: "u2" };
var SYSTEM_TARGET = { slug: null, sessionId: null };

var STRICT = [
  { name: "iPhone", ua: contract.IOS_UA },
  { name: "desktop Safari", ua: contract.SAFARI_UA },
  { name: "Android Chrome", ua: contract.ANDROID_UA },
  { name: "desktop Chrome", ua: contract.CHROME_DESKTOP_UA },
];
var AGENTS = STRICT;

function targetFor(name) {
  if (name === "mate_dm") return MATE_TARGET;
  if (registry.get(name).category === "system") return SYSTEM_TARGET;
  return TARGET;
}

function corePayload(name) {
  return payloads.buildPayload(registry.get(name), targetFor(name), { title: "T", body: "B" });
}

function closePush(tags) {
  return payloads.buildClose(registry.get("permission_request"), tags);
}

function tick() {
  return new Promise(function (r) { setImmediate(r); });
}

AGENTS.forEach(function (agent) {
  registry.names().forEach(function (name) {
    test("[" + agent.name + "] core type " + name + " shows a notification", async function () {
      var w = contract.createContractWorld(agent.ua);
      var shown = await w.runPush(name, corePayload(name));
      assert.ok(shown.length >= 1, "AC4: at least one notification shown");
      assert.equal(w.live().length, 1);
    });
  });
});

STRICT.forEach(function (agent) {
  test("[" + agent.name + "] close with a live match closes it and leaves no placeholder", async function () {
    var w = contract.createContractWorld(agent.ua);
    var data = corePayload("permission_request");
    await w.runPush("open", data);
    var shown = await w.runPush("close with match", closePush(data.tag));
    assert.ok(shown.length >= 1, "the close push showed something");
    assert.equal(shown[0].options.silent, true);
    assert.equal(w.live().length, 0, "AC1: nothing lingers after the timer");
  });

  test("[" + agent.name + "] close with no match shows one silent notice and closes it", async function () {
    var w = contract.createContractWorld(agent.ua);
    var shown = await w.runPush("close without match", closePush(["n:permission_request:p:3:r1", "n:ask_user:p:3:r1"]));
    assert.equal(shown.length, 1, "AC2: exactly one notice");
    assert.equal(shown[0].options.silent, true);
    assert.equal(w.live().length, 0);
  });

  test("[" + agent.name + "] a newer live notification that took the tag survives the placeholder's close (R2)", async function () {
    var w = contract.createContractWorld(agent.ua);
    var first = corePayload("permission_request");
    await w.runPush("open", first);
    w.holdLingers();
    var closing = w.startPush("close with newer live", closePush(first.tag));
    await tick();
    assert.equal(w.lingers.length, 1, "the placeholder waits on the linger timer");
    await w.runPush("newer live", corePayload("permission_request"));
    w.lingers[0]();
    var shown = await closing.settled;
    assert.ok(shown.length >= 1);
    var live = w.liveUnder(first.tag);
    assert.equal(live.length, 1, "AC2: the newer live notification stays");
    assert.equal(live[0].data.core, 1);
  });
});

STRICT.forEach(function (agent) {
  var SHOWS_NOTHING = [
    ["a test push", { type: "test" }],
    ["an unmarked legacy push", { type: "done", title: "d", body: "b", tag: "any" }],
    ["a malformed payload", null],
    ["a payload that is not an object", "oops"],
    ["a close naming no tags", { type: "notify_close", core: 1, tags: [] }],
  ];
  SHOWS_NOTHING.forEach(function (row) {
    test("[" + agent.name + "] " + row[0] + " shows one silent notice and closes it", async function () {
      var w = contract.createContractWorld(agent.ua);
      var shown = await w.runPush(row[0], row[1]);
      assert.equal(shown.length, 1);
      assert.equal(shown[0].options.silent, true);
      assert.equal(w.live().length, 0);
    });
  });
});

test("the harness fails a push that shows nothing (AC5)", async function () {
  var w = contract.createContractWorld(contract.IOS_UA);
  var realHandle = require("../lib/public/notify-sw-logic.js").handlePush;
  var sw = require("../lib/public/notify-sw-logic.js");
  sw.handlePush = function () { return Promise.resolve(); };
  try {
    await assert.rejects(
      w.runPush("shows nothing", { type: "done" }),
      /push 'shows nothing' showed no notification/
    );
  } finally {
    sw.handlePush = realHandle;
  }
});
