// outbound-query.js - the read side of the outbound ledger: what one session
// sent out through open-session and send-input, for the `list-outbound` verb.
//
// Read-only. Returns the outbound calls only (target, prompt, time, initiator,
// result), never any transcript content. A prompt is returned only when the
// caller may read the target session (lib/outbound-access.js); otherwise the
// entry carries its metadata, `prompt: null` and the reason it was withheld.
// For a target that runs as another OS user the text was never stored (the
// writer, lib/outbound-entry.js, withholds it), so the entry already carries
// promptWithheld, contextNoteWithheld and the reason as stored.

var { isSafeSessionId } = require("./session-id");
var { VERB } = require("./outbound-entry");

var KIND_TO_VERB = Object.freeze({ sent: VERB.SEND_INPUT, opens: VERB.OPEN_SESSION });
var KIND_OF_VERB = Object.freeze({ send_input: "sent", open_session: "opens" });

function refused(reason) {
  return { ok: false, result: "refused", reason: reason };
}

// A ledger that cannot be read is an error result, not an empty list.
function unreadable(err) {
  return { ok: false, result: "error", reason: err && err.message ? err.message : String(err), code: (err && err.code) || null };
}

function shape(entry, verdict) {
  var out = {};
  for (var k in entry) if (k !== "prompt" && k !== "formatVersion") out[k] = entry[k];
  out.kind = KIND_OF_VERB[entry.verb] || null;
  // The context note is message content the caller wrote alongside the prompt,
  // so it is shown only when the prompt may be. The other free-text fields
  // (reason, sender and target names, addresses) are console-made or are names
  // and addresses, not message content.
  if (!verdict.allowed && typeof entry.contextNote === "string") {
    delete out.contextNote;
    out.contextNoteWithheld = true;
  }
  if (typeof entry.prompt !== "string") {
    out.prompt = null;
  } else if (verdict.allowed) {
    out.prompt = entry.prompt;
  } else {
    out.prompt = null;
    out.promptWithheld = true;
    out.promptWithheldReason = verdict.reason;
  }
  return out;
}

// deps:
//   ledger    lib/outbound-ledger.js createOutboundLedger() result
//   access    lib/outbound-access.js createOutboundAccess() result
//   caller    { user, authenticated } the principal behind this transport
function createOutboundQuery(deps) {
  var ledger = deps.ledger;
  var access = deps.access;
  var caller = deps.caller;

  function present(entries) {
    return entries.map(function (e) { return shape(e, access.canReadPrompt(e, caller)); });
  }

  // req: { sessionId, projectSlug?, sinceMs?, kind? }
  //   sessionId  the vendor's own session id of the sender (never a console id)
  //   sinceMs    only entries at or after this time (epoch ms)
  //   kind       "sent" (send-input) or "opens" (open-session)
  function list(req) {
    req = req || {};
    if (typeof req.sessionId !== "string" || !isSafeSessionId(req.sessionId)) {
      return refused("a session id is required and must be a plain id (letters, digits, _ and -)");
    }
    // A console id is renumbered at a daemon restart, so one number can name
    // different sessions over the ledger's retention; it is never an identity.
    if (/^[0-9]+$/.test(req.sessionId)) {
      return refused("--session takes the vendor session id, not a console id: console ids are renumbered when the daemon restarts, so one can name different sessions over time. The vendor id is shown by list-sessions (sessionId).");
    }
    if (req.projectSlug !== undefined && (typeof req.projectSlug !== "string" || !req.projectSlug)) {
      return refused("project must be a non-empty string");
    }
    if (req.sinceMs !== undefined && !(typeof req.sinceMs === "number" && isFinite(req.sinceMs))) {
      return refused("since must be a time");
    }
    var verb = null;
    if (req.kind !== undefined) {
      verb = Object.prototype.hasOwnProperty.call(KIND_TO_VERB, req.kind) ? KIND_TO_VERB[req.kind] : null;
      if (!verb) return refused("unknown kind " + JSON.stringify(String(req.kind).slice(0, 32)) + " (accepted: sent, opens)");
    }

    var days = ledger.retentionDays();
    var base = { ok: true, result: "listed", retentionDays: days };
    if (days === 0) {
      return Object.assign(base, { count: 0, messages: [], unattributed: [], note: "the outbound ledger is turned off (outboundRetentionDays is 0)" });
    }

    var id = req.sessionId;
    var mine;
    try {
      mine = ledger.readAttributed({ project: req.projectSlug, sinceMs: req.sinceMs }).filter(function (e) {
        return (e.sender || {}).cliSessionId === id;
      });
    } catch (e) {
      return unreadable(e);
    }

    // Vendor ids are unique, but a ledger written by hand or by an older
    // writer could repeat one across projects; never merge those silently.
    // A Set, not an object: a slug such as __proto__ must count as a key.
    var projects = new Set();
    mine.forEach(function (e) { projects.add(e.sender.project); });
    var projectNames = Array.from(projects);
    if (projectNames.length > 1) {
      return {
        ok: false,
        result: "ambiguous",
        reason: "the session id " + JSON.stringify(id) + " names a sender in " + projectNames.length + " projects; send again with --project",
        projects: projectNames.sort(),
      };
    }

    // The vendor ids this sender has used, to find calls that only named it.
    var vendorIds = new Set([id]);
    mine.forEach(function (e) { if (e.sender.cliSessionId) vendorIds.add(e.sender.cliSessionId); });

    // Self-reported: a declared sender names the session it claims to be. Kept
    // apart and labelled, never merged into the identified senders' list.
    var claimed;
    try {
      claimed = ledger.readUnattributed({ sinceMs: req.sinceMs }).filter(function (e) {
        return e.sender && typeof e.sender.fromSession === "string" && vendorIds.has(e.sender.fromSession);
      });
    } catch (e) {
      return unreadable(e);
    }

    function wanted(e) { return !verb || e.verb === verb; }
    var messages = mine.filter(wanted);
    var unattributed = claimed.filter(wanted);

    return Object.assign(base, {
      session: { id: id, project: projectNames[0] || req.projectSlug || null },
      count: messages.length,
      messages: present(messages),
      unattributedCount: unattributed.length,
      unattributed: present(unattributed),
      unattributedNote: "Calls whose sender only named itself (--from-session). The console cannot verify them; they are listed so they are not lost, not as this session's own calls.",
    });
  }

  return { list: list };
}

module.exports = { createOutboundQuery: createOutboundQuery, KIND_TO_VERB: KIND_TO_VERB };
