// The phone settings navigation: one Settings entry in More, one list of the
// areas a user may use with their sections, a section opens and Back returns.
//
// The shared component (settings-nav.js) and the access rules
// (settings-access.js) run here over a hand-built DOM (no jsdom in this repo).
// The section lists come from the real index.html, so a name, order or
// grouping that differs between the phone list and desktop fails here. The
// browser-bound modules (sidebar-mobile.js, settings-hub.js) are pinned from
// their source, as elsewhere in this suite.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var dom = require("./fake-dom-prompt-cards");

var PUBLIC = path.join(__dirname, "../lib/public");
var HTML = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
function moduleSource(name) {
  return fs.readFileSync(path.join(PUBLIC, "modules", name), "utf8");
}

function load(name) {
  dom.setupGlobals();
  return import(dom.moduleUrl(name));
}

// ---------------------------------------------------------------------------
// A desktop section list, built from index.html markup
// ---------------------------------------------------------------------------

var AREA_MARKUP = {
  server: { from: '<div class="server-settings-nav-items">', to: '<div class="server-settings-content">', after: '<div id="server-settings"' },
  project: { from: '<div class="server-settings-nav-items">', to: '<div class="project-settings-content">', after: '<div id="project-settings"' },
  user: { from: '<div class="us-modal-nav-items">', to: '<div class="us-modal-content">' },
};

function navElement(area) {
  var def = AREA_MARKUP[area];
  var start = def.after ? HTML.indexOf(def.after) : 0;
  var from = HTML.indexOf(def.from, start);
  var to = HTML.indexOf(def.to, from);
  assert.ok(from !== -1 && to !== -1, "the " + area + " section list is in index.html");
  var region = HTML.slice(from + def.from.length, to);
  var nav = new dom.FakeElement("div");
  var tag = /<(div|button)\s+class="([^"]*)"([^>]*)>(?:<span>([^<]*)<\/span>|([^<]*)<\/div>)?/g;
  var m;
  while ((m = tag.exec(region))) {
    var el = new dom.FakeElement(m[1]);
    el.className = m[2];
    var data = /data-section="([^"]*)"/.exec(m[3]);
    if (data) el.dataset.section = data[1];
    el.textContent = (m[4] !== undefined ? m[4] : m[5] || "").trim();
    nav.appendChild(el);
  }
  return nav;
}

var READ = {
  server: { categorySelector: ".settings-nav-category" },
  project: { categorySelector: ".settings-nav-category" },
  user: { itemSelector: ".us-nav-item", separatorSelector: ".us-nav-separator", dangerClass: "us-nav-danger" },
};

function plain(groups) {
  return groups.map(function (g) {
    return { label: g.label, items: g.items.map(function (i) { return i.label + (i.danger ? "!" : ""); }) };
  });
}

// ---------------------------------------------------------------------------
// Section names, order and grouping equal desktop's (AC5)
// ---------------------------------------------------------------------------

var SECTION_ROWS = [
  // [area, options, expected groups]
  ["server", { isAdmin: false }, [
    { label: "General", items: ["Status", "Notifications", "Security"] },
    { label: "Defaults", items: ["Model"] },
    { label: "Config", items: ["Instructions", "Environment", "Storage", "Custom Icons"] },
    { label: "Clagentic", items: ["Lite"] },
    { label: "Server", items: ["Advanced", "Restart", "Shutdown!"] },
  ]],
  ["server", { isAdmin: true }, [
    { label: "General", items: ["Status", "Notifications", "Security"] },
    { label: "Defaults", items: ["Model"] },
    { label: "Config", items: ["Instructions", "Environment", "Storage", "Custom Icons"] },
    { label: "Admin", items: ["Users", "Invites", "Projects", "Email"] },
    { label: "Clagentic", items: ["Lite"] },
    { label: "Server", items: ["Advanced", "Restart", "Shutdown!"] },
  ]],
  ["project", { isAdmin: false }, [
    { label: "General", items: ["Profile", "Model"] },
    { label: "Config", items: ["Instructions", "Environment"] },
  ]],
  ["user", { isAdmin: false }, [
    { label: null, items: ["Account", "Appearance", "Chat"] },
    { label: null, items: ["Log Out!"] },
  ]],
];

SECTION_ROWS.forEach(function (row) {
  var title = "section list parity: " + row[0] + (row[1].isAdmin ? " (administrator)" : "");
  test(title, async function () {
    var nav = await load("settings-nav.js");
    var groups = nav.readNavGroups(navElement(row[0]), Object.assign({}, READ[row[0]], row[1]));
    assert.deepEqual(plain(groups), row[2]);
  });
});

test("section list parity: the project's Lite section follows the desktop list's visibility", async function () {
  var nav = await load("settings-nav.js");
  var el = navElement("project");
  var lite = el.querySelectorAll(".settings-nav-item").filter(function (i) { return i.dataset.section === "lite"; })[0];
  assert.ok(lite, "the project list has a Lite entry");
  assert.ok(lite.classList.contains("hidden"), "hidden until the project's Lite status shows it");
  lite.classList.remove("hidden");
  var groups = nav.readNavGroups(el, READ.project);
  assert.deepEqual(plain(groups)[1].items, ["Instructions", "Environment", "Lite"]);
});

test("section list parity: the desktop Cmd+K palette lists the server sections as the list does", async function () {
  var nav = await load("settings-nav.js");
  var groups = nav.readNavGroups(navElement("server"), Object.assign({ isAdmin: true }, READ.server));
  var phone = [];
  groups.forEach(function (g) {
    g.items.forEach(function (i) { phone.push([i.section, i.label, g.label].join("|")); });
  });
  var src = moduleSource("server-settings.js");
  var table = src.slice(src.indexOf("var SETTINGS_SECTIONS = ["), src.indexOf("];", src.indexOf("var SETTINGS_SECTIONS = [")));
  var palette = [];
  var re = /section: '([^']+)',\s+label: '([^']+)',\s+group: '([^']+)'/g;
  var m;
  while ((m = re.exec(table))) palette.push([m[1], m[2], m[3]].join("|"));
  assert.deepEqual(palette, phone);
});

test("section list parity: an administrator-only group is dropped with its separator for everyone else", async function () {
  var nav = await load("settings-nav.js");
  var groups = nav.groupNavEntries([
    { type: "item", section: "a", label: "A" },
    { type: "separator", hidden: true },
    { type: "category", label: "Admin", hidden: true },
    { type: "item", section: "b", label: "B", hidden: true },
    { type: "separator" },
    { type: "category", label: "Other" },
    { type: "item", section: "c", label: "C" },
  ]);
  assert.deepEqual(plain(groups), [{ label: null, items: ["A"] }, { label: "Other", items: ["C"] }]);
});

// ---------------------------------------------------------------------------
// The Settings list: areas, sections, a row opens a section, Back returns (AC1)
// ---------------------------------------------------------------------------

function sampleAreas(nav) {
  return [
    { id: "user", title: "Personal", groups: nav.groupNavEntries([
      { type: "item", section: "us-account", label: "Account" },
      { type: "item", section: "us-appearance", label: "Appearance" },
    ]) },
    { id: "project", title: "Project", subtitle: "Atlas", groups: nav.groupNavEntries([
      { type: "category", label: "General" },
      { type: "item", section: "profile", label: "Profile" },
    ]) },
  ];
}

test("the Settings list shows each area's title and a row per section", async function () {
  var nav = await load("settings-nav.js");
  var box = new dom.FakeElement("div");
  nav.renderSettingsNav(box, { areas: sampleAreas(nav), onSelect: function () {} });
  assert.deepEqual(box.querySelectorAll(".settings-nav-area-title").map(function (h) { return h.textContent; }), ["Personal", "ProjectAtlas"]);
  assert.deepEqual(box.querySelectorAll(".settings-nav-row").map(function (r) { return r.dataset.area + ":" + r.dataset.section; }),
    ["user:us-account", "user:us-appearance", "project:profile"]);
  assert.deepEqual(box.querySelectorAll(".settings-nav-group-title").map(function (h) { return h.textContent; }), ["General"]);
});

test("choosing a row opens that area's section", async function () {
  var nav = await load("settings-nav.js");
  var box = new dom.FakeElement("div");
  var chosen = [];
  nav.renderSettingsNav(box, { areas: sampleAreas(nav), onSelect: function (area, section) { chosen.push(area + ":" + section); } });
  box.querySelectorAll(".settings-nav-row")[2].click();
  box.querySelectorAll(".settings-nav-row")[1].click();
  assert.deepEqual(chosen, ["project:profile", "user:us-appearance"]);
});

test("every project and server section is one row in the list, so one tap opens it", async function () {
  var nav = await load("settings-nav.js");
  var box = new dom.FakeElement("div");
  var areas = ["user", "project", "server"].map(function (id) {
    return { id: id, title: id, groups: nav.readNavGroups(navElement(id), Object.assign({ isAdmin: true }, READ[id])) };
  });
  nav.renderSettingsNav(box, { areas: areas, onSelect: function () {} });
  var desktop = 0;
  areas.forEach(function (a) { a.groups.forEach(function (g) { desktop += g.items.length; }); });
  assert.equal(box.querySelectorAll(".settings-nav-row").length, desktop);
  assert.ok(desktop >= 20, "the list carries the user, project and server sections");
});

test("a danger section keeps its warning style in the list", async function () {
  var nav = await load("settings-nav.js");
  var box = new dom.FakeElement("div");
  var areas = [{ id: "user", title: "Personal", groups: nav.readNavGroups(navElement("user"), READ.user) }];
  nav.renderSettingsNav(box, { areas: areas, onSelect: function () {} });
  var danger = box.querySelectorAll(".settings-nav-row-danger");
  assert.equal(danger.length, 1);
  assert.equal(danger[0].dataset.section, "us-logout");
});

test("Back calls the panel's own close and names the open section", async function () {
  var nav = await load("settings-nav.js");
  var host = new dom.FakeElement("div");
  host.appendChild(new dom.FakeElement("div"));
  var backs = 0;
  var bar = nav.mountSettingsBack(host, { title: "Settings", label: "Back to Settings", onBack: function () { backs++; } });
  assert.equal(host.children[0], bar.el, "the bar is the first child");
  var btn = bar.el.querySelector(".settings-back-btn");
  assert.equal(btn.getAttribute("aria-label"), "Back to Settings");
  btn.click();
  assert.equal(backs, 1);
  bar.setTitle("Appearance");
  assert.equal(bar.el.querySelector(".settings-back-title").textContent, "Appearance");
});

// ---------------------------------------------------------------------------
// Which areas a user is offered (AC6)
// ---------------------------------------------------------------------------

var AREA_ROWS = [
  // [description, state, areas offered]
  ["administrator, project open", { permissions: null, isAdmin: true, currentSlug: "atlas" }, ["user", "project", "server"]],
  ["single-user mode (no permission object), project open", { permissions: undefined, isAdmin: true, currentSlug: "atlas" }, ["user", "project", "server"]],
  ["member without project-settings permission", { permissions: { projectSettings: false }, isAdmin: false, currentSlug: "atlas" }, ["user"]],
  ["member with project-settings permission", { permissions: { projectSettings: true }, isAdmin: false, currentSlug: "atlas" }, ["user", "project"]],
  ["administrator without project-settings permission", { permissions: { projectSettings: false }, isAdmin: true, currentSlug: "atlas" }, ["user", "server"]],
  ["permissions that do not mention project settings", { permissions: { sessionDelete: false }, isAdmin: false, currentSlug: "atlas" }, ["user", "project"]],
  ["no project open", { permissions: null, isAdmin: true, currentSlug: null }, ["user", "server"]],
  ["a member with nothing else to open", { permissions: { projectSettings: false }, isAdmin: false, currentSlug: null }, ["user"]],
];

AREA_ROWS.forEach(function (row) {
  test("settings areas offered: " + row[0], async function () {
    var access = await load("settings-access.js");
    assert.deepEqual(access.settingsAreaIds(row[1]), row[2]);
  });
});

test("the phone Settings list takes its areas from the shared access rule", function () {
  var hub = moduleSource("settings-hub.js");
  assert.match(hub, /settingsAreaIds\(\{[\s\S]*permissions: store\.get\("permissions"\)[\s\S]*isAdmin: isAdmin/);
  assert.match(hub, /checkAdminAccess\(\)\.then\(/);
  assert.match(hub, /openServerSettings\(section\)/);
  assert.doesNotMatch(hub, /getElementById\(["']server-settings-btn["']\)/);
});

test("the phone Settings list opens an area on a section, with no second picker", function () {
  var hub = moduleSource("settings-hub.js");
  assert.match(hub, /openUserSettings\(section\)/);
  assert.match(hub, /\}, section\);/);
  assert.match(hub, /openServerSettings\(section\)/);
});

// ---------------------------------------------------------------------------
// The More sheet holds tools and one Settings entry (AC3)
// ---------------------------------------------------------------------------

function moreSheetSource() {
  var src = moduleSource("sidebar-mobile.js");
  var start = src.indexOf("function renderSheetMore(");
  return src.slice(start, src.indexOf("\nexport function initSidebarMobile", start));
}

test("More sheet: one Settings entry opens the Settings list", function () {
  var body = moreSheetSource();
  var entries = body.match(/addItem\("settings", "Settings"/g) || [];
  assert.equal(entries.length, 1);
  assert.match(body, /closeMobileSheet\(\);\s*openSettingsHub\(\);/);
});

test("More sheet: no setting is edited in the sheet", function () {
  var body = moreSheetSource();
  [/Project Settings/, /Server Settings/, /Appearance/, /Chat layout/, /mountThemeChoice/, /setChatLayout/, /setThemeMode/, /fetch\(/].forEach(function (re) {
    assert.doesNotMatch(body, re, String(re));
  });
  var imports = moduleSource("sidebar-mobile.js").split("\n").filter(function (l) { return /^import /.test(l); }).join("\n");
  assert.doesNotMatch(imports, /theme-choice|theme\.js/, "the sheet no longer imports an appearance control");
});

test("More sheet: the tools are as they were", function () {
  var body = moreSheetSource();
  assert.match(body, /addItem\("folder-tree", "Files"/);
  assert.match(body, /addItem\("square-terminal", "Terminal"/);
  assert.match(body, /getSessionTools\(\)/);
  assert.match(body, /addItem\("smartphone", "Open as app"/);
});

test("each appearance control exists in exactly one place", function () {
  var count = (HTML.match(/id="us-theme-switcher"/g) || []).length;
  assert.equal(count, 1);
  var appearance = HTML.slice(HTML.indexOf('<div class="us-section" data-section="us-appearance">'), HTML.indexOf('<div class="us-section" data-section="us-chat">'));
  assert.match(appearance, /us-theme-switcher/);
  assert.match(appearance, /us-layout-switcher/);
  assert.match(moduleSource("user-settings.js"), /mountThemeChoice\(themeSwitcher/);
  ["sidebar-mobile.js", "settings-hub.js", "settings-nav.js"].forEach(function (name) {
    assert.doesNotMatch(moduleSource(name), /mountThemeChoice\(/, name);
  });
});

// ---------------------------------------------------------------------------
// The shared component replaces the copied pill, overlay and select (AC8)
// ---------------------------------------------------------------------------

test("no copied pill, second overlay or section dropdown remains in the markup", function () {
  assert.doesNotMatch(HTML, /settings-nav-pill|ps-nav-pill/);
  assert.doesNotMatch(HTML, /id="ps-palette/);
  assert.doesNotMatch(HTML, /user-settings-nav-dropdown/);
  assert.equal((HTML.match(/class="settings-palette /g) || []).length, 1, "one Jump to setting overlay, the desktop Cmd+K one");
  assert.match(HTML, /id="settings-hub"/);
});

test("no copied pill, overlay or section dropdown remains in the code", function () {
  ["server-settings.js", "project-settings.js", "user-settings.js"].forEach(function (name) {
    var src = moduleSource(name);
    assert.doesNotMatch(src, /nav-pill|NavPill|PsPill|navDropdown/, name);
    assert.match(src, /mountSettingsBack\(/, name + " uses the shared Back bar");
  });
  assert.doesNotMatch(moduleSource("project-settings.js"), /Palette/);
  var css = ["server-settings.css", "user-settings.css", "filebrowser.css"].map(function (f) {
    return fs.readFileSync(path.join(PUBLIC, "css", f), "utf8");
  }).join("\n");
  assert.doesNotMatch(css, /settings-nav-pill|settings-nav-dropdown/);
});

// ---------------------------------------------------------------------------
// Desktop is unchanged (AC7)
// ---------------------------------------------------------------------------

test("desktop keeps its section lists, openers, close buttons and Cmd+K palette", function () {
  ["server-settings-btn", "user-settings-btn", "server-settings-close", "project-settings-close", "user-settings-close", "settings-palette-input"].forEach(function (id) {
    assert.match(HTML, new RegExp('id="' + id + '"'), id);
  });
  assert.match(moduleSource("server-settings.js"), /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === "k"/);
  assert.match(moduleSource("user-settings.js"), /openBtn\.addEventListener\('click', function \(\) \{\s*openUserSettings\(\);/);
  var css = fs.readFileSync(path.join(PUBLIC, "css", "settings-nav.css"), "utf8");
  var outside = css.slice(0, css.indexOf("@media"));
  assert.match(outside, /\.settings-back-bar,\s*#settings-hub \{\s*display: none;/);
  assert.doesNotMatch(outside.replace(/\/\*[\s\S]*?\*\//g, ""), /(color|background|padding|width)/, "nothing above 768px is styled by the phone list");
});

test("the phone back bar and list are phone-only and tap targets are 44px", function () {
  var css = fs.readFileSync(path.join(PUBLIC, "css", "settings-nav.css"), "utf8");
  assert.match(css, /\.settings-back-btn \{[^}]*width: 44px;[^}]*height: 44px;/);
  assert.match(css, /\.settings-nav-row \{[^}]*min-height: 44px;/);
  assert.match(css, /#user-settings \.layout-option,[\s\S]*min-height: 44px;/);
});

// ---------------------------------------------------------------------------
// Nested overlays: closing the top one from the UI is not a back swipe
// ---------------------------------------------------------------------------

test("overlay history: closing a nested overlay from the UI does not close the one under it", async function () {
  var calls = [];
  global.history = { pushState: function () { calls.push("push"); }, back: function () { calls.push("back"); } };
  var h = await import(dom.moduleUrl("overlay-history.js") + "?nested");
  h.pushOverlayState(); // the Settings list
  h.pushOverlayState(); // a section panel
  h.popOverlayState(); // Back on the section panel
  assert.equal(h.hasOverlayState(), true, "the Settings list still holds its entry");
  assert.equal(h.consumeOwnPopstate(), true, "the popstate of our own back is recognised");
  assert.equal(h.consumeOwnPopstate(), false, "and only once");
  // A real back swipe now closes the list.
  assert.equal(h.consumeOverlayPopstate(), true);
  h.popOverlayState();
  assert.deepEqual(calls, ["push", "push", "back"], "the swipe's own pop issues no second back");
  assert.equal(h.hasOverlayState(), false);
});
