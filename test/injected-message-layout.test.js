"use strict";
// The one conversation layout: the viewer's own messages on the right, every
// other speaker (a person, input another process injected) on the left, each with
// one header line. No browser: the real addUserMessage runs over the hand-built
// DOM, and the real stylesheets are read as text to check the cascade.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var dom = require("./fake-dom-prompt-cards");

var CSS_DIR = path.join(__dirname, "..", "lib", "public", "css");
var CSS = fs.readFileSync(path.join(CSS_DIR, "chat-layout.css"), "utf8");
var BASE_CSS = fs.readFileSync(path.join(CSS_DIR, "base.css"), "utf8");

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
// the stylesheets use are understood; anything else is treated as not applying.
function mediaApplies(media, width) {
  if (media === null) return true;
  var parts = media.split(/\s+and\s+/);
  return parts.every(function (p) {
    var m = /^\((max|min)-width:\s*(\d+)px\)$/.exec(p.trim());
    if (!m) return false;
    return m[1] === "max" ? width <= Number(m[2]) : width >= Number(m[2]);
  });
}

function rulesAt(css, width) {
  return rules(css).filter(function (r) { return mediaApplies(r.media, width); });
}

function ruleFor(css, selector, width) {
  var found = rulesAt(css, width === undefined ? 1280 : width).filter(function (r) { return r.selector === selector; });
  return found.length ? found[found.length - 1] : null;
}

function declares(rule, prop, value) {
  return !!rule && new RegExp("(^|;|\\s)" + prop + "\\s*:\\s*" + value + "\\s*(;|$)").test(rule.body);
}

var sharedMessages = new dom.FakeElement("div");

// Renders typed and injected messages through the real addUserMessage as `me`.
async function renderMessages(t, opts) {
  var o = opts || {};
  // A test may render two viewers in turn; the mock clock is enabled once per test.
  if (!t.timersMocked) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.timersMocked = true;
  }
  dom.setupGlobals();
  // dom-refs caches the first #messages it is given for the life of the process.
  var messages = sharedMessages;
  messages._children = [];
  messages.className = "";
  document.getElementById = function (id) { return id === "messages" ? messages : null; };
  // The action buttons are written with innerHTML, which this DOM does not parse:
  // give the lookup a stand-in so the rest of the row renders.
  var realQuery = dom.FakeElement.prototype.querySelector;
  dom.FakeElement.prototype.querySelector = function (sel) {
    return realQuery.call(this, sel) || (/^\.msg-action-/.test(sel) ? new dom.FakeElement("button") : null);
  };
  t.after(function () { dom.FakeElement.prototype.querySelector = realQuery; });
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({ connected: true, myUserId: o.me || "me", cachedAllUsers: [{ id: "u2", username: "bob" }, { id: "me", username: "me" }] });
  var participants = await import(dom.moduleUrl("message-participants.js"));
  participants.resetHumans();
  var rendering = await import(dom.moduleUrl("app-rendering.js") + "?layout=one");
  return { rendering: rendering, messages: messages };
}

var REPORT = {
  senderKind: "extracted", fromName: "Lane A@alpha", initiator: "trigger", contextNote: "lane report",
  senderAgent: "Lane A", senderAgentSlug: "lane-a", senderSessionId: "7",
};

async function renderThree(t) {
  var env = await renderMessages(t);
  env.rendering.addUserMessage("typed by me", null, null, "me", "Me");
  env.rendering.addUserMessage("from bob", null, null, "u2", "bob");
  env.rendering.addUserMessage("report", null, null, "injected:trigger", undefined, REPORT);
  return env.messages.querySelectorAll(".msg-user");
}

function childClasses(el) {
  return el._children.map(function (c) { return c.className; });
}

// What each child of a header is, in DOM order.
function headerKinds(head) {
  return head._children.map(function (c) {
    if (c.classList.contains("msg-header-avatar")) return "avatar";
    if (c.classList.contains("dm-bubble-name")) return "name";
    if (c.classList.contains("msg-header-label")) return "label";
    if (c.classList.contains("dm-bubble-time")) return "time";
    if (c.classList.contains("collapsible-toggle")) return "control";
    if (c.classList.contains("msg-actions")) return "actions";
    return "other";
  });
}

test("DOM: an injected message is an other-sender row with avatar, name, label and its dashed distinction", async function (t) {
  var rows = await renderThree(t);
  var own = rows[0];
  var other = rows[1];
  var injected = rows[2];
  assert.equal(own.classList.contains("msg-user-other"), false, "the local user's message is unchanged");
  assert.equal(other.classList.contains("msg-user-other"), true, "the human multi-user path shares the class");
  assert.equal(other.classList.contains("msg-user-injected"), false);
  assert.equal(injected.classList.contains("msg-user-other"), true);
  assert.equal(injected.classList.contains("msg-user-injected"), true);
  assert.ok(injected.querySelector(".dm-bubble-avatar-other"));
  assert.equal(injected.querySelector(".dm-bubble-name").textContent, "Lane A@alpha");
  assert.equal(injected.querySelector(".injected-label").textContent, "trigger · lane report · extracted");
  var frame = rules(CSS).filter(function (r) { return /msg-user-injected \.bubble$/.test(r.selector) && /dashed/.test(r.body); });
  assert.equal(frame.length, 1, "typed input and injected input stay visually distinct");
});

test("DOM: every message is exactly a header line and a bubble, and the header holds avatar, name, label and time", async function (t) {
  var rows = await renderThree(t);
  rows.forEach(function (row, i) {
    var parts = childClasses(row);
    assert.equal(parts.length, 2, "row " + i + " has no row of its own for avatar, name, label, time, collapse or actions: " + parts.join(" | "));
    assert.match(parts[0], /\bmsg-header\b/);
    assert.equal(parts[1], "bubble");
  });
  assert.deepEqual(headerKinds(rows[2]._children[0]), ["avatar", "name", "label", "time", "actions"]);
  assert.equal(rows[2].querySelector(".dm-bubble-time").textContent.length > 0, true, "the time is in the header, not in an action row");
});

test("DOM: the own header is the same line mirrored, and the other speaker's is not", async function (t) {
  var rows = await renderThree(t);
  var ownHead = rows[0]._children[0];
  var otherHead = rows[1]._children[0];
  assert.ok(ownHead.classList.contains("msg-header-own"));
  assert.equal(otherHead.classList.contains("msg-header-own"), false);
  assert.deepEqual(headerKinds(ownHead), ["avatar", "name", "time", "actions"], "the same DOM order on both sides; CSS reverses the own side to time, name, avatar");
  assert.deepEqual(headerKinds(otherHead), ["avatar", "name", "time", "actions"]);
  var mirror = ruleFor(CSS, ".msg-header-own");
  assert.ok(declares(mirror, "flex-direction", "row-reverse"));
});

test("DOM: the sender session id is on the name for hover and toggles into the label on tap", async function (t) {
  var rows = await renderThree(t);
  var name = rows[2].querySelector(".dm-bubble-name");
  var label = rows[2].querySelector(".injected-label");
  assert.equal(name.title, "session 7");
  name.click();
  assert.equal(label.textContent, "trigger · lane report · extracted · session 7");
  name.click();
  assert.equal(label.textContent, "trigger · lane report · extracted");
});

test("DOM: a long injected message collapses with its control in the header, still reachable", async function (t) {
  var env = await renderMessages(t);
  var long = ["one", "two", "three", "four", "five"].join("\n");
  env.rendering.addUserMessage(long, null, null, "injected:trigger", undefined, REPORT);
  var row = env.messages.querySelectorAll(".msg-user")[0];
  var head = row._children[0];
  var toggle = head.querySelector(".collapsible-toggle");
  assert.ok(toggle, "the Expand control is in the header line");
  assert.equal(toggle.textContent, "Expand");
  // The control stops propagation of its click; the hand-built DOM passes a bare event.
  toggle._listeners.click.forEach(function (fn) { fn({ stopPropagation: function () {} }); });
  assert.equal(toggle.textContent, "Collapse");
  assert.equal(row._children.length, 2, "no row of its own for the control");
});

test("DOM: the own header shows time only while one person has spoken, and avatar, name and time once two have", async function (t) {
  var env = await renderMessages(t);
  env.rendering.addUserMessage("first", null, null, "me", "Me");
  assert.equal(env.messages.classList.contains("multi-human"), false, "one person: the own header is time only (CSS hides avatar and name)");
  env.rendering.addUserMessage("an agent injected this", null, null, "injected:trigger", undefined, REPORT);
  assert.equal(env.messages.classList.contains("multi-human"), false, "an agent is not a person");
  env.rendering.addUserMessage("second person", null, null, "u2", "bob");
  assert.equal(env.messages.classList.contains("multi-human"), true, "two people: the own header shows avatar, name and time");
  env.rendering.resetTranscriptParticipants();
  assert.equal(env.messages.classList.contains("multi-human"), false, "a cleared transcript starts over");

  var hide = ruleFor(CSS, "#messages:not(.multi-human) .msg-header-own .msg-header-avatar, #messages:not(.multi-human) .msg-header-own .dm-bubble-name");
  assert.ok(declares(hide, "display", "none"), "the stylesheet hides own avatar and name until a second person speaks");
});

test("DOM: two people typing each see their own messages on the right and the other's on the left with that person's name", async function (t) {
  var envA = await renderMessages(t, { me: "me" });
  envA.rendering.addUserMessage("from me", null, null, "me", "Me");
  envA.rendering.addUserMessage("from bob", null, null, "u2", "bob");
  var a = envA.messages.querySelectorAll(".msg-user");
  assert.equal(a[0].classList.contains("msg-user-other"), false);
  assert.equal(a[1].classList.contains("msg-user-other"), true);
  assert.equal(a[1].querySelector(".dm-bubble-name").textContent, "bob");
  assert.ok(a[1].querySelector(".msg-header-avatar"));

  var envB = await renderMessages(t, { me: "u2" });
  envB.rendering.addUserMessage("from me", null, null, "me", "Me");
  envB.rendering.addUserMessage("from bob", null, null, "u2", "bob");
  var b = envB.messages.querySelectorAll(".msg-user");
  assert.equal(b[0].classList.contains("msg-user-other"), true, "bob's screen: the first person is on the left");
  assert.equal(b[0].querySelector(".dm-bubble-name").textContent, "Me");
  assert.equal(b[1].classList.contains("msg-user-other"), false, "and bob's own message is on the right");
});

test("CSS: one header line of the header-height token, own side right-aligned, other side left", function () {
  var header = ruleFor(CSS, ".msg-header");
  assert.ok(declares(header, "display", "flex"));
  assert.ok(declares(header, "height", "var\\(--msg-header-height\\)"));
  assert.ok(declares(header, "align-items", "center"));
  assert.ok(declares(header, "white-space", "nowrap"), "nothing in the header wraps onto a row of its own");
  var ownBubble = ruleFor(CSS, ".msg-user:not(.msg-user-other) .bubble");
  assert.ok(declares(ownBubble, "margin-left", "auto"), "the own bubble sits on the right");
  assert.equal(ruleFor(CSS, ".msg-user-other .bubble").body.indexOf("margin-left"), -1, "another speaker's bubble stays on the left");
});

test("CSS: the same rules hold on a phone (no mode or breakpoint forks the layout), and the controls are in the header", function () {
  var phone = rulesAt(CSS, 400);
  var desktop = rulesAt(CSS, 1280);
  assert.equal(phone.length, desktop.length, "the stylesheet has no phone-only layout");
  assert.ok(rules(CSS).every(function (r) { return r.media === null; }));
  assert.ok(declares(ruleFor(CSS, ".msg-header .collapsible-toggle"), "min-width", "var\\(--msg-touch-target\\)"));
  var hit = ruleFor(CSS, ".msg-header .collapsible-toggle::after");
  assert.match(hit.body, /inset:\s*calc\(\(var\(--msg-header-height\) - var\(--msg-touch-target\)\) \/ 2\) 0/, "the 44 px target comes from a pseudo-element and adds no height");
});

test("CSS: colours, spacing, radii and sizes come from tokens", function () {
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(CSS), false, "no literal colour in the layout stylesheet");
  // Named in the pull request with their reasons: hairline borders, the gap
  // between action buttons, and the working-dots footer.
  var allowed = {
    "border": null, "border-left": null,
    ".msg-header .msg-actions": ["gap"],
    ".thinking-dots": ["gap", "padding"],
    ".thinking-dots span": ["width", "height"],
  };
  rules(CSS).forEach(function (r) {
    r.body.split(";").forEach(function (decl) {
      if (!/\d+(\.\d+)?px/.test(decl)) return;
      var prop = decl.split(":")[0].trim();
      var ok = Object.prototype.hasOwnProperty.call(allowed, prop) ||
        (Object.prototype.hasOwnProperty.call(allowed, r.selector) && allowed[r.selector].indexOf(prop) !== -1);
      assert.ok(ok, "unexpected literal size: " + r.selector + " { " + decl.trim() + " }");
    });
  });
  ["--msg-header-height", "--msg-avatar-size", "--msg-gap", "--msg-pad-x", "--msg-bubble-radius", "--msg-touch-target"].forEach(function (token) {
    assert.match(BASE_CSS, new RegExp(token + ":\\s*\\d"), token + " is defined once in base.css");
  });
});
