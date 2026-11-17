// admin-external-signin.js — the External sign-in card in the admin Users section.
// The client secret is write-only here: the form never holds the stored value,
// and an empty field on save means "keep the one already set".
import { showToast, escapeHtml } from './utils.js';

function request(method, body) {
  var init = { method: method, headers: { "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  return fetch("/api/admin/external-signin", init).then(function (r) { return r.json(); });
}

function row(label, inputHtml) {
  return '<div class="admin-smtp-row"><label>' + label + '</label>' + inputHtml + '</div>';
}

function checkbox(id, checked, text) {
  return '<label class="admin-smtp-toggle"><input type="checkbox" id="' + id + '"' + (checked ? " checked" : "") + '><span>' + text + '</span></label>';
}

function render(box, view) {
  var o = view.oidc;
  var html = '<div class="admin-smtp-form">';
  html += '<h3>External sign-in</h3>';
  html += '<p class="admin-modal-desc">Sign in through an OpenID Connect identity provider. While it is on, this console has exactly one user, bound to the identity below, and no user can be added.</p>';
  html += '<div class="admin-smtp-fields">';
  html += row('Issuer', '<input type="text" id="xs-issuer" class="admin-smtp-input" placeholder="https://id.example.com" autocomplete="off" value="' + escapeHtml(o.issuer) + '">');
  html += row('Client id', '<input type="text" id="xs-client-id" class="admin-smtp-input" autocomplete="off" value="' + escapeHtml(o.clientId) + '">');
  html += row('Client secret', '<input type="password" id="xs-secret" class="admin-smtp-input" autocomplete="new-password" placeholder="' + (o.clientSecretSet ? "Set. Leave empty to keep it." : "Not set") + '">');
  html += row('Allowed identity (subject)', '<input type="text" id="xs-subject" class="admin-smtp-input" autocomplete="off" value="' + escapeHtml(o.allowedSubject) + '">');
  html += row('Local sign-in fallback', checkbox("xs-fallback", view.localFallback, "Keep PIN or emailed-code sign-in available if the provider is down"));
  html += row('Turn on', checkbox("xs-enabled", view.enabled, "Use external sign-in"));
  html += '</div>';
  html += '<div class="admin-smtp-actions"><button class="admin-action-btn" id="xs-save">Save</button></div>';
  html += '<div class="admin-smtp-error" id="xs-error"></div>';
  html += '</div>';
  box.innerHTML = html;

  var errorEl = box.querySelector("#xs-error");
  box.querySelector("#xs-save").addEventListener("click", function () {
    var btn = this;
    btn.disabled = true;
    errorEl.textContent = "";
    errorEl.className = "admin-smtp-error";
    request("PUT", {
      enabled: box.querySelector("#xs-enabled").checked,
      localFallback: box.querySelector("#xs-fallback").checked,
      oidc: {
        issuer: box.querySelector("#xs-issuer").value.trim(),
        clientId: box.querySelector("#xs-client-id").value.trim(),
        clientSecret: box.querySelector("#xs-secret").value,
        allowedSubject: box.querySelector("#xs-subject").value.trim(),
      },
    }).then(function (data) {
      if (data.ok) {
        showToast("External sign-in settings saved");
        render(box, data.externalSignin);
      } else {
        errorEl.textContent = data.error || "Failed to save";
        errorEl.className = "admin-smtp-error admin-smtp-error-visible";
        btn.disabled = false;
      }
    }).catch(function () {
      errorEl.textContent = "Failed to save";
      errorEl.className = "admin-smtp-error admin-smtp-error-visible";
      btn.disabled = false;
    });
  });
}

export function mountExternalSignin(box) {
  if (!box) return;
  request("GET").then(function (data) {
    if (data.externalSignin) render(box, data.externalSignin);
  }).catch(function () {
    box.innerHTML = '<div class="admin-error">Failed to load external sign-in settings</div>';
  });
}
