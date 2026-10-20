// session-directory.js - discover the console's sessions and resolve an address
// to one of them. Read-only: nothing here changes a session or delivers input;
// lib/session-input.js does the delivery once an address has become a session id.
//
// The directory is the console's own session store as the daemon holds it: every
// session recorded on disk is loaded into its project's session manager at start,
// whether or not it has a runtime, so a session whose runtime was reaped is listed
// and addressable exactly like a running one. A session started outside the
// console is not in the store and is not listed.
//
// States:
//   live    a turn is running
//   idle    a runtime is attached and no turn is running
//   reaped  no runtime (idle reaper, daemon restart); input resumes it
//
// Addresses (the label format of lib/sender-ref.js):
//   <agent>@<project>    a session running that named agent
//   <vendor>@<project>   a PLAIN session (no named agent) on that vendor
//   @<project>           any session in the project

var senderRef = require("./sender-ref");
var { slugifyAgentName } = require("./agents");
var { isInjected } = require("./injected-sender");

var STATE = Object.freeze({ LIVE: "live", IDLE: "idle", REAPED: "reaped" });
var ANY_STATE = "any";
var STATE_FILTERS = Object.freeze([STATE.LIVE, STATE.IDLE, STATE.REAPED, ANY_STATE]);

var MAX_ADDRESS_LENGTH = 192;
var ADDRESS_RE = /^([^@\s]*)@([^@\s]+)$/;

function stateOf(session) {
  if (!senderRef.isLive(session)) return STATE.REAPED;
  return session.isProcessing ? STATE.LIVE : STATE.IDLE;
}

function isoOrNull(ms) {
  return typeof ms === "number" && isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

// One directory entry. slug is the project's slug, the same string the label
// carries.
function describe(slug, project, session) {
  var agent = session.agentName || null;
  var vendor = session.vendor || project.sm.defaultVendor || null;
  return {
    consoleSessionId: String(session.localId),
    sessionId: session.cliSessionId || null,
    project: slug,
    agent: agent,
    vendor: vendor,
    label: senderRef.labelFor(agent, vendor, slug),
    title: session.title || "",
    state: stateOf(session),
    lastActivity: isoOrNull(session.lastActivity || session.createdAt),
  };
}

// Newest first; ties keep the lower console id first so the order is stable.
function byRecency(a, b) {
  var ta = a.lastActivity || "";
  var tb = b.lastActivity || "";
  if (ta !== tb) return ta < tb ? 1 : -1;
  return Number(a.consoleSessionId) - Number(b.consoleSessionId);
}

// projects: [{ slug, project }] with project a context holding sm.sessions.
// A hidden session (a background helper) is not part of the directory, and a
// session that has no id from its vendor yet and no runtime was never recorded.
function collect(projects) {
  var out = [];
  (projects || []).forEach(function (p) {
    if (!p || !p.project || !p.project.sm || !p.project.sm.sessions) return;
    p.project.sm.sessions.forEach(function (s) {
      if (s.hidden) return;
      if (!s.cliSessionId && !senderRef.isLive(s)) return;
      out.push(describe(p.slug, p.project, s));
    });
  });
  return out.sort(byRecency);
}

// filter: { project?, agent?, vendor?, state? }. Returns { entries } or { error }.
function list(projects, filter) {
  filter = filter || {};
  var state = filter.state === undefined || filter.state === null ? ANY_STATE : filter.state;
  if (STATE_FILTERS.indexOf(state) === -1) {
    return { error: "unknown state " + JSON.stringify(String(state).slice(0, 32)) + " (accepted: " + STATE_FILTERS.join(", ") + ")" };
  }
  var agentSlug = filter.agent ? slugifyAgentName(filter.agent) : null;
  if (filter.agent && !agentSlug) return { error: "agent must name an agent" };
  var vendor = filter.vendor ? String(filter.vendor).toLowerCase() : null;
  var entries = collect(projects).filter(function (e) {
    if (filter.project && e.project !== filter.project) return false;
    if (agentSlug && slugifyAgentName(e.agent) !== agentSlug) return false;
    if (vendor && String(e.vendor || "").toLowerCase() !== vendor) return false;
    if (state !== ANY_STATE && e.state !== state) return false;
    return true;
  });
  return { entries: entries };
}

// Returns { project, token } (token is "" for @<project>) or { error }.
function parseAddress(raw) {
  if (typeof raw !== "string" || !raw) return { error: "address must be a non-empty string" };
  if (raw.length > MAX_ADDRESS_LENGTH) return { error: "address is longer than " + MAX_ADDRESS_LENGTH + " characters" };
  var m = ADDRESS_RE.exec(raw);
  if (!m) return { error: "address " + JSON.stringify(raw.slice(0, 64)) + " is not <agent>@<project>, <vendor>@<project> or @<project>" };
  var token = slugifyAgentName(m[1]);
  if (m[1] && !token) return { error: "address " + JSON.stringify(raw.slice(0, 64)) + " names no agent or vendor" };
  return { project: m[2], token: token };
}

// Which sessions an address names, among the entries of its project. A named
// session matches by its agent, a plain one by its vendor.
function matchesOf(entries, parsed) {
  return entries.filter(function (e) {
    if (e.project !== parsed.project) return false;
    if (!parsed.token) return true;
    if (e.agent) return slugifyAgentName(e.agent) === parsed.token;
    return String(e.vendor || "").toLowerCase() === parsed.token;
  });
}

// Resolves an address against the entries (collect()). Never guesses:
//   { match }       exactly one session
//   { candidates }  more than one; the caller chooses with a session id
//   { none: true }  no session
// A session with a runtime is preferred over a reaped one; reaped sessions are
// considered only when none has a runtime.
function resolve(entries, parsed) {
  var matches = matchesOf(entries, parsed);
  if (matches.length === 0) return { none: true };
  var running = matches.filter(function (e) { return e.state !== STATE.REAPED; });
  var tier = running.length > 0 ? running : matches;
  if (tier.length === 1) return { match: tier[0] };
  return { candidates: tier };
}

// The sender of the most recent injected message in a session's history.
// Returns { project, sessionId } or { reason } saying why there is none. Only an
// extracted sender names a session; a declared or undeclared one cannot be
// answered. Searches the history window held in memory.
function lastInjectedSender(history) {
  for (var i = (history || []).length - 1; i >= 0; i--) {
    var entry = history[i];
    if (!isInjected(entry)) continue;
    if (entry.senderKind === "extracted" && entry.senderProject && entry.senderSessionId) {
      return { project: entry.senderProject, sessionId: String(entry.senderSessionId), name: entry.fromName || null };
    }
    return { reason: "the most recent injected message in this session has no recorded sender session (its sender is " + (entry.senderKind || "unrecorded") + ")" };
  }
  return { reason: "this session has received no injected message to reply to" };
}

module.exports = {
  STATE: STATE,
  STATE_FILTERS: STATE_FILTERS,
  stateOf: stateOf,
  collect: collect,
  list: list,
  parseAddress: parseAddress,
  resolve: resolve,
  lastInjectedSender: lastInjectedSender,
};
