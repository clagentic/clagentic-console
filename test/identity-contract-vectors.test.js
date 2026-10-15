"use strict";
// The test verifier that judges the console's own assertions is itself proven
// against the vendored conformance vectors of the contract (version pinned), so
// "the vectors verify against the console-published JWKS" means something.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var crypto = require("crypto");
var verifier = require("./fixtures/identity-contract/verifier");

var VECTORS = path.join(__dirname, "fixtures", "identity-contract", "v1");
var manifest = JSON.parse(fs.readFileSync(path.join(VECTORS, "manifest.json"), "utf8"));
var pin = JSON.parse(fs.readFileSync(path.join(VECTORS, "PIN.json"), "utf8"));

var trusted = {};
Object.keys(manifest.jwks_files).forEach(function (iss) {
  trusted[iss] = JSON.parse(fs.readFileSync(path.join(VECTORS, manifest.jwks_files[iss]), "utf8"));
});

test("the vendored vector set is the pinned one", function () {
  assert.equal(manifest.contract_version, pin.contract_version);
  assert.equal(manifest.cia, 1);
  Object.keys(pin.files).forEach(function (name) {
    var digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(VECTORS, name))).digest("hex");
    assert.equal(digest, pin.files[name], name + " differs from its pin");
  });
});

function layoutDelivery(layout, scratch) {
  if (layout.dir === "unset") return undefined;
  var dir = path.join(scratch, "d");
  if (layout.dir === "absent") return dir;
  fs.mkdirSync(dir);
  fs.chmodSync(dir, parseInt(layout.dir_mode, 8));
  if (layout.file === "regular") fs.writeFileSync(path.join(dir, "identity.jwt"), layout.content);
  if (layout.file === "symlink") {
    var target = path.join(scratch, "elsewhere");
    fs.writeFileSync(target, layout.content);
    fs.symlinkSync(target, path.join(dir, "identity.jwt"));
  }
  return dir;
}

manifest.vectors.forEach(function (vector) {
  test("vector " + vector.id, async function () {
    var actual;
    if (vector.kind === "token") {
      actual = await verifier.verifyToken(vector.token, {
        trusted: trusted,
        mode: vector.mode,
        now: vector.now,
        observedDir: vector.observed_dir,
        peerId: vector.peer_id,
      });
    } else {
      var scratch = fs.mkdtempSync(path.join(os.tmpdir(), "identity-vector-"));
      try {
        var result = verifier.checkDelivery(layoutDelivery(vector.layout, scratch));
        actual = result.ok ? { ok: true, content: result.content } : result;
        if (result.ok) assert.equal(result.content, vector.layout.content);
        delete actual.content;
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
    assert.equal(actual.ok, vector.expect.ok, vector.description);
    if (vector.expect.ok) {
      if (vector.expect.actor) assert.equal(actual.actor, vector.expect.actor);
      if (vector.expect.grade) assert.equal(actual.grade, vector.expect.grade);
    } else {
      assert.equal(actual.error, vector.expect.error);
    }
  });
});
