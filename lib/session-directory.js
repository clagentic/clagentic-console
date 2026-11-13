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
//   live    a turn is running, or the session is blocked on a pending prompt
//           (pendingPrompts tells the two apart)
//   idle    a runtime is attached, nothing running, nothing pending
//   reaped  no runtime (idle reaper, daemon restart); input resumes it
// The three come from the shared derivation in lib/session-liveness.js.
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
// tier that has any match decides: running, then idle, then prompt-blocked, then
// reaped. Exactly one there is the answer; several there are refused with
// candidates; a lower tier is not consulted once a higher one matched.
// "running" and "prompt-blocked" split the live state for resolution only: a
// live session with a pending prompt is stuck on the operator, so it ranks below
// an idle twin that is free to take the input. The reported state is unchanged.
//
// answer-prompt --to is the exception: its target is by definition the session
// holding the named request, so it resolves by holding that request id among the
// address matches (resolve() with holdsRequest), whatever the tier. None holds it
// is no session; several hold it are candidates.

var senderRef = require("./sender-ref");
var { slugifyAgentName } = require("./agents");
var { isInjected } = require("./injected-sender");
var { pendingPrompts } = require("./pending-prompts");
var liveness = require("./session-liveness");

var STATE = Object.freeze({ LIVE: "live", IDLE: "idle", REAPED: "reaped" });
var ANY_STATE = "any";
var STATE_FILTERS = Object.freeze([STATE.LIVE, STATE.IDLE, STATE.REAPED, ANY_STATE]);

var MAX_ADDRESS_LENGTH = 192;
var ADDRESS_RE = /^([^@\s]*)@([^@\s]+)$/;

// Highest first: the order resolve() consults the tiers in. A tier is a
// predicate over a directory entry; the live state is split in two here and
// nowhere else.
function isPromptBlocked(e) { return e.state === STATE.LIVE && !!e.pendingPrompts && e.pendingPrompts.length > 0; }
var TIER_ORDER = Object.freeze([
  function (e) { return e.state === STATE.LIVE && !isPromptBlocked(e); },
  function (e) { return e.state === STATE.IDLE; },
  isPromptBlocked,
  function (e) { return e.state === STATE.REAPED; },
]);

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
  return liveness.liveStateOf(liveness.activityOf(session));
}

function isoOrNull(ms) {
  return typeof ms === "number" && isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

// One directory entry. slug is the project's slug, the same string the label
// carries.
function describe(slug, project, session, now) {
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
    pendingPrompts: pendingPrompts(session, now),
  };
}

// The richer fields of a session, for list-sessions --verbose and for the
// candidates of an ambiguous address. Read from what the daemon already holds:
// nothing is loaded from disk, so a field that needs history is null when the
// session's history is not in memory.
//   openedAt             when the session was created
//   opener               who started it: the first message's sender record
//                        (kind, name, project, initiator), from the history held
//                        in memory when that history starts at the first message
//   lastInjectedSender   who sent the newest injected message held in memory
//   turnCount            turns completed
//   midTurn              a turn is running now
//   memory.heapEntries   history entries held in memory (the console's own
//                        per-session memory count)
function detailOf(session) {
  var history = session.history || [];
  var first = null;
  if (!session._historyBaseIndex) {
    for (var i = 0; i < history.length && !first; i++) {
      if (history[i] && history[i].type === "user_message") first = history[i];
    }
  }
  var last = lastInjectedSender(history);
  return {
    openedAt: isoOrNull(session.createdAt),
    opener: first ? {
      kind: first.senderKind || null,
      name: first.fromName || null,
      project: first.senderProject || null,
      initiator: first.initiator || null,
    } : null,
    lastInjectedSender: last.reason ? null : {
      project: last.project,
      vendor: last.vendor,
      sessionId: last.cliSessionId,
      name: last.name,
    },
    turnCount: typeof session.turnCount === "number" ? session.turnCount : 0,
    midTurn: !!session.isProcessing,
    memory: { heapEntries: history.length },
  };
}

function withDetail(entry, session) {
  return Object.assign({}, entry, detailOf(session));
}

// Newest first; ties keep the lower console id first so the order is stable.
function byRecency(a, b) {
  var ta = a.entry.lastActivity || "";
  var tb = b.entry.lastActivity || "";
  if (ta !== tb) return ta < tb ? 1 : -1;
  return Number(a.entry.consoleSessionId) - Number(b.entry.consoleSessionId);
}

// projects: [{ slug, project }] with project a context holding sm.sessions.
// A hidden session (a background helper) is not part of the directory, and a
// session that has no id from its vendor yet and no runtime was never recorded.
// Returns [{ entry, session }], newest first.
function collectPairs(projects, now) {
  var out = [];
  var at = typeof now === "number" ? now : Date.now();
  (projects || []).forEach(function (p) {
    if (!p || !p.project || !p.project.sm || !p.project.sm.sessions) return;
    p.project.sm.sessions.forEach(function (s) {
      if (s.hidden) return;
      if (!s.cliSessionId && !senderRef.isLive(s)) return;
      out.push({ entry: describe(p.slug, p.project, s, at), session: s });
    });
  });
  return out.sort(byRecency);
}

function collect(projects, now) {
  return collectPairs(projects, now).map(function (pair) { return pair.entry; });
}

// What a list with no state filter shows: sessions that are running or waiting
// to be used. Reaped sessions pile up (every idle reap and daemon restart leaves
// one), so they are asked for by name. The one exception is a lane: a (project,
// agent) pair with a named agent and no live or idle session among the matches
// would vanish from the default, and a coordinator could not see that it holds
// work, so its newest reaped session is shown too (withReapedLanes). A plain
// session with no agent has no lane and keeps this default.
var DEFAULT_STATES = Object.freeze([STATE.LIVE, STATE.IDLE]);

function laneKey(entry) {
  return entry.agent ? entry.project + "\u0000" + slugifyAgentName(entry.agent) : null;
}

// pairs: newest first (collectPairs order). Keeps DEFAULT_STATES pairs plus, per
// lane with none of them, its newest reaped pair; the order is preserved.
function withReapedLanes(pairs) {
  var active = {};
  pairs.forEach(function (pair) {
    var key = laneKey(pair.entry);
    if (key && DEFAULT_STATES.indexOf(pair.entry.state) !== -1) active[key] = true;
  });
  var taken = {};
  return pairs.filter(function (pair) {
    if (DEFAULT_STATES.indexOf(pair.entry.state) !== -1) return true;
    var key = laneKey(pair.entry);
    if (!key || active[key] || taken[key]) return false;
    taken[key] = true;
    return true;
  });
}

// The states a filter names: a comma list ("live,idle"), an array of names, or
// "any" for every state. Unset is DEFAULT_STATES. Returns { states } (null means
// every state) or { error } listing the valid names.
function parseStates(raw) {
  if (raw === undefined || raw === null) return { states: DEFAULT_STATES.slice() };
  var names = Array.isArray(raw) ? raw : String(raw).split(",");
  var states = [];
  for (var i = 0; i < names.length; i++) {
    var name = typeof names[i] === "string" ? names[i].trim() : names[i];
    if (STATE_FILTERS.indexOf(name) === -1) {
      return { error: "unknown state " + JSON.stringify(String(name).slice(0, 32)) + " (accepted: " + STATE_FILTERS.join(", ") + "; several as a comma list)" };
    }
    if (name === ANY_STATE) return { states: null };
    if (states.indexOf(name) === -1) states.push(name);
  }
  return { states: states };
}

// filter: { project?, agent?, vendor?, state?, limit?, detail?, now? }
//   state   a comma list of live, idle, reaped, or "any"; default live and idle
//           plus each agent lane's newest reaped session when it has no live
//           or idle one (see withReapedLanes); an explicit value is exact
//   limit   at most this many entries, the newest (a whole number of 1 or more)
//   detail  add the richer fields of detailOf() to each entry
//   now     ms epoch for the prompt ages, default the current time
// Returns { entries, total } (total counts the rows shown before the limit) or
// { error }.
function list(projects, filter) {
  filter = filter || {};
  var parsedStates = parseStates(filter.state);
  if (parsedStates.error) return { error: parsedStates.error };
  var states = parsedStates.states;
  var limit = null;
  if (filter.limit !== undefined && filter.limit !== null) {
    if (typeof filter.limit !== "number" || !isFinite(filter.limit) || filter.limit < 1 || Math.floor(filter.limit) !== filter.limit) {
      return { error: "limit must be a whole number of 1 or more" };
    }
    limit = filter.limit;
  }
  var agentSlug = filter.agent ? slugifyAgentName(filter.agent) : null;
  if (filter.agent && !agentSlug) return { error: "agent must name an agent" };
  var vendor = filter.vendor ? String(filter.vendor).toLowerCase() : null;
  var scoped = collectPairs(projects, filter.now).filter(function (pair) {
    var e = pair.entry;
    if (filter.project && e.project !== filter.project) return false;
    if (agentSlug && slugifyAgentName(e.agent) !== agentSlug) return false;
    if (vendor && String(e.vendor || "").toLowerCase() !== vendor) return false;
    return true;
  });
  var matched = filter.state === undefined || filter.state === null
    ? withReapedLanes(scoped)
    : scoped.filter(function (pair) { return !states || states.indexOf(pair.entry.state) !== -1; });
  var shown = limit === null ? matched : matched.slice(0, limit);
  // The richer fields are worked out for the rows returned, not for every match.
  return {
    entries: shown.map(function (pair) { return filter.detail ? withDetail(pair.entry, pair.session) : pair.entry; }),
    total: matched.length,
  };
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
// The highest tier (running, idle, prompt-blocked, reaped) holding any match decides: one
// there is the answer, several are the candidates, and lower tiers are not
// looked at. A named address (parsed.name) is exact: it matches only sessions
// of that name, so it never falls to a different session; the tiers then only
// separate same-named twins (a reaped one beside a running one).
// With holdsRequest (a prompt request id) the matches are first narrowed to the
// sessions with that request pending and the tiers are not consulted.
function resolve(entries, parsed, holdsRequest) {
  var matches = matchesOf(entries, parsed);
  if (holdsRequest !== undefined) {
    var holders = matches.filter(function (e) {
      return (e.pendingPrompts || []).some(function (p) { return p.requestId === holdsRequest; });
    });
    if (holders.length === 1) return { match: holders[0] };
    return holders.length ? { candidates: holders } : { none: true };
  }
  for (var i = 0; i < TIER_ORDER.length; i++) {
    var tier = matches.filter(TIER_ORDER[i]);
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
  // `none` tells a caller holding only a window of the history that this is a
  // miss in that window, not proof that the session never received one.
  return { none: true, reason: "this session has received no injected message to reply to" };
}

module.exports = {
  STATE: STATE,
  STATE_FILTERS: STATE_FILTERS,
  stateOf: stateOf,
  DEFAULT_STATES: DEFAULT_STATES,
  parseStates: parseStates,
  collect: collect,
  detailOf: detailOf,
  withDetail: withDetail,
  list: list,
  parseAddress: parseAddress,
  validateName: validateName,
  resolve: resolve,
  lastInjectedSender: lastInjectedSender,
};
