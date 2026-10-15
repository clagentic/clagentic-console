"use strict";

// Who a session's delivery directory belongs to: the OS user the session runs as.

// Failures of the lookup itself, as lib/os-users.js raises them: a name that is
// not a user name, a `getent` that answered nothing usable or exited non-zero
// (no such user). Anything else is not an expected outcome of a lookup.
function isExpectedLookupError(err) {
  if (!err) return false;
  if (err.message === "Invalid Linux username" || /^Unexpected getent output/.test(err.message)) return true;
  return typeof err.status === "number";
}

// lookup(linuxUser) returns { uid, gid } or throws. Returns { owner } where owner
// is { uid, gid }, or { unresolved: true } when the user cannot be told. An
// unexpected failure is logged through warn; the session still starts without an
// identity, as for an expected one.
function resolveOwner(linuxUser, lookup, warn) {
  try {
    var info = lookup(linuxUser);
    if (Number.isInteger(info.uid) && Number.isInteger(info.gid)) return { owner: { uid: info.uid, gid: info.gid } };
  } catch (err) {
    if (!isExpectedLookupError(err)) {
      warn("[identity] unexpected failure resolving the session's OS user: " + (err && err.message));
    }
  }
  return { unresolved: true };
}

module.exports = { resolveOwner: resolveOwner, isExpectedLookupError: isExpectedLookupError };
