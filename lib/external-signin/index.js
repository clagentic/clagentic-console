"use strict";

// External sign-in, provider-neutral core. One object per server: the admin
// settings (read and write), the local-fallback answer, and the step that turns
// a verified provider identity into the console's one user. The provider
// (OIDC today) supplies only its own sign-in step and its settings checks.

var settings = require("./settings");
var policy = require("./policy");
var { createOidcProvider } = require("./oidc");

var MAX_FIELD_LENGTH = 2048;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : null;
}

function createExternalSignin(deps) {
  var users = deps.users;
  var provider = deps.provider || createOidcProvider();

  function isEnabled() {
    return policy.isEnabled();
  }

  function getView() {
    var current = settings.load();
    var view = settings.publicView(current);
    var bound = null;
    if (current.enabled) {
      bound = users.findUserByExternalIdentity(provider.allowedIdentity(current.oidc));
    }
    view.boundUser = bound ? { id: bound.id, username: bound.username } : null;
    return view;
  }

  // Applies an admin's change. Returns { ok: true, view } or
  // { error, status }. Nothing is written unless every check passes.
  function update(body, actor) {
    var current = settings.load();
    var next = JSON.parse(JSON.stringify(current));

    if (body.provider !== undefined && body.provider !== provider.kind) {
      return { error: "Unsupported sign-in provider.", status: 400 };
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return { error: "Invalid request", status: 400 };
      next.enabled = body.enabled;
    }
    if (body.localFallback !== undefined) {
      if (typeof body.localFallback !== "boolean") return { error: "Invalid request", status: 400 };
      next.localFallback = body.localFallback;
    }
    var incoming = body.oidc;
    if (incoming !== undefined) {
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return { error: "Invalid request", status: 400 };
      var fields = ["issuer", "clientId", "allowedSubject", "clientSecret"];
      for (var i = 0; i < fields.length; i++) {
        var name = fields[i];
        if (incoming[name] === undefined) continue;
        var text = cleanText(incoming[name]);
        if (text === null || text.length > MAX_FIELD_LENGTH) return { error: "Invalid request", status: 400 };
        // An empty secret means "keep the stored one": the form never holds it.
        if (name === "clientSecret" && text === "") continue;
        next.oidc[name] = text;
      }
    }

    if (next.enabled) {
      var problem = provider.validateConfig(next.oidc);
      if (problem) return { error: problem, status: 400 };
      var count = users.loadUsers().users.length;
      var refusal = policy.turnOnRefusal(count);
      if (refusal) return { error: refusal, status: 409 };
      if (!actor || !users.findUserById(actor.id)) return { error: "Admin access required", status: 403 };
      // The identity is recorded on the one user before the setting is saved,
      // so a failure in between leaves sign-in off rather than on with nobody
      // able to use it.
      var bound = users.setExternalIdentity(actor.id, provider.allowedIdentity(next.oidc));
      if (bound.error) return { error: bound.error, status: 500 };
    }

    settings.save(next);
    return { ok: true, view: getView() };
  }

  // A verified provider identity becomes the console's one user, or a refusal.
  // The user is found by provider kind plus issuer plus subject. A console
  // holding more than one user while sign-in is on is refused outright.
  function resolveUser(identity) {
    if (!isEnabled()) return { error: "disabled" };
    var user = users.findUserByExternalIdentity(identity);
    if (!user) return { error: "not_allowed" };
    if (users.loadUsers().users.length !== 1) return { error: "not_allowed" };
    return { user: user };
  }

  return {
    provider: provider,
    isEnabled: isEnabled,
    localSignInAllowed: policy.localSignInAllowed,
    getSettings: settings.load,
    getView: getView,
    update: update,
    resolveUser: resolveUser,
  };
}

module.exports = { createExternalSignin: createExternalSignin };
