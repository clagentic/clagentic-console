"use strict";

// HTTP routes for external sign-in. They are dispatched from the auth module's
// handleRequest and every successful sign-in ends in the same
// createMultiUserSession call as a local login, so the cookie, the phone app
// and the WebSocket ticket path work unchanged.

var audit = require("../audit");
var { resolveEffectiveProtocol } = require("../effective-protocol");
var { resolveClientAddress } = require("../client-address");
var pages = require("./pages");

var STATE_COOKIE = "clagentic_console_signin";
var STATE_COOKIE_PATH = "/auth/external";
var STATE_COOKIE_MAX_AGE_S = 600;
var HOST_PATTERN = /^[A-Za-z0-9.\-:\[\]]+$/;

// What the browser is told for each refusal. The reason is deliberately
// coarse: the provider's own error text and the identity that was refused stay
// out of the page.
var MESSAGES = {
  unreachable: "The identity provider cannot be reached.",
  provider_metadata: "The identity provider's configuration could not be used.",
  state: "This sign-in attempt is not valid or has expired. Start again.",
  callback: "The identity provider's answer was incomplete. Start again.",
  pkce: "This sign-in attempt is not valid or has expired. Start again.",
  token_rejected: "The identity provider did not accept the sign-in. Start again.",
  id_token: "The identity provider's answer could not be verified.",
  nonce: "The identity provider's answer could not be verified.",
  not_allowed: "This identity is not allowed to sign in to this console.",
  provider_error: "The identity provider refused the sign-in.",
  disabled: "External sign-in is not turned on.",
};

function attachExternalSignin(ctx) {
  var core = ctx.externalSignin;
  var createSession = ctx.createMultiUserSession;
  var secureAttr = ctx.secureAttr;
  var isAuthed = ctx.isAuthed;
  var parseCookies = ctx.parseCookies;
  var getLocalAuthPage = ctx.getLocalAuthPage;
  var tlsOptions = ctx.tlsOptions;
  var trustedProxy = !!ctx.trustedProxy;

  function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }

  function sendMessage(res, status, code) {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(pages.messagePageHtml(MESSAGES[code] || MESSAGES.state, true));
  }

  function stateCookie(value, req, maxAge) {
    return STATE_COOKIE + "=" + value + "; Path=" + STATE_COOKIE_PATH + "; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + secureAttr(req);
  }

  function redirectUriFor(req) {
    var host = req.headers.host;
    if (!host || !HOST_PATTERN.test(host)) return null;
    var proto = resolveEffectiveProtocol({
      tlsOptions: tlsOptions,
      trustedProxy: trustedProxy,
      forwardedProtoHeader: req.headers["x-forwarded-proto"],
    }).protocol;
    return proto + "://" + host + "/auth/external/callback";
  }

  function refuse(res, code, status) {
    audit.log("auth.external.refused", { actorId: "system", metadata: { provider: core.provider.kind, reason: code } });
    sendMessage(res, status || 403, code);
  }

  function handleStatus(res) {
    var current = core.getSettings();
    if (!current.enabled) {
      sendJson(res, 200, { enabled: false });
      return;
    }
    core.provider.isAvailable(current.oidc).then(function (available) {
      sendJson(res, 200, { enabled: true, provider: core.provider.kind, available: available, localFallback: current.localFallback });
    });
  }

  function handleStart(req, res) {
    var current = core.getSettings();
    if (!current.enabled) return sendMessage(res, 400, "disabled");
    var redirectUri = redirectUriFor(req);
    if (!redirectUri) return sendMessage(res, 400, "callback");
    var clientAddress = resolveClientAddress(req, trustedProxy).address;
    core.provider.begin(current.oidc, redirectUri, clientAddress).then(function (started) {
      if (started.error) return refuse(res, started.error, 502);
      res.writeHead(302, {
        Location: started.url,
        "Set-Cookie": stateCookie(started.state, req, STATE_COOKIE_MAX_AGE_S),
        "Cache-Control": "no-store",
      });
      res.end();
    });
  }

  function handleCallback(req, res) {
    var current = core.getSettings();
    if (!current.enabled) return sendMessage(res, 400, "disabled");
    var query = new URL(req.url, "http://placeholder").searchParams;
    if (query.get("error")) {
      // The provider turned the sign-in down; its error text is not echoed.
      return refuse(res, "provider_error", 403);
    }
    var cookieState = parseCookies(req)[STATE_COOKIE];
    core.provider.complete(current.oidc, {
      code: query.get("code"),
      state: query.get("state"),
      stateCookie: cookieState,
    }).then(function (result) {
      if (result.error) return refuse(res, result.error, result.error === "unreachable" ? 502 : 403);
      var resolved = core.resolveUser(result.identity);
      if (resolved.error) return refuse(res, resolved.error, 403);
      var session = createSession(resolved.user.id, req);
      audit.log("auth.external.login", {
        actorId: resolved.user.id,
        actorName: resolved.user.username,
        metadata: { provider: core.provider.kind },
      });
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": [session.cookie, stateCookie("", req, 0)],
        "Cache-Control": "no-store",
      });
      res.end();
    }).catch(function () {
      refuse(res, "unreachable", 502);
    });
  }

  // The local login page, reached from the external page while the local
  // fallback is on.
  function handleLocalPage(req, res) {
    if (isAuthed(req) || !core.isEnabled() || !core.localSignInAllowed()) {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getLocalAuthPage());
  }

  function handleRequest(req, res, fullUrl) {
    if (req.method !== "GET") return false;
    if (fullUrl === "/auth/external/status") { handleStatus(res); return true; }
    if (fullUrl === "/auth/external/start") { handleStart(req, res); return true; }
    if (fullUrl === "/auth/external/callback") { handleCallback(req, res); return true; }
    if (fullUrl === "/auth/local") { handleLocalPage(req, res); return true; }
    return false;
  }

  return { handleRequest: handleRequest, signinPageHtml: pages.signinPageHtml };
}

module.exports = { attachExternalSignin: attachExternalSignin, STATE_COOKIE: STATE_COOKIE };
