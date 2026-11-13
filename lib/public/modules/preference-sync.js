// preference-sync.js - the one place a per-user preference's server round trip is
// reported and the profile is read at load.
//
// The theme, the chat width and the session-list avatars are cached in
// localStorage and reconciled with the server, best effort: a failed save or a
// failed profile load must not stop the page, but it must not vanish either.
// Every such failure goes through reportPreferenceFailure, so the way it is
// reported changes in one place.

export function reportPreferenceFailure(message, err) {
  if (err === undefined) console.error(message);
  else console.error(message, err);
}

// Reads /api/profile and hands it to `apply`. A network error, a non-OK status,
// an unreadable body or an `apply` that throws is reported, naming the
// preference, and leaves what this browser already had in place. Resolves
// either way.
export function loadProfilePreference(name, apply) {
  return fetch("/api/profile").then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then(function (profile) {
    if (profile) apply(profile);
  }).catch(function (err) {
    reportPreferenceFailure("Loading the " + name + " preference failed:", err);
  });
}
