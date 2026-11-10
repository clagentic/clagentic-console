// team-traffic.js - the read side of the Team view's agent-messages section:
// the agent-to-agent traffic that went through the console, grouped by
// counterpart pair, for one caller.
//
// Read-only. The outbound ledger (lib/outbound-ledger.js) is the primary source:
// every open-session and send-input leaves one entry there. Two routes never
// reach the ledger and are filled from the receiving session's own history, in
// the same aggregation (no second view):
//   - a scheduled firing (fireScheduled in session-input.js records the turn the
//     console composed, never a ledger entry)
//   - a loop iteration (project-loop.js starts its sessions itself and does not
//     call session-input.js)
// Both are recorded on the target as a user_message from the console's own
// automation (senderKind "automation"). The fill reads the sessions the console
// holds in memory, so it only reaches back as far as their loaded history.
// Armed scheduled inputs are listed as pending, read-only.
//
// The read rules are the ledger's (lib/outbound-access.js), unchanged. An entry
// is shown only when its text may be shown to this caller: one whose text the
// caller cannot read, or that was never stored because the target runs as
// another OS user, is counted and its reason reported, and is not listed.

var outboundEntry = require("./outbound-entry");
var injectedSender = require("./injected-sender");
var { INITIATORS } = require("./turn-initiator");

var MAX_MESSAGES = 1000;
var MAX_TEXT_CHARS = 4000;
var MAX_REASONS = 5;
var DAY_MS = 24 * 60 * 60 * 1000;
var OTHER_OS_USER = "the target session runs as another OS user";

var KIND = Object.freeze({ OPEN: "open", INPUT: "input", SCHEDULED: "scheduled", REPLY: "reply", LOOP: "loop" });

var OUTBOUND_VERBS = new Set([outboundEntry.VERB.SEND_INPUT, outboundEntry.VERB.OPEN_SESSION]);

function clip(text) {
  if (typeof text !== "string") return { text: null, truncated: false };
  if (text.length <= MAX_TEXT_CHARS) return { text: text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

function kindOfEntry(entry) {
  if (entry.target && entry.target.reply === true) return KIND.REPLY;
  if (entry.initiator === INITIATORS.SCHEDULED || entry.initiator === INITIATORS.SCHEDULED_NOW) return KIND.SCHEDULED;
  return entry.verb === outboundEntry.VERB.OPEN_SESSION ? KIND.OPEN : KIND.INPUT;
}

function kindOfAutomation(initiator) {
  return initiator === INITIATORS.LOOP ? KIND.LOOP : KIND.SCHEDULED;
}

// A sender as the client's identity adapter takes it (injected-identity.js).
function identityOfLedgerSender(sender) {
  sender = sender || {};
  var out = { senderKind: sender.kind || injectedSender.SENDER_KIND.UNDECLARED, attribution: sender.attribution || "unverified" };
  if (sender.name) out.fromName = sender.name;
  if (sender.agent) out.senderAgent = sender.agent;
  if (sender.project) out.senderProject = sender.project;
  if (sender.sessionId) out.senderSessionId = sender.sessionId;
  if (sender.declaredName) out.declaredName = sender.declaredName;
  return out;
}

function identityOfAutomation(entry) {
  return {
    senderKind: injectedSender.SENDER_KIND.AUTOMATION,
    attribution: "console",
    fromName: entry.fromName,
    initiator: entry.initiator,
  };
}

// Stable text for "who": the pair is the same pair whichever entry names it.
function senderKey(sender) {
  sender = sender || {};
  if (sender.attribution === "extracted" && sender.project && (sender.cliSessionId || sender.sessionId)) {
    return "s:" + sender.project + "/" + (sender.cliSessionId || "console-" + sender.sessionId);
  }
  if (sender.kind === "declared" && sender.name) return "d:" + sender.name + (sender.fromSession ? "/" + sender.fromSession : "");
  return "u:";
}

function targetKey(target) {
  target = target || {};
  return (target.project || "") + "/" + (target.cliSessionId || (target.sessionId ? "console-" + target.sessionId : target.address || ""));
}

// deps:
//   ledger           lib/outbound-ledger.js createOutboundLedger() result
//   access           lib/outbound-access.js createOutboundAccess() result
//   getProject(slug) -> project context | null
//   listProjects()   -> [{ slug, project }] every project held
//   scheduledInput   optional { armedForSession(slug, session) } (lib/scheduled-input/service.js)
//   now()            ms clock (default Date.now)
function createTeamTraffic(deps) {
  var ledger = deps.ledger;
  var access = deps.access;
  var getProject = deps.getProject;
  var listProjects = deps.listProjects || function () { return []; };
  var scheduledInput = deps.scheduledInput || null;
  var now = deps.now || Date.now;

  // The caller's view of one session, by the same decision the ledger applies to
  // its prompts. A session is named by project and vendor id only.
  function mayRead(project, cliSessionId, caller) {
    return access.canReadPrompt({ target: { project: project, cliSessionId: cliSessionId } }, caller);
  }

  // The live session behind a vendor id, as the sidebar addresses it now. A
  // console id is renumbered by a restart, so it is looked up here at read time
  // and never stored. null when the session is gone or the caller may not read it.
  function linkFor(slug, cliSessionId, caller) {
    if (!slug || !cliSessionId) return null;
    var project = getProject(slug);
    if (!project || !project.sm || !project.sm.sessions) return null;
    var found = null;
    project.sm.sessions.forEach(function (s) {
      if (!found && s.cliSessionId === cliSessionId) found = s;
    });
    if (!found || !mayRead(slug, cliSessionId, caller).allowed) return null;
    return { project: slug, id: found.localId };
  }

  function describeTarget(target) {
    target = target || {};
    var out = { project: target.project || null };
    if (target.agent) out.agent = target.agent;
    if (target.name) out.name = target.name;
    return out;
  }

  // Collects what the caller may see into `state`; counts and explains the rest.
  function collect(state, caller, cutoff) {
    function withhold(reason) {
      state.withheldCount++;
      if (reason && state.reasons.indexOf(reason) === -1 && state.reasons.length < MAX_REASONS) state.reasons.push(reason);
    }

    ledger.readAttributed({}).concat(ledger.readUnattributed({})).forEach(function (e) {
      if (!OUTBOUND_VERBS.has(e.verb)) return;
      var verdict = access.canReadPrompt(e, caller);
      if (!verdict.allowed) return withhold(verdict.reason);
      if (e.promptWithheld === true) return withhold(e.promptWithheldReason || OTHER_OS_USER);
      var sender = e.sender || {};
      var text = clip(e.prompt);
      state.items.push({
        ts: e.ts,
        pairKey: senderKey(sender) + ">" + targetKey(e.target),
        senderIdentity: identityOfLedgerSender(sender),
        senderRef: { project: sender.project || null, cliSessionId: sender.cliSessionId || null },
        target: describeTarget(e.target),
        targetRef: { project: (e.target || {}).project || null, cliSessionId: (e.target || {}).cliSessionId || null },
        message: {
          ts: e.ts,
          kind: kindOfEntry(e),
          result: e.result,
          reason: e.reason || null,
          initiator: e.initiator || null,
          messageId: e.messageId || null,
          text: text.text,
          truncated: text.truncated,
          contextNote: typeof e.contextNote === "string" ? e.contextNote : null,
          source: "ledger",
        },
      });
    });

    listProjects().forEach(function (held) {
      var project = held.project;
      if (!project || !project.sm || !project.sm.sessions) return;
      project.sm.sessions.forEach(function (s) {
        var history = Array.isArray(s.history) ? s.history : [];
        var fromHistory = history.filter(function (h) {
          return injectedSender.isInjected(h) && h.senderKind === injectedSender.SENDER_KIND.AUTOMATION
            && typeof h._ts === "number" && h._ts >= cutoff;
        });
        if (!fromHistory.length) return;
        var linux = typeof project.getLinuxUserForSession === "function" ? project.getLinuxUserForSession(s) : null;
        var verdict = mayRead(held.slug, s.cliSessionId, caller);
        fromHistory.forEach(function (h) {
          if (!verdict.allowed) return withhold(verdict.reason);
          if (linux) return withhold(OTHER_OS_USER);
          var text = clip(h.text);
          var tRef = { project: held.slug, cliSessionId: s.cliSessionId || null };
          state.items.push({
            ts: new Date(h._ts).toISOString(),
            pairKey: "a:" + h.fromName + ">" + targetKey({ project: held.slug, cliSessionId: s.cliSessionId, sessionId: String(s.localId) }),
            senderIdentity: identityOfAutomation(h),
            senderRef: { project: null, cliSessionId: null },
            target: { project: held.slug, agent: s.agentName || undefined, name: s.sessionName || undefined },
            targetRef: tRef,
            message: {
              ts: new Date(h._ts).toISOString(),
              kind: kindOfAutomation(h.initiator),
              result: "delivered",
              reason: null,
              initiator: h.initiator || null,
              messageId: h.messageId || null,
              text: text.text,
              truncated: text.truncated,
              contextNote: typeof h.contextNote === "string" ? h.contextNote : null,
              source: "session",
            },
          });
        });
      });
    });
  }

  // Armed scheduled inputs of the sessions the caller may read, as pending items.
  function collectPending(state, caller) {
    if (!scheduledInput || typeof scheduledInput.armedForSession !== "function") return;
    listProjects().forEach(function (held) {
      var project = held.project;
      if (!project || !project.sm || !project.sm.sessions) return;
      project.sm.sessions.forEach(function (s) {
        var armed;
        try { armed = scheduledInput.armedForSession(held.slug, s); } catch (e) {
          console.error("[team-traffic] could not list the armed scheduled inputs of " + held.slug + ":", e && e.message ? e.message : e);
          return;
        }
        if (!armed.length || !mayRead(held.slug, s.cliSessionId, caller).allowed) return;
        if (typeof project.getLinuxUserForSession === "function" && project.getLinuxUserForSession(s)) return;
        armed.forEach(function (r) {
          var text = clip(r.text);
          state.pending.push({
            pairKey: "a:" + injectedSender.AUTOMATION_NAMES[INITIATORS.SCHEDULED] + ">" + targetKey({ project: held.slug, cliSessionId: s.cliSessionId, sessionId: String(s.localId) }),
            senderIdentity: { senderKind: injectedSender.SENDER_KIND.AUTOMATION, attribution: "console", fromName: injectedSender.AUTOMATION_NAMES[INITIATORS.SCHEDULED], initiator: INITIATORS.SCHEDULED },
            target: { project: held.slug, agent: s.agentName || undefined, name: s.sessionName || undefined },
            targetRef: { project: held.slug, cliSessionId: s.cliSessionId || null },
            pending: {
              id: r.id,
              kind: KIND.SCHEDULED,
              nextAt: r.nextAt,
              every: r.every,
              createdBy: r.createdBy,
              text: text.text,
              truncated: text.truncated,
            },
          });
        });
      });
    });
  }

  // caller: { user, authenticated } as for lib/outbound-query.js.
  // Returns { ok, result, retentionDays, pairs, messages, pending, withheld }
  // or { ok: false, result: "error", reason } when the ledger cannot be read.
  function snapshot(caller) {
    var days = ledger.retentionDays();
    var base = { ok: true, result: "listed", retentionDays: days };
    if (days === 0) {
      return Object.assign(base, {
        pairs: [], messages: [], pending: [], withheld: { count: 0, reasons: [] },
        note: "the outbound ledger is turned off (outboundRetentionDays is 0)",
      });
    }
    var state = { items: [], pending: [], withheldCount: 0, reasons: [] };
    try {
      collect(state, caller, now() - days * DAY_MS);
    } catch (e) {
      return { ok: false, result: "error", reason: e && e.message ? e.message : String(e), code: (e && e.code) || null };
    }
    collectPending(state, caller);

    state.items.sort(function (a, b) { return Date.parse(a.ts) - Date.parse(b.ts); });
    var pairs = new Map();
    function pairOf(item) {
      var p = pairs.get(item.pairKey);
      if (!p) {
        p = {
          key: item.pairKey,
          sender: Object.assign({}, item.senderIdentity, { link: item.senderRef ? linkFor(item.senderRef.project, item.senderRef.cliSessionId, caller) : null }),
          target: Object.assign({}, item.target, { link: linkFor(item.targetRef.project, item.targetRef.cliSessionId, caller) }),
          count: 0,
          pendingCount: 0,
          lastAt: null,
        };
        pairs.set(item.pairKey, p);
      }
      return p;
    }
    state.items.forEach(function (item) {
      var p = pairOf(item);
      p.count++;
      p.lastAt = item.ts;
    });
    var pending = state.pending.map(function (item) {
      pairOf(item).pendingCount++;
      return Object.assign({ pairKey: item.pairKey }, item.pending);
    });

    var shown = state.items;
    var truncated = 0;
    if (shown.length > MAX_MESSAGES) {
      truncated = shown.length - MAX_MESSAGES;
      shown = shown.slice(truncated);
    }
    var list = Array.from(pairs.values()).sort(function (a, b) {
      return (b.lastAt ? Date.parse(b.lastAt) : 0) - (a.lastAt ? Date.parse(a.lastAt) : 0);
    });
    return Object.assign(base, {
      pairs: list,
      messages: shown.map(function (item) { return Object.assign({ pairKey: item.pairKey }, item.message); }),
      messagesTruncated: truncated,
      pending: pending,
      withheld: { count: state.withheldCount, reasons: state.reasons },
    });
  }

  return { snapshot: snapshot };
}

module.exports = { createTeamTraffic: createTeamTraffic, KIND: KIND, MAX_MESSAGES: MAX_MESSAGES, MAX_TEXT_CHARS: MAX_TEXT_CHARS };
