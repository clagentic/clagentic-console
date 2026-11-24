"use strict";

// The Ctrl+E project switcher lists the projects the sidebar shows at top
// level: a worktree that has a parent project is reached through that parent,
// so it gets no row. No browser: the real project-switcher.js and the real
// switchProject run over the hand-built DOM, driven by the keyboard.

var test = require("node:test");
var assert = require("node:assert/strict");

var dom = require("./fake-dom-prompt-cards");

var instance = 0;

function project(slug, over) {
  return Object.assign({ slug: slug, title: "Title " + slug }, over);
}

function worktree(slug, parent, over) {
  return project(slug, Object.assign({ isWorktree: true, parentSlug: parent, worktreeAccessible: true }, over));
}

// A browser with the switcher initialised over a page that already has its
// overlay markup, so the dialog's header and result list are found by class.
async function browser(t, current, projects) {
  await dom.setupToolsEnv(t);
  var listeners = {};
  global.document.addEventListener = function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); };
  global.document.documentElement = { classList: { contains: function () { return false; } } };
  global.window.addEventListener = function () {};
  var pushed = [];
  global.history = {
    pushState: function (s, title, url) { pushed.push(url); },
    replaceState: function (s, title, url) { pushed.push(url); },
  };
  global.WebSocket = function () { this.readyState = 0; this.close = function () {}; };

  var overlay = new dom.FakeElement("div");
  overlay.id = "project-switcher";
  overlay.className = "hidden";
  ["cmd-palette-backdrop", "cmd-palette-results", "project-switcher-header"].forEach(function (cls) {
    var child = new dom.FakeElement("div");
    child.className = cls;
    overlay.appendChild(child);
  });
  global.document.getElementById = function (id) { return id === "project-switcher" ? overlay : null; };

  var storeMod = await import(dom.moduleUrl("store.js"));
  storeMod.store.set({ currentSlug: current, activeSessionId: 1 });
  var appProjects = await import(dom.moduleUrl("app-projects.js"));
  appProjects.setCachedProjects(projects);
  var n = ++instance;
  var switcher = await import(dom.moduleUrl("project-switcher.js") + "?switcher=" + n);
  switcher.initProjectSwitcher();

  function key(k, extra) {
    var ev = Object.assign({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      preventDefault: function () {}, stopPropagation: function () {} }, extra);
    (listeners.keydown || []).forEach(function (fn) { fn(ev); });
  }
  return {
    open: function () { key("e", { ctrlKey: true }); },
    enter: function () { key("Enter"); },
    isOpen: function () { return !overlay.classList.contains("hidden"); },
    items: function () { return overlay.querySelectorAll(".project-switcher-item"); },
    titles: function () {
      return overlay.querySelectorAll(".project-switcher-item").map(function (el) {
        return el.querySelector(".cmd-palette-item-title").textContent;
      });
    },
    current: function () { return storeMod.store.get("currentSlug"); },
    pushed: pushed,
  };
}

var ROWS = [
  { name: "AC1: worktrees of a parent get no row, the rest keep the server order",
    current: "alpha",
    projects: [project("alpha"), worktree("alpha--wt-one", "alpha"), project("gamma"), worktree("alpha--wt-two", "alpha")],
    titles: ["Title alpha", "Title gamma"], badges: 1, commitTo: "gamma" },
  { name: "AC2: opened from a worktree, no row is current and Enter switches to the parent",
    current: "alpha--wt-one",
    projects: [project("alpha"), worktree("alpha--wt-one", "alpha"), project("gamma"), worktree("alpha--wt-two", "alpha")],
    titles: ["Title alpha", "Title gamma"], badges: 0, commitTo: "alpha" },
  { name: "AC3: a worktree record without a parent is listed, and an unreachable one stays disabled",
    current: "alpha",
    projects: [project("alpha"), worktree("orphan", undefined), worktree("stranded", undefined, { worktreeAccessible: false })],
    titles: ["Title alpha", "Title orphan", "Title stranded"], badges: 1, disabled: ["Title stranded"], commitTo: "orphan" },
  { name: "AC4: only the current project and its worktrees leaves one row, and the dialog still opens",
    current: "alpha",
    projects: [project("alpha"), worktree("alpha--wt-one", "alpha")],
    titles: ["Title alpha"], badges: 1, commitTo: null },
  { name: "AC4: nothing but worktrees of other projects leaves no row, and the dialog stays shut",
    current: "alpha",
    projects: [worktree("beta--wt-one", "beta")],
    titles: [], badges: 0, commitTo: null },
];

test("project switcher: Ctrl+E lists only top-level projects, Enter switches to the highlighted one", async function (t) {
  for (var i = 0; i < ROWS.length; i++) {
    var row = ROWS[i];
    t.mock.timers.reset();
    var b = await browser(t, row.current, row.projects);
    b.open();
    assert.deepEqual(b.titles(), row.titles, row.name + ": rows");
    assert.equal(b.isOpen(), row.titles.length > 0, row.name + ": dialog open");
    assert.equal(b.items().filter(function (el) { return el.querySelector(".project-switcher-current"); }).length, row.badges, row.name + ": current badge");
    (row.disabled || []).forEach(function (title) {
      var el = b.items().filter(function (it) { return it.querySelector(".cmd-palette-item-title").textContent === title; })[0];
      assert.ok(el.classList.contains("disabled"), row.name + ": " + title + " disabled");
      assert.equal(el.title, "Outside project path", row.name + ": " + title + " reason");
    });
    b.enter();
    assert.equal(b.current(), row.commitTo || row.current, row.name + ": slug after Enter");
    assert.deepEqual(b.pushed, row.commitTo ? ["/p/" + row.commitTo + "/"] : [], row.name + ": navigation");
  }
});
