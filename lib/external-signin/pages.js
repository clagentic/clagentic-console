"use strict";

// The pages external sign-in adds: the login page offered in place of the PIN
// page, and the page a refused or failed sign-in lands on.

var { authPageStyles } = require("../pages");

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

var linkStyles =
  "a.btn{display:block;text-decoration:none;box-sizing:border-box}" +
  ".alt{display:none;margin-top:18px;font-size:13px}" +
  ".alt a{color:var(--accent)}";

// The status line and the local link are filled in from /auth/external/status,
// so the page itself is static and says nothing about the provider until the
// server has checked it.
function signinPageHtml() {
  return '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<title>Login - Clagentic: Console</title>' +
    '<style>' + authPageStyles + linkStyles + '</style></head><body><div class="c">' +
    '<h1>Welcome back</h1>' +
    '<div class="sub">Sign in with your identity provider</div>' +
    '<a class="btn" id="signin-start" href="/auth/external/start">Sign in</a>' +
    '<div class="err" id="signin-err"></div>' +
    '<div class="alt" id="signin-local"><a href="/auth/local">Use local sign-in</a></div>' +
    '<script>' +
    'fetch("/auth/external/status",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){' +
    'if(d.enabled&&!d.available){document.getElementById("signin-err").textContent="The identity provider cannot be reached."}' +
    'if(d.enabled&&d.localFallback){document.getElementById("signin-local").style.display="block"}' +
    '}).catch(function(){})' +
    '</script></div></body></html>';
}

function messagePageHtml(message, showSigninLink) {
  return '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<title>Sign-in - Clagentic: Console</title>' +
    '<style>' + authPageStyles + linkStyles + '</style></head><body><div class="c">' +
    '<h1>Sign-in refused</h1>' +
    '<div class="sub">' + escapeHtml(message) + '</div>' +
    (showSigninLink ? '<a class="btn" href="/">Back to sign-in</a>' : '') +
    '</div></body></html>';
}

module.exports = { signinPageHtml: signinPageHtml, messagePageHtml: messagePageHtml };
