"use strict";

// The provider-neutral rules of external sign-in. Nothing here knows which
// provider is configured: the one-user rule, the refusal to add a user, the
// refusal to turn sign-in on over several users, the local fallback and the
// identity match all live here so a later provider adds only its own sign-in
// step and settings.

var settings = require("./settings");

var USER_CREATION_REFUSAL =
  "External sign-in is on: this console is limited to one user, so no user can be added. " +
  "Turn external sign-in off to add users.";

var TURN_ON_REFUSAL =
  "External sign-in cannot be turned on while this console has more than one user. " +
  "Remove the other users first; nothing is removed or changed automatically.";

var NO_USER_REFUSAL = "External sign-in needs exactly one user on this console.";

var LOCAL_SIGNIN_REFUSAL =
  "Local sign-in is turned off while external sign-in is on. Sign in through your identity provider.";

function isEnabled() {
  return settings.load().enabled;
}

// The one answer to "may a user be added": null when yes, the reason when no.
// Every writer that adds a user or an invite asks this before it writes.
function userCreationRefusal() {
  return isEnabled() ? USER_CREATION_REFUSAL : null;
}

// null when sign-in may be turned on for a console holding userCount users.
function turnOnRefusal(userCount) {
  if (userCount === 0) return NO_USER_REFUSAL;
  if (userCount > 1) return TURN_ON_REFUSAL;
  return null;
}

// Whether the local PIN and emailed-code sign-in may be used right now.
function localSignInAllowed() {
  var current = settings.load();
  return !current.enabled || current.localFallback;
}

// An external identity is the provider kind, the issuer or directory that
// vouches for it, and the subject that issuer assigned. All three must match;
// an email address is never part of the comparison.
function isCompleteIdentity(identity) {
  return !!identity &&
    typeof identity.provider === "string" && identity.provider !== "" &&
    typeof identity.issuer === "string" && identity.issuer !== "" &&
    typeof identity.subject === "string" && identity.subject !== "";
}

function sameIdentity(a, b) {
  return isCompleteIdentity(a) && isCompleteIdentity(b) &&
    a.provider === b.provider && a.issuer === b.issuer && a.subject === b.subject;
}

module.exports = {
  USER_CREATION_REFUSAL: USER_CREATION_REFUSAL,
  TURN_ON_REFUSAL: TURN_ON_REFUSAL,
  NO_USER_REFUSAL: NO_USER_REFUSAL,
  LOCAL_SIGNIN_REFUSAL: LOCAL_SIGNIN_REFUSAL,
  isEnabled: isEnabled,
  userCreationRefusal: userCreationRefusal,
  turnOnRefusal: turnOnRefusal,
  localSignInAllowed: localSignInAllowed,
  isCompleteIdentity: isCompleteIdentity,
  sameIdentity: sameIdentity,
};
