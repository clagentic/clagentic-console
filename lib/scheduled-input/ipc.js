// ipc.js - the daemon side of `clagentic-console schedule-input`: which fields
// of an IPC message reach the scheduled-input service, and what each verb
// answers. The CLI is the same primitive the clock button uses; both go through
// the one service, so a record made by either shows in the other's list.
//
//   schedule_input_create  { projectSlug, sessionId, prompt, at | every + until | count,
//                            senderProject?, senderSessionId? }
//   schedule_input_list    { projectSlug?, sessionId?, state? }
//   schedule_input_delete  { id, projectSlug? }
//
// Times arrive as absolute milliseconds: the CLI resolves "in 10m" and a local
// "20:01" in the caller's own time zone.

var senderRef = require("../sender-ref");

function refused(reason) {
  return { ok: false, result: "refused", reason: reason };
}

function isMs(value) {
  return typeof value === "number" && isFinite(value);
}

// What the record says made it: the calling console session ("<agent>@<project>"),
// as send-input records its sender, else the plain CLI.
function createdByFor(getProject, msg) {
  var extracted = senderRef.resolve(getProject, { project: msg.senderProject, sessionId: msg.senderSessionId });
  return extracted ? extracted.name : "cli";
}

function create(deps, msg) {
  if (typeof msg.projectSlug !== "string" || !msg.projectSlug) return Promise.resolve(refused("a project is required"));
  if (typeof msg.prompt !== "string" || !msg.prompt) return Promise.resolve(refused("prompt must be a non-empty string"));
  var recurring = msg.every !== undefined;
  if (recurring ? !isMs(msg.every) : !isMs(msg.at)) {
    return Promise.resolve(refused(recurring ? "every must be a duration" : "a once input needs the time to send at"));
  }
  return deps.service.resolveTarget(msg.projectSlug, msg.sessionId).then(function (resolved) {
    if (!resolved.ok) return resolved;
    var out = deps.service.create(msg.projectSlug, {
      target: resolved.target,
      session: resolved.session || undefined,
      kind: recurring ? "recurring" : "once",
      text: msg.prompt,
      note: recurring ? "scheduled repeat" : "scheduled message",
      createdBy: createdByFor(deps.getProject, msg),
      at: recurring ? undefined : msg.at,
      every: recurring ? msg.every : undefined,
      until: recurring && msg.until !== undefined ? msg.until : undefined,
      count: recurring && msg.count !== undefined ? msg.count : undefined,
    });
    if (out.ok) out.project = msg.projectSlug;
    return out;
  });
}

function list(deps, msg) {
  var slugs = typeof msg.projectSlug === "string" && msg.projectSlug ? [msg.projectSlug] : deps.service.projectSlugs();
  var inputs = [];
  // Projects whose list cannot be saved (nothing of theirs is delivered).
  var storeErrors = [];
  for (var i = 0; i < slugs.length; i++) {
    var part = deps.service.list(slugs[i], { sessionId: msg.sessionId, state: msg.state });
    if (!part.ok) return part;
    part.inputs.forEach(function (r) { inputs.push(Object.assign({ project: slugs[i] }, r)); });
    if (part.store) storeErrors.push(Object.assign({ project: slugs[i] }, part.store));
  }
  inputs.sort(function (a, b) { return (a.nextAt === null ? Infinity : a.nextAt) - (b.nextAt === null ? Infinity : b.nextAt); });
  var listed = { ok: true, result: "listed", count: inputs.length, inputs: inputs };
  if (storeErrors.length) listed.storeErrors = storeErrors;
  return listed;
}

function remove(deps, msg) {
  if (typeof msg.id !== "string" || !msg.id) return refused("an id is required");
  var slugs = typeof msg.projectSlug === "string" && msg.projectSlug ? [msg.projectSlug] : deps.service.projectSlugs();
  var last = { ok: false, result: "not-found", reason: "no scheduled input " + JSON.stringify(msg.id.slice(0, 64)) };
  for (var i = 0; i < slugs.length; i++) {
    var out = deps.service.remove(slugs[i], msg.id);
    if (out.ok) { out.project = slugs[i]; return out; }
    if (out.result !== "not-found") last = out;
  }
  return last;
}

// deps: { service, getProject(slug) }
// Returns the result, or a Promise of it; undefined when msg.cmd is not ours.
function handleScheduledInputCommand(deps, msg) {
  if (msg.cmd === "schedule_input_create") return create(deps, msg);
  if (msg.cmd === "schedule_input_list") return list(deps, msg);
  if (msg.cmd === "schedule_input_delete") return remove(deps, msg);
  return undefined;
}

module.exports = { handleScheduledInputCommand: handleScheduledInputCommand };
