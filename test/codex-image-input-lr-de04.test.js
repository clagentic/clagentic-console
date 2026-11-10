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
function buildFakeAppServer(opts) {
  opts = opts || {};
  var handlers = [];
  var sentTurnStarts = [];
  var deferredSteer = null;

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
        if (!opts.manual) {
          setImmediate(function () {
            dispatch({ method: "turn/completed", params: { usage: null } });
          });
        }
        return Promise.resolve({});
      }
      if (method === "turn/steer" && opts.deferSteer) {
        // The test settles the steer by hand, after the loop has ended.
        return new Promise(function (resolve, reject) {
          deferredSteer = { resolve: resolve, reject: reject };
        });
      }
      if (method === "turn/steer" && opts.refuseSteer) {
        var err = new Error("no active turn");
        err.rpcCode = -32600;
        return Promise.reject(err);
      }
      return Promise.resolve({});
    },
  };

  function dispatch(msg) {
    handlers.forEach(function (h) {
      if (h.threadId === null || h.threadId === "test-thread-1") h.fn(msg);
    });
  }

  return {
    appServer: appServer,
    dispatch: dispatch,
    sentTurnStarts: sentTurnStarts,
    settleSteer: function (err) {
      if (err) deferredSteer.reject(err); else deferredSteer.resolve({});
    },
  };
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

// Queued-message image lifetime: a file lives until the turn that carries it
// has ended, not until the end of whichever turn was running when it arrived.
var IMG = [{ mediaType: "image/png", data: ONE_BY_ONE_PNG_BASE64 }];

function imagePathOf(turnStart) {
  return turnStart.input.filter(function (item) { return item.type === "localImage"; })[0].path;
}

function ticks(n) {
  var p = Promise.resolve();
  for (var i = 0; i < n; i++) p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
  return p;
}

test("a message with an image queued during a running turn reaches its turn with the file present, and nothing is left after both turns", async function () {
  var fake = buildFakeAppServer({ manual: true });
  var handle = createCodexQueryHandle(fake.appServer, {});

  handle.pushMessage("first", IMG);
  await waitForTurnStarts(fake, 1);
  var firstPath = imagePathOf(fake.sentTurnStarts[0]);

  handle.pushMessage("second", IMG);
  fake.dispatch({ method: "turn/completed", params: { usage: null } });
  await waitForTurnStarts(fake, 2);
  var secondPath = imagePathOf(fake.sentTurnStarts[1]);

  assert.equal(fs.existsSync(firstPath), false, "first turn's file is removed when it ends");
  assert.ok(fs.existsSync(secondPath), "queued turn's file must still exist when its turn starts");

  fake.dispatch({ method: "turn/completed", params: { usage: null } });
  await ticks(3);
  assert.equal(fs.existsSync(secondPath), false, "no temp file is left after both turns end");

  handle.close();
});

test("on abort with a queued image message, the running and queued files are removed", async function () {
  var fake = buildFakeAppServer({ manual: true });
  var handle = createCodexQueryHandle(fake.appServer, {});

  handle.pushMessage("first", IMG);
  await waitForTurnStarts(fake, 1);
  var firstPath = imagePathOf(fake.sentTurnStarts[0]);

  // The queued entry's path is not visible on any turn/start yet, so record
  // what the adapter writes.
  var codexLocalImage = require("../lib/yoke/codex-local-image");
  var realWrite = codexLocalImage.writeTempImage;
  var written = [];
  codexLocalImage.writeTempImage = function () {
    var p = realWrite.apply(this, arguments);
    written.push(p);
    return p;
  };
  try {
    handle.pushMessage("second", IMG);
  } finally {
    codexLocalImage.writeTempImage = realWrite;
  }
  assert.equal(written.length, 1);
  assert.ok(fs.existsSync(written[0]), "queued file exists while queued");

  handle.abort();
  await ticks(3);

  assert.equal(fs.existsSync(firstPath), false);
  assert.equal(fs.existsSync(written[0]), false, "queued file removed along with the running turn's");

  handle.close();
});

test("a refused steer re-queued with an image keeps its file until its turn, then removes it", async function () {
  var fake = buildFakeAppServer({ manual: true, refuseSteer: true });
  var handle = createCodexQueryHandle(fake.appServer, {});

  handle.pushMessage("first", null);
  await waitForTurnStarts(fake, 1);
  // The steer needs an active turn id; turn/started names it.
  fake.dispatch({ method: "turn/started", params: { turn: { id: "turn-1" } } });

  var result = await handle.steerMessage("steered", IMG);
  assert.equal(result.steered, false);

  fake.dispatch({ method: "turn/completed", params: { usage: null } });
  await waitForTurnStarts(fake, 2);
  var path = imagePathOf(fake.sentTurnStarts[1]);
  assert.ok(fs.existsSync(path), "re-queued steer's file must exist when its turn starts");

  fake.dispatch({ method: "turn/completed", params: { usage: null } });
  await ticks(3);
  assert.equal(fs.existsSync(path), false);

  handle.close();
});

// A steer whose response arrives after the loop has ended (abort mid-turn) must
// not leave its file behind: nothing drains the per-loop lists again.
async function lateSteerLeavesNoFile(settleError) {
  var fake = buildFakeAppServer({ manual: true, deferSteer: true });
  var handle = createCodexQueryHandle(fake.appServer, {});

  handle.pushMessage("first", null);
  await waitForTurnStarts(fake, 1);
  fake.dispatch({ method: "turn/started", params: { turn: { id: "turn-1" } } });

  var codexLocalImage = require("../lib/yoke/codex-local-image");
  var realWrite = codexLocalImage.writeTempImage;
  var written = [];
  codexLocalImage.writeTempImage = function () {
    var p = realWrite.apply(this, arguments);
    written.push(p);
    return p;
  };
  var steer;
  try {
    steer = handle.steerMessage("steered", IMG);
  } finally {
    codexLocalImage.writeTempImage = realWrite;
  }
  assert.equal(written.length, 1);
  assert.ok(fs.existsSync(written[0]), "steer file exists while the steer is in flight");

  handle.abort();
  await ticks(3);

  fake.settleSteer(settleError);
  await steer;
  await ticks(3);

  assert.equal(fs.existsSync(written[0]), false, "a steer settling after the loop ended leaves no temp file");
  handle.close();
}

test("a confirmed steer settling after the loop has ended leaves no temp file", async function () {
  await lateSteerLeavesNoFile(null);
});

test("an unconfirmed steer settling after the loop has ended leaves no temp file", async function () {
  // No rpcCode: a transport failure, the outcome is unknown.
  await lateSteerLeavesNoFile(new Error("timeout"));
});
