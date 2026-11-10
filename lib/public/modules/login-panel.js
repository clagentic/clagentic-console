// The sign-in panel shown above a login terminal. The terminal stays the
// engine: the panel only offers the link the login printed, the code the login
// displayed, and a field that types the user's code back into that terminal.
//
// The URL and the code live only in this closure, and only while the panel is
// open. They are never logged, stored, or written to the page's persisted
// state, and remove() drops them.

import { displayHost } from './login-parser.js';

export var IDENTITY_NOTES = {
  "os-users": "This sign-in applies to your own account on this host.",
  "shared": "This sign-in applies to every user of this host.",
};

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {object} opts
 * @param {string} opts.vendorName   agent display name, for the heading
 * @param {string} [opts.identity]   "os-users", "shared" or "" (no note)
 * @param {function(string):void} opts.sendCode   types text into the login terminal
 * @param {function(string):void} opts.copy       copies text to the clipboard
 * @param {function(string):void} opts.openLink   opens a URL in a new tab, noopener
 * @param {function():void} opts.onDismiss        user closed the panel
 * @returns {{element: object, update: function, remove: function, setHidden: function, isOpen: function}}
 */
export function createLoginPanel(opts) {
  var url = "";
  var userCode = "";
  var open = true;

  var root = el("div", "login-panel");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Sign in to " + opts.vendorName);

  var head = el("div", "login-panel-head");
  head.appendChild(el("span", "login-panel-title", "Sign in to " + opts.vendorName));
  var dismissBtn = el("button", "login-panel-dismiss", "Dismiss");
  dismissBtn.setAttribute("type", "button");
  head.appendChild(dismissBtn);
  root.appendChild(head);

  var hostEl = el("div", "login-panel-host");
  root.appendChild(hostEl);

  var linkRow = el("div", "login-panel-row login-panel-links");
  var openBtn = el("button", "login-panel-btn login-panel-open", "Open link");
  openBtn.setAttribute("type", "button");
  var copyBtn = el("button", "login-panel-btn login-panel-copy-link", "Copy link");
  copyBtn.setAttribute("type", "button");
  linkRow.appendChild(openBtn);
  linkRow.appendChild(copyBtn);
  root.appendChild(linkRow);

  var shownRow = el("div", "login-panel-row login-panel-shown-code");
  shownRow.style.display = "none";
  shownRow.appendChild(el("span", "login-panel-label", "Your sign-in code"));
  var shownValue = el("code", "login-panel-code-value");
  shownRow.appendChild(shownValue);
  var copyCodeBtn = el("button", "login-panel-btn login-panel-copy-code", "Copy code");
  copyCodeBtn.setAttribute("type", "button");
  shownRow.appendChild(copyCodeBtn);
  root.appendChild(shownRow);

  var entryRow = el("div", "login-panel-row login-panel-code-entry");
  entryRow.style.display = "none";
  var input = el("input", "login-panel-code-input");
  input.setAttribute("type", "text");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("placeholder", "Code from the sign-in page");
  input.setAttribute("aria-label", "Code from the sign-in page");
  var submitBtn = el("button", "login-panel-btn login-panel-submit", "Submit code");
  submitBtn.setAttribute("type", "button");
  entryRow.appendChild(input);
  entryRow.appendChild(submitBtn);
  root.appendChild(entryRow);

  if (opts.identity && IDENTITY_NOTES[opts.identity]) {
    root.appendChild(el("div", "login-panel-identity", IDENTITY_NOTES[opts.identity]));
  }

  function submit() {
    var code = String(input.value || "").trim();
    if (!code || !open) return;
    input.value = "";
    opts.sendCode(code + "\n");
  }

  openBtn.addEventListener("click", function () { if (url) opts.openLink(url); });
  copyBtn.addEventListener("click", function () { if (url) opts.copy(url); });
  copyCodeBtn.addEventListener("click", function () { if (userCode) opts.copy(userCode); });
  submitBtn.addEventListener("click", submit);
  input.addEventListener("keydown", function (e) {
    if (e && e.key === "Enter") submit();
  });
  dismissBtn.addEventListener("click", function () {
    remove();
    if (opts.onDismiss) opts.onDismiss();
  });

  function remove() {
    open = false;
    url = "";
    userCode = "";
    input.value = "";
    shownValue.textContent = "";
    hostEl.textContent = "";
    root.remove();
  }

  return {
    element: root,
    isOpen: function () { return open; },
    remove: remove,
    /** @param {{url: string, codePrompt: boolean, userCode: string}} parsed */
    update: function (parsed) {
      if (!open || !parsed) return;
      url = parsed.url;
      userCode = parsed.userCode || "";
      hostEl.textContent = displayHost(url);
      shownValue.textContent = userCode;
      shownRow.style.display = userCode ? "" : "none";
      entryRow.style.display = parsed.codePrompt ? "" : "none";
    },
    setHidden: function (hidden) { root.style.display = hidden ? "none" : ""; },
  };
}
