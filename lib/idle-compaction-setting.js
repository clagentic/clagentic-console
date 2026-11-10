// idle-compaction-setting.js - read and write the Claude user setting
// "idleCompaction" in the Claude user settings file, the same file the CLI
// reads. The console owns that one key only: every other key is preserved.
//
// The setting is off-or-default by design. In the Claude SDK types, false stops
// Claude Code from compacting an idle session and true does not turn it on, so
// this module only ever writes false, or removes the key to return to the CLI
// default. A missing file reads as the default. A file that exists but cannot
// be read or parsed is reported and never written over.

var fs = require("fs");
var os = require("os");
var path = require("path");
var childProcess = require("child_process");
var claudeSettingsEnv = require("./claude-settings-env");

var KEY = "idleCompaction";

// "default" = key absent (the CLI decides), "off" = false, "on" = true as
// written by someone else; the console never writes "on".
function valueName(parsed) {
  if (parsed[KEY] === false) return "off";
  if (parsed[KEY] === true) return "on";
  return "default";
}

function readParsed(file) {
  var text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: true, parsed: {}, exists: false };
    return { ok: false, error: "Settings file could not be read: " + (e.code || e.message) };
  }
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: "Settings file is not valid JSON; it was left unchanged" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Settings file is not a JSON object; it was left unchanged" };
  }
  return { ok: true, parsed: parsed, exists: true };
}

/**
 * @param {string} file  absolute path of the user settings file
 * @returns {{ok: boolean, value?: string, error?: string}}
 */
function readSetting(file) {
  var r = readParsed(file);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, value: valueName(r.parsed) };
}

/**
 * @param {string} file  absolute path of the user settings file
 * @param {"off"|"default"} mode  off writes false; default removes the key
 * @returns {{ok: boolean, value?: string, error?: string}}
 */
function writeSetting(file, mode) {
  if (mode !== "off" && mode !== "default") {
    return { ok: false, error: "Value must be off or default" };
  }
  var r = readParsed(file);
  if (!r.ok) return { ok: false, error: r.error };
  var parsed = r.parsed;
  if (mode === "default") {
    if (!(KEY in parsed)) return { ok: true, value: "default" };
    delete parsed[KEY];
  } else {
    parsed[KEY] = false;
  }

  var dir = path.dirname(file);
  var tmp = path.join(dir, "." + path.basename(file) + "." + process.pid + "." + Date.now() + ".tmp");
  try {
    fs.mkdirSync(dir, { recursive: true });
    var mode0 = r.exists ? fs.statSync(file).mode & 0o777 : 0o600;
    var fd = fs.openSync(tmp, "wx", mode0);
    try {
      fs.writeFileSync(fd, JSON.stringify(parsed, null, 2) + "\n");
      fs.fchmodSync(fd, mode0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* tmp may not exist */ }
    return { ok: false, error: "Settings file could not be written: " + (e.code || e.message) };
  }
  return { ok: true, value: valueName(parsed) };
}

/**
 * The settings file of the account a request acts for, never anyone else's.
 * Under os-users mode that is the user's own home; otherwise it is the file the
 * daemon account's CLI reads (claude-settings-env.js).
 *
 * @param {{osUserInfo?: {home: string}|null, osUsers?: boolean, homeDir?: string}} opts
 * @returns {?string} null when the owner's file cannot be named
 */
function settingsFileFor(opts) {
  opts = opts || {};
  if (opts.osUsers) {
    if (!opts.osUserInfo || !opts.osUserInfo.home) return null;
    return path.join(opts.osUserInfo.home, ".claude", "settings.json");
  }
  return claudeSettingsEnv.resolveSettingsFile({ homeDir: opts.homeDir || os.homedir() });
}

/**
 * Run a read or write against the owner's file. Under os-users mode the work
 * runs in a child process under the owner's uid and gid, the same way other
 * per-user file access does, so the daemon never touches another account's
 * file with its own privileges.
 *
 * @param {"read"|"write"} op
 * @param {"off"|"default"|null} mode  for write
 * @param {{osUserInfo?: object|null, osUsers?: boolean, homeDir?: string}} opts
 * @returns {{ok: boolean, value?: string, error?: string}}
 */
function applyForOwner(op, mode, opts) {
  var file = settingsFileFor(opts);
  if (!file) return { ok: false, error: "The settings file for this account is not available" };
  var run = op === "write" ? function () { return writeSetting(file, mode); } : function () { return readSetting(file); };
  if (!(opts && opts.osUsers)) return run();
  var script = "var m=require(" + JSON.stringify(__filename) + ");" +
    "process.stdout.write(JSON.stringify(" +
    (op === "write" ? "m.writeSetting(" + JSON.stringify(file) + "," + JSON.stringify(mode) + ")" : "m.readSetting(" + JSON.stringify(file) + ")") + "));";
  try {
    var out = childProcess.execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      timeout: 10000,
      uid: opts.osUserInfo.uid,
      gid: opts.osUserInfo.gid,
    });
    return JSON.parse(out.trim());
  } catch (e) {
    return { ok: false, error: "The settings file for this account could not be reached" };
  }
}

module.exports = {
  KEY: KEY,
  readSetting: readSetting,
  writeSetting: writeSetting,
  settingsFileFor: settingsFileFor,
  applyForOwner: applyForOwner,
};
