"use strict";

// The admin user list under node: the real admin.js module over a hand-built
// DOM and a fetch that records its requests. The shared fake element keeps
// innerHTML as text, so the body used here reads the buttons out of the markup
// the module wrote and hands back elements that carry the click listeners the
// module bound.

var test = require("node:test");
var assert = require("node:assert/strict");
var dom = require("./fake-dom-prompt-cards.js");

var USERS = [
  { id: "u-locked", username: "alice", displayName: "alice", role: "user", createdAt: 1700000000000, locked: true },
  { id: "u-open", username: "bob", displayName: "bob", role: "user", createdAt: 1700000000000, locked: false },
];

// A body whose querySelectorAll finds the <button> tags in its current markup.
function markupBody() {
  var body = new dom.FakeElement("div");
  var builtFor = null;
  var buttons = [];
  function refresh() {
    if (builtFor === body.innerHTML) return;
    builtFor = body.innerHTML;
    buttons = [];
    var re = /<button class="([^"]*)"([^>]*)>/g;
    var m;
    while ((m = re.exec(builtFor))) {
      var el = new dom.FakeElement("button");
      el.className = m[1];
      var attr = /data-user-id="([^"]*)"/.exec(m[2]);
      if (attr) el.dataset.userId = attr[1];
      buttons.push(el);
    }
  }
  body.querySelectorAll = function (sel) {
    refresh();
    var base = /^\.([\w-]+)/.exec(sel);
    if (!base) return [];
    var nots = (sel.match(/:not\(\.([\w-]+)\)/g) || []).map(function (n) { return n.slice(6, -1); });
    return buttons.filter(function (b) {
      return b.classList.contains(base[1]) && nots.every(function (n) { return !b.classList.contains(n); });
    });
  };
  body.querySelector = function (sel) { return body.querySelectorAll(sel)[0] || null; };
  return body;
}

function flush() {
  return new Promise(function (r) { setImmediate(r); }).then(function () { return new Promise(function (r) { setImmediate(r); }); });
}

test("the admin user list marks a locked user and its Unlock control posts the unlock and reloads the list", async function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  dom.setupGlobals();
  var requests = [];
  global.fetch = function (url, opts) {
    var method = (opts && opts.method) || "GET";
    requests.push(method + " " + url);
    var answer = {};
    if (url === "/api/admin/users") answer = { users: USERS };
    else if (/\/unlock$/.test(url)) answer = { ok: true };
    return Promise.resolve({ json: function () { return Promise.resolve(answer); } });
  };

  var admin = await import(dom.moduleUrl("admin.js"));
  var body = markupBody();
  admin.loadAdminSection("admin-users", body);
  await flush();

  var html = body.innerHTML;
  assert.match(html, /admin-locked-badge/, "the locked user shows the locked state");
  assert.equal((html.match(/admin-locked-badge/g) || []).length, 1, "only the locked user does");

  var unlockButtons = body.querySelectorAll(".admin-unlock-btn");
  assert.equal(unlockButtons.length, 1, "one Unlock control, for the locked user only");
  assert.equal(unlockButtons[0].dataset.userId, "u-locked");
  assert.doesNotMatch(html, /clagentic/i, "no bare brand word in the list");

  var listLoads = requests.filter(function (r) { return r === "GET /api/admin/users"; }).length;
  unlockButtons[0].click();
  await flush();

  assert.ok(requests.indexOf("POST /api/admin/users/u-locked/unlock") !== -1, "the control sends the unlock request");
  assert.equal(
    requests.filter(function (r) { return r === "GET /api/admin/users"; }).length,
    listLoads + 1,
    "the list is loaded again"
  );
});
