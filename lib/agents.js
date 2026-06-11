// Named agents — SDK-based catalog discovery.
//
// History: an earlier path (chadbyte/clay#332) registered each chat-enabled
// agent as its own Clay project rooted at ~/.clay/agents/<slug>/, with the
// agent body materialized as that project's CLAUDE.md so Claude CLI's
// project-context loader injected it as the system prompt. That path was
// retired in lr-ea32 once the per-session SDK-`agent`-option path (lr-7db0)
// proved out — sessions now carry an `agentName` and the SDK applies the
// agent identity itself.
//
// lr-8e39: replaced CLI text-parse path (claude agents --setting-sources …)
// with the SDK supportedAgents() surface. The CLI subcommand was retasked in
// Claude Code 2.1.x to "Manage background agents" and returns an error when
// invoked non-interactively. supportedAgents() is a stable SDK Query API that
// returns AgentInfo[] (name, description, model?) and follows the same
// settingSources as the prior CLI call.
//
// Discovery is async and cached. Call refresh() at daemon startup; getAll()
// returns the last-known cache synchronously. An empty cache (before the first
// refresh completes, or if discovery fails) returns [].
//
// Implementation: we open a streaming-input SDK session (sdk.query with a
// no-message async iterable), await initialization, call supportedAgents(),
// then abort the session. The Query object's supportedAgents() method awaits
// the internal initialization promise — no user prompt is ever sent.
//
// This implementation lives only on our fork; we are not pushing it upstream.

var fs = require("fs");
var path = require("path");
// Use config.js REAL_HOME — it handles sudo/getent/root-reject uniformly.
var { REAL_HOME } = require("./config");

// Still exported for callers that referenced them (backwards compat).
var AGENTS_SOURCE_DIR = path.join(REAL_HOME, ".claude", "agents");
var PLUGINS_CACHE_DIR = path.join(REAL_HOME, ".claude", "plugins", "cache");

// Minimal frontmatter parser — kept for any callers that still use it.
function parseFrontmatter(raw) {
  if (typeof raw !== "string") return null;
  var stripped = raw.replace(/^﻿/, "");
  if (stripped.indexOf("---") !== 0) return { meta: {}, body: stripped };
  var rest = stripped.slice(3);
  var endIdx = rest.indexOf("\n---");
  if (endIdx === -1) return { meta: {}, body: stripped };
  var fmText = rest.slice(0, endIdx);
  var afterFence = rest.slice(endIdx + 4);
  if (afterFence.charAt(0) === "\n") afterFence = afterFence.slice(1);
  var meta = {};
  var lines = fmText.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || /^\s*#/.test(line)) continue;
    var colon = line.indexOf(":");
    if (colon === -1) continue;
    var key = line.slice(0, colon).trim();
    var val = line.slice(colon + 1).trim();
    if (!key) continue;
    if ((val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
        (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")) {
      val = val.slice(1, -1);
    }
    if (val === "true") val = true;
    else if (val === "false") val = false;
    meta[key] = val;
  }
  return { meta: meta, body: afterFence };
}

// Normalize an agent name to a filesystem-safe slug.
function slugifyAgentName(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// lr-4c90 — Read the tools list for a named agent directly from its on-disk
// frontmatter. The SDK AgentInfo surface (supportedAgents()) does not expose
// the tools field — only name, description, and model are returned. Reading
// the file directly is the only synchronous path for belt-and-suspenders
// enforcement in the query setup path.
//
// agentName: the agent identity string (e.g. "agentic-director").
// Returns: string[] of tool names if the tools field is a valid JSON array,
//          null if the file is absent, the frontmatter is missing, or the
//          tools field cannot be parsed.
//
// Failures are silent (logged at debug level) — callers treat null as "no
// restriction from this source" and fall through to whatever the SDK applies
// via claudeOpts.agent.
function readAgentToolsFromFile(agentName) {
  if (!agentName || typeof agentName !== "string") return null;
  var slug = slugifyAgentName(agentName);
  if (!slug) return null;
  var filePath = path.join(AGENTS_SOURCE_DIR, slug + ".md");
  var raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    // File not found is expected for agents with no on-disk definition.
    return null;
  }
  var parsed = parseFrontmatter(raw);
  if (!parsed || !parsed.meta) return null;
  var toolsVal = parsed.meta.tools;
  if (!toolsVal || typeof toolsVal !== "string") return null;
  var trimmed = toolsVal.trim();
  if (trimmed.charAt(0) !== "[") return null; // not a JSON array — skip
  try {
    var arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) return null;
    var result = [];
    for (var i = 0; i < arr.length; i++) {
      if (typeof arr[i] === "string" && arr[i]) result.push(arr[i]);
    }
    return result.length > 0 ? result : null;
  } catch (e) {
    return null;
  }
}

// --- SDK-backed discovery cache ---

// Module-level cache. Populated by refresh(); read by getAll().
var _cache = [];
// In-flight refresh promise (deduplicate concurrent calls).
var _refreshPromise = null;

// Map AgentInfo (SDK shape) → picker-facing shape.
// AgentInfo: { name: string; description?: string; model?: string }
function agentInfoToEntry(info) {
  var name = info.name || "";
  var slug = slugifyAgentName(name);
  return {
    name: name,
    slug: slug,
    description: info.description || "",
    model: info.model || "",
    // Retained for backwards compat with consumers that read these fields.
    // Always null/agent since the plugin marketplace is gone (lr-635a).
    kind: "agent",
    pluginName: null,
    sourcePath: null,
  };
}

// Build an async iterable that emits no messages, allowing the SDK session
// to initialize without sending a user prompt.
async function* _emptyIterable() {
  // Yield nothing. The AbortController will terminate the session after we
  // read supportedAgents() from the initialization result.
}

// Kick off an async SDK discovery session and update the cache.
// Returns a promise that never rejects — failures are logged and the cache
// retains its last-known value.
//
// settingSources: string array, defaults to ['user','project','local']
// to match the prior CLI --setting-sources flag.
function refresh(settingSources) {
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async function () {
    var sdk;
    try {
      sdk = await import("@anthropic-ai/claude-agent-sdk");
    } catch (e) {
      console.error("[agents] failed to import SDK:", e.message);
      _refreshPromise = null;
      return;
    }

    var sources = Array.isArray(settingSources) ? settingSources : ["user", "project", "local"];
    var abortController = new AbortController();
    var queryInstance = null;
    try {
      // Open a streaming-input session with an empty iterable. The SDK
      // initializes its subprocess and completes the handshake before
      // surfacing any events — supportedAgents() awaits that handshake.
      queryInstance = sdk.query({
        prompt: _emptyIterable(),
        options: {
          settingSources: sources,
          abortController: abortController,
        },
      });

      var agents = await queryInstance.supportedAgents();
      if (Array.isArray(agents)) {
        _cache = agents.map(agentInfoToEntry).filter(function (e) { return e.slug; });
        console.log("[agents] discovered " + _cache.length + " agents via SDK");
      } else {
        console.warn("[agents] supportedAgents() returned non-array:", agents);
      }
    } catch (e) {
      console.error("[agents] SDK discovery failed:", (e && e.message) || e);
      // Keep last-known cache on failure.
    } finally {
      // Abort the session subprocess — we don't need it anymore.
      try { abortController.abort(); } catch (e) { /* best-effort */ }
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

// Return the last-known cached agent list. Synchronous; never throws.
// Returns [] before the first refresh completes or if discovery failed.
function getAll() {
  return _cache.slice();
}

// Legacy alias. Returns the same as getAll() — kept so callers that used
// discoverAllAgents() still work without changes.
function discoverAllAgents() {
  return getAll();
}

// Read all named-agent definitions from a project-local .claude/agents/ directory,
// merged with the global ~/.claude/agents/ directory.
//
// Claude Code resolves agents from both locations. Project-local definitions
// take precedence: if the same slug appears in both directories, the
// project-local entry wins.
//
// projectDir: absolute path to the project root (cwd).
// Returns: array of { name, slug, description } objects, sorted by name.
// Returns [] if neither directory exists or is readable — callers treat
// an empty array as "no agents" and degrade gracefully.
//
// This reads the filesystem directly (no SDK subprocess) — it is synchronous
// and cheap. Each agents directory is small (typically 0–20 files).
function _readAgentsFromDir(agentsDir) {
  var entries;
  try {
    entries = fs.readdirSync(agentsDir);
  } catch (e) {
    // Directory absent or unreadable — not an error.
    return [];
  }
  var results = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry || !entry.endsWith(".md")) continue;
    var slug = entry.slice(0, -3); // strip .md
    if (!slug) continue;
    var filePath = path.join(agentsDir, entry);
    var raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (e) {
      continue;
    }
    var parsed = parseFrontmatter(raw);
    var name = (parsed && parsed.meta && parsed.meta.name) ? String(parsed.meta.name) : slug;
    var description = (parsed && parsed.meta && parsed.meta.description) ? String(parsed.meta.description) : "";
    results.push({ name: name, slug: slug, description: description });
  }
  return results;
}

// _globalAgentsDir is an optional override used in tests; callers must not pass it.
function readProjectAgents(projectDir, _globalAgentsDir) {
  if (!projectDir || typeof projectDir !== "string") return [];

  var localDir = path.join(projectDir, ".claude", "agents");
  var globalDir = (typeof _globalAgentsDir === "string" && _globalAgentsDir)
    ? _globalAgentsDir
    : path.join(REAL_HOME, ".claude", "agents");

  var localEntries = _readAgentsFromDir(localDir);
  var globalEntries = _readAgentsFromDir(globalDir);

  // Build a slug-keyed map from global entries, then overlay local entries.
  // Local definitions win when the same slug appears in both directories.
  var bySlug = Object.create(null);
  for (var i = 0; i < globalEntries.length; i++) {
    bySlug[globalEntries[i].slug] = globalEntries[i];
  }
  for (var j = 0; j < localEntries.length; j++) {
    bySlug[localEntries[j].slug] = localEntries[j];
  }

  var results = Object.keys(bySlug).map(function (slug) { return bySlug[slug]; });
  results.sort(function (a, b) {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return results;
}

module.exports = {
  AGENTS_SOURCE_DIR: AGENTS_SOURCE_DIR,
  PLUGINS_CACHE_DIR: PLUGINS_CACHE_DIR,
  parseFrontmatter: parseFrontmatter,
  slugifyAgentName: slugifyAgentName,
  readAgentToolsFromFile: readAgentToolsFromFile,
  readProjectAgents: readProjectAgents,
  // New SDK-backed surface:
  refresh: refresh,
  getAll: getAll,
  // Legacy compat alias (no longer shells out to claude CLI):
  discoverAllAgents: discoverAllAgents,
};
