"use strict";

// A read-only view of the prompts a session is waiting on, for the session
// directory (list-sessions). The source is the live registry state on the
// session objects in the daemon's memory (the maps lib/prompt-registry.js owns),
// the same state the operator's banner is raised from; no file is read.
//
// A prompt is shown by its identifiers and the one-line summary the banner
// already shows for a tool call. Excluded: tool input beyond that summary, the
// decision reason, a question's or an elicitation's text and schema, a plan's
// content and anything a client would answer with.

var promptKinds = require("./prompt-kinds");
var { ownValue } = require("./prompt-kinds/codecs");
var { summarize } = require("./permission-summary");

var STORES = promptKinds.sessionStores();

// Kinds whose summary is a tool call; any other kind reports none.
var TOOL_KINDS = { permission: true, plan: true };

function ageSeconds(createdAt, now) {
  if (typeof createdAt !== "number" || !isFinite(createdAt)) return 0;
  return Math.max(0, Math.floor((now - createdAt) / 1000));
}

// Returns [{ requestId, kind, tool, summary, ageSeconds }], oldest first;
// empty when the session waits on nothing. Only operator-facing prompts count
// (kind.journal), the ones a banner is raised for.
function pendingPrompts(session, now) {
  var out = [];
  STORES.forEach(function (store) {
    var map = session && session[store];
    if (!map) return;
    Object.keys(map).forEach(function (id) {
      var record = ownValue(map, id);
      if (!record) return;
      var kind = promptKinds.kindOfRecord(record, store);
      if (!kind || !kind.journal) return;
      out.push({
        createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
        view: {
          requestId: id,
          kind: kind.name,
          tool: typeof record.toolName === "string" ? record.toolName : null,
          summary: TOOL_KINDS[kind.name] ? summarize(record.toolName, record.toolInput) : "",
          ageSeconds: ageSeconds(record.createdAt, now),
        },
      });
    });
  });
  return out.sort(function (a, b) { return a.createdAt - b.createdAt; }).map(function (e) { return e.view; });
}

module.exports = { pendingPrompts: pendingPrompts };
