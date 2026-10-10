"use strict";
// lib/smtp.js is the only consumer of nodemailer. These tests pin the exact
// nodemailer surface it relies on (createTransport options, sendMail message
// shape, close) so a major-version bump of the library cannot silently change
// the contract.
//
// Two layers:
//   1. A stub transport swapped in through require.cache, to assert what
//      lib/smtp.js hands to nodemailer for every caller shape:
//      server-admin.js (sendTestEmail, sendInviteEmail, saveSmtpConfig),
//      server-auth.js (sendOtpEmail).
//   2. The real installed nodemailer, driven with its in-memory jsonTransport,
//      to prove the same message shape is still accepted by the library
//      version in package-lock.json (no network, no SMTP server).

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var SMTP_CFG = {
  host: "smtp.example.test",
  port: 2525,
  secure: true,
  user: "mailer",
  pass: "s3cret",
  from: "console@example.test",
};

function makeStub(opts) {
  var calls = { createTransport: [], sendMail: [], close: 0 };
  var failSend = !!(opts && opts.failSend);
  return {
    calls: calls,
    exports: {
      createTransport: function (options) {
        calls.createTransport.push(options);
        return {
          sendMail: function (message) {
            calls.sendMail.push(message);
            if (failSend) return Promise.reject(new Error("stub send failure"));
            return Promise.resolve({ messageId: "<stub-id@example.test>" });
          },
          close: function () { calls.close += 1; },
        };
      },
    },
  };
}

// Loads a fresh lib/smtp.js whose `require("nodemailer")` resolves to the stub,
// against a throwaway CLAGENTIC_HOME so saveSmtpConfig never touches real state.
function loadSmtpWithStub(stub) {
  var home = fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-test-smtp-"));
  var nodemailerPath = require.resolve("nodemailer");
  var savedNodemailer = require.cache[nodemailerPath];
  var mods = ["../lib/config", "../lib/users", "../lib/users-auth", "../lib/users-permissions",
    "../lib/users-preferences", "../lib/store", "../lib/smtp"];
  mods.forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  });
  require.cache[nodemailerPath] = {
    id: nodemailerPath, filename: nodemailerPath, loaded: true, exports: stub.exports,
  };
  var origHome = process.env.CLAGENTIC_HOME;
  process.env.CLAGENTIC_HOME = home;
  var smtp;
  try {
    // smtp.js lazy-loads ./users on first config access; users.js fixes its
    // storage path at module scope, so load it now while the temp home is set.
    require("../lib/users");
    smtp = require("../lib/smtp");
  } finally {
    if (origHome === undefined) delete process.env.CLAGENTIC_HOME;
    else process.env.CLAGENTIC_HOME = origHome;
    if (savedNodemailer) require.cache[nodemailerPath] = savedNodemailer;
    else delete require.cache[nodemailerPath];
    // Drop the stub-bound copy so later tests in this process re-require cleanly.
    delete require.cache[require.resolve("../lib/smtp")];
  }
  return smtp;
}

test("sendTestEmail builds the transport from the saved shape and closes it", async function () {
  var stub = makeStub();
  var smtp = loadSmtpWithStub(stub);

  var result = await smtp.sendTestEmail(SMTP_CFG, "admin@example.test");

  assert.deepEqual(result, { ok: true, messageId: "<stub-id@example.test>" });
  assert.equal(stub.calls.createTransport.length, 1);
  assert.deepEqual(stub.calls.createTransport[0], {
    host: "smtp.example.test",
    port: 2525,
    secure: true,
    auth: { user: "mailer", pass: "s3cret" },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });
  assert.equal(stub.calls.sendMail.length, 1);
  assert.equal(stub.calls.sendMail[0].from, SMTP_CFG.from);
  assert.equal(stub.calls.sendMail[0].to, "admin@example.test");
  assert.equal(stub.calls.sendMail[0].subject, "Clagentic: Console SMTP Test");
  assert.match(stub.calls.sendMail[0].html, /SMTP is configured correctly/);
  assert.equal(stub.calls.close, 1, "one-shot transport must be closed after a successful send");
});

test("sendTestEmail closes the transport and rethrows when the send fails", async function () {
  var stub = makeStub({ failSend: true });
  var smtp = loadSmtpWithStub(stub);

  await assert.rejects(smtp.sendTestEmail(SMTP_CFG, "admin@example.test"), /stub send failure/);
  assert.equal(stub.calls.close, 1, "transport must be closed on the failure path too");
});

test("sendTestEmail defaults the port to 587 and secure to false", async function () {
  var stub = makeStub();
  var smtp = loadSmtpWithStub(stub);

  await smtp.sendTestEmail({ host: "h.example.test", user: "u", pass: "p", from: "f@example.test" }, "a@example.test");

  assert.equal(stub.calls.createTransport[0].port, 587);
  assert.equal(stub.calls.createTransport[0].secure, false);
});

test("sendOtpEmail and sendInviteEmail send through the cached configured transporter", async function () {
  var stub = makeStub();
  var smtp = loadSmtpWithStub(stub);
  smtp.saveSmtpConfig(SMTP_CFG);
  assert.equal(smtp.isSmtpConfigured(), true);

  await smtp.sendOtpEmail("user@example.test", "123456");
  await smtp.sendInviteEmail("new@example.test", "https://console.example.test/invite/abc", "Admin");

  assert.equal(stub.calls.createTransport.length, 1, "transporter is created once and reused");
  assert.equal(stub.calls.sendMail.length, 2);
  var otp = stub.calls.sendMail[0];
  assert.equal(otp.to, "user@example.test");
  assert.equal(otp.from, SMTP_CFG.from);
  assert.match(otp.subject, /123456/);
  assert.match(otp.html, /123456/);
  var invite = stub.calls.sendMail[1];
  assert.equal(invite.to, "new@example.test");
  assert.match(invite.html, /https:\/\/console\.example\.test\/invite\/abc/);
});

test("saveSmtpConfig(null) resets the cached transporter and unconfigures SMTP", async function () {
  var stub = makeStub();
  var smtp = loadSmtpWithStub(stub);
  smtp.saveSmtpConfig(SMTP_CFG);
  await smtp.sendOtpEmail("user@example.test", "111111");

  smtp.saveSmtpConfig(null);

  assert.equal(stub.calls.close, 1, "resetTransporter closes the cached transporter");
  assert.equal(smtp.isSmtpConfigured(), false);
  await assert.rejects(smtp.sendOtpEmail("user@example.test", "222222"), /SMTP not configured/);
});

test("the installed nodemailer accepts the transport options and message shape used by lib/smtp.js", async function () {
  var nodemailer = require("nodemailer");
  var smtpTransport = nodemailer.createTransport({
    host: SMTP_CFG.host,
    port: SMTP_CFG.port,
    secure: SMTP_CFG.secure,
    auth: { user: SMTP_CFG.user, pass: SMTP_CFG.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });
  assert.equal(typeof smtpTransport.sendMail, "function");
  assert.equal(typeof smtpTransport.close, "function");
  smtpTransport.close();

  var json = nodemailer.createTransport({ jsonTransport: true });
  var info = await json.sendMail({
    from: SMTP_CFG.from,
    to: "user@example.test",
    subject: "Your Clagentic login code: 123456",
    html: "<p>123456</p>",
  });
  assert.equal(typeof info.messageId, "string");
  var parsed = JSON.parse(info.message);
  assert.equal(parsed.subject, "Your Clagentic login code: 123456");
  assert.equal(parsed.html, "<p>123456</p>");
  assert.equal(parsed.to[0].address, "user@example.test");
  assert.equal(parsed.from.address, SMTP_CFG.from);
});
