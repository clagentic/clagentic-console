var usersModule = require("./users");
var { discoverWorkflows } = require("./sdk-workflow-discovery");
var { buildEnrichedSlashCommands } = require("./sdk-slash-enrichment");
var { partitionSubagentOwnedPermissions, retainPreservedTaskBookkeeping, sweepClearedPermissionIndex } = require("./sdk-permission-ownership");
var sessionActivity = require("./session-activity");

function attachMessageProcessor(ctx) {
  var sm = ctx.sm;
  var send = ctx.send;
  var slug = ctx.slug;
  var pushModule = ctx.pushModule;
  var getNotificationsModule = ctx.getNotificationsModule || function () { return null; };
  var getSDK = ctx.getSDK;
  var adapter = ctx.adapter;
  var cwd = ctx.cwd;
  var onProcessingChanged = ctx.onProcessingChanged;
  var onTurnDone = ctx.onTurnDone;
  var onAutoTitle = ctx.onAutoTitle;
  var onTeamCreate = ctx.onTeamCreate || null;
  var onTeamDelete = ctx.onTeamDelete || null;
  var opts = ctx.opts;
  var discoverSkillDirs = ctx.discoverSkillDirs;
  var mergeSkills = ctx.mergeSkills;
  var discoverSkillsWithMeta = ctx.discoverSkillsWithMeta;
  var mergeSkillsWithMeta = ctx.mergeSkillsWithMeta;
  // lr-3ccc78 — resolves the session owner's home on a shared multi-user
  // daemon; returns null (falls back to REAL_HOME) in single-user mode.
  var resolveSessionHome = ctx.resolveSessionHome || function () { return null; };
  // Allows callers (and tests) to inject a mock; falls back to the real implementation.
  var discoverWorkflowsFn = ctx.discoverWorkflows || discoverWorkflows;

  var AUTO_TITLE_TURN_THRESHOLD = 2;

  function sendAndRecord(session, obj) {
    sm.sendAndRecord(session, obj);
  }

  function sendToSession(session, obj) {
    sm.sendToSession(session, obj);
  }

  // lr-9bcd7b: server activity registry wiring. Acquire/release a token in
  // lib/session-activity.js and broadcast the SESSION LIST only on a real
  // 0->1 / 1->0 transition of the derived active boolean (the chattiness
  // mitigation the spec makes mandatory — a Task tool starting/progressing
  // while another source is already active must not trigger a broadcast).
  //
  // session.isProcessing itself is intentionally left as a legacy write in
  // parallel (see the 'result' handler below) rather than fully retired in
  // this pass — see this task's PR body for the explicit shadow-mode
  // boundary and what's deferred to lr-66c118.
  function acquireActivity(session, token, info) {
    var result = sessionActivity.acquireToken(session, token, info);
    if (result.changed) sm.broadcastSessionList();
    return result;
  }

  function releaseActivity(session, token) {
    var result = sessionActivity.releaseToken(session, token);
    if (result.changed) sm.broadcastSessionList();
    return result;
  }

  // lr-c56476: Codex parity wiring. Codex (lib/yoke/adapters/codex.js) has no
  // subagent concept -- ordinary tool_start/thinking_start there are NOT a
  // backgrounded Task the way Claude's Task tool is, so this does not (and
  // must not) fabricate a Task lifecycle. What it DOES need: Codex's
  // tool_start/thinking_start/tool_result/result already ride through this
  // same shared processor, but unlike Claude, Codex has no equivalent of the
  // turn-wide isProcessing=true covering ordinary tool activity implicitly --
  // acquiring an explicit token here is how Codex activity becomes visible to
  // the derived isProcessing/picker-dot path at all. Gated on
  // session.vendor === "codex" so this stays independent of Claude's own
  // widened acquisition below (lr-6e20f7, block_stop) -- the two vendors
  // acquire tokens through different yokeType branches (tool_start here vs.
  // block_stop for Claude) and neither path double-acquires the other's
  // tokens.
  //
  // Release happens on tool_result (per-token, matching Claude's tool_result
  // release) OR at the turn's result event, which releases EVERY still-live
  // Codex-sourced token for this session at once -- a catch-all so a
  // thinking block (which Codex ends via its own top-level thinking_stop
  // event that this shared processor does not otherwise dispatch) is never
  // left acquired past the end of its own turn. This mirrors Claude's
  // task_notification acting as a second, idempotent drain path for a token
  // that tool_result might not otherwise catch.
  function releaseAllCodexActivity(session) {
    var sources = sessionActivity.listActiveSources(session);
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].source === "codex-tool" || sources[i].source === "codex-thinking") {
        releaseActivity(session, sources[i].token);
      }
    }
  }

  // lr-9bcd7b / lr-255e residual #2: the SDK 'result' handler used to clear
  // session.isProcessing UNCONDITIONALLY, with no check for a still-running
  // backgrounded Task — the exact defect that made every session/project/
  // recent picker's green dot go dark the instant a subagent started (picker
  // dots read session.isProcessing directly — lib/sessions.js
  // mapSessionForClient). Now: only clear isProcessing when the activity
  // registry agrees nothing else is live for this session (e.g. no
  // backgrounded Task still running). If the registry disagrees (something
  // is still active), isProcessing stays true — this is the shadow-mode
  // reconciliation called for in the PR body: the legacy field is kept in
  // sync with the new derived source of truth at its known-wrong write site,
  // rather than either fully retiring session.isProcessing (too large a diff
  // for this pass) or leaving this specific site unconditionally wrong (the
  // one residual this task exists to fix).
  function setIsProcessingFromRegistry(session) {
    session.isProcessing = sessionActivity.isSessionActive(session);
  }

  function getModelsForVendor(vendor) {
    if (vendor && sm.modelsByVendor && sm.modelsByVendor[vendor]) return sm.modelsByVendor[vendor];
    return sm.availableModels || [];
  }

  function toolActivityTextForSubagent(name, input) {
    if (name === "Bash" && input && input.description) return input.description;
    if (name === "Read" && input && input.file_path) return "Reading " + input.file_path.split("/").pop();
    if (name === "Edit" && input && input.file_path) return "Editing " + input.file_path.split("/").pop();
    if (name === "Write" && input && input.file_path) return "Writing " + input.file_path.split("/").pop();
    if (name === "Grep" && input && input.pattern) return "Searching for " + input.pattern;
    if (name === "Glob" && input && input.pattern) return "Finding " + input.pattern;
    if (name === "WebSearch" && input && input.query) return "Searching: " + input.query;
    if (name === "WebFetch") return "Fetching URL...";
    if (name === "Task" && input && input.description) return input.description;
    return "Running " + name + "...";
  }


  // Maps a rate-limit bucket id to a predicate on the model string.
  // null means "applies to all models in the vendor" (e.g. five_hour, seven_day).
  var BUCKET_MODEL_PREDICATES = {
    "five_hour": null,
    "seven_day": null,
    "seven_day_sonnet": function (m) { return /sonnet/i.test(m || ""); },
    "seven_day_opus":   function (m) { return /opus/i.test(m || ""); },
    // Future: "seven_day_haiku": function (m) { return /haiku/i.test(m || ""); }
  };

  function bucketBlocksModel(bucketType, model) {
    if (!bucketType) return false;
    if (!(bucketType in BUCKET_MODEL_PREDICATES)) {
      // Unknown bucket — be conservative and treat as blocking.
      return true;
    }
    var pred = BUCKET_MODEL_PREDICATES[bucketType];
    if (pred === null) return true; // vendor-wide
    return pred(model);
  }

  function processSubagentMessage(session, parsed) {
    var parentId = parsed.parentToolUseId;
    var content = parsed.content;
    if (!Array.isArray(content)) return;

    // lr-f36626: a backgrounded Task's own stream activity is genuine session
    // activity even though the parent turn's isProcessing is false while the
    // dispatch-loop sits WAITING on the child (root cause: the idle reaper in
    // sdk-bridge.js only ever saw the two top-level turn/query bump sites, so
    // a session correctly waiting on a live child looked identical to an
    // abandoned one and got reaped out from under it). Bumping here — the
    // same field the reaper compares against — means a genuinely progressing
    // child keeps the parent session non-idle for as long as it keeps
    // producing output; a dead/silent child stops bumping and the session
    // still times out and is reaped normally (no blanket "never reap if a
    // child is registered" rule — see startIdleReaper in sdk-bridge.js).
    session.lastActivityAt = Date.now();

    if (parsed.messageRole === "assistant") {
      // Extract tool_use blocks from sub-agent assistant messages
      for (var i = 0; i < content.length; i++) {
        var block = content[i];
        if (block.type === "tool_use") {
          // lr-9d4b: Record which backgrounded Task (parentId) owns this tool
          // call's id so the parent turn's 'result' handler can tell a
          // sub-agent-owned pendingPermissions entry apart from an orphaned one
          // before it wipes the map (see sdk-message-processor.js result branch).
          if (!session.subagentToolOwners) session.subagentToolOwners = {};
          session.subagentToolOwners[block.id] = parentId;
          var activityText = toolActivityTextForSubagent(block.name, block.input);
          sendAndRecord(session, {
            type: "subagent_tool",
            parentToolId: parentId,
            toolName: block.name,
            toolId: block.id,
            text: activityText,
          });
        } else if (block.type === "thinking") {
          sendAndRecord(session, {
            type: "subagent_activity",
            parentToolId: parentId,
            text: "Thinking...",
          });
        } else if (block.type === "text" && block.text) {
          sendAndRecord(session, {
            type: "subagent_activity",
            parentToolId: parentId,
            text: "Writing response...",
          });
        }
      }
    }
    // user messages with parentToolUseId contain tool_results -- skip silently
  }

  function processSDKMessage(session, parsed) {
    // Timing: log key SDK milestones relative to query start
    if (session._queryStartTs) {
      var _elapsed = Date.now() - session._queryStartTs;
      if (parsed.yokeType === "init") {
        console.log("[PERF] processSDKMessage: system/init +" + _elapsed + "ms");
      }
      if (parsed.yokeType === "turn_start") {
        console.log("[PERF] processSDKMessage: message_start (API response begun) +" + _elapsed + "ms");
      }
      if ((parsed.yokeType === "text_delta" || parsed.yokeType === "tool_input_delta" || parsed.yokeType === "thinking_delta") && !session._firstTextLogged) {
        session._firstTextLogged = true;
        console.log("[PERF] processSDKMessage: FIRST content_block_delta (visible text) +" + _elapsed + "ms");
      }
      if (parsed.yokeType === "result") {
        console.log("[PERF] processSDKMessage: result +" + _elapsed + "ms");
      }
    }

    // Extract session_id from any message that carries it. Persist the meta
    // record whenever cliSessionId actually changes (not only when it was
    // previously null) -- otherwise a changed id starts appending history
    // lines to a file whose first line is never a meta record, and the
    // session is silently dropped by loadSessions/loadSessionHistory on
    // restart (lr-1bdb item B).
    if (parsed.sessionId && parsed.sessionId !== session.cliSessionId) {
      var _isNewSessionId = !session.cliSessionId;
      session.cliSessionId = parsed.sessionId;
      sm.saveSessionFile(session);
      if (_isNewSessionId) {
        sendAndRecord(session, { type: "session_id", cliSessionId: session.cliSessionId });
      }
    }

    // Capture message UUIDs for rewind support.
    // lr-2ea2a7: historyIndex must be ABSOLUTE (session._historyBaseIndex +
    // heap length), not the raw heap length — messageUUIDs[].historyIndex is
    // part of the wire/rewind contract and must stay valid once the heap
    // array can be trimmed out from under a long-running session.
    if (parsed.uuid) {
      var _absHistoryIndex = (session._historyBaseIndex || 0) + session.history.length;
      if (parsed.messageType === "user" && !parsed.parentToolUseId) {
        session.messageUUIDs.push({ uuid: parsed.uuid, type: "user", historyIndex: _absHistoryIndex });
        sendAndRecord(session, { type: "message_uuid", uuid: parsed.uuid, messageType: "user" });
      } else if (parsed.messageType === "assistant") {
        session.messageUUIDs.push({ uuid: parsed.uuid, type: "assistant", historyIndex: _absHistoryIndex });
        sendAndRecord(session, { type: "message_uuid", uuid: parsed.uuid, messageType: "assistant" });
      }
    }

    // Cache slash_commands and model from CLI init message
    if (parsed.yokeType === "init") {
      // lr-3ccc78 — resolve THIS session's owner's home so skill discovery
      // isn't the daemon's REAL_HOME for every user on a shared daemon.
      var _initHome = resolveSessionHome(session);
      var fsSkills = discoverSkillDirs(_initHome);
      sm.skillNames = mergeSkills(parsed.skills, fsSkills);
      sm.workflowMeta = discoverWorkflowsFn(cwd);
      // Enriched skill metadata (lr-7d8d) — stored alongside skillNames for consumers
      // that need description and type without breaking existing skillNames callers.
      if (typeof discoverSkillsWithMeta === "function" && typeof mergeSkillsWithMeta === "function") {
        var fsSkillsMeta = discoverSkillsWithMeta(cwd, _initHome);
        sm.skillMeta = mergeSkillsWithMeta(parsed.skills, fsSkillsMeta);
      }
      if (parsed.slashCommands) {
        // Delegate to shared enrichment helper (lr-cf84). Pass ctx-injected
        // discovery functions so tests can mock filesystem reads as before.
        var _enrichFns = {
          discoverSkillsWithMeta: typeof discoverSkillsWithMeta === "function" ? discoverSkillsWithMeta : undefined,
          mergeSkillsWithMeta: typeof mergeSkillsWithMeta === "function" ? mergeSkillsWithMeta : undefined,
          discoverWorkflows: discoverWorkflowsFn,
          homeOverride: _initHome,
        };
        var combined = buildEnrichedSlashCommands(parsed.slashCommands, cwd, _enrichFns);
        sm.slashCommands = combined;
        send({ type: "slash_commands", commands: sm.slashCommands });
      }
      if (parsed.model) {
        sm.currentModel = sm.currentModel || sm._savedDefaultModel || parsed.model;
        var initVendor = session.vendor || (adapter && adapter.vendor) || "claude";
        send({
          type: "model_info",
          model: sm.currentModel,
          models: getModelsForVendor(initVendor),
          vendor: initVendor,
          availableVendors: sm.availableVendors || [],
          installedVendors: sm.installedVendors || [],
        });
      }
      if (parsed.fastModeState) {
        sendAndRecord(session, { type: "fast_mode_state", state: parsed.fastModeState });
      }
    }

    if (parsed.yokeType === "turn_start") {
      if (parsed.inputTokens) {
        session.lastStreamInputTokens = parsed.inputTokens;
      }

    } else if (parsed.yokeType === "tool_start" || parsed.yokeType === "thinking_start" || parsed.yokeType === "text_start") {
      var idx = parsed.blockId;

      if (parsed.yokeType === "tool_start") {
        session.blocks[idx] = { type: "tool_use", id: parsed.toolId, name: parsed.toolName, inputJson: "" };
        sendAndRecord(session, { type: "tool_start", id: parsed.toolId, name: parsed.toolName });
        // lr-c56476: Codex parity -- see releaseAllCodexActivity above for why
        // this is gated to vendor === "codex" and not applied to Claude.
        if (session.vendor === "codex" && parsed.toolId) {
          acquireActivity(session, parsed.toolId, { source: "codex-tool", label: parsed.toolName || "" });
        }
      } else if (parsed.yokeType === "thinking_start") {
        session.blocks[idx] = { type: "thinking", thinkingText: "", startTime: Date.now() };
        sendAndRecord(session, { type: "thinking_start" });
        // lr-c56476: Codex parity. Token id keyed on blockId (Codex's
        // "blk_N" counter, see lib/yoke/adapters/codex.js flattenEvent) since
        // a thinking_start event carries no separate tool-style id.
        if (session.vendor === "codex") {
          acquireActivity(session, "thinking_" + idx, { source: "codex-thinking", label: "" });
        }
      } else if (parsed.yokeType === "text_start") {
        session.blocks[idx] = { type: "text" };
      }

    } else if (parsed.yokeType === "text_delta" || parsed.yokeType === "tool_input_delta" || parsed.yokeType === "thinking_delta") {
      var idx = parsed.blockId;

      if (parsed.yokeType === "text_delta" && typeof parsed.text === "string") {
        session.streamedText = true;
        if (session.responsePreview.length < 200) {
          session.responsePreview += parsed.text;
        }
        // Accumulate text for mate DM response
        if (typeof session._mateDmResponseText === "string") {
          session._mateDmResponseText += parsed.text;
        }
        sendAndRecord(session, { type: "delta", text: parsed.text });
      } else if (parsed.yokeType === "tool_input_delta" && session.blocks[idx]) {
        session.blocks[idx].inputJson += parsed.partialJson;
      } else if (parsed.yokeType === "thinking_delta" && session.blocks[idx]) {
        session.blocks[idx].thinkingText += parsed.text;
        sendAndRecord(session, { type: "thinking_delta", text: parsed.text });
      }

    } else if (parsed.yokeType === "tool_executing") {
      sendAndRecord(session, {
        type: "tool_executing",
        id: parsed.toolId,
        name: parsed.toolName,
        input: parsed.input || {},
      });

      // TeamCreate: record pending so we can extract the teamId from tool_result
      if (parsed.toolName === "TeamCreate" && onTeamCreate) {
        if (!session._pendingTeamCreates) session._pendingTeamCreates = {};
        session._pendingTeamCreates[parsed.toolId] = {
          cliSessionId: session.cliSessionId || null,
          cwd: cwd,
        };
      }

      // TeamDelete: fire immediately on execution
      if (parsed.toolName === "TeamDelete" && onTeamDelete) {
        try { onTeamDelete(); } catch (e) {}
      }

    } else if (parsed.yokeType === "tool_result") {
      sendAndRecord(session, {
        type: "tool_result",
        id: parsed.toolId,
        content: parsed.content || "",
        is_error: !!parsed.isError,
      });

      // lr-c56476: Codex parity -- release the token acquired at tool_start
      // for this same toolId. releaseActivity is idempotent (see
      // session-activity.js), so this is always safe even if the token was
      // already released elsewhere (e.g. by the result-time catch-all below).
      if (session.vendor === "codex" && parsed.toolId) {
        releaseActivity(session, parsed.toolId);
      }

      // TeamCreate result: extract team ID from result text and activate
      if (onTeamCreate && session._pendingTeamCreates && session._pendingTeamCreates[parsed.toolId]) {
        var pending = session._pendingTeamCreates[parsed.toolId];
        delete session._pendingTeamCreates[parsed.toolId];
        if (!parsed.isError) {
          // Extract UUID from result text (e.g. "Created team abc123...")
          var resultText = typeof parsed.content === "string" ? parsed.content : "";
          var uuidMatch = resultText.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
          var shortMatch = uuidMatch ? null : resultText.match(/team\s+([a-z0-9_-]{4,})/i);
          var teamId = (uuidMatch && uuidMatch[1]) || (shortMatch && shortMatch[1]) || null;
          if (teamId) {
            try {
              onTeamCreate(teamId, session.cliSessionId || pending.cliSessionId, pending.cwd);
            } catch (e) {
              console.error("[sdk-message-processor] onTeamCreate threw:", e && e.message ? e.message : e);
            }
          }
        }
      }

    } else if (parsed.yokeType === "plan_updated") {
      var todos = Array.isArray(parsed.plan) ? parsed.plan.map(function(step, idx) {
        var todo = {
          id: String(idx + 1),
          content: step.step || "",
          status: step.status || "pending",
        };
        if (todo.status === "in_progress" && parsed.explanation) {
          todo.activeForm = parsed.explanation;
        }
        return todo;
      }) : [];
      sendAndRecord(session, {
        type: "tool_executing",
        id: parsed.turnId || "codex-plan",
        name: "TodoWrite",
        input: {
          todos: todos,
          meta: {
            variant: "plan",
            title: parsed.title || "Plan",
          },
        },
      });

    } else if (parsed.yokeType === "plan_content") {
      sendAndRecord(session, {
        type: "plan_content",
        content: parsed.content || "",
      });

    } else if (parsed.yokeType === "block_stop") {
      var idx = parsed.blockId;
      var block = session.blocks[idx];

      if (block && block.type === "tool_use") {
        var input = {};
        try { input = JSON.parse(block.inputJson); } catch (e) {}
        sendAndRecord(session, { type: "tool_executing", id: block.id, name: block.name, input: input });

        // lr-6e20f7: acquire an activity token for EVERY Claude tool_use
        // block, not only Task. Claude has turn-wide isProcessing coverage
        // for ordinary tools (see the module-header comment), which is
        // sufficient for the LOCAL viewing client's own turn-in-flight
        // signal (store.processing) but not for the SERVER-side registry
        // that drives every OTHER client's picker/sidebar dot — that
        // registry previously only saw a live token for a backgrounded
        // Task, so a plain Bash/Read/Edit call was invisible to it. Released
        // at the same block below (whichever tool ends up there) OR at the
        // 'message' handler's tool_result content-array scan below
        // (releaseActivity is idempotent either way).
        acquireActivity(session, block.id, { source: "tool", label: input.description || block.name || "" });

        // Track active Task tools for sub-agent done detection
        if (block.name === "Task") {
          if (!session.activeTaskToolIds) session.activeTaskToolIds = {};
          session.activeTaskToolIds[block.id] = true;
        }

        if (pushModule && block.name === "AskUserQuestion" && input.questions) {
          var q = input.questions[0];
          var _askPayload = {
            type: "ask_user",
            slug: slug,
            title: "Claude has a question",
            body: q ? q.question : "Waiting for your response",
            tag: "claude-ask",
          };
          // Route to session owner only — content carries prompt text.
          if (session.ownerId && pushModule.sendPushToUser) {
            pushModule.sendPushToUser(session.ownerId, _askPayload);
          } else {
            pushModule.sendPush(_askPayload);
          }
        }
      } else if (block && block.type === "thinking") {
        var duration = block.startTime ? (Date.now() - block.startTime) / 1000 : 0;
        sendAndRecord(session, { type: "thinking_stop", duration: duration });
      }

      delete session.blocks[idx];

    } else if (parsed.yokeType === "subagent_message") {
      // Sub-agent messages: extract tool_use blocks for activity display
      processSubagentMessage(session, parsed);

    } else if (parsed.yokeType === "message") {
      var content = parsed.content;

      // Fallback: if assistant text wasn't streamed via deltas, send it now
      if (parsed.messageRole === "assistant" && !session.streamedText && Array.isArray(content)) {
        var assistantText = content
          .filter(function(c) { return c.type === "text"; })
          .map(function(c) { return c.text; })
          .join("");
        if (assistantText) {
          if (session.responsePreview.length < 200) {
            session.responsePreview += assistantText;
          }
          sendAndRecord(session, { type: "delta", text: assistantText });
        }
      }

      // Check for local slash command output in user messages
      if (parsed.messageRole === "user") {
        var fullText = "";
        if (typeof content === "string") {
          fullText = content;
        } else if (Array.isArray(content)) {
          fullText = content
            .filter(function(c) { return c.type === "text"; })
            .map(function(c) { return c.text; })
            .join("\n");
        }
        if (fullText.indexOf("local-command-stdout") !== -1) {
          var m = fullText.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
          if (m) {
            sendAndRecord(session, { type: "slash_command_result", text: m[1].trim() });
          }
        }
      }

      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var block = content[i];
          if (block.type === "tool_result" && !session.sentToolResults[block.tool_use_id]) {
            // Clear active Task tool when its result arrives
            if (session.activeTaskToolIds && session.activeTaskToolIds[block.tool_use_id]) {
              sendAndRecord(session, {
                type: "subagent_done",
                parentToolId: block.tool_use_id,
              });
              delete session.activeTaskToolIds[block.tool_use_id];
            }
            // lr-9bcd7b (widened lr-6e20f7): release the activity token
            // acquired at block_stop for this tool id, unconditionally --
            // NOT gated on activeTaskToolIds still containing the entry.
            // This covers every tool now (lr-6e20f7 widened acquisition
            // beyond Task), not only backgrounded Task tools -- the
            // Task-specific bookkeeping above (activeTaskToolIds,
            // subagent_done) is unrelated to this release and unaffected by
            // the widening. The 'result' handler's pre-existing lr-9d4b
            // cleanup (retainPreservedTaskBookkeeping) already trims
            // activeTaskToolIds down to only Task ids with a preserved
            // permission on EVERY result, so a Task with no pending permission
            // of its own has its activeTaskToolIds entry deleted before this
            // tool_result ever arrives -- gating the release on that same map
            // would silently skip it and leak the token forever. releaseToken
            // is idempotent (no-op if this id was never acquired, or already
            // released by task_notification), so calling it unconditionally
            // for every tool_result is always safe.
            releaseActivity(session, block.tool_use_id);
            var resultText = "";
            var resultImages = [];
            if (typeof block.content === "string") {
              resultText = block.content;
            } else if (Array.isArray(block.content)) {
              resultText = block.content
                .filter(function(c) { return c.type === "text"; })
                .map(function(c) { return c.text; })
                .join("\n");
              for (var ri = 0; ri < block.content.length; ri++) {
                var rc = block.content[ri];
                if (rc.type === "image" && rc.source) {
                  resultImages.push({
                    mediaType: rc.source.media_type,
                    data: rc.source.data,
                  });
                }
              }
            }
            session.sentToolResults[block.tool_use_id] = true;
            var toolResultMsg = {
              type: "tool_result",
              id: block.tool_use_id,
              content: resultText,
              is_error: block.is_error || false,
            };
            if (resultImages.length > 0) toolResultMsg.images = resultImages;
            sendAndRecord(session, toolResultMsg);
          }
        }
      }

    } else if (parsed.yokeType === "result") {
      session.blocks = {};
      session.sentToolResults = {};
      // lr-c56476: Codex parity catch-all -- release EVERY still-live
      // Codex-sourced token for this session now, regardless of whether its
      // own tool_result/thinking_stop already fired. This runs first, before
      // the error_during_execution early return below, so a turn that ends
      // in an SDK execution error still drains Codex's tokens (Codex has no
      // task_notification-equivalent second drain path the way Claude does,
      // so this is the ONLY backstop short of the next startQuery's
      // generation bump -- see this task's PR body for why that generation
      // bump already covers the harder case of abort/interrupt ending the
      // stream before 'result' is ever reached at all).
      if (session.vendor === "codex") releaseAllCodexActivity(session);
      // lr-9d4b: Preserve pendingPermissions entries owned by a backgrounded
      // sub-agent that is still running when the PARENT turn's 'result' arrives.
      // A Task tool launched an async sub-agent whose own Bash/etc permission
      // request is still awaiting the operator's click; that resolver lives in
      // this same session.pendingPermissions map (keyed by requestId) but is
      // unrelated to the parent turn that just ended. Wiping it unconditionally
      // orphans the resolver — the permission card stays on the UI, but the
      // operator's later permission_response finds nothing to resolve and the
      // sub-agent's canUseTool Promise hangs forever (lr-9d4b root cause).
      // Shared with sdk-bridge.js's processQueryStream finally block, which
      // performs the same reset on normal (non-superseded) turn completion —
      // see lib/sdk-permission-ownership.js for the single source of truth.
      // This MUST run before activeTaskToolIds/taskIdMap are reset below, since
      // that is the ownership information this decision depends on. Mirrors the
      // _keepAskUser preservation pattern for pendingAskUser directly below.
      var _perm9d4b = partitionSubagentOwnedPermissions(session);
      // lr-f940 (N3): sweep sm.permissionRequestIndex for every entry this
      // pass is about to drop — see sdk-permission-ownership.js for why this
      // mirrors the same sweep in sdk-bridge.js's processQueryStream finally.
      sweepClearedPermissionIndex(sm, session.pendingPermissions, _perm9d4b.keptPermissions);
      session.pendingPermissions = _perm9d4b.keptPermissions;
      session.pendingElicitations = {};
      // Record ask_user_answered for any leftover pending questions so replay pairs correctly.
      // EXCEPTION: "mcp" mode entries are stateless — the tool returned immediately and the
      // turn is expected to end while the card is still awaiting the user's answer. Those
      // entries must survive across turns so the eventual ask_user_response can inject the
      // answer as the next user message. Only blocking modes (Claude canUseTool) get closed.
      var leftoverAskIds = Object.keys(session.pendingAskUser);
      var keptAskUser = {};
      for (var lai = 0; lai < leftoverAskIds.length; lai++) {
        var lid = leftoverAskIds[lai];
        var lentry = session.pendingAskUser[lid];
        if (lentry && lentry.mode === "mcp") {
          keptAskUser[lid] = lentry;
          continue;
        }
        sendAndRecord(session, { type: "ask_user_answered", toolId: lid });
      }
      session.pendingAskUser = keptAskUser;
      // Only clear activeTaskToolIds/taskIdMap entries for Task ids we did NOT
      // just preserve a permission for above — a still-active backgrounded
      // sub-agent's bookkeeping must survive alongside its pending permission,
      // otherwise a second permission from the same sub-agent (or subagent_done
      // delivery) has nothing to correlate against.
      retainPreservedTaskBookkeeping(session, _perm9d4b.preservedTaskIds);
      // Only clear rateLimitResetsAt on genuine success (non-zero cost).
      // When rate-limited, the SDK sends result with zero cost right after
      // rate_limit_event; clearing here would prevent auto-continue scheduling.
      if (parsed.cost && parsed.cost > 0) {
        session.rateLimitResetsAt = null;
      }
      console.log("[sdk-bridge] result handler: session " + session.localId + " cost=" + parsed.cost + " rateLimitResetsAt=" + session.rateLimitResetsAt);

      // Handle SDK execution errors: show the error to the user instead of
      // silently swallowing it. These have subtype "error_during_execution".
      if (parsed.subtype === "error_during_execution") {
        var execErrors = parsed.errors || [];
        var execError = execErrors.length > 0
          ? execErrors.join("; ")
          : "Unknown SDK error";
        if (parsed.terminalReason) execError += " (reason: " + parsed.terminalReason + ")";
        console.error("[sdk-bridge] Execution error for session " + session.localId + ": " + execError);
        setIsProcessingFromRegistry(session);
        onProcessingChanged();
        sendAndRecord(session, { type: "error", text: "Claude error: " + execError });
        sendAndRecord(session, { type: "done", code: 1 });
        sm.broadcastSessionList();
        return;
      }

      setIsProcessingFromRegistry(session);
      onProcessingChanged();
      // Detect "Not logged in" scenario early for the check below
      var previewTrimmed = (session.responsePreview || "").trim();
      var isZeroCost = !parsed.cost || parsed.cost === 0;
      var isLoginPrompt = isZeroCost && previewTrimmed.length < 100
        && /not logged in/i.test(previewTrimmed) && /\/login/i.test(previewTrimmed);
      // Fetch rich context usage breakdown (fire-and-forget, non-blocking)
      if (session.queryInstance && typeof session.queryInstance.getContextUsage === "function") {
        session.queryInstance.getContextUsage().then(function(ctxUsage) {
          session.lastContextUsage = ctxUsage;
          sendToSession(session, { type: "context_usage", data: ctxUsage });
        }).catch(function(e) {
          console.error("[sdk-bridge] getContextUsage failed (non-fatal):", e.message || e);
        });
      }
      var lastStreamInput = session.lastStreamInputTokens || parsed.lastStreamInputTokens || null;
      session.lastStreamInputTokens = null;
      sendAndRecord(session, {
        type: "result",
        cost: parsed.cost,
        duration: parsed.duration,
        usage: parsed.usage || null,
        modelUsage: parsed.modelUsage || null,
        sessionId: parsed.sessionId,
        lastStreamInputTokens: lastStreamInput,
      });
      if (parsed.fastModeState) {
        sendAndRecord(session, { type: "fast_mode_state", state: parsed.fastModeState });
      }
      // Detect "Not logged in / Please run /login" from SDK.
      // This is a short canned response with zero cost, not actual AI output.
      if (isLoginPrompt) {
        var authUser = session.ownerId ? usersModule.findUserById(session.ownerId) : null;
        var authLinuxUser = authUser && authUser.linuxUser ? authUser.linuxUser : null;
        var canAutoLogin = !!authLinuxUser
          || (authUser && authUser.role === "admin");
        var authTitle = session.vendor === "codex" ? "Codex is not logged in." : "Claude Code is not logged in.";
        var loginCommand = session.vendor === "codex"
          ? "codex login --device-auth"
          : "claude login";
        var _nmLogin = getNotificationsModule();
        var authMsg = {
          type: "auth_required",
          text: authTitle,
          vendor: session.vendor || "claude",
          loginCommand: loginCommand,
          linuxUser: authLinuxUser,
          canAutoLogin: canAutoLogin,
        };
        sendAndRecord(session, authMsg);
        if (_nmLogin) {
          _nmLogin.notify("auth_required", {
            title: authTitle,
            body: "Open a terminal, then click the URL and follow the instructions.",
            slug: slug,
            sessionId: session.localId,
            ownerId: session.ownerId || null,
            vendor: session.vendor || "claude",
            loginCommand: loginCommand,
            linuxUser: authLinuxUser,
            canAutoLogin: canAutoLogin,
          });
        }
        // Reset CLI session so next query starts fresh with new auth
        session.cliSessionId = null;
      }
      sendAndRecord(session, { type: "done", code: 0 });
      var _donePreviewText = (session.responsePreview || "").replace(/\s+/g, " ").trim();
      if (_donePreviewText.length > 140) _donePreviewText = _donePreviewText.substring(0, 140) + "...";
      var _doneTitle = session.title || "Claude";

      if (pushModule) {
        var _donePayload = {
          type: "done",
          slug: slug,
          title: _doneTitle,
          body: _donePreviewText || "Response ready",
          tag: "claude-done",
        };
        // Route to session owner only — body carries response preview text.
        if (session.ownerId && pushModule.sendPushToUser) {
          pushModule.sendPushToUser(session.ownerId, _donePayload);
        } else {
          pushModule.sendPush(_donePayload);
        }
      }

      var _nm = getNotificationsModule();
      if (_nm && !session.loop) {
        _nm.notify("response_done", {
          title: _doneTitle,
          preview: _donePreviewText,
          slug: slug,
          sessionId: session.localId,
          mateId: null,
          ownerId: session.ownerId || null,
        });
      }
      // Reset for next turn in the same query
      session.lastActivityAt = Date.now();
      session.turnCount = (session.turnCount || 0) + 1;
      var donePreview = session.responsePreview || "";
      session.responsePreview = "";
      session.streamedText = false;
      sm.broadcastSessionList();

      // Auto-generate title after N turns (skip if loop or already auto-generated)
      if (session.turnCount === AUTO_TITLE_TURN_THRESHOLD
          && !session.titleAutoGenerated
          && !session.titleManuallySet
          && !session.loop
          && onAutoTitle) {
        try { onAutoTitle(session); } catch (e) {
          console.error("[auto-title] onAutoTitle threw:", e.message || e);
        }
      }

      if (onTurnDone) {
        try { onTurnDone(session, donePreview); } catch (e) {}
      }

    } else if (parsed.yokeType === "status") {
      if (parsed.status === "compacting") {
        sendAndRecord(session, { type: "compacting", active: true });
      } else if (session.compacting) {
        sendAndRecord(session, { type: "compacting", active: false });
        // lr-3af675: compaction just finished (session.compacting true ->
        // this transition). Re-read vendor-reported usage now instead of
        // leaving the context meter pinned at its pre-compact figure until
        // the next turn's 'result' event — the provider has already
        // self-corrected its own usage accounting at this point, we just
        // never asked. Fire-and-forget, same pattern as the 'result' handler.
        if (session.queryInstance && typeof session.queryInstance.getContextUsage === "function") {
          session.queryInstance.getContextUsage().then(function(ctxUsage) {
            session.lastContextUsage = ctxUsage;
            sendToSession(session, { type: "context_usage", data: ctxUsage });
          }).catch(function(e) {
            console.error("[sdk-bridge] post-compaction getContextUsage failed (non-fatal):", e.message || e);
          });
        }
      }
      session.compacting = parsed.status === "compacting";

    } else if (parsed.yokeType === "task_started") {
      var parentId = parsed.parentToolId;
      if (parentId) {
        // lr-f36626: genuine backgrounded-Task lifecycle activity — see the
        // matching comment on processSubagentMessage's bump above and on
        // startIdleReaper in sdk-bridge.js for why this keeps a WAITING
        // parent session non-idle for as long as its child keeps reporting in.
        session.lastActivityAt = Date.now();
        if (!session.taskIdMap) session.taskIdMap = {};
        session.taskIdMap[parentId] = parsed.taskId;
        sendAndRecord(session, {
          type: "task_started",
          parentToolId: parentId,
          taskId: parsed.taskId,
          description: parsed.description || "",
        });
      }

    } else if (parsed.yokeType === "task_progress") {
      var parentId = parsed.parentToolId;
      if (parentId) {
        session.lastActivityAt = Date.now(); // lr-f36626 — see task_started above
        sendAndRecord(session, {
          type: "task_progress",
          parentToolId: parentId,
          taskId: parsed.taskId,
          usage: parsed.usage || null,
          lastToolName: parsed.lastToolName || null,
          description: parsed.description || "",
          summary: parsed.summary || null,
        });
      }

    } else if (parsed.yokeType === "task_updated") {
      // Live task state patches (status, description, error, backgrounded)
      var taskId = parsed.taskId;
      var patch = parsed.patch || {};
      var parentId = null;
      if (session.taskIdMap) {
        for (var k in session.taskIdMap) {
          if (session.taskIdMap[k] === taskId) { parentId = k; break; }
        }
      }
      if (parentId) {
        session.lastActivityAt = Date.now(); // lr-f36626 — see task_started above
        sendAndRecord(session, {
          type: "task_updated",
          parentToolId: parentId,
          taskId: taskId,
          patch: patch,
        });
      }

    } else if (parsed.yokeType === "tool_progress") {
      // Sub-agent tool_progress: forward as activity update
      var parentId = parsed.parentToolId;
      if (parentId) {
        session.lastActivityAt = Date.now(); // lr-f36626 — see task_started above
        sendAndRecord(session, {
          type: "subagent_activity",
          parentToolId: parentId,
          text: parsed.text || "",
        });
      }

    } else if (parsed.yokeType === "task_notification") {
      var parentId = parsed.parentToolId;
      if (parentId) {
        sendAndRecord(session, {
          type: "subagent_done",
          parentToolId: parentId,
          status: parsed.status || "completed",
          summary: parsed.summary || "",
          usage: parsed.usage || null,
        });
        // lr-9bcd7b: release the activity token for this Task, in case the
        // tool_result drain path above never fired for it (e.g. the SDK
        // delivered task_notification without a corresponding tool_result
        // block, or delivered it first). releaseActivity is idempotent —
        // if tool_result already released this same token, this is a no-op.
        if (session.activeTaskToolIds) delete session.activeTaskToolIds[parentId];
        releaseActivity(session, parentId);
      }
      if (session.taskIdMap) {
        for (var k in session.taskIdMap) {
          if (session.taskIdMap[k] === parsed.taskId) {
            delete session.taskIdMap[k];
            break;
          }
        }
      }
      // lr-9d4b: the sub-agent is done — release any tool-ownership records
      // for tool ids it registered, so they don't linger as orphaned entries.
      // EXCEPTION: do not prune a tool id that still has a live
      // pendingPermissions entry pointing at it. task_notification can arrive
      // while the sub-agent's own permission request (e.g. its last Bash
      // call) is still awaiting the operator's click, or a permission can
      // arrive in the brief window right after. Pruning ownership here would
      // make that entry look like an orphaned top-level permission to the
      // 'result' handler / processQueryStream finally block, which would
      // then clear it and re-orphan the resolver — the same hang via a
      // different timing path. Defer cleanup for those tool ids until the
      // permission itself is resolved (project-sessions.js's permission_response
      // handler deletes the pendingPermissions entry; the ownership record is
      // harmless to leave a little longer since it is keyed by tool-use id,
      // not by Task, and simply becomes inert once no pendingPermissions
      // entry references it).
      if (parentId && session.subagentToolOwners) {
        var liveOwnedToolIds = {};
        for (var lpk in (session.pendingPermissions || {})) {
          var lpEntry = session.pendingPermissions[lpk];
          if (lpEntry && lpEntry.toolUseId) liveOwnedToolIds[lpEntry.toolUseId] = true;
        }
        for (var stk in session.subagentToolOwners) {
          if (session.subagentToolOwners[stk] === parentId && !liveOwnedToolIds[stk]) {
            delete session.subagentToolOwners[stk];
          }
        }
      }

    } else if (parsed.yokeType === "rate_limit") {
      var info = parsed.rateLimitInfo;
      console.log("[sdk-bridge] rate_limit_event for session " + session.localId + ": status=" + info.status + " resetsAt=" + info.resetsAt + " isUsingOverage=" + info.isUsingOverage + " isProcessing=" + session.isProcessing);

      // Broadcast reset time for top-bar usage link. This is a project-wide
      // broadcast (not sendAndRecord), but still stamp localId so a client
      // with multiple sessions open across tabs can tell which session's
      // query actually triggered this usage update.
      if (info.rateLimitType && info.resetsAt) {
        send({
          type: "rate_limit_usage",
          rateLimitType: info.rateLimitType,
          resetsAt: info.resetsAt * 1000,
          status: info.status,
          localId: session.localId,
        });
      }

      // Warning/rejection handling (existing behavior)
      if (info.status === "allowed_warning" || info.status === "rejected") {
        sendAndRecord(session, {
          type: "rate_limit",
          status: info.status,
          resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
          rateLimitType: info.rateLimitType || null,
          utilization: info.utilization || null,
          isUsingOverage: info.isUsingOverage || false,
          blocksCurrentModel: bucketBlocksModel(info.rateLimitType, sm && sm.currentModel),
          localId: session.localId,
        });
        // Track rejection for auto-continue / scheduled message support
        if (info.status === "rejected" && info.resetsAt) {
          session.rateLimitResetsAt = info.resetsAt * 1000;

          // Schedule auto-continue immediately on rejection (don't wait for
          // query completion which has timing issues with worker/non-worker paths).
          if (!session.scheduledMessage && !session.destroying) {
            var acEnabled = session.onQueryComplete ||
              (typeof opts.getAutoContinueSetting === "function" && opts.getAutoContinueSetting(session));
            console.log("[sdk-bridge] rate_limit rejected: acEnabled=" + acEnabled + " overage=" + !!info.isUsingOverage + " session=" + session.localId);
            if (acEnabled) {
              session.rateLimitAutoContinuePending = true;
              if (info.isUsingOverage) {
                // Extra usage available: send continue immediately (5s delay for query to finish)
                console.log("[sdk-bridge] Overage available, sending immediate continue for session " + session.localId);
                session.rateLimitResetsAt = null;
                if (typeof opts.scheduleMessage === "function") {
                  opts.scheduleMessage(session, "continue", Date.now());
                }
              } else {
                // No overage: schedule after rate limit resets
                var acResetsAt = session.rateLimitResetsAt;
                session.rateLimitResetsAt = null;
                console.log("[sdk-bridge] Scheduling auto-continue on rate limit rejection for session " + session.localId);
                if (typeof opts.scheduleMessage === "function") {
                  opts.scheduleMessage(session, "continue", acResetsAt);
                }
              }
            }
          }
        }
      }

    } else if (parsed.yokeType === "prompt_suggestion") {
      sendAndRecord(session, {
        type: "prompt_suggestion",
        suggestion: parsed.suggestion || "",
      });

    } else if (parsed.yokeType === "notification") {
      var notifText = parsed.text || "";
      var notifPriority = parsed.priority || "low";
      if (notifText) {
        sendAndRecord(session, {
          type: "sdk_notification",
          key: parsed.key || "",
          text: notifText,
          priority: notifPriority,
          color: parsed.color || null,
          timeoutMs: parsed.timeout_ms || null,
        });
      }

    } else if (parsed.yokeType === "api_retry") {
      // Transient retry notification, show in UI but don't persist in history
      var retryText = parsed.message || parsed.error || "Retrying API request...";
      sendToSession(session, { type: "system_info", text: retryText });

    } else if (parsed.yokeType === "diagnostic") {
      // Diagnostic events captured from CLI stderr (stage 3/5, lr-0868, epic lr-1a52).
      // These are NOT errors — they are informational/warning signals from the CLI
      // (e.g. unknown hook events, settings warnings, deprecation notices).
      // Stage 4/5 (lr-8294) renders this message as a toast + Diagnostics panel entry.
      sendAndRecord(session, {
        type: "diagnostic",
        severity: parsed.severity,
        source: parsed.source,
        message: parsed.message,
      });

    } else if (parsed.yokeType === "system") {
      // Catch-all for unhandled system subtypes (e.g. hook-block errors).
      // Extract any error text and surface it in the UI.
      var sysText = parsed.error || parsed.message || parsed.text || "";
      if (!sysText && Array.isArray(parsed.content)) {
        sysText = parsed.content
          .filter(function(c) { return c.type === "text"; })
          .map(function(c) { return c.text; })
          .join("\n");
      }
      if (sysText) {
        console.log("[sdk-bridge] Unhandled system message (subtype=" + (parsed.subtype || "none") + "): " + sysText.substring(0, 200));
        sendAndRecord(session, { type: "error", text: sysText });
      }
    }
  }

  return {
    processSDKMessage: processSDKMessage,
    sendAndRecord: sendAndRecord,
    sendToSession: sendToSession,
    processSubagentMessage: processSubagentMessage,
    toolActivityTextForSubagent: toolActivityTextForSubagent,
  };
}

module.exports = { attachMessageProcessor: attachMessageProcessor };
