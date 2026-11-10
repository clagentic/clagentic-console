"use strict";

// The Team view: a section registry plus a desktop view that hosts it, with
// Agent Teams as the first section and the mobile Team tab drawing through
// the same registry. Drives the real client modules under a hand-built DOM.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var dom = require("./fake-dom-prompt-cards.js");

var ROOT = path.resolve(__dirname, "..");
var PUBLIC = path.join(ROOT, "lib", "public");
var TEAM_VIEW_FILE = path.join(PUBLIC, "modules", "team-view.js");

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

// Neutral fixtures: no names of any real agent or deployment.
var TEAM = {
  members: [{ id: "worker-a", name: "Worker A" }, { id: "worker-b", name: "Worker B" }],
  tasks: [
    { id: "t1", title: "Index the fixtures", status: "in_progress" },
    { id: "t2", title: "Write the summary", status: "pending" },
  ],
  _memberStatuses: { "worker-a": "alive" },
  _memberActivities: { "worker-a": "reading inputs" },
};
var MESSAGES = [{ fromAgentId: "worker-a", toAgentId: "worker-b", summary: "handing over the index" }];

// Builds the document the client modules look elements up in. Both the old
// popup ids and the new view ids exist, so the same driver runs at either
// side of the change and reports whichever surface the code wrote to.
function installPage(innerWidth) {
  dom.setupGlobals();
  global.window.innerWidth = innerWidth || 1280;
  var ids = [
    "team-view", "team-view-body", "team-view-close", "icon-strip-team-btn",
    "team-panel", "team-panel-body", "team-panel-close",
  ];
  var els = {};
  ids.forEach(function (id) { els[id] = new dom.FakeElement("div"); });
  els["team-view"].className = "hidden";
  els["team-panel"].className = "hidden";
  global.document.getElementById = function (id) { return els[id] || null; };
  return els;
}

async function loadModules(withView) {
  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.createStore({ connected: false });
  var panel = await import(dom.moduleUrl("team-panel.js"));
  var view = withView ? await import(dom.moduleUrl("team-view.js")) : null;
  return { panel: panel, view: view };
}

function surfaceText(els) {
  return els["team-view-body"].textContent + els["team-panel-body"].textContent;
}

function feedTeam(panel) {
  panel.handleTeamState({ team: JSON.parse(JSON.stringify(TEAM)), messages: MESSAGES.slice() });
}

test("Agent Teams content renders the same: members, tasks, messages, live updates", async function () {
  var els = installPage();
  var hasView = fs.existsSync(TEAM_VIEW_FILE);
  var mods = await loadModules(hasView);
  if (mods.view) mods.view.initTeamView();

  feedTeam(mods.panel);
  var text = surfaceText(els);
  ["Members", "Worker A", "Worker B", "reading inputs", "Tasks", "Index the fixtures",
    "Write the summary", "in progress", "Messages", "worker-a → worker-b:", "handing over the index"]
    .forEach(function (needle) { assert.ok(text.indexOf(needle) >= 0, "missing: " + needle); });

  mods.panel.handleTeamMemberUpdate({ agentId: "worker-b", status: "idle", currentActivity: "waiting on the index" });
  assert.ok(surfaceText(els).indexOf("waiting on the index") >= 0, "member update renders live");

  mods.panel.handleTeamTaskUpdate({ tasks: [{ id: "t1", title: "Index the fixtures", status: "completed" }] });
  assert.ok(surfaceText(els).indexOf("completed") >= 0, "task update renders live");
  assert.equal(surfaceText(els).indexOf("Write the summary"), -1, "task list is replaced, not appended");

  mods.panel.handleTeamMessage({ message: { fromAgentId: "worker-b", toAgentId: "worker-a", summary: "second note" } });
  assert.ok(surfaceText(els).indexOf("second note") >= 0, "message update renders live");

  mods.panel.handleTeamGone();
  assert.equal(surfaceText(els).indexOf("Worker A"), -1, "team_gone clears the team content");
});

test("team_state opens the Team view with the Agent Teams section", async function () {
  var els = installPage();
  var mods = await loadModules(true);
  mods.view.initTeamView();
  mods.panel.handleTeamGone();
  mods.view.closeTeamView();

  assert.equal(mods.view.isTeamViewOpen(), false);
  feedTeam(mods.panel);

  assert.equal(els["team-view"].classList.contains("hidden"), false, "team_state auto-opens the view");
  var section = els["team-view-body"].querySelector(".team-view-section");
  assert.ok(section, "a section is drawn");
  assert.equal(section.dataset.sectionId, "agent-teams");
});

test("the Team button opens the Team view at full size, not the popup", async function () {
  var els = installPage();
  var mods = await loadModules(true);
  mods.view.initTeamView();
  mods.panel.handleTeamGone();
  mods.view.closeTeamView();
  feedTeam(mods.panel);
  mods.view.closeTeamView();

  var users = await import(dom.moduleUrl("sidebar-users.js"));
  users.initSidebarUsers();
  els["icon-strip-team-btn"].click();

  assert.equal(els["team-view"].classList.contains("hidden"), false, "click opens the view");
  assert.ok(els["team-view-body"].querySelector('[data-section-id="agent-teams"]'), "Agent Teams section is shown");
  assert.equal(els["icon-strip-team-btn"].classList.contains("active"), true, "button shows the open state");

  els["icon-strip-team-btn"].click();
  assert.equal(els["team-view"].classList.contains("hidden"), true, "a second click closes it");
  assert.equal(els["icon-strip-team-btn"].classList.contains("active"), false);

  var html = read("lib/public/index.html");
  var viewAt = html.indexOf('id="team-view"');
  var panelsAt = html.indexOf('<div id="main-panels">');
  assert.ok(viewAt > panelsAt, "the view sits in #main-panels, a main-area view");
  assert.doesNotMatch(html.slice(viewAt, viewAt + 600), /usage-panel/, "the view does not borrow usage-panel styling");
});

test("with no active team the view shows an empty state, not a blank panel", async function () {
  var els = installPage();
  var mods = await loadModules(true);
  mods.view.initTeamView();
  mods.panel.handleTeamGone();
  mods.view.closeTeamView();

  mods.view.openTeamView();

  var body = els["team-view-body"];
  assert.ok(body.querySelector(".team-empty-state"), "empty state is drawn");
  assert.ok(body.textContent.indexOf("Nothing active") >= 0);
  assert.equal(body.querySelector(".team-view-section"), null, "no section content when nothing is available");
});

test("a second section registers beside Agent Teams: both listed and switchable", async function () {
  var els = installPage();
  var mods = await loadModules(true);
  mods.view.initTeamView();
  feedTeam(mods.panel);
  var panelSourceBefore = read("lib/public/modules/team-panel.js");

  mods.view.registerTeamSection({
    id: "test-only",
    title: "Test Only",
    render: function (container) {
      var p = document.createElement("p");
      p.textContent = "test-only content";
      container.appendChild(p);
    },
  });
  try {
    mods.view.openTeamView();
    var body = els["team-view-body"];
    var tabs = body.querySelectorAll(".team-view-tab");
    assert.deepEqual(tabs.map(function (t) { return t.textContent; }), ["Agent Teams", "Test Only"]);
    assert.ok(body.textContent.indexOf("Worker A") >= 0, "first section shown by default");

    tabs[1].click();
    body = els["team-view-body"];
    assert.ok(body.textContent.indexOf("test-only content") >= 0, "switched to the second section");
    assert.equal(body.textContent.indexOf("Worker A"), -1, "the first section is not drawn while the second is");

    body.querySelectorAll(".team-view-tab")[0].click();
    assert.ok(els["team-view-body"].textContent.indexOf("Worker A") >= 0, "switches back");

    assert.equal(read("lib/public/modules/team-panel.js"), panelSourceBefore);
    assert.doesNotMatch(panelSourceBefore, /test-only/, "Agent Teams code knows nothing of other sections");
  } finally {
    mods.view.unregisterTeamSection("test-only");
  }
});

test("registry: validates input, replaces by id, hides unavailable sections", async function () {
  installPage();
  var mods = await loadModules(true);
  var v = mods.view;

  assert.throws(function () { v.registerTeamSection({ title: "x", render: function () {} }); }, /id/);
  assert.throws(function () { v.registerTeamSection({ id: "x", render: function () {} }); }, /title/);
  assert.throws(function () { v.registerTeamSection({ id: "x", title: "X" }); }, /render/);

  var available = false;
  v.registerTeamSection({ id: "gated", title: "Gated", render: function () {}, isAvailable: function () { return available; } });
  v.registerTeamSection({ id: "gated", title: "Gated Again", render: function () {}, isAvailable: function () { return available; } });
  try {
    assert.equal(v.listTeamSections().some(function (s) { return s.id === "gated"; }), false);
    available = true;
    var gated = v.listTeamSections().filter(function (s) { return s.id === "gated"; });
    assert.equal(gated.length, 1, "re-registering an id replaces it");
    assert.equal(gated[0].title, "Gated Again");
  } finally {
    v.unregisterTeamSection("gated");
  }
});

test("the mobile Team tab draws the same sections through the same registry", async function () {
  installPage(390);
  var mods = await loadModules(true);
  mods.view.initTeamView();
  feedTeam(mods.panel);

  mods.view.registerTeamSection({
    id: "test-only",
    title: "Test Only",
    render: function (container) { container.textContent = "test-only content"; },
  });
  try {
    var sheetList = new dom.FakeElement("div");
    mods.view.renderTeamSections(sheetList);
    assert.deepEqual(
      sheetList.querySelectorAll(".team-view-tab").map(function (t) { return t.textContent; }),
      ["Agent Teams", "Test Only"]
    );
    assert.ok(sheetList.textContent.indexOf("Worker A") >= 0, "Agent Teams content on the phone sheet");

    mods.view.openTeamView();
    assert.equal(mods.view.isTeamViewOpen(), false, "the desktop view stays closed on a phone viewport");
  } finally {
    mods.view.unregisterTeamSection("test-only");
  }

  var mobileSrc = read("lib/public/modules/sidebar-mobile.js");
  assert.match(mobileSrc, /import \{ renderTeamSections \} from '\.\/team-view\.js'/);
  assert.match(mobileSrc, /function renderSheetTeam\(listEl\) \{\s*renderTeamSections\(listEl\);\s*\}/);
});

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

test("no live reference to the old #team-panel popup remains in the shipped tree", function () {
  // The module and stylesheet keep the team-panel file name; only the popup's
  // ids, class and toggle are gone.
  var stale = /#team-panel|id="team-panel|"team-panel(-body|-close)?"|team-panel-(body|close)|toggleTeamPanel|team-panel pattern/;
  var hits = walk(path.join(ROOT, "lib"), []).filter(function (f) {
    return /\.(js|html|css|md)$/.test(f) && stale.test(fs.readFileSync(f, "utf8"));
  });
  assert.deepEqual(hits.map(function (f) { return path.relative(ROOT, f); }), []);
});

// --- Round 2: breakpoint consistency and auto-open ownership ---

// Splits a stylesheet into its top-level rules and @media blocks. Enough for
// this file; the repo has no CSS engine to resolve :has() or media queries.
function topLevelBlocks(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  var blocks = [];
  var depth = 0;
  var start = 0;
  for (var i = 0; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        var text = css.slice(start, i + 1);
        var open = text.indexOf("{");
        blocks.push({ prelude: text.slice(0, open).trim(), body: text.slice(open + 1, -1) });
        start = i + 1;
      }
    }
  }
  return blocks;
}

test("the chat pane is hidden only at widths where the Team view can show, across the 768px breakpoint", async function () {
  var pos = await import(dom.moduleUrl("popover-position.js"));
  var bp = pos.MOBILE_BREAKPOINT;
  var blocks = topLevelBlocks(read("lib/public/css/team-view.css"));
  var hidesChat = /#app\s*\{\s*display:\s*none/;

  var unconditional = blocks.filter(function (b) { return /#team-view:not\(\.hidden\)/.test(b.prelude) && hidesChat.test(b.body); });
  assert.equal(unconditional.length, 0, "no top-level rule hides #app on the view's open state alone");

  var wide = blocks.filter(function (b) { return /^@media/.test(b.prelude) && /#team-view:not\(\.hidden\)\)\s*>\s*#app/.test(b.body); });
  assert.equal(wide.length, 1, "the #app-hiding rule lives in exactly one media block");
  assert.equal(wide[0].prelude.replace(/\s+/g, ""), "@media(min-width:" + (bp + 1) + "px)",
    "it applies only above the width where isMobileViewport() is true");

  var phone = blocks.filter(function (b) { return /^@media/.test(b.prelude) && /#team-view\s*\{\s*display:\s*none/.test(b.body); });
  assert.equal(phone.length, 1, "the phone rule that hides the view");
  assert.equal(phone[0].prelude.replace(/\s+/g, ""), "@media(max-width:" + bp + "px)",
    "the CSS ceiling equals MOBILE_BREAKPOINT, the threshold isMobileViewport() uses");
  assert.doesNotMatch(phone[0].body, /#app/, "the phone rule leaves the chat pane alone");

  // At every width exactly one of the two media rules applies, so the chat is
  // hidden if and only if the view is shown: no width has both or neither.
  [320, bp, bp + 1, 1280].forEach(function (w) {
    var viewHiddenByCss = w <= bp;
    var chatHiddenByCss = w >= bp + 1;
    assert.notEqual(viewHiddenByCss, chatHiddenByCss, "width " + w);
  });

  // The JS side of the same threshold: auto-open is skipped at or below it.
  global.window = global.window || {};
  [bp, bp + 1].forEach(function (w) {
    global.window.innerWidth = w;
    assert.equal(pos.isMobileViewport(), w <= bp);
  });
});

test("opened wide then narrowed then widened, the view stays open and consistent", async function () {
  var els = installPage(1280);
  var mods = await loadModules(true);
  mods.view.initTeamView();
  mods.panel.handleTeamGone();
  mods.view.closeTeamView();

  mods.view.openTeamView();
  assert.equal(mods.view.isTeamViewOpen(), true);

  global.window.innerWidth = 600;
  mods.view.refreshTeamView();
  assert.equal(mods.view.isTeamViewOpen(), true, "narrowing does not change the open state; CSS owns visibility");
  assert.ok(els["team-view-body"].querySelector(".team-empty-state"), "still renders in place");

  global.window.innerWidth = 1280;
  mods.view.refreshTeamView();
  assert.equal(mods.view.isTeamViewOpen(), true);
  assert.equal(els["team-view"].classList.contains("hidden"), false);
});

test("team_gone closes a view team_state opened on its own, back to the chat", async function () {
  var els = installPage();
  var mods = await loadModules(true);
  mods.view.initTeamView();
  mods.panel.handleTeamGone();
  mods.view.closeTeamView();

  feedTeam(mods.panel);
  assert.equal(mods.view.isTeamViewOpen(), true, "team_state auto-opened it");

  mods.panel.handleTeamGone();
  assert.equal(mods.view.isTeamViewOpen(), false, "the view closes with the team");
  assert.equal(els["team-view"].classList.contains("hidden"), true);
  assert.equal(els["icon-strip-team-btn"].classList.contains("active"), false);
});

test("team_gone leaves a view the user opened on the empty state", async function () {
  var els = installPage();
  var mods = await loadModules(true);
  mods.view.initTeamView();
  mods.panel.handleTeamGone();
  mods.view.closeTeamView();

  mods.view.openTeamView();
  feedTeam(mods.panel);
  mods.panel.handleTeamGone();

  assert.equal(mods.view.isTeamViewOpen(), true, "a user-opened view stays open");
  assert.ok(els["team-view-body"].querySelector(".team-empty-state"), "it shows the empty state");

  mods.view.closeTeamView();
  feedTeam(mods.panel);
  mods.panel.handleTeamGone();
  assert.equal(mods.view.isTeamViewOpen(), false, "once closed, the next auto-open is auto again");
});
