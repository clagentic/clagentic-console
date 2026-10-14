// session-id.js - the one place a session id is checked before it becomes part
// of a file path. An id arrives from outside (a browser message, an injected
// input), so it is validated before any filesystem use and every path built from
// it is checked to stay inside the directory it is meant for.

var path = require("path");

// Letters, digits, "_" and "-", not starting with a separator-like character.
var SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isSafeSessionId(id) {
  return typeof id === "string" && SAFE_SESSION_ID.test(id);
}

// Returns <dir>/<id><ext>, throwing when the id is unsafe or the resolved path
// is not inside dir. The containment check is separate from the allowlist so a
// later loosening of the allowlist cannot reopen traversal.
function sessionPathWithin(dir, id, ext) {
  if (!isSafeSessionId(id)) {
    throw new Error("unsafe session id " + JSON.stringify(String(id).slice(0, 64)));
  }
  var root = path.resolve(dir);
  var full = path.resolve(root, id + ext);
  if (full.indexOf(root + path.sep) !== 0) {
    throw new Error("session path escapes its directory: " + JSON.stringify(String(id).slice(0, 64)));
  }
  return full;
}

module.exports = {
  isSafeSessionId: isSafeSessionId,
  sessionPathWithin: sessionPathWithin,
};
