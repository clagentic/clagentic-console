"use strict";
// An injected (or other-user) message must sit on the left in both chat layouts.
// No browser: the real addUserMessage runs over the hand-built DOM, and the
// real stylesheet is read as text to check the cascade that places it.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var dom = require("./fake-dom-prompt-cards");

var CSS = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "channel-layout.css"), "utf8");

// Rules of the stylesheet as { selector, body, index } in source order.
function rules(css) {
  var out = [];
  var stripped = css.replace(/\/\*[\s\S]*?\*\//g, function (m) { return " ".repeat(m.length); });
  var re = /([^{}]+)\{([^{}]*)\}/g;
  var m;
  while ((m = re.exec(stripped))) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2], index: m.index });
  }
  return out;
}

function declares(rule, prop, value) {
  return new RegExp("(^|;|\\s)" + prop + "\\s*:\\s*" + value + "\\s*(;|$)").test(rule.body);
}

var sharedMessages = new dom.FakeElement("div");

async function renderMessages(t, wide) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  // dom-refs caches the first #messages it is given for the life of the process.
  var messages = sharedMessages;
  messages._children = [];
  document.getElementById = function (id) { return id === "messages" ? messages : null; };
  if (wide) document.body.classList.add("wide-view");
  // The action buttons are written with innerHTML, which this DOM does not parse:
  // give the lookup a stand-in so the rest of the row renders.
  var realQuery = dom.FakeElement.prototype.querySelector;
  dom.FakeElement.prototype.querySelector = function (sel) {
    return realQuery.call(this, sel) || (/^\.msg-action-/.test(sel) ? new dom.FakeElement("button") : null);
  };
  t.after(function () { dom.FakeElement.prototype.querySelector = realQuery; });
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({ connected: true, myUserId: "me", cachedAllUsers: [{ id: "u2", username: "bob" }] });
  var rendering = await import(dom.moduleUrl("app-rendering.js") + "?layout=" + (wide ? "wide" : "bubble"));
  rendering.addUserMessage("typed by me", null, null, "me", "Me");
  rendering.addUserMessage("from bob", null, null, "u2", "bob");
  rendering.addUserMessage("report", null, null, "injected:trigger", undefined, {
    senderKind: "extracted", fromName: "Lane A@alpha", initiator: "trigger", contextNote: "lane report",
    senderAgent: "Lane A", senderAgentSlug: "lane-a", senderSessionId: "7",
  });
  return messages.querySelectorAll(".msg-user");
}

["bubble", "channel"].forEach(function (layout) {
  test("DOM, " + layout + " layout: an injected message is an other-sender row with avatar, name and label", async function (t) {
    var rows = await renderMessages(t, layout === "channel");
    var own = rows[0];
    var other = rows[1];
    var injected = rows[2];
    assert.equal(own.classList.contains("msg-user-other"), false, "the local user's message is unchanged");
    assert.equal(other.classList.contains("msg-user-other"), true, "the human multi-user path shares the class");
    assert.equal(other.classList.contains("msg-user-injected"), false);
    assert.equal(injected.classList.contains("msg-user-other"), true);
    assert.equal(injected.classList.contains("msg-user-injected"), true);
    assert.ok(injected.querySelector(".dm-bubble-avatar-other"));
    assert.ok(injected.querySelector(".dm-bubble-content .bubble"), "the bubble sits in the content column");
    assert.equal(injected.querySelector(".dm-bubble-name").textContent, "Lane A@alpha");
    assert.equal(injected.querySelector(".injected-label").textContent, "trigger · lane report · extracted");
  });
});

test("DOM: the sender session id is on the name for hover and toggles into the label on tap", async function (t) {
  var rows = await renderMessages(t, false);
  var name = rows[2].querySelector(".dm-bubble-name");
  var label = rows[2].querySelector(".injected-label");
  assert.equal(name.title, "session 7");
  name.click();
  assert.equal(label.textContent, "trigger · lane report · extracted · session 7");
  name.click();
  assert.equal(label.textContent, "trigger · lane report · extracted");
});

test("CSS, bubble layout: another sender's content column is left-aligned, after the base right-aligned rule", function () {
  var all = rules(CSS);
  var base = all.filter(function (r) { return r.selector === ".msg-user .dm-bubble-content"; })[0];
  var other = all.filter(function (r) { return r.selector === ".msg-user-other .dm-bubble-content"; })[0];
  assert.ok(base && declares(base, "align-items", "flex-end"), "the local user's bubble stays right-aligned");
  assert.ok(other && declares(other, "align-items", "flex-start"));
  // Equal specificity, so source order decides.
  assert.ok(other.index > base.index);
});

test("CSS, channel layout: every row is left-aligned and an injected row is not framed", function () {
  var all = rules(CSS);
  var wide = all.filter(function (r) { return r.selector === "body.wide-view .msg-user .dm-bubble-content"; })[0];
  assert.ok(wide && declares(wide, "align-items", "flex-start"));
  var frame = all.filter(function (r) { return /msg-user-injected \.bubble$/.test(r.selector) && /dashed/.test(r.body); });
  assert.equal(frame.length, 1);
  assert.equal(frame[0].selector, "body:not(.wide-view) .msg-user-injected .bubble");
});

test("CSS: colours come from theme variables, so light and dark follow the theme", function () {
  var all = rules(CSS).filter(function (r) { return /msg-user-(other|injected)/.test(r.selector); });
  all.forEach(function (r) {
    assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(r.body), false, r.selector + " uses a literal colour");
  });
});
