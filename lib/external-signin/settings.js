"use strict";

// Persistent settings for external sign-in. They live in their own owner-only
// file beside the rest of the console's state, never in daemon.json, because
// they hold the provider client secret: daemon.json is read back to browsers
// and copied by backup tooling, this file is neither.
//
// Reads are synchronous on purpose: the user-creation guard in users.js runs
// inside synchronous code and must see the current setting, not a cached one.

var fs = require("fs");
var path = require("path");

var FILE_NAME = "external-signin.json";

// The config directory is resolved on each call rather than captured at load,
// so a process (or a test) that points the console at another home sees the
// right file.
function settingsPath() {
  return path.join(require("../config").CONFIG_DIR, FILE_NAME);
}

function defaults() {
  return {
    enabled: false,
    provider: "oidc",
    // The local sign-in of the one user stays usable unless the admin turns it
    // off, so a provider outage cannot lock the owner out.
    localFallback: true,
    oidc: {
      issuer: "",
      clientId: "",
      clientSecret: "",
      allowedSubject: "",
    },
  };
}

function load() {
  var raw;
  try {
    raw = fs.readFileSync(settingsPath(), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return defaults();
    throw e;
  }
  // A file that exists but cannot be parsed is an error, not "off": treating
  // it as off would silently lift the one-user rule.
  var data = JSON.parse(raw);
  var base = defaults();
  var oidc = data && typeof data.oidc === "object" && data.oidc ? data.oidc : {};
  return {
    enabled: data.enabled === true,
    provider: typeof data.provider === "string" && data.provider ? data.provider : base.provider,
    localFallback: data.localFallback !== false,
    oidc: {
      issuer: typeof oidc.issuer === "string" ? oidc.issuer : "",
      clientId: typeof oidc.clientId === "string" ? oidc.clientId : "",
      clientSecret: typeof oidc.clientSecret === "string" ? oidc.clientSecret : "",
      allowedSubject: typeof oidc.allowedSubject === "string" ? oidc.allowedSubject : "",
    },
  };
}

function save(settings) {
  var target = settingsPath();
  var tmp = target + ".tmp." + process.pid;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  // The mode argument only applies when the file is created; keep an older,
  // looser file owner-only too.
  try { fs.chmodSync(target, 0o600); } catch (e) { /* the rename already succeeded */ }
}

// What a browser may be told. The client secret never leaves this module in
// any other form than "is one set".
function publicView(settings) {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    localFallback: settings.localFallback,
    oidc: {
      issuer: settings.oidc.issuer,
      clientId: settings.oidc.clientId,
      allowedSubject: settings.oidc.allowedSubject,
      clientSecretSet: !!settings.oidc.clientSecret,
    },
  };
}

module.exports = {
  FILE_NAME: FILE_NAME,
  settingsPath: settingsPath,
  load: load,
  save: save,
  publicView: publicView,
  defaults: defaults,
};
