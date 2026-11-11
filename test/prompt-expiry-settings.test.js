"use strict";
// The prompt expiry setting (lib/prompt-expiry-settings.js): what is accepted,
// how daemon.json is updated, the admin-only WebSocket message, and the
// Settings input.

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var { pathToFileURL } = require("url");
var world = require("./prompt-harness-world");
var { createProjectAccess } = require("../lib/project-access");
var { createPromptRegistry } = require("../lib/prompt-registry");
var settings = require("../lib/prompt-expiry-settings");
var expiry = require("../lib/prompt-expiry");
var { MALFORMED_MINUTES } = require("./prompt-expiry-rows");

var client = world.client;
var MIN = 60000;

test("the default is 30 minutes and an absent or malformed key reads as the default", function () {
  assert.equal(expiry.DEFAULT_MINUTES, 30);
  var cfgs = [null, {}].concat(MALFORMED_MINUTES.map(function (bad) { return { promptExpiryMinutes: bad }; }));
  cfgs.forEach(function (cfg) {
    assert.equal(expiry.readExpiryMinutes(cfg), 30, JSON.stringify(cfg));
  });
  assert.equal(expiry.readExpiryMinutes({ promptExpiryMinutes: 0 }), 0);
  assert.equal(expiry.readExpiryMinutes({ promptExpiryMinutes: 10 }), 10);
});

// One row per request: accepted with its minutes, or refused with a reason.
var PICK_ROWS = [
  { body: { promptExpiryMinutes: 10 }, ok: true, minutes: 10 },
  { body: { promptExpiryMinutes: 0 }, ok: true, minutes: 0 },
  { body: { promptExpiryMinutes: expiry.MAX_MINUTES }, ok: true, minutes: expiry.MAX_MINUTES },
  { body: { promptExpiryMinutes: -1 }, ok: false },
  { body: { promptExpiryMinutes: 1.5 }, ok: false },
  { body: { promptExpiryMinutes: expiry.MAX_MINUTES + 1 }, ok: false },
  { body: { promptExpiryMinutes: "10" }, ok: false },
  { body: { promptExpiryMinutes: NaN }, ok: false },
  { body: {}, ok: false },
  { body: { promptExpiryMinutes: 10, extra: 1 }, ok: false },
];

PICK_ROWS.forEach(function (row) {
  test("a request " + JSON.stringify(row.body) + (row.ok ? " is accepted" : " is refused with a reason"), function () {
    var picked = settings.pickSettingChange(Object.assign({ type: "set_prompt_expiry_settings" }, row.body));
    assert.equal(picked.ok, row.ok);
    if (row.ok) assert.equal(picked.minutes, row.minutes);
    else assert.match(picked.reason, /promptExpiryMinutes|Unknown/);
  });
});

test("a saved value is kept, and the default removes the key", function () {
  var cfg = { other: 1 };
  settings.applySettingChange(cfg, 10);
  assert.deepEqual(cfg, { other: 1, promptExpiryMinutes: 10 });
  settings.applySettingChange(cfg, 0);
  assert.equal(cfg.promptExpiryMinutes, 0, "0 is a value, kept");
  settings.applySettingChange(cfg, 30);
  assert.deepEqual(cfg, { other: 1 });
  assert.deepEqual(settings.settingsMessage(cfg), { type: "prompt_expiry_settings", promptExpiryMinutes: 30 });
});

test("a saved value is the bound of the next prompt, and 0 leaves none", function (t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  var cfg = {};
  var cancels = [];
  var session = { localId: 1, queryInstance: null };
  var registry = createPromptRegistry({
    index: Object.create(null),
    getSession: function () { return session; },
    sendAndRecord: function (s, m) { if (m.type === "prompt_cancel") cancels.push(m); },
    saveSessionFile: function () {},
    getConfig: function () { return cfg; },
  });
  function open(id) {
    return registry.open(session, "permission", { toolName: "Bash", toolInput: {}, vendor: "claude" }, { toolUseId: id });
  }
  settings.applySettingChange(cfg, 5);
  open("a");
  t.mock.timers.tick(5 * MIN);
  assert.equal(cancels.length, 1);
  settings.applySettingChange(cfg, 0);
  open("b");
  t.mock.timers.tick(1000 * MIN);
  assert.equal(cancels.length, 1, "no expiry");
});

function setup(server) {
  var cfg = {};
  var sets = [];
  var announced = [];
  var access = createProjectAccess({
    users: { canAccessProject: function () { return true; }, canAccessSession: function () { return true; } },
    isMultiUser: function () { return true; },
  });
  var ctx = Object.assign({}, server.handlerContext, {
    projectAccess: access,
    opts: {
      onGetPromptExpirySettings: function () { return settings.settingsMessage(cfg); },
      onSetPromptExpirySettings: function (minutes) { sets.push(minutes); settings.applySettingChange(cfg, minutes); return { ok: true }; },
      broadcastAll: function (msg) { announced.push(msg); },
    },
  });
  return { handlers: require(world.LIB_ROOT + "/project-sessions").attachSessions(ctx), sets: sets, announced: announced, cfg: cfg };
}

function who(server, user) {
  var c = client();
  c.ws._clagenticUser = user;
  c.ws._clagenticAuthenticated = true;
  server.connect(c.ws);
  c.inbox.length = 0;
  return c;
}

function errors(c) { return c.inbox.filter(function (m) { return m.type === "error"; }); }

test("an admin's change is saved and announced; setting the default removes the key", async function () {
  var server = await world.createServer();
  try {
    var s = setup(server);
    var admin = who(server, { id: "a1", role: "admin" });
    s.handlers.handleSessionsMessage(admin.ws, { type: "set_prompt_expiry_settings", promptExpiryMinutes: 10 });
    assert.deepEqual(s.cfg, { promptExpiryMinutes: 10 });
    assert.deepEqual(s.announced[0], { type: "prompt_expiry_settings", promptExpiryMinutes: 10 });
    s.handlers.handleSessionsMessage(admin.ws, { type: "set_prompt_expiry_settings", promptExpiryMinutes: 30 });
    assert.deepEqual(s.cfg, {});
    assert.deepEqual(s.announced[1], { type: "prompt_expiry_settings", promptExpiryMinutes: 30 });
    assert.equal(errors(admin).length, 0);
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("a non-admin is refused and an invalid value saves nothing", async function () {
  var server = await world.createServer();
  try {
    var s = setup(server);
    var warn = console.warn;
    console.warn = function () {};
    try {
      [{ id: "u9", role: "user" }, null].forEach(function (user) {
        var c = who(server, user);
        s.handlers.handleSessionsMessage(c.ws, { type: "set_prompt_expiry_settings", promptExpiryMinutes: 10 });
        assert.equal(errors(c).length, 1, JSON.stringify(user));
      });
      var admin = who(server, { id: "a1", role: "admin" });
      s.handlers.handleSessionsMessage(admin.ws, { type: "set_prompt_expiry_settings", promptExpiryMinutes: -5 });
      assert.equal(errors(admin).length, 1);
      assert.match(errors(admin)[0].text, /promptExpiryMinutes/);
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(s.sets, []);
    assert.deepEqual(s.announced, []);
  } finally {
    server.shutdown();
    world.removeHome(server.home);
  }
});

test("the message is in the schema in both directions", function () {
  var table = require("../lib/ws-schema").schema;
  assert.equal(table.set_prompt_expiry_settings.direction, "c2s");
  assert.equal(table.prompt_expiry_settings.direction, "s2c");
});

// The Settings input: shows the value the server sent and sends the whole
// number typed, refusing anything else.
async function loadControls() {
  var input = { value: "", onchange: null };
  var problem = { textContent: "" };
  global.document = {
    getElementById: function (id) { return id === "ss-prompt-expiry" ? input : id === "ss-prompt-expiry-problem" ? problem : null; },
  };
  var file = path.join(__dirname, "..", "lib", "public", "modules", "prompt-expiry-controls.js");
  var mod = await import(pathToFileURL(file).href + "?c=" + Math.random());
  var sent = [];
  mod.renderPromptExpirySettings(function (type, data) { sent.push({ type: type, data: data }); });
  return { mod: mod, input: input, problem: problem, sent: sent };
}

test("the input shows the server's value and sends a whole number of minutes", async function () {
  var c = await loadControls();
  assert.equal(c.input.value, "30", "the default before the server answers");
  c.mod.handlePromptExpirySettings({ type: "prompt_expiry_settings", promptExpiryMinutes: 10 });
  assert.equal(c.input.value, "10");
  c.input.value = "0";
  c.input.onchange();
  c.input.value = "45";
  c.input.onchange();
  assert.deepEqual(c.sent, [
    { type: "set_prompt_expiry_settings", data: { promptExpiryMinutes: 0 } },
    { type: "set_prompt_expiry_settings", data: { promptExpiryMinutes: 45 } },
  ]);
});

test("the input refuses a value outside the range, says so, and puts the current value back", async function () {
  var c = await loadControls();
  c.mod.handlePromptExpirySettings({ type: "prompt_expiry_settings", promptExpiryMinutes: 10 });
  ["-1", "1.5", "abc", "", "99999"].forEach(function (typed) {
    c.input.value = typed;
    c.input.onchange();
    assert.match(c.problem.textContent, /0 turns expiry off/, typed);
    assert.equal(c.input.value, "10", typed);
  });
  assert.deepEqual(c.sent, []);
});

test("the Settings page says that 0 disables expiry and shows the input to admins only", function () {
  var html = require("fs").readFileSync(path.join(__dirname, "..", "lib", "public", "index.html"), "utf8");
  var card = html.slice(html.lastIndexOf('<div class="settings-card', html.indexOf('id="ss-prompt-expiry"')), html.indexOf('id="ss-prompt-expiry-problem"'));
  assert.match(card, /settings-admin-only/);
  assert.match(card, /0 disables expiry/);
});
