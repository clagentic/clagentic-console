#!/usr/bin/env node
// Copies the Identity Assertion conformance vectors into test/fixtures and
// records a pin (contract version, source ref, sha256 of each file) so a test
// can prove the vendored set is the one that was pinned.
//
// Usage: node scripts/vendor-identity-vectors.js <vectors/v1 dir> [--ref <source ref>]
//
// Only the published contract artifacts are copied (manifest.json, jwks.json).
// No code from the contract's home repository is read or imported.

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var FILES = ["manifest.json", "jwks.json"];
var DEST = path.join(__dirname, "..", "test", "fixtures", "identity-contract", "v1");

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function parseArgs(argv) {
  var out = { source: null, ref: null };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--ref") out.ref = argv[++i];
    else if (!out.source) out.source = argv[i];
  }
  return out;
}

function main() {
  var args = parseArgs(process.argv.slice(2));
  if (!args.source) {
    console.error("usage: vendor-identity-vectors.js <vectors/v1 dir> [--ref <source ref>]");
    process.exit(2);
  }
  fs.mkdirSync(DEST, { recursive: true });
  var pin = { files: {} };
  FILES.forEach(function (name) {
    var buf = fs.readFileSync(path.join(args.source, name));
    fs.writeFileSync(path.join(DEST, name), buf);
    pin.files[name] = sha256(buf);
  });
  var manifest = JSON.parse(fs.readFileSync(path.join(DEST, "manifest.json"), "utf8"));
  pin.contract_version = manifest.contract_version;
  pin.cia = manifest.cia;
  pin.source_ref = args.ref || null;
  fs.writeFileSync(path.join(DEST, "PIN.json"), JSON.stringify(pin, null, 2) + "\n");
  console.log("vendored contract " + pin.contract_version + " (cia " + pin.cia + ") into " + DEST);
}

main();
