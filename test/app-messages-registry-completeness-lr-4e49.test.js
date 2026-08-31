// Regression/completeness test for lr-4e49 Part 2: app-messages.js's
// 185-case switch was converted to a handler registry (registerHandlers()
// calls in app-messages.js, filebrowser.js, and server-settings.js).
//
// This test proves no message type was silently dropped during the
// conversion: it statically extracts every key ever passed to
// registerHandlers({...}) across the three files that call it, and diffs
// that set against the exact case-label set the pre-refactor switch handled
// (lib/public/modules/app-messages.js at merged commit 52d716b, PR #355 —
// the last commit before this split). The golden list below was transcribed
// directly from that file's `case "..."` labels; do not add to it without
// also confirming the label existed in the pre-refactor switch.
//
// Static source parsing (no jsdom/DOM harness) follows the same pattern as
// test/cli-require-exports.test.js — app-messages.js and its registrants
// call document.getElementById() at module scope, which is unsafe to
// require/import directly outside a browser/jsdom environment.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

// Exact case "..." labels from the pre-refactor 185-case switch
// (lib/public/modules/app-messages.js, merged commit 52d716b / PR #355).
var ORIGINAL_CASE_LABELS = [
  "history_meta", "history_prepend", "history_done", "info",
  "update_available", "up_to_date", "update_started", "slash_commands",
  "model_info", "config_state", "codex_config", "client_count", "toast",
  "skill_installed", "skill_uninstalled", "loop_registry_updated",
  "schedule_run_started", "schedule_run_finished", "loop_scheduled",
  "schedule_move_result", "remove_project_check_result", "hub_schedules",
  "hub_recent_sessions", "input_sync", "session_deleted", "session_list",
  "agents_list", "agent_favorite_toggled", "project_agents_list",
  "session_presence", "cursor_move", "cursor_leave", "text_select",
  "session_io", "session_unread", "search_results", "search_content_results",
  "cli_session_list", "session_switched", "session_id", "message_uuid",
  "user_message", "plan_content", "context_preview", "status", "compacting",
  "thinking_start", "thinking_delta", "thinking_stop", "delta", "tool_start",
  "tool_executing", "tool_result", "ask_user_answered", "permission_request",
  "permission_cancel", "permission_resolved", "permission_request_pending",
  "elicitation_request", "elicitation_resolved", "slash_command_result",
  "subagent_activity", "subagent_tool", "subagent_done", "task_started",
  "task_progress", "task_updated", "result", "context_usage", "done",
  "stderr", "error", "system_info", "sdk_notification", "process_conflict",
  "context_overflow", "auth_required", "rate_limit", "rate_limit_usage",
  "scheduled_message_queued", "scheduled_message_sent",
  "scheduled_message_cancelled", "auto_continue_scheduled",
  "auto_continue_fired", "prompt_suggestion", "fast_mode_state",
  "process_killed", "rewind_preview_result", "rewind_complete",
  "rewind_error", "fork_complete", "fs_list_result", "fs_search_result",
  "fs_read_result", "fs_write_result", "project_env_result",
  "set_project_env_result", "global_claude_md_result",
  "write_global_claude_md_result", "shared_env_result",
  "set_shared_env_result", "fs_file_changed", "fs_dir_changed",
  "fs_file_history_result", "fs_git_diff_result", "fs_file_at_result",
  "term_list", "context_sources_state", "extension_command", "mcp_tool_call",
  "mcp_servers_state", "term_created", "term_output", "term_resized",
  "term_exited", "term_closed", "notes_list", "note_created", "note_updated",
  "note_deleted", "process_stats", "browse_dir_result", "add_project_result",
  "clone_project_progress", "remove_project_result",
  "reorder_projects_result", "set_project_title_result",
  "set_project_icon_result", "set_project_preferred_agent_result",
  "set_project_folder_result", "rename_project_folder_result",
  "set_folder_icon_result", "projects_updated", "rename_custom_icon_result",
  "project_owner_changed", "dm_history", "dm_message", "dm_typing",
  "dm_list", "dm_favorites_updated", "mention_start", "mention_activity",
  "mention_stream", "mention_done", "mention_error", "mention_user",
  "mention_response", "user_mention", "user_mention_error", "team_state",
  "team_member_update", "team_task_update", "team_message", "team_gone",
  "diagnostic", "daemon_config", "set_pin_result", "set_keep_awake_result",
  "keep_awake_changed", "set_auto_continue_result", "auto_continue_changed",
  "refresh_agents_result", "restart_server_result", "shutdown_server_result",
  "loop_available", "loop_started", "loop_iteration", "loop_judging",
  "loop_verdict", "loop_stopping", "loop_finished", "loop_error",
  "loop_pending_messages", "loop_message_error", "ralph_phase",
  "ralph_crafting_started", "ralph_files_status",
  "loop_registry_files_content", "ralph_files_content",
  "loop_registry_error", "notifications_state", "notification_created",
  "notification_dismissed", "notification_dismissed_all", "daemon_config_changed",
  "lite_project_status", "lite_enroll_result", "lite_unenroll_result",
  // lr-93e3c8: genuinely new message types (not pre-refactor labels) --
  // these were declared in ws-schema.js with app-messages.js as handler but
  // never implemented anywhere (fnd-66af4e). Added here the same way
  // daemon_config_changed / lite_* above were: this list has been extended
  // for real new types before, not just transcribed once and frozen.
  "set_mem_available_threshold_result", "mem_available_threshold_changed",
  "set_tokens_per_mb_headroom_result", "tokens_per_mb_headroom_changed",
];

var REGISTRY_FILES = [
  path.join(__dirname, "..", "lib", "public", "modules", "app-messages.js"),
  path.join(__dirname, "..", "lib", "public", "modules", "filebrowser.js"),
  path.join(__dirname, "..", "lib", "public", "modules", "server-settings.js"),
];

// Extracts every TOP-LEVEL key passed to registerHandlers({...}) calls in a
// source file — i.e. the message-type keys of the outer object literal,
// not any key nested inside a handler function's own body (e.g.
// `store.set({ codexApproval: ... })` inside the codex_config handler must
// NOT be picked up as a registered message type). Deliberately a small
// brace-depth-aware scanner rather than a full JS parser — sufficient for
// a completeness check, and any false negative here would fail the test
// loudly (missing key), not silently pass.
function extractRegisteredKeys(source) {
  var keys = [];
  var callRe = /registerHandlers\(\{/g;
  var callMatch;
  while ((callMatch = callRe.exec(source))) {
    var bodyStart = callMatch.index + callMatch[0].length;
    // Walk forward tracking brace depth (relative to the outer object
    // literal, depth 0) to find keys that appear immediately at depth 0,
    // and to find where the outer object literal closes.
    var depth = 0;
    var i = bodyStart;
    for (; i < source.length; i++) {
      var ch = source[i];
      if (ch === "{" || ch === "(" || ch === "[") { depth++; continue; }
      if (ch === "}" || ch === ")" || ch === "]") {
        if (ch === "}" && depth === 0) break; // end of the outer registerHandlers({...}) object
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
        // A depth-0 identifier/quoted-string immediately followed (after
        // optional whitespace) by ":" is a registered key.
        var keyMatch = /^["']?([A-Za-z_$][A-Za-z0-9_$]*)["']?\s*:/.exec(source.slice(i));
        if (keyMatch) {
          keys.push(keyMatch[1]);
          i += keyMatch[0].length - 1;
          continue;
        }
        // Any other depth-0 character (e.g. "," between entries) — skip.
      }
    }
  }
  return keys;
}

function readAllRegistrySources() {
  return REGISTRY_FILES.map(function (p) {
    return fs.readFileSync(p, "utf8");
  });
}

test("registerHandlers() registry covers every message type from the pre-refactor 185-case switch", function () {
  var allKeys = [];
  readAllRegistrySources().forEach(function (src) {
    allKeys = allKeys.concat(extractRegisteredKeys(src));
  });
  var registeredSet = new Set(allKeys);

  var missing = ORIGINAL_CASE_LABELS.filter(function (label) {
    return !registeredSet.has(label);
  });

  assert.deepEqual(
    missing,
    [],
    "message type(s) dropped from the switch->registry conversion: " + missing.join(", ")
  );
});

test("registerHandlers() registry introduces no unexpected extra message type keys", function () {
  var allKeys = [];
  readAllRegistrySources().forEach(function (src) {
    allKeys = allKeys.concat(extractRegisteredKeys(src));
  });
  var originalSet = new Set(ORIGINAL_CASE_LABELS);

  var extra = allKeys.filter(function (key) {
    return !originalSet.has(key);
  });

  assert.deepEqual(
    extra,
    [],
    "registry key(s) not present in the original switch (typo or unintended new type?): " + extra.join(", ")
  );
});

test("app-messages.js exports registerHandlers and processMessage", function () {
  var src = fs.readFileSync(REGISTRY_FILES[0], "utf8");
  assert.ok(/export function registerHandlers\(/.test(src), "app-messages.js must export registerHandlers()");
  assert.ok(/export function processMessage\(/.test(src), "app-messages.js must export processMessage()");
});

test("app-messages.js no longer contains a switch(msg.type) statement (the 185-case switch is gone)", function () {
  var src = fs.readFileSync(REGISTRY_FILES[0], "utf8");
  assert.ok(
    !/switch\s*\(\s*msg\.type\s*\)/.test(src),
    "app-messages.js still contains a switch(msg.type) — the registry conversion should have removed it entirely"
  );
});

test("filebrowser.js and server-settings.js each register at least one handler (domain modules self-register)", function () {
  var fbSrc = fs.readFileSync(REGISTRY_FILES[1], "utf8");
  var ssSrc = fs.readFileSync(REGISTRY_FILES[2], "utf8");
  assert.ok(extractRegisteredKeys(fbSrc).length > 0, "filebrowser.js should call registerHandlers() with at least one key");
  assert.ok(extractRegisteredKeys(ssSrc).length > 0, "server-settings.js should call registerHandlers() with at least one key");
});
