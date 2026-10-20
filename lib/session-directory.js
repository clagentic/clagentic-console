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
// Each form takes an optional "/<name>" after the project, naming one session by
// the name it was opened with (see validateName):
//   <agent>@<project>/<name>, <vendor>@<project>/<name>, @<project>/<name>
//
// Resolution never guesses. Among the sessions an address matches, the highest
// state tier that has any match decides: live, then idle, then reaped. Exactly
// one there is the answer; several there are refused with candidates; a lower
// tier is not consulted once a higher one matched.

var senderRef = require("./sender-ref");
var { slugifyAgentName } = require("./agents");
var { isInjected } = require("./injected-sender");

var STATE = Object.freeze({ LIVE: "live", IDLE: "idle", REAPED: "reaped" });
var ANY_STATE = "any";
var STATE_FILTERS = Object.freeze([STATE.LIVE, STATE.IDLE, STATE.REAPED, ANY_STATE]);

var MAX_ADDRESS_LENGTH = 192;
var ADDRESS_RE = /^([^@\s]*)@([^@\s]+)$/;

// Highest first: the order resolve() consults the tiers in.
var TIER_ORDER = Object.freeze([STATE.LIVE, STATE.IDLE, STATE.REAPED]);

// A session name is a path-free token so it can follow the project after a "/"
// in an address. Project slugs never contain "/" (lib/config.js generateSlug).
var NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// Returns { name } (lowercased: names compare case-insensitively) or { error }.
function validateName(raw) {
  if (typeof raw !== "string" || !raw) return { error: "session name must be a non-empty string" };
  var name = raw.toLowerCase();
  if (!NAME_RE.test(name)) {
    return { error: "session name " + JSON.stringify(raw.slice(0, 40)) + " must be 1-32 characters of a-z, 0-9, \"-\" and \"_\", starting with a letter or digit" };
  }
  return { name: name };
}

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
    name: session.sessionName || null,
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

// Returns { project, token } (token is "" for @<project>) or { error }, plus
// name when the address carries "/<name>".
function parseAddress(raw) {
  if (typeof raw !== "string" || !raw) return { error: "address must be a non-empty string" };
  if (raw.length > MAX_ADDRESS_LENGTH) return { error: "address is longer than " + MAX_ADDRESS_LENGTH + " characters" };
  var m = ADDRESS_RE.exec(raw);
  if (!m) return { error: "address " + JSON.stringify(raw.slice(0, 64)) + " is not <agent>@<project>, <vendor>@<project> or @<project>, each with an optional /<name>" };
  var token = slugifyAgentName(m[1]);
  if (m[1] && !token) return { error: "address " + JSON.stringify(raw.slice(0, 64)) + " names no agent or vendor" };
  var slash = m[2].indexOf("/");
  if (slash === -1) return { project: m[2], token: token };
  var project = m[2].slice(0, slash);
  var named = validateName(m[2].slice(slash + 1));
  if (!project) return { error: "address " + JSON.stringify(raw.slice(0, 64)) + " names no project" };
  if (named.error) return { error: named.error };
  return { project: project, token: token, name: named.name };
}

// Which sessions an address names, among the entries of its project. A named
// session matches by its agent, a plain one by its vendor. A recorded identity
// ({ project, vendor, sessionId } with sessionId the vendor's own session id)
// names a session only when all three are equal.
function matchesOf(entries, parsed) {
  return entries.filter(function (e) {
    if (e.project !== parsed.project) return false;
    if (parsed.sessionId !== undefined) {
      return !!parsed.sessionId && e.sessionId === parsed.sessionId
        && String(e.vendor || "").toLowerCase() === String(parsed.vendor || "").toLowerCase();
    }
    if (parsed.name !== undefined && e.name !== parsed.name) return false;
    if (!parsed.token) return true;
    if (e.agent) return slugifyAgentName(e.agent) === parsed.token;
    return String(e.vendor || "").toLowerCase() === parsed.token;
  });
}

// Resolves an address, or a recorded identity, against the entries (collect()).
// Never guesses:
//   { match }       exactly one session
//   { candidates }  more than one; the caller chooses with a session id
//   { none: true }  no session
// The highest state tier (live, idle, reaped) holding any match decides: one
// there is the answer, several are the candidates, and lower tiers are not
// looked at. A named address (parsed.name) is exact: it matches only sessions
// of that name, so it never falls to a different session; the tiers then only
// separate same-named twins (a reaped one beside a running one).
function resolve(entries, parsed) {
  var matches = matchesOf(entries, parsed);
  for (var i = 0; i < TIER_ORDER.length; i++) {
    var tier = matches.filter(function (e) { return e.state === TIER_ORDER[i]; });
    if (tier.length === 1) return { match: tier[0] };
    if (tier.length > 1) return { candidates: tier };
  }
  return { none: true };
}

// The sender of the most recent injected message in a session's history.
// Returns { project, vendor, cliSessionId, name } or { reason } saying why there
// is none. Only an extracted sender names a session; a declared or undeclared
// one cannot be answered. The sender is identified by project, vendor and the
// vendor's own session id, all recorded together at injection time; an entry
// lacking any of them (one recorded before they were kept) has no answerable
// sender. The console session id is deliberately not returned. Searches the
// history window held in memory.
function lastInjectedSender(history) {
  for (var i = (history || []).length - 1; i >= 0; i--) {
    var entry = history[i];
    if (!isInjected(entry)) continue;
    if (entry.senderKind !== "extracted" || !entry.senderProject) {
      return { reason: "the most recent injected message in this session has no recorded sender session (its sender is " + (entry.senderKind || "unrecorded") + ")" };
    }
    if (!entry.senderVendor || !entry.senderCliSessionId) {
      return { reason: "reply refused: the most recent injected message recorded no vendor or vendor session id for its sender (it predates them, or the sender had no vendor session id yet), so the sender session cannot be proven" };
    }
    return { project: entry.senderProject, vendor: entry.senderVendor, cliSessionId: entry.senderCliSessionId, name: entry.fromName || null };
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
  validateName: validateName,
  resolve: resolve,
  lastInjectedSender: lastInjectedSender,
};
