"use strict";

// POST /api/custom-emoji/:slug?create=1 never replaces an existing icon; without
// the flag an upload replaces, as it always did (Server Settings relies on that).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { EventEmitter } = require("events");

var audit = require("../lib/audit");
var { attachSettings } = require("../lib/server-settings");

// The route audits every upload; keep this test off the host's audit log.
var realAuditLog = audit.log;
audit.log = function () {};
test.after(function () { audit.log = realAuditLog; });

var PNG_A = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("first")]);
var PNG_B = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("second")]);
var JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("other-format")]);

function makeWorld() {
  var configDir = fs.mkdtempSync(path.join(os.tmpdir(), "emoji-create-only-"));
  var settings = attachSettings({
    users: {},
    getMultiUserFromReq: function () { return { id: "user-1", username: "operator" }; },
    isRequestAuthed: function () { return true; },
    projects: new Map(),
    opts: {},
    CONFIG_DIR: configDir,
  });
  return { dir: path.join(configDir, "custom-emoji"), configDir: configDir, settings: settings };
}

function post(world, url, body) {
  return new Promise(function (resolve) {
    var req = new EventEmitter();
    req.method = "POST";
    req.headers = {};
    var res = {
      status: null,
      writeHead: function (code) { this.status = code; },
      end: function (text) { resolve({ status: this.status, body: text ? JSON.parse(text) : null }); },
    };
    assert.equal(world.settings.handleRequest(req, res, url), true);
    req.emit("data", body);
    req.emit("end");
  });
}

function stored(world, slug, ext) {
  var file = path.join(world.dir, slug + "." + ext);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

var TABLE = [
  { name: "a create-only upload of a new slug is stored", first: null, second: { body: PNG_A, query: "?create=1" }, status: 200, png: PNG_A, jpg: null },
  { name: "a create-only upload of an existing slug does not overwrite it", first: PNG_A, second: { body: PNG_B, query: "?create=1" }, status: 409, png: PNG_A, jpg: null },
  { name: "a create-only upload of an existing slug in another format neither replaces nor adds beside it", first: PNG_A, second: { body: JPG, query: "?create=1" }, status: 409, png: PNG_A, jpg: null },
  { name: "an upload without the flag still replaces, so Server Settings is unchanged", first: PNG_A, second: { body: PNG_B, query: "" }, status: 200, png: PNG_B, jpg: null },
  { name: "an upload without the flag still replaces across formats", first: PNG_A, second: { body: JPG, query: "" }, status: 200, png: null, jpg: JPG },
];

TABLE.forEach(function (row) {
  test(row.name, async function () {
    var world = makeWorld();
    try {
      if (row.first) assert.equal((await post(world, "/api/custom-emoji/team-icon", row.first)).status, 200);
      var out = await post(world, "/api/custom-emoji/team-icon" + row.second.query, row.second.body);
      assert.equal(out.status, row.status);
      if (row.status === 409) assert.match(out.body.error, /already exists/);
      assert.deepEqual(stored(world, "team-icon", "png"), row.png);
      assert.deepEqual(stored(world, "team-icon", "jpg"), row.jpg);
    } finally {
      fs.rmSync(world.configDir, { recursive: true, force: true });
    }
  });
});
