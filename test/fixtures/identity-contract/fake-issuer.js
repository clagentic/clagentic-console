"use strict";

// A stand-in for the issuer's client program (`gatekeeper hook process`), written
// as an executable script so the console runs it exactly as it runs the real one:
// directly, with the documented arguments. The socket path it is given selects
// what it does, so one script covers an issuer that works and each way one fails.
//
//   <anything>.sock       issues a session: makes a private directory holding an
//                         identity.jwt whose claims echo the arguments, prints
//                         CLAGENTIC_IDENTITY_DIR=<dir>
//   unreachable.sock      exits 1 as a client does when the socket cannot be dialled
//   slow.sock             never answers
//   late.sock             issues a session after 700 ms, if still running
//   garbage.sock          prints something that is not an assignment
//   badmode.sock          issues a directory that is not private
//
// Every invocation's arguments are appended to argv.log beside the script.

var fs = require("fs");
var os = require("os");
var path = require("path");

var SCRIPT = [
  "var fs = require('fs'), path = require('path'), crypto = require('crypto');",
  "var args = process.argv.slice(2);",
  "var base = path.dirname(__filename);",
  "fs.appendFileSync(path.join(base, 'argv.log'), JSON.stringify(args) + '\\n');",
  "fs.appendFileSync(path.join(base, 'env.log'), String(process.env.CLAGENTIC_IDENTITY_DIR) + '\\n');",
  "function flag(name) { var i = args.indexOf('--' + name); return i === -1 ? null : args[i + 1]; }",
  "if (args[0] !== 'hook' || args[1] !== 'process') { process.stderr.write('bad arguments\\n'); process.exit(2); }",
  "var socket = flag('socket'), definition = flag('definition'), origin = flag('origin') || 'trigger';",
  "var mode = path.basename(socket);",
  "if (mode === 'unreachable.sock') { process.stderr.write('dial unix: no such file or directory\\n'); process.exit(1); }",
  "function issue() {",
  "  var root = path.join(base, 'spawn'); fs.mkdirSync(root, { recursive: true });",
  "  var dir = path.join(root, 'gk-' + crypto.randomBytes(8).toString('hex'));",
  "  var dirMode = mode === 'badmode.sock' ? 0o755 : 0o700;",
  "  fs.mkdirSync(dir, { mode: dirMode }); fs.chmodSync(dir, dirMode); fs.mkdirSync(path.join(dir, 'tmp'), { mode: 0o700 });",
  "  var now = Math.floor(Date.now() / 1000);",
  "  var claims = { iss: 'unix://' + socket, sub: 'runtime:node', act: { sub: definition ? 'agent:' + definition : 'runtime:node' },",
  "    roles: [], grade: 'workload', rt: { id: 'claude-code', version: '1' }, sid: 'sess-1', origin: origin, dir: dir,",
  "    iat: now, exp: now + 3600, jti: 'jti-1', cia: 1 };",
  "  function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }",
  "  fs.writeFileSync(path.join(dir, 'identity.jwt'), b64({ alg: 'EdDSA', kid: 'k' }) + '.' + b64(claims) + '.sig', { mode: 0o600 });",
  "  process.stdout.write('CLAGENTIC_IDENTITY_DIR=' + dir + '\\n');",
  "}",
  "if (mode === 'slow.sock') { setTimeout(function () {}, 60000); }",
  "else if (mode === 'late.sock') { setTimeout(issue, 700); }",
  "else if (mode === 'garbage.sock') { process.stdout.write('hello\\n'); }",
  "else { issue(); }",
].join("\n");

// A log that was never written means no invocation; anything else (a corrupt
// line, a permission error) must fail the test that reads it, not pass it.
function orEmptyWhenMissing(read) {
  try {
    return read();
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

// Installs the script in a fresh directory and returns where it is.
function installFakeIssuer() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-issuer-"));
  var binary = path.join(dir, "fake-issuer");
  fs.writeFileSync(binary, "#!" + process.execPath + "\n" + SCRIPT + "\n", { mode: 0o755 });
  return {
    dir: dir,
    binary: binary,
    // The arguments of each invocation, in order.
    invocations: function () {
      return orEmptyWhenMissing(function () {
        return fs.readFileSync(path.join(dir, "argv.log"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      });
    },
    // The value of CLAGENTIC_IDENTITY_DIR in each invocation's environment.
    inheritedDirs: function () {
      return orEmptyWhenMissing(function () {
        return fs.readFileSync(path.join(dir, "env.log"), "utf8").trim().split("\n");
      });
    },
    // The delivery directories it has issued that still exist.
    issued: function () {
      return orEmptyWhenMissing(function () {
        return fs.readdirSync(path.join(dir, "spawn")).map(function (n) { return path.join(dir, "spawn", n); });
      });
    },
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { installFakeIssuer: installFakeIssuer };
