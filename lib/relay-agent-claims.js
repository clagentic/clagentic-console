// relay-agent-claims.js — optional relay live-claim integration for UI-path agent sessions.
//
// When an operator opens a named-agent session via the clagentic-console Agents
// sidebar, the session gets a relay live claim so that inbound relay messages
// addressed to that agent route to this operator session instead of spawning a
// subprocess. (lr-9cfc)
//
// Design constraints:
//   - clagentic-relay is OPTIONAL infrastructure. This module MUST degrade
//     gracefully when the relay socket is absent. No error should surface to
//     the operator when relay is not running.
//   - All public functions are fire-and-forget or return Promises that never
//     reject (errors are logged and swallowed). Callers must not await them
//     for correctness.
//   - No new external dependencies. Uses only Node.js built-ins: http, net, os, fs.
//
// Relay socket: CLAGENTIC_RELAY_SOCKET env > ~/.lore/relay.sock (same default
// as the clagentic CLI — conversation.go defaultSocketPath()).
//
// Wire shape: POST /conversations/live-claim/register|heartbeat|release
// Body: { conversation_id, participant, claim_id, [session_label], [force] }
// Response: { claim_id, heartbeat_ts, effective }
// All requests over HTTP/1.1 on the Unix domain socket, no TLS.
// Identity header: X-Relay-Caller-Lead sourced from CLAGENTIC_OPERATOR_LEAD env
// (set by per-installation config). Falls back to empty string — relay treats
// an absent header as anonymous operator access, which is safe for UI-path sessions.
//
// Conversation list: read ~/.lore/conversation-sidecars/ directly (same as
// clagentic conversation list). No relay round-trip needed for listing — the
// sidecar files are written by the relay daemon and available on disk.
//
// Heartbeat: setInterval every HEARTBEAT_INTERVAL_MS. Relay claim TTL is 90s;
// we heartbeat every 30s to stay well within the window.
//
// Release: called on session deletion or agentName clear. Best-effort; the relay
// will expire the claim after TTL if release fails.
//
// lr-9cfc. Referenced: lr-ce19 (claim redesign), lr-aa68 (live-claim routing),
// tome #488 §2.4, tome #493.

var fs = require("fs");
var http = require("http");
var net = require("net");
var os = require("os");
var path = require("path");
var crypto = require("crypto");

var HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds — relay TTL is 90s
var SOCKET_CONNECT_TIMEOUT_MS = 2000;  // 2s timeout for connectivity check
var REQUEST_TIMEOUT_MS = 8000;         // 8s max per relay call

// --- Relay socket path ---

function relaySocketPath() {
  if (process.env.CLAGENTIC_RELAY_SOCKET) return process.env.CLAGENTIC_RELAY_SOCKET;
  var home = os.homedir();
  return path.join(home, ".lore", "relay.sock");
}

// --- Low-level HTTP-over-UDS helpers ---

// Try a quick connect to the relay socket. Resolves true/false; never rejects.
function isRelayReachable() {
  return new Promise(function (resolve) {
    var sockPath = relaySocketPath();
    var conn = net.createConnection({ path: sockPath });
    var settled = false;
    function done(ok) {
      if (settled) return;
      settled = true;
      try { conn.destroy(); } catch (e) {}
      resolve(ok);
    }
    var timer = setTimeout(function () { done(false); }, SOCKET_CONNECT_TIMEOUT_MS);
    conn.on("connect", function () { clearTimeout(timer); done(true); });
    conn.on("error", function () { clearTimeout(timer); done(false); });
  });
}

// POST JSON body to the relay, return parsed response body. Rejects on HTTP error
// or network failure. Callers wrap in try/catch.
function relayPost(urlPath, body) {
  return new Promise(function (resolve, reject) {
    var sockPath = relaySocketPath();
    var data = JSON.stringify(body);

    var opts = {
      socketPath: sockPath,
      method: "POST",
      path: urlPath,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "X-Relay-Caller-Lead": process.env.CLAGENTIC_OPERATOR_LEAD || "",
      },
    };

    var req = http.request(opts, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          var msg = raw;
          try {
            var parsed = JSON.parse(raw);
            if (parsed.message) msg = (parsed.error ? parsed.error + ": " : "") + parsed.message;
          } catch (e) {}
          return reject(new Error("relay " + urlPath + " HTTP " + res.statusCode + ": " + msg));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error("relay " + urlPath + ": invalid JSON response")); }
      });
      res.on("error", reject);
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, function () {
      req.destroy(new Error("relay " + urlPath + ": request timeout"));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// --- Sidecar-based conversation listing (mirrors clagentic conversation list) ---
//
// The relay writes a JSON sidecar for each conversation at:
//   ~/.lore/conversation-sidecars/<conv_id>.json
// Each sidecar has: conversation_id, topic, kind, status, opened_by,
//   participants[{name, role}], message_count, last_seq, opened_at.
//
// We read these directly — no relay round-trip needed.

function loreHomeDir() {
  var home = os.homedir();
  return path.join(home, ".lore");
}

// Returns array of sidecar objects for open conversations where agentName is
// a participant. Returns [] on any error (relay absent, dir missing, etc.).
function listOpenConversationsForAgent(agentName) {
  var sidecarDir = path.join(loreHomeDir(), "conversation-sidecars");
  try {
    var entries = fs.readdirSync(sidecarDir);
    var results = [];
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i];
      if (!name.endsWith(".json")) continue;
      var fullPath = path.join(sidecarDir, name);
      var raw;
      try { raw = fs.readFileSync(fullPath, "utf8"); } catch (e) { continue; }
      var obj;
      try { obj = JSON.parse(raw); } catch (e) { continue; }
      if (!obj || typeof obj !== "object") continue;
      if (obj.status !== "open") continue;
      var participants = Array.isArray(obj.participants) ? obj.participants : [];
      var isParticipant = participants.some(function (p) { return p && p.name === agentName; });
      if (!isParticipant) continue;
      results.push(obj);
    }
    return results;
  } catch (e) {
    // Directory missing (relay never ran) or any other error — return empty.
    return [];
  }
}

// --- Per-session claim state ---
//
// Map from session.localId -> { agentName, claims: Map<convId, claimId>, timer, watcher }
// where timer is the heartbeat setInterval handle and watcher is the fs.watch
// handle for the sidecar directory (stops on detach).

var _sessionClaims = new Map(); // localId -> { agentName, claims, timer, watcher }

// Generate a UUID for use as claimId. Uses crypto.randomUUID if available
// (Node 14.17+), falls back to a hex blob.
function generateClaimId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

// Register a single live claim for agentName on convId. Resolves with claim_id
// or null on failure. Never rejects.
function registerClaim(agentName, convId, sessionLabel) {
  var claimId = generateClaimId();
  var body = {
    conversation_id: convId,
    participant: agentName,
    claim_id: claimId,
  };
  if (sessionLabel) body.session_label = sessionLabel;

  return relayPost("/conversations/live-claim/register", body).then(function (resp) {
    if (resp && resp.effective) {
      return resp.claim_id || claimId;
    }
    // effective=false means claim was superseded — not an error for us; return
    // the claim_id anyway (we may get heartbeat rejections later and handle then).
    return resp && resp.claim_id ? resp.claim_id : claimId;
  }).catch(function (e) {
    // 409 claim-already-held: another session holds this claim. Log and skip.
    var msg = (e && e.message) ? e.message : String(e);
    if (msg.indexOf("claim-already-held") !== -1) {
      console.log("[relay-agent-claims] claim already held for " + agentName + " on " + convId + " — skip (use --force to supersede)");
    } else {
      console.warn("[relay-agent-claims] register failed for " + agentName + " on " + convId + ":", msg);
    }
    return null;
  });
}

// Send a heartbeat for an existing claim. Resolves true if effective, false if
// superseded. Never rejects.
function heartbeatClaim(agentName, convId, claimId) {
  return relayPost("/conversations/live-claim/heartbeat", {
    conversation_id: convId,
    participant: agentName,
    claim_id: claimId,
  }).then(function (resp) {
    return !!(resp && resp.effective);
  }).catch(function (e) {
    var msg = (e && e.message) ? e.message : String(e);
    console.warn("[relay-agent-claims] heartbeat failed for " + agentName + " on " + convId + ":", msg);
    return false;
  });
}

// Release a live claim. Best-effort; never rejects, never throws.
function releaseClaim(agentName, convId, claimId) {
  return relayPost("/conversations/live-claim/release", {
    conversation_id: convId,
    participant: agentName,
    claim_id: claimId,
  }).then(function () {
    // success
  }).catch(function (e) {
    var msg = (e && e.message) ? e.message : String(e);
    console.warn("[relay-agent-claims] release failed for " + agentName + " on " + convId + ":", msg);
  });
}

// Start the 30s heartbeat loop for a session's claims. Restores claims after
// relay restart by re-registering when heartbeat returns effective=false.
function startHeartbeatLoop(localId) {
  var state = _sessionClaims.get(localId);
  if (!state) return;
  if (state.timer) return; // already running

  var timer = setInterval(function () {
    var st = _sessionClaims.get(localId);
    if (!st) {
      clearInterval(timer);
      return;
    }
    var convIds = Array.from(st.claims.keys());
    for (var i = 0; i < convIds.length; i++) {
      (function (convId) {
        var claimId = st.claims.get(convId);
        if (!claimId) return;
        heartbeatClaim(st.agentName, convId, claimId).then(function (effective) {
          if (effective) return; // still alive
          // Superseded or expired — attempt re-register.
          var sessState = _sessionClaims.get(localId);
          if (!sessState) return;
          registerClaim(st.agentName, convId, "console-reregister").then(function (newId) {
            var s2 = _sessionClaims.get(localId);
            if (!s2 || !newId) return;
            s2.claims.set(convId, newId);
            console.log("[relay-agent-claims] re-registered claim for " + st.agentName + " on " + convId);
          });
        });
      })(convIds[i]);
    }
  }, HEARTBEAT_INTERVAL_MS);

  state.timer = timer;
}

// Watch the sidecar directory for new conversation files. When a new sidecar
// appears where agentName is a participant, auto-claims via onNewConversation.
// Called from attachAgentSession after relay reachability is confirmed.
//
// preExistingConvIds: Set of conversation_id strings that existed at watcher-start
// time. Events for these are ignored — operator decides whether to claim them,
// per lr-9cfc spec. Only sidecar files not in this set trigger auto-claim.
//
// Returns the fs.FSWatcher instance, or null if the directory is absent.
function startSidecarWatcher(localId, agentName, preExistingConvIds) {
  var sidecarDir = path.join(loreHomeDir(), "conversation-sidecars");
  // Keyed by filename so concurrent events for different files don't cancel each other.
  var debounceMap = new Map();
  var watcher;
  try {
    watcher = fs.watch(sidecarDir, function (eventType, filename) {
      if (!filename || !filename.endsWith(".json")) return;
      // Debounce per filename to avoid double-fire from write + rename events.
      var prev = debounceMap.get(filename);
      if (prev) clearTimeout(prev);
      debounceMap.set(filename, setTimeout(function () {
        debounceMap.delete(filename);
        var fullPath = path.join(sidecarDir, filename);
        var raw;
        try { raw = fs.readFileSync(fullPath, "utf8"); } catch (e) { return; }
        var obj;
        try { obj = JSON.parse(raw); } catch (e) { return; }
        if (!obj || obj.status !== "open") return;
        var convId = obj.conversation_id;
        if (!convId) return;
        // Skip conversations that existed before the watcher started — those are
        // display-only; the operator must explicitly claim them (lr-9cfc spec).
        if (preExistingConvIds && preExistingConvIds.has(convId)) return;
        var participants = Array.isArray(obj.participants) ? obj.participants : [];
        var isParticipant = participants.some(function (p) { return p && p.name === agentName; });
        if (!isParticipant) return;
        onNewConversation(localId, agentName, convId);
      }, 50));
    });
  } catch (e) {
    // Sidecar dir absent or watch not supported — silently ignore.
    return null;
  }
  return watcher;
}

// --- Public API ---

// Called when a new session is opened with agentName set.
// 1. Checks relay reachability; if absent, returns immediately (no-op).
// 2. Lists open conversations for agentName from sidecars.
// 3. Surfaces open conv list to operator (display-only — operator decides to claim).
// 4. Starts heartbeat loop and sidecar watcher for auto-claiming new conversations.
//
// sendToSessionFn: function(obj) — sends to all clients viewing this session.
//
// Returns immediately; all relay calls are async and non-blocking.
function attachAgentSession(session, agentName, sendToSessionFn) {
  if (!agentName || typeof agentName !== "string") return;
  var localId = session.localId;

  // Initialize state entry.
  _sessionClaims.set(localId, {
    agentName: agentName,
    claims: new Map(),
    timer: null,
    watcher: null,
  });

  isRelayReachable().then(function (reachable) {
    if (!reachable) {
      // Relay not running — clean up and exit silently.
      _sessionClaims.delete(localId);
      return;
    }

    var state = _sessionClaims.get(localId);
    if (!state) return; // session already deleted

    // List open conversations for this agent.
    var openConvs = listOpenConversationsForAgent(agentName);

    // Surface open conversations to operator (display-only, per task spec lr-9cfc).
    // Pre-existing conversations are NOT auto-claimed — operator decides per-conversation
    // to avoid recreating the stale-claim/zombie-blocking problem fixed 2026-05-19.
    if (openConvs.length > 0 && typeof sendToSessionFn === "function") {
      var lines = ["Open conversations where " + agentName + " is a participant (not claimed — operator decides):"];
      for (var k = 0; k < openConvs.length; k++) {
        var c = openConvs[k];
        var short = (c.conversation_id || "").substring(0, 8);
        lines.push("  " + short + "  [" + (c.kind || "?") + "]  " + (c.topic || "(no topic)") + "  (msgs: " + (c.message_count || 0) + ")");
      }
      lines.push("New conversations opened after this session starts will be auto-claimed.");
      sendToSessionFn({
        type: "system_message",
        text: lines.join("\n"),
        role: "system",
        _ts: Date.now(),
      });
    }

    // Do NOT auto-claim pre-existing conversations (lr-9cfc spec).
    // Start the heartbeat loop and sidecar watcher so new conversations are
    // auto-claimed via onNewConversation as they appear.
    // Pass the pre-existing conv IDs so the watcher can ignore sidecar rewrites
    // for conversations that were open before this session started.
    var preExistingIds = new Set(openConvs.map(function (c) { return c.conversation_id; }));
    var s = _sessionClaims.get(localId);
    if (s) {
      startHeartbeatLoop(localId);
      s.watcher = startSidecarWatcher(localId, agentName, preExistingIds);
    }
  });
}

// Called when a new conversation is opened where agentName is a participant
// AND this agent has an active UI session. Auto-registers a live claim without
// prompting the operator (new convs only — not pre-existing, per lr-9cfc spec).
//
// convId: the newly-opened conversation ID.
// agentName: the participant name (must match the session's agentName).
// localId: the session's localId.
//
// Returns a Promise that resolves with the claim_id or null. Never rejects.
function onNewConversation(localId, agentName, convId) {
  var state = _sessionClaims.get(localId);
  if (!state || state.agentName !== agentName) return Promise.resolve(null);
  if (!convId) return Promise.resolve(null);
  if (state.claims.has(convId)) return Promise.resolve(state.claims.get(convId));

  var sessionLabel = "console-ui-new-" + agentName + "-" + Date.now();
  return registerClaim(agentName, convId, sessionLabel).then(function (claimId) {
    if (!claimId) return null;
    var s = _sessionClaims.get(localId);
    if (!s) return null;
    s.claims.set(convId, claimId);
    console.log("[relay-agent-claims] auto-claimed new conv " + convId.substring(0, 8) + " for session " + localId + " (" + agentName + ")");
    return claimId;
  });
}

// Called when a session is deleted or its agentName is cleared.
// Releases all live claims, stops the heartbeat loop, and closes the sidecar watcher.
// Best-effort — never throws.
function detachAgentSession(localId) {
  var state = _sessionClaims.get(localId);
  if (!state) return;

  // Stop heartbeat loop.
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  // Stop sidecar watcher.
  if (state.watcher) {
    try { state.watcher.close(); } catch (e) {}
    state.watcher = null;
  }

  // Release all claims (best-effort, async).
  var agentName = state.agentName;
  var entries = Array.from(state.claims.entries());
  _sessionClaims.delete(localId);

  for (var i = 0; i < entries.length; i++) {
    (function (convId, claimId) {
      releaseClaim(agentName, convId, claimId).then(function () {
        console.log("[relay-agent-claims] released claim for " + agentName + " on " + convId.substring(0, 8));
      });
    })(entries[i][0], entries[i][1]);
  }
}

// Returns true if this session has an active relay claim state (relay was
// reachable when the session was attached).
function hasClaimState(localId) {
  return _sessionClaims.has(localId);
}

// Exported for testing: get the current claims for a session.
function getClaimsForSession(localId) {
  var state = _sessionClaims.get(localId);
  if (!state) return null;
  return { agentName: state.agentName, claims: Object.fromEntries(state.claims) };
}

module.exports = {
  attachAgentSession: attachAgentSession,
  detachAgentSession: detachAgentSession,
  onNewConversation: onNewConversation,
  hasClaimState: hasClaimState,
  getClaimsForSession: getClaimsForSession,
  // exported for tests
  listOpenConversationsForAgent: listOpenConversationsForAgent,
  isRelayReachable: isRelayReachable,
  registerClaim: registerClaim,
  heartbeatClaim: heartbeatClaim,
  releaseClaim: releaseClaim,
};
