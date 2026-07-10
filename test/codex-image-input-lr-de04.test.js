// Regression tests for lr-de04 — Codex adapter must not silently drop
// image attachments. Previously lib/yoke/adapters/codex.js's pushMessage
// had a `// For now, text-only` stub that iterated over `images` and threw
// the data away. This exercises the real createCodexQueryHandle (exported
// as _test_createCodexQueryHandle) against a fake app-server so reverting
// the fix breaks these tests, the same pattern as
// test/codex-approval-routing-lr-f7a4.test.js.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");

var codexAdapter = require("../lib/yoke/adapters/codex");
var createCodexQueryHandle = codexAdapter._test_createCodexQueryHandle;

var ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Minimal fake app-server, same shape as the lr-f7a4 tests: only implements
// what runQueryLoop / handleServerEvent actually call.
function buildFakeAppServer() {
  var handlers = [];
  var sentTurnStarts = [];

  var appServer = {
    started: true,
    addEventHandler: function (fn, threadId) {
      var entry = { fn: fn, threadId: threadId || null };
      handlers.push(entry);
      return entry;
    },
    removeEventHandler: function (entry) {
      handlers = handlers.filter(function (h) { return h !== entry; });
    },
    updateHandlerThreadId: function (entry, threadId) {
      entry.threadId = threadId || null;
    },
    respond: function () {},
    send: function (method, params) {
      if (method === "thread/start") {
        return Promise.resolve({ thread: { id: "test-thread-1" } });
      }
      if (method === "turn/start") {
        sentTurnStarts.push(params);
        // Complete the turn on the next tick so runQueryLoop's cleanup
        // (post-turnPromise) runs deterministically inside the test.
        setImmediate(function () {
          dispatch({ method: "turn/completed", params: { usage: null } });
        });
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
  };

  function dispatch(msg) {
    handlers.forEach(function (h) {
      if (h.threadId === null || h.threadId === "test-thread-1") h.fn(msg);
    });
  }

  return { appServer: appServer, dispatch: dispatch, sentTurnStarts: sentTurnStarts };
}

function waitForTurnStarts(fake, count) {
  return new Promise(function (resolve, reject) {
    var deadline = Date.now() + 2000;
    (function poll() {
      if (fake.sentTurnStarts.length >= count) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for turn/start"));
      setImmediate(poll);
    })();
  });
}

test("lr-de04: an attached image reaches the app-server as a localImage item, not silently dropped", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, {});

  handle.pushMessage("look at this", [{ mediaType: "image/png", data: ONE_BY_ONE_PNG_BASE64 }]);
  await waitForTurnStarts(fake, 1);

  var input = fake.sentTurnStarts[0].input;
  var imageItems = input.filter(function (item) { return item.type === "localImage"; });
  var textItems = input.filter(function (item) { return item.type === "text"; });

  assert.equal(imageItems.length, 1, "the image must be forwarded as a localImage item");
  assert.equal(typeof imageItems[0].path, "string");
  assert.ok(imageItems[0].path.length > 0);
  assert.equal(textItems.length, 1);
  assert.equal(textItems[0].text, "look at this");

  // The written file must actually contain the decoded image bytes at the
  // moment turn/start is sent (i.e. before any cleanup has run).
  var writtenBytes = fs.readFileSync(imageItems[0].path);
  assert.ok(writtenBytes.equals(Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64")));

  handle.close();
});

test("lr-de04: multiple attached images each become a distinct localImage item", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, {});

  handle.pushMessage("two images", [
    { mediaType: "image/png", data: ONE_BY_ONE_PNG_BASE64 },
    { mediaType: "image/jpeg", data: ONE_BY_ONE_PNG_BASE64 },
  ]);
  await waitForTurnStarts(fake, 1);

  var input = fake.sentTurnStarts[0].input;
  var imageItems = input.filter(function (item) { return item.type === "localImage"; });
  assert.equal(imageItems.length, 2);
  assert.notEqual(imageItems[0].path, imageItems[1].path);

  handle.close();
});

test("lr-de04: the temp image file is cleaned up once the turn that used it completes", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, {});

  handle.pushMessage("cleanup check", [{ mediaType: "image/png", data: ONE_BY_ONE_PNG_BASE64 }]);
  await waitForTurnStarts(fake, 1);

  var imagePath = fake.sentTurnStarts[0].input.filter(function (item) {
    return item.type === "localImage";
  })[0].path;
  assert.ok(fs.existsSync(imagePath), "file must exist while the turn is in flight");

  // turn/completed was dispatched by the fake's setImmediate; give the
  // post-turnPromise cleanup a tick to run.
  await new Promise(function (resolve) { setImmediate(resolve); });
  await new Promise(function (resolve) { setImmediate(resolve); });

  assert.equal(fs.existsSync(imagePath), false, "temp image file must be removed after the turn completes");

  handle.close();
});

test("lr-de04: a text-only message (no images) is unaffected — sent as before", async function () {
  var fake = buildFakeAppServer();
  var handle = createCodexQueryHandle(fake.appServer, {});

  handle.pushMessage("no attachments here", null);
  await waitForTurnStarts(fake, 1);

  var input = fake.sentTurnStarts[0].input;
  assert.equal(input.length, 1);
  assert.equal(input[0].type, "text");
  assert.equal(input[0].text, "no attachments here");

  handle.close();
});
