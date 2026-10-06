"use strict";
// A prompt's notification banner answers through the card's state machine
// (lib/public/modules/prompt-card.js): it never sits disabled waiting for a
// confirmation that is not coming.

var test = require("node:test");
var assert = require("node:assert/strict");
var dom = require("./fake-dom-prompt-cards");

function makeBanner() {
  var banner = new dom.FakeElement("div");
  banner.className = "notif-banner notif-banner-permission";
  var body = banner.appendChild(new dom.FakeElement("div"));
  body.className = "notif-banner-body";
  var actions = body.appendChild(new dom.FakeElement("div"));
  actions.className = "notif-banner-actions";
  ["allow", "allow_always", "deny"].forEach(function (d) {
    var b = actions.appendChild(new dom.FakeElement("button"));
    b.setAttribute("data-decision", d);
  });
  var goto = actions.appendChild(new dom.FakeElement("button"));
  goto.className = "notif-banner-goto";
  var close = banner.appendChild(new dom.FakeElement("button"));
  close.className = "notif-banner-close";
  return { banner: banner, goto: goto, close: close, decisions: actions.querySelectorAll("button[data-decision]") };
}

async function load(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var banner = await import(dom.moduleUrl("prompt-banner.js"));
  var card = await import(dom.moduleUrl("prompt-card.js"));
  return { mod: banner, card: card };
}

function wire(env, sendOk) {
  var b = makeBanner();
  var sent = [];
  env.mod.wirePromptBanner(b.banner, { requestId: "r1", kind: "permission", slug: "proj" }, function (msg) {
    sent.push(msg);
    return sendOk;
  });
  return Object.assign(b, { sent: sent });
}

function enabled(buttons) { return buttons.filter(function (x) { return !x.disabled; }).length; }

test("a banner answer is the card's: sending, then answerable again when no confirmation comes", async function (t) {
  var env = await load(t);
  var b = wire(env, true);
  b.decisions[0].click();
  assert.deepEqual(b.sent, [{ type: "prompt_response", requestId: "r1", kind: "permission", decision: "allow", targetSlug: "proj" }]);
  assert.ok(b.banner.classList.contains("sending"));
  assert.equal(enabled(b.decisions), 0, "its answers are locked while sending");
  assert.equal(b.goto.disabled, false, "Go to session stays usable");
  assert.equal(b.close.disabled, false, "close stays usable");
  b.decisions[2].click();
  assert.equal(b.sent.length, 1, "one answer in flight at a time");

  t.mock.timers.tick(env.card.ACK_TIMEOUT_MS);
  assert.equal(b.banner.classList.contains("sending"), false);
  assert.equal(enabled(b.decisions), 3, "no confirmation: the operator can answer again");
  assert.match(b.banner.textContent, /No confirmation/);
  b.decisions[2].click();
  assert.equal(b.sent[1].decision, "deny");
});

test("a dropped connection makes a sending banner answerable again", async function (t) {
  var env = await load(t);
  var root = new dom.FakeElement("div");
  var b = wire(env, true);
  root.appendChild(b.banner);
  b.decisions[1].click();
  assert.equal(enabled(b.decisions), 0);
  env.mod.restoreUnconfirmedBanners(root, "Connection lost. Choose again.");
  assert.equal(enabled(b.decisions), 3);
  assert.match(b.banner.textContent, /Connection lost/);
});

test("a banner that cannot send says so and stays answerable", async function (t) {
  var env = await load(t);
  var b = wire(env, false);
  b.decisions[0].click();
  assert.equal(b.banner.classList.contains("sending"), false);
  assert.equal(enabled(b.decisions), 3);
  assert.match(b.banner.textContent, /Not connected/);
});

test("the shell puts a banner's controls back as they were, and a card's too", async function (t) {
  var env = await load(t);
  var card = new dom.FakeElement("div");
  var actions = card.appendChild(new dom.FakeElement("div"));
  actions.className = "permission-actions";
  var live = actions.appendChild(new dom.FakeElement("button"));
  var off = actions.appendChild(new dom.FakeElement("button"));
  off.disabled = true;
  var choice = card.appendChild(new dom.FakeElement("select"));
  env.card.submitPromptResponse(card, function () { return true; });
  assert.equal(live.disabled, true);
  assert.equal(choice.disabled, true, "a select is locked like any other control");
  env.card.restorePromptCard(card);
  assert.equal(live.disabled, false);
  assert.equal(choice.disabled, false);
  assert.equal(off.disabled, true, "a control disabled before the send stays disabled");
});
