"use strict";
// Send now, browser side: the shortcut, the state the button and shortcut
// share, and the markup the phone button lives in.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var { pathToFileURL } = require("url");
require("./fake-dom-prompt-cards");

var PUBLIC = path.join(__dirname, "..", "lib", "public");

function sendNowModule() {
  return import(pathToFileURL(path.join(PUBLIC, "modules", "send-now.js")).href);
}

function key(over) {
  return Object.assign({ key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, over);
}

test("Ctrl+Enter sends now everywhere; Cmd+Enter only on macOS; plain Enter never", async function () {
  var m = await sendNowModule();
  assert.equal(m.isSendNowKey(key({ ctrlKey: true }), false), true);
  assert.equal(m.isSendNowKey(key({ ctrlKey: true }), true), true);
  assert.equal(m.isSendNowKey(key({ metaKey: true }), true), true);
  assert.equal(m.isSendNowKey(key({ metaKey: true }), false), false);
  assert.equal(m.isSendNowKey(key(), true), false, "plain Enter is unchanged");
  assert.equal(m.isSendNowKey(key({ shiftKey: true }), true), false);
  assert.equal(m.isSendNowKey(key({ key: "a", ctrlKey: true }), true), false);
});

test("send now steers only a running turn on an agent that can; otherwise it sends or says why not", async function () {
  var m = await sendNowModule();
  var can = { enabled: true, reason: "" };
  var cannot = { enabled: false, reason: "This agent cannot take a message while it is working." };
  assert.equal(m.sendNowState(false, can).mode, "send");
  assert.equal(m.sendNowState(false, cannot).mode, "send", "no turn running: a normal send");
  assert.equal(m.sendNowState(true, can).mode, "steer");
  var off = m.sendNowState(true, cannot);
  assert.equal(off.mode, "disabled");
  assert.match(off.reason, /cannot take a message/);
});

test("the composer has no send-now button; the keydown handler routes the shortcut before Enter", function () {
  var html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  assert.equal(html.indexOf("send-now-btn"), -1, "the lightning button is gone from the markup");
  var input = fs.readFileSync(path.join(PUBLIC, "modules", "input.js"), "utf8");
  assert.equal(input.indexOf("initSendNowButton"), -1);
  assert.equal(input.indexOf("send-now-btn"), -1);
  var shortcut = input.indexOf("isSendNowKey(e, isMacPlatform())");
  var enter = input.indexOf('if (e.key === "Enter" && !e.shiftKey && !isComposing)');
  assert.ok(shortcut > 0 && shortcut < enter);
  var css = fs.readFileSync(path.join(PUBLIC, "css", "input.css"), "utf8");
  assert.equal(css.indexOf("send-now-btn"), -1, "its CSS is gone");
  var mod = fs.readFileSync(path.join(PUBLIC, "modules", "send-now.js"), "utf8");
  assert.equal(mod.indexOf("initSendNowButton"), -1);
});
