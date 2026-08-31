// Double-loop regression test for lr-93e3c8 (item 8).
//
// ws-schema.js documents every wire message type and, for each, names the
// file responsible for handling it -- but nothing ever checked that the
// named file actually implements the message type it claims to handle.
// This bug class has recurred more than once (this incident's
// set_tokens_per_mb_headroom_result / tokens_per_mb_headroom_changed /
// mem_available_threshold_changed / set_mem_available_threshold_result,
// declared with lib/public/modules/app-messages.js as handler but
// unimplemented anywhere -- fnd-66af4e; prior instance: update-channel
// persistence, codex 7487563).
//
// This test asserts, for every ws-schema.js entry whose direction includes
// an s2c leg ("s2c" or "both"), that the named handler file actually
// registers a handler for that message type -- either via a
// registerHandlers({...}) call (app-messages.js, filebrowser.js,
// server-settings.js -- see the brace-depth scanner shared with
// test/app-messages-registry-completeness-lr-4e49.test.js) or, for
// non-registry files, a literal `msg.type === "<type>"` / `case "<type>"`
// check.
//
// Static source parsing (no jsdom/DOM harness), same rationale as the
// sibling completeness test: app-messages.js and its registrants call
// document.getElementById() at module scope, unsafe to require/import
// directly outside a browser environment.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var REPO_ROOT = path.join(__dirname, "..");
var ws = require(path.join(REPO_ROOT, "lib", "ws-schema.js"));

// Files that self-register via registerHandlers({...}) — same brace-depth
// scanner approach as test/app-messages-registry-completeness-lr-4e49.test.js
// (duplicated here rather than imported: that test's scanner is a private
// helper, not an exported shared utility, and this file's needs are
// slightly different — it looks up a single key's presence rather than
// diffing a golden list).
function extractRegisteredKeys(source) {
  var keys = [];
  var callRe = /registerHandlers\(\{/g;
  var callMatch;
  while ((callMatch = callRe.exec(source))) {
    var bodyStart = callMatch.index + callMatch[0].length;
    var depth = 0;
    var i = bodyStart;
    for (; i < source.length; i++) {
      var ch = source[i];
      if (ch === "{" || ch === "(" || ch === "[") { depth++; continue; }
      if (ch === "}" || ch === ")" || ch === "]") {
        if (ch === "}" && depth === 0) break;
        depth--;
        continue;
      }
      if (depth === 0) {
        if (ch === "\n" || ch === " " || ch === "\t") continue;
        if (ch === "/" && source[i + 1] === "/") {
          var eol = source.indexOf("\n", i);
          i = eol === -1 ? source.length : eol;
          continue;
        }
        var keyMatch = /^["']?([A-Za-z_$][A-Za-z0-9_$]*)["']?\s*:/.exec(source.slice(i));
        if (keyMatch) {
          keys.push(keyMatch[1]);
          i += keyMatch[0].length - 1;
          continue;
        }
      }
    }
  }
  return keys;
}

// Files that actually CALL registerHandlers({...}) themselves (this is where
// extractRegisteredKeys must look for object-literal keys).
var REGISTRY_CALL_SITES = [
  "lib/public/modules/app-messages.js",
  "lib/public/modules/filebrowser.js",
  "lib/public/modules/server-settings.js",
];

// ws-schema.js's `handler` field for a client-side message type names
// whichever module OWNS the handler function conceptually, which is not
// always the file that calls registerHandlers({...}) for it -- a leaf
// module (team-panel.js, custom-icons-settings.js, app-misc.js) exports a
// named handler function that app-messages.js imports and registers on the
// leaf module's behalf (e.g. `team_state: handleTeamState` at
// app-messages.js, handleTeamState defined in team-panel.js). So any
// "handler" value in this set is resolved against the UNION of all
// REGISTRY_CALL_SITES, not read as a file that must itself contain a
// registerHandlers call.
var ROUTES_THROUGH_REGISTRY_LIST = REGISTRY_CALL_SITES.concat([
  "lib/public/modules/team-panel.js",
  "lib/public/modules/custom-icons-settings.js",
  "lib/public/modules/app-misc.js",
]);
var ROUTES_THROUGH_REGISTRY = new Set(ROUTES_THROUGH_REGISTRY_LIST);

// lr-93e3c8 (item 8) also found genuine, pre-existing gaps unrelated to this
// PR's memory-guard/settings-panel fix -- declared in ws-schema.js but not
// implemented anywhere in the client, or (for create_worktree_result)
// implemented via an ad hoc raw ws.addEventListener("message", ...) outside
// the registerHandlers registry entirely rather than a registry omission.
// Fixing 8 unrelated missing handlers spanning terminal, knowledge panel,
// loop scheduler, image retention, and ask_user would blow this PR's blast
// radius past the memory-guard/settings surface it was scoped to fix --
// named here for a follow-up task rather than silently dropped or folded in
// (CREW_SOP fold-in test: not small, not this diff's own blast radius).
// TODO(lr-93e3c8): file a follow-up task enumerating these once this PR
// lands, then remove them from this allowlist as each is fixed.
var KNOWN_PRE_EXISTING_GAPS = new Set([
  "input_sync_broadcast",
  "ask_user",
  "set_image_retention_result",
  "term_error",
  "knowledge_content",
  "knowledge_saved",
  "knowledge_deleted",
  "loop_rerun_started",
  // create_worktree_result: real client-side consumer is an ad hoc raw
  // ws.addEventListener("message", ...) in sidebar-projects.js, not the
  // registerHandlers registry ws-schema.js's handler field points at.
  "create_worktree_result",
]);

// Non-registry handler files (server-side dispatch, `if (msg.type === ...)`
// or `switch (msg.type)` / `case "...":` style) checked by literal string
// search rather than the brace-depth scanner above.
function fileHandlesTypeLiterally(source, type) {
  var patterns = [
    new RegExp("msg\\.type\\s*===\\s*[\"']" + type + "[\"']"),
    new RegExp("case\\s+[\"']" + type + "[\"']\\s*:"),
  ];
  return patterns.some(function (re) { return re.test(source); });
}

var sourceCache = {};
function readSource(relPath) {
  if (!(relPath in sourceCache)) {
    var abs = path.join(REPO_ROOT, relPath);
    sourceCache[relPath] = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  }
  return sourceCache[relPath];
}

function anyRegistryCallSiteRegisters(type) {
  return REGISTRY_CALL_SITES.some(function (relPath) {
    var source = readSource(relPath);
    if (source === null) return false;
    return extractRegisteredKeys(source).indexOf(type) !== -1;
  });
}

function handlerImplementsType(relPath, type) {
  // A leaf module wired into the registry (e.g. app-misc.js) can ALSO
  // handle some of its own message types directly with a literal
  // `msg.type === "..."` check rather than exporting a function for
  // app-messages.js to register (e.g. clay_ext_tab_list / clay_ext_result
  // in app-misc.js) -- so both paths must be checked, not either/or.
  if (ROUTES_THROUGH_REGISTRY.has(relPath) && anyRegistryCallSiteRegisters(type)) {
    return true;
  }
  var source = readSource(relPath);
  if (source === null) return false; // handler file doesn't even exist
  return fileHandlesTypeLiterally(source, type);
}

test("every ws-schema.js s2c/both entry resolves to a real handler in the file it names", function () {
  var schema = ws.schema;
  var missing = [];

  Object.keys(schema).forEach(function (type) {
    var entry = schema[type];
    if (entry.direction !== "s2c" && entry.direction !== "both") return;
    if (KNOWN_PRE_EXISTING_GAPS.has(type)) return;
    if (!handlerImplementsType(entry.handler, type)) {
      missing.push(type + " (declared handler: " + entry.handler + ")");
    }
  });

  assert.deepEqual(
    missing,
    [],
    "message type(s) declared in ws-schema.js with an s2c/both direction but not implemented in their named handler file: " + missing.join(", ")
  );
});

test("KNOWN_PRE_EXISTING_GAPS allowlist does not silently hide a type that is actually implemented", function () {
  // Guards the allowlist itself from rotting into a dumping ground: if any
  // of these ever gets a real implementation, this test forces its removal
  // from the list rather than letting a stale allowlist entry mask a
  // regression check.
  var schema = ws.schema;
  var stillGaps = [];

  KNOWN_PRE_EXISTING_GAPS.forEach(function (type) {
    var entry = schema[type];
    if (!entry) return; // type removed from schema entirely — fine, ignore
    if (!handlerImplementsType(entry.handler, type)) {
      stillGaps.push(type);
    }
  });

  assert.deepEqual(
    stillGaps.sort(),
    Array.from(KNOWN_PRE_EXISTING_GAPS).sort(),
    "a KNOWN_PRE_EXISTING_GAPS entry now has a real implementation -- remove it from the allowlist"
  );
});

test("lib/ws-schema.js exports a plain schema object usable without a DOM", function () {
  assert.equal(typeof ws.schema, "object");
  assert.ok(Object.keys(ws.schema).length > 0);
});
