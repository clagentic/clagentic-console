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

// Rules of the stylesheet as { selector, body, index, media } in source order.
// media is the enclosing @media condition, or null for a top-level rule; other
// at-rule blocks (@keyframes, @supports ...) are skipped, not read as rules.
function rules(css) {
  var stripped = css.replace(/\/\*[\s\S]*?\*\//g, function (m) { return " ".repeat(m.length); });
  var out = [];

  function blockEnd(open) {
    var depth = 0;
    for (var i = open; i < stripped.length; i++) {
      if (stripped[i] === "{") depth++;
      else if (stripped[i] === "}" && --depth === 0) return i;
    }
    throw new Error("unbalanced braces in stylesheet");
  }

  function walk(from, to, media) {
    var pos = from;
    while (pos < to) {
      var open = stripped.indexOf("{", pos);
      if (open === -1 || open >= to) return;
      var close = blockEnd(open);
      var prelude = stripped.slice(pos, open).trim().replace(/\s+/g, " ");
      if (/^@media\b/.test(prelude)) {
        walk(open + 1, close, prelude.replace(/^@media\s*/, ""));
      } else if (!/^@/.test(prelude)) {
        out.push({ selector: prelude, body: stripped.slice(open + 1, close), index: pos + stripped.slice(pos, open).search(/\S/), media: media });
      }
      pos = close + 1;
    }
  }

  walk(0, stripped.length, null);
  return out;
}

// Whether a media condition holds at a viewport width. Only the width queries
// the stylesheet uses are understood; anything else is treated as not applying.
function mediaApplies(media, width) {
  if (media === null) return true;
  var parts = media.split(/\s+and\s+/);
  return parts.every(function (p) {
    var m = /^\((max|min)-width:\s*(\d+)px\)$/.exec(p.trim());
    if (!m) return false;
    return m[1] === "max" ? width <= Number(m[2]) : width >= Number(m[2]);
  });
}

// The rules in force at a viewport width: top-level ones plus those in a
// @media block whose condition holds there.
function rulesAt(css, width) {
  return rules(css).filter(function (r) { return mediaApplies(r.media, width); });
}

// The phone breakpoint is the stylesheet's own (max-width) media query.
var PHONE_MAX = (function () {
  var widths = rules(CSS).filter(function (r) { return r.media; }).map(function (r) {
    var m = /^\(max-width:\s*(\d+)px\)$/.exec(r.media);
    return m ? Number(m[1]) : null;
  }).filter(Boolean);
  return widths[0];
})();
var PHONE = PHONE_MAX;
var DESKTOP = PHONE_MAX + 512;

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

// Bubble layout: another sender's content column is left-aligned, after the base
// right-aligned rule. Returns the failure message, or null when it holds.
function bubbleColumnProblem(css, width) {
  var all = rulesAt(css, width);
  var base = all.filter(function (r) { return r.selector === ".msg-user .dm-bubble-content"; })[0];
  var other = all.filter(function (r) { return r.selector === ".msg-user-other .dm-bubble-content"; })[0];
  if (!(base && declares(base, "align-items", "flex-end"))) return "the local user's bubble is not right-aligned at " + width + "px";
  if (!(other && declares(other, "align-items", "flex-start"))) return "no left-aligned other-sender column at " + width + "px";
  // Equal specificity, so source order decides.
  if (!(other.index > base.index)) return "the other-sender rule precedes the base rule at " + width + "px";
  return null;
}

// Channel layout: every row's content column is left-aligned in wide view.
function channelColumnProblem(css, width) {
  var wide = rulesAt(css, width).filter(function (r) { return r.selector === "body.wide-view .msg-user .dm-bubble-content"; })[0];
  return wide && declares(wide, "align-items", "flex-start") ? null : "no left-aligned wide-view column at " + width + "px";
}

test("CSS: the stylesheet's phone breakpoint is found and the two test widths straddle it", function () {
  assert.ok(PHONE_MAX > 0);
  assert.equal(mediaApplies("(max-width: " + PHONE_MAX + "px)", PHONE), true);
  assert.equal(mediaApplies("(max-width: " + PHONE_MAX + "px)", DESKTOP), false);
});

test("CSS, bubble layout: another sender's content column is left-aligned on desktop and phone", function () {
  assert.equal(bubbleColumnProblem(CSS, DESKTOP), null);
  assert.equal(bubbleColumnProblem(CSS, PHONE), null);
});

test("CSS, channel layout: every row is left-aligned on desktop and phone, and an injected row is not framed", function () {
  assert.equal(channelColumnProblem(CSS, DESKTOP), null);
  assert.equal(channelColumnProblem(CSS, PHONE), null);
  var frame = rulesAt(CSS, DESKTOP).filter(function (r) { return /msg-user-injected \.bubble$/.test(r.selector) && /dashed/.test(r.body); });
  assert.equal(frame.length, 1);
  assert.equal(frame[0].selector, "body:not(.wide-view) .msg-user-injected .bubble");
});

test("CSS parser: a matching rule that sits only in a non-applying @media block fails the assertions", function () {
  var base = ".msg-user .dm-bubble-content { align-items: flex-end; }\n";
  var other = ".msg-user-other .dm-bubble-content { align-items: flex-start; }\n";
  var wide = "body.wide-view .msg-user .dm-bubble-content { align-items: flex-start; }\n";
  // Top-level: counts at both widths.
  assert.equal(bubbleColumnProblem(base + other, DESKTOP), null);
  assert.equal(bubbleColumnProblem(base + other, PHONE), null);
  // Phone-only block: counts on the phone, not on desktop.
  var phoneOnly = base + "@media (max-width: " + PHONE_MAX + "px) {\n" + other + "}\n";
  assert.equal(bubbleColumnProblem(phoneOnly, PHONE), null);
  assert.notEqual(bubbleColumnProblem(phoneOnly, DESKTOP), null);
  // A block that applies at neither width: never counts.
  var never = base + "@media (min-width: 5000px) {\n" + other + "}\n";
  assert.notEqual(bubbleColumnProblem(never, DESKTOP), null);
  assert.notEqual(bubbleColumnProblem(never, PHONE), null);
  var neverWide = "@media (max-width: 100px) {\n" + wide + "}\n";
  assert.notEqual(channelColumnProblem(neverWide, DESKTOP), null);
  assert.notEqual(channelColumnProblem(neverWide, PHONE), null);
  // Unknown conditions do not apply, and at-rule bodies are not read as rules.
  assert.notEqual(channelColumnProblem("@media print {\n" + wide + "}\n", DESKTOP), null);
  assert.equal(rules("@keyframes k { 0% { top: 0; } }\n" + base).length, 1);
});

test("CSS: colours come from theme variables, so light and dark follow the theme", function () {
  var all = rules(CSS).filter(function (r) { return /msg-user-(other|injected)/.test(r.selector); });
  all.forEach(function (r) {
    assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(r.body), false, r.selector + " uses a literal colour");
  });
});
