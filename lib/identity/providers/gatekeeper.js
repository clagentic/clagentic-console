"use strict";

// Class 1: an attestation provider that issues Identity Assertions.
//
// Transport. The console runs the issuer's published client, `gatekeeper hook
// process`, documented for a launcher that starts a runtime as a subprocess. The
// socket protocol itself is not part of the published contract documents, so it
// is not spoken here.
//
// Launcher binding. The issuer binds the assertion to the runtime above the
// requesting process, which for the process adapter is its parent: the console
// process that starts the session. The client is therefore started directly by
// this process (execFile, no shell, no wrapper), never through `sh -c`.
//
// Origin passing. The origin is handed over as `--origin`. The adapter does not
// issue the origin "human" (follow-up in the issuer: lr-f184b8), so for a typed
// session no client is run at all: the session starts without an identity, with
// the stable reason code origin_human_not_issued and no notice, and is graded
// declared by consumers. It is never given an identity claiming another origin.
// The runtime id is not sent: the issuer derives `rt` from the launcher itself.

var childProcess = require("child_process");
var contract = require("../contract");
var unavailableModule = require("../unavailable");

var unavailable = unavailableModule.unavailable;

var OUTPUT_PATTERN = new RegExp("^" + contract.IDENTITY_DIR_ENV + "=(/[A-Za-z0-9._/+-]+)\\n?$");
var MAX_OUTPUT_BYTES = 4096;
var HUMAN_ORIGIN_CODE = "origin_human_not_issued";

function clientArgs(cfg, definition, origin) {
  var args = ["hook", "process", "--socket", cfg.socket];
  if (contract.matches(contract.NAME_PATTERN, definition)) args.push("--definition", definition);
  if (origin) args.push("--origin", origin);
  return args;
}

function createGatekeeperProvider(cfg, deps) {
  var execFile = (deps && deps.execFile) || childProcess.execFile;
  var warn = (deps && deps.warn) || console.warn;

  function obtainSession(definition, origin, rt, ctx) {
    // The issuer never issues a session for a typed turn; the human signal is the
    // per-turn origin, not the session assertion. Asking would only fail, so no
    // client is run and the absence is expected (no notice), never worked around
    // by another class.
    if (origin === "human") {
      return Promise.resolve(unavailable(HUMAN_ORIGIN_CODE,
        "the issuer does not issue sessions for a human-typed turn", { quiet: true }));
    }
    if (ctx && ctx.owner && ctx.owner.uid !== process.getuid()) {
      return Promise.resolve(unavailable("owner_unsupported",
        "the issuer delivers to the console's own user only, not to a per-user OS account"));
    }
    var env = Object.assign({}, process.env);
    delete env[contract.IDENTITY_DIR_ENV];
    return new Promise(function (resolve) {
      execFile(cfg.binary, clientArgs(cfg, definition, origin), {
        env: env,
        timeout: cfg.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: ctx && ctx.signal,
        windowsHide: true,
      }, function (err, stdout, stderr) {
        if (err) {
          var detail = String(stderr || err.message || "").trim().split("\n")[0].slice(0, 200);
          warn("[identity] gatekeeper client failed: " + (err.code === "ENOENT" ? "executable not found" : detail));
          if (err.code === "ENOENT") {
            resolve(unavailable("issuer_client_missing", "the identity issuer's client program was not found"));
          } else if (err.killed) {
            resolve(unavailable("issuer_timeout", "the identity issuer did not answer in time"));
          } else {
            resolve(unavailable("issuer_unavailable", "the identity issuer could not issue a session"));
          }
          return;
        }
        var match = OUTPUT_PATTERN.exec(String(stdout));
        if (!match) {
          resolve(unavailable("issuer_output_invalid", "the identity issuer's client answered in a form the console does not recognise"));
          return;
        }
        resolve({ provider: contract.PROVIDERS.GATEKEEPER, dir: match[1] });
      });
    });
  }

  return { name: contract.PROVIDERS.GATEKEEPER, obtainSession: obtainSession };
}

module.exports = { createGatekeeperProvider: createGatekeeperProvider };
