// A session's additive settings file: a user-supplied path handed to the
// vendor runtime as an extra settings source. The console checks the path and,
// when it must also pass a settings object of its own, combines the two; it
// does not interpret the file's content otherwise.

var fs = require("fs");
var path = require("path");

// Checks a path at open time and at every launch. Returns { path } or { error }.
// Readable is checked for the daemon's identity; a session run as another OS
// user is checked again by that user's runtime, which fails the turn if it
// cannot read the file.
function checkSettingsFile(file) {
  if (typeof file !== "string" || !file) return { error: "settings file must be a path" };
  var shown = JSON.stringify(file.slice(0, 200));
  if (!path.isAbsolute(file)) return { error: "settings file " + shown + " is not an absolute path" };
  var stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return { error: "settings file " + shown + " does not exist or cannot be read" };
  }
  if (!stat.isFile()) return { error: "settings file " + shown + " is not a regular file" };
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch (e) {
    return { error: "settings file " + shown + " is not readable" };
  }
  return { path: file };
}

// The value for the runtime's single `settings` option. The option takes a
// path or one object, not both, so with no console-supplied object the path is
// passed as is; with one, the file is read and the two are shallow-merged,
// the console's keys winning (they are the console's own switches). Returns
// { settings } or { error } (an unreadable or non-object file fails closed).
function composeSettings(file, consoleSettings) {
  var checked = checkSettingsFile(file);
  if (checked.error) return checked;
  if (!consoleSettings || Object.keys(consoleSettings).length === 0) return { settings: file };
  var parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { error: "settings file " + JSON.stringify(file.slice(0, 200)) + " is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "settings file " + JSON.stringify(file.slice(0, 200)) + " is not a JSON object" };
  }
  return { settings: Object.assign({}, parsed, consoleSettings) };
}

module.exports = { checkSettingsFile: checkSettingsFile, composeSettings: composeSettings };
