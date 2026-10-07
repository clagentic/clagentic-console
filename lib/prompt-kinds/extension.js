"use strict";

// A command sent to the operator's browser extension (tab context, console,
// screenshots). Answered by the extension rather than by a person, so it is
// never recorded, re-presented or notified, and it belongs to the project
// rather than to a session. It always runs under a timeout; a request that
// ends unanswered resolves to null, which callers treat as "no data".

module.exports = {
  name: "extension",
  scope: "project",
  journal: false,
  defaultTimeoutMs: 3000,

  fields: function (req) {
    return { command: req.command, args: req.args };
  },

  requestFields: function (record) {
    return { command: record.command, args: record.args };
  },

  decisions: ["result"],

  parse: function (msg) {
    return { result: msg.result === undefined ? null : msg.result };
  },

  outcome: function (record, response) {
    return response.result;
  },

  grantsSession: function () { return false; },

  resolvedFields: function () { return {}; },

  cancelled: function () { return null; },
};
