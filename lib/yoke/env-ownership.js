// env-ownership.js - the one rule for whether an environment variable name
// belongs to a namespace. Ownership is by prefix (or an exact name), never by a
// list of the variables known today: a list is one name short the day a
// provider adds a variable, and that variable then leaks from the daemon's
// environment into a session that was meant to use its own.
//
// Names compare case-insensitively, as runtime-env-keys.js does.

function normalize(name) {
  return typeof name === "string" ? name.toUpperCase() : "";
}

/** Whether name starts with any of the prefixes. */
function matchesPrefix(prefixes, name) {
  var upper = normalize(name);
  if (!upper) return false;
  return (prefixes || []).some(function (p) { return upper.indexOf(normalize(p)) === 0; });
}

/** Whether name is one of the exact names. */
function matchesName(names, name) {
  var upper = normalize(name);
  if (!upper) return false;
  return (names || []).some(function (n) { return normalize(n) === upper; });
}

/**
 * Whether a scope ({names, prefixes}) owns the variable name.
 * @param {{names: ?string[], prefixes: ?string[]}} scope
 * @param {string} name
 */
function owns(scope, name) {
  return matchesName(scope.names, name) || matchesPrefix(scope.prefixes, name);
}

module.exports = {
  matchesPrefix: matchesPrefix,
  matchesName: matchesName,
  owns: owns,
};
