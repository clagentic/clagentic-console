var fs = require("fs");
var path = require("path");
var fileScope = require("./project-file-scope");
var projectGit = require("./project-git");

// Settings that act on the whole machine (not on this project), so the
// per-user projectSettings permission is not enough: administrators only.
var ADMIN_ONLY_TYPES = {
  read_global_claude_md: true,
  write_global_claude_md: true,
  get_shared_env: true,
  set_shared_env: true,
};

/**
 * Attach filesystem-related message handlers to a project context.
 *
 * ctx fields:
 *   cwd, slug, osUsers
 *   sm (session manager)
 *   send, sendTo
 *   getOsUserInfoForWs (function)
 *   startFileWatch, stopFileWatch, startDirWatch (from _fileWatch; take the ws first)
 *   usersModule, projectAccess (lib/project-access.js resolver), fsAsUser
 *   validateEnvString (function)
 *   opts (for onGetProjectEnv, onSetProjectEnv, onGetSharedEnv, onSetSharedEnv callbacks)
 *   fileAccess           from project-file-scope.createFileAccess
 *   IGNORED_DIRS, IMAGE_EXTS (constants)
 *
 * The slug every handler acts on is ctx.slug: the per-message gate in
 * project.js has already authorized it. A slug carried in a message is never
 * used.
 */
function attachFilesystem(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var osUsers = ctx.osUsers;
  var sm = ctx.sm;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var getOsUserInfoForWs = ctx.getOsUserInfoForWs;
  var startFileWatch = ctx.startFileWatch;
  var stopFileWatch = ctx.stopFileWatch;
  var startDirWatch = ctx.startDirWatch;
  var usersModule = ctx.usersModule;
  var projectAccess = ctx.projectAccess;
  var fsAsUser = ctx.fsAsUser;
  var validateEnvString = ctx.validateEnvString;
  var opts = ctx.opts;
  var IGNORED_DIRS = ctx.IGNORED_DIRS;
  var IMAGE_EXTS = ctx.IMAGE_EXTS;
  var fileAccess = ctx.fileAccess;

  // The file policy applies to every fs_* message except fs_unwatch, which
  // only releases what the connection already holds.
  function isFileMessage(type) {
    return typeof type === "string" && type.indexOf("fs_") === 0 && type !== "fs_unwatch";
  }

  // Run read-only git inside the project as the repository's owner (see
  // project-git.js); the connection was authorized before this handler ran.
  function gitFor(args) {
    return projectGit.runGit(args, { cwd: cwd, osUsers: osUsers });
  }

  function handleFilesystemMessage(ws, msg) {
    // --- Settings that act beyond this project: administrators only ---
    if (typeof msg.type === "string" && ADMIN_ONLY_TYPES[msg.type] === true) {
      if (!projectAccess.isAdmin(ws._clagenticUser, projectAccess.authOf(ws))) {
        sendTo(ws, { type: "error", text: "Admin access required" });
        return true;
      }
    }

    // --- File policy gate (fileBrowser permission, OS identity) ---
    if (isFileMessage(msg.type)) {
      var fileError = fileAccess.authorize(ws);
      if (fileError) {
        sendTo(ws, { type: msg.type + "_result", path: msg.path, error: fileError });
        return true;
      }
    }

    // --- fs_list ---
    if (msg.type === "fs_list") {
      var fsListUserInfo = getOsUserInfoForWs(ws);
      var fsDir = fileScope.resolveReadPath(cwd, msg.path || ".", fsListUserInfo);
      if (!fsDir) {
        sendTo(ws, { type: "fs_list_result", path: msg.path, entries: [], error: "Access denied" });
        return true;
      }
      try {
        var entries = [];
        var items = fileAccess.listDir(ws, fsDir);
        for (var fi = 0; fi < items.length; fi++) {
          var item = items[fi];
          if (item.isDir && IGNORED_DIRS.has(item.name)) continue;
          entries.push({
            name: item.name,
            type: item.isDir ? "dir" : "file",
            path: path.relative(cwd, path.join(fsDir, item.name)).split(path.sep).join("/"),
          });
        }
        sendTo(ws, { type: "fs_list_result", path: msg.path || ".", entries: entries });
        // Auto-watch the directory for changes
        startDirWatch(ws, msg.path || ".");
      } catch (e) {
        sendTo(ws, { type: "fs_list_result", path: msg.path, entries: [], error: e.message });
      }
      return true;
    }

    // --- fs_search ---
    if (msg.type === "fs_search") {
      var query = (typeof msg.query === "string" ? msg.query : "").trim().toLowerCase();
      if (!query) {
        sendTo(ws, { type: "fs_search_result", query: msg.query, entries: [] });
        return true;
      }
      try {
        var searchResults = [];
        var MAX_RESULTS = 50;

        function walkDir(dir, relPrefix) {
          if (searchResults.length >= MAX_RESULTS) return;
          var items;
          try {
            items = fileAccess.listDir(ws, dir);
          } catch (e) { return; }
          for (var i = 0; i < items.length; i++) {
            if (searchResults.length >= MAX_RESULTS) return;
            var it = items[i];
            if (it.isDir && IGNORED_DIRS.has(it.name)) continue;
            var rel = relPrefix ? relPrefix + "/" + it.name : it.name;
            if (it.name.toLowerCase().indexOf(query) !== -1) {
              searchResults.push({ name: it.name, type: it.isDir ? "dir" : "file", path: rel });
            }
            if (it.isDir) {
              walkDir(path.join(dir, it.name), rel);
            }
          }
        }

        walkDir(cwd, "");
        sendTo(ws, { type: "fs_search_result", query: msg.query, entries: searchResults });
      } catch (e) {
        sendTo(ws, { type: "fs_search_result", query: msg.query, entries: [], error: e.message });
      }
      return true;
    }

    // --- fs_read ---
    if (msg.type === "fs_read") {
      var fsReadUserInfo = getOsUserInfoForWs(ws);
      var fsFile = fileScope.resolveReadPath(cwd, msg.path, fsReadUserInfo);
      if (!fsFile) {
        sendTo(ws, { type: "fs_read_result", path: msg.path, error: "Access denied" });
        return true;
      }
      try {
        var readResult = fileAccess.readFile(ws, fsFile);
        if (readResult.kind === "too_large") {
          sendTo(ws, { type: "fs_read_result", path: msg.path, binary: true, size: readResult.size, error: "File too large (" + (readResult.size / 1024 / 1024).toFixed(1) + " MB)" });
        } else if (readResult.kind === "binary") {
          var result = { type: "fs_read_result", path: msg.path, binary: true, size: readResult.size };
          if (IMAGE_EXTS.has(readResult.ext)) result.imageUrl = "api/file?path=" + encodeURIComponent(msg.path);
          sendTo(ws, result);
        } else {
          sendTo(ws, { type: "fs_read_result", path: msg.path, content: readResult.content, size: readResult.size });
        }
      } catch (e) {
        sendTo(ws, { type: "fs_read_result", path: msg.path, error: e.message });
      }
      return true;
    }

    // --- fs_write ---
    if (msg.type === "fs_write") {
      var fsWriteFile = fileScope.resolveProjectPath(cwd, msg.path, getOsUserInfoForWs(ws));
      if (!fsWriteFile) {
        sendTo(ws, { type: "fs_write_result", path: msg.path, ok: false, error: "Access denied" });
        return true;
      }
      try {
        var fsWriteUserInfo = getOsUserInfoForWs(ws);
        if (fsWriteUserInfo) {
          fsAsUser("write", { file: fsWriteFile, content: msg.content || "" }, fsWriteUserInfo);
        } else {
          fs.writeFileSync(fsWriteFile, msg.content || "", "utf8");
        }
        sendTo(ws, { type: "fs_write_result", path: msg.path, ok: true });
      } catch (e) {
        sendTo(ws, { type: "fs_write_result", path: msg.path, ok: false, error: e.message });
      }
      return true;
    }

    // --- Project settings permission gate ---
    if (msg.type === "get_project_env" || msg.type === "set_project_env" ||
        msg.type === "transfer_project_owner") {
      if (ws._clagenticUser) {
        var psPerms = usersModule.getEffectivePermissions(ws._clagenticUser, osUsers);
        if (!psPerms.projectSettings) {
          sendTo(ws, { type: "error", text: "Project settings access is not permitted" });
          return true;
        }
      }
    }

    // --- Project environment variables ---
    if (msg.type === "get_project_env") {
      var envrc = "";
      var hasEnvrc = false;
      if (typeof opts.onGetProjectEnv === "function") {
        var envResult = opts.onGetProjectEnv(slug);
        envrc = envResult.envrc || "";
      }
      try {
        var envrcPath = path.join(cwd, ".envrc");
        hasEnvrc = fs.existsSync(envrcPath);
      } catch (e) {}
      sendTo(ws, { type: "project_env_result", slug: slug, envrc: envrc, hasEnvrc: hasEnvrc });
      return true;
    }

    if (msg.type === "set_project_env") {
      if (typeof opts.onSetProjectEnv === "function") {
        if (msg.envrc != null && typeof msg.envrc !== "string") {
          sendTo(ws, { type: "set_project_env_result", ok: false, slug: slug, error: "Invalid value" });
          return true;
        }
        var envText = msg.envrc || "";
        var envError = validateEnvString(envText);
        if (envError) {
          sendTo(ws, { type: "set_project_env_result", ok: false, slug: slug, error: envError });
          return true;
        }
        var setResult = opts.onSetProjectEnv(slug, envText);
        sendTo(ws, { type: "set_project_env_result", ok: setResult.ok, slug: slug, error: setResult.error });
      } else {
        sendTo(ws, { type: "set_project_env_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Global CLAUDE.md ---
    if (msg.type === "read_global_claude_md") {
      var globalMdPath = path.join(require("./config").REAL_HOME, ".claude", "CLAUDE.md");
      try {
        var globalMdContent = fs.readFileSync(globalMdPath, "utf8");
        sendTo(ws, { type: "global_claude_md_result", content: globalMdContent });
      } catch (e) {
        sendTo(ws, { type: "global_claude_md_result", error: e.message });
      }
      return true;
    }

    if (msg.type === "write_global_claude_md") {
      var globalMdDir = path.join(require("./config").REAL_HOME, ".claude");
      var globalMdWritePath = path.join(globalMdDir, "CLAUDE.md");
      try {
        if (!fs.existsSync(globalMdDir)) {
          fs.mkdirSync(globalMdDir, { recursive: true });
        }
        fs.writeFileSync(globalMdWritePath, msg.content || "", "utf8");
        sendTo(ws, { type: "write_global_claude_md_result", ok: true });
      } catch (e) {
        sendTo(ws, { type: "write_global_claude_md_result", ok: false, error: e.message });
      }
      return true;
    }

    // --- Shared environment variables ---
    if (msg.type === "get_shared_env") {
      var sharedEnvrc = "";
      if (typeof opts.onGetSharedEnv === "function") {
        var sharedResult = opts.onGetSharedEnv();
        sharedEnvrc = sharedResult.envrc || "";
      }
      sendTo(ws, { type: "shared_env_result", envrc: sharedEnvrc });
      return true;
    }

    if (msg.type === "set_shared_env") {
      if (typeof opts.onSetSharedEnv === "function") {
        if (msg.envrc != null && typeof msg.envrc !== "string") {
          sendTo(ws, { type: "set_shared_env_result", ok: false, error: "Invalid value" });
          return true;
        }
        var sharedEnvError = validateEnvString(msg.envrc || "");
        if (sharedEnvError) {
          sendTo(ws, { type: "set_shared_env_result", ok: false, error: sharedEnvError });
          return true;
        }
        var sharedSetResult = opts.onSetSharedEnv(msg.envrc || "");
        sendTo(ws, { type: "set_shared_env_result", ok: sharedSetResult.ok, error: sharedSetResult.error });
      } else {
        sendTo(ws, { type: "set_shared_env_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- File watcher ---
    if (msg.type === "fs_watch") {
      if (msg.path) startFileWatch(ws, msg.path);
      return true;
    }

    if (msg.type === "fs_unwatch") {
      stopFileWatch(ws);
      return true;
    }

    // --- File edit history ---
    if (msg.type === "fs_file_history") {
      var histPath = msg.path;
      if (!histPath) {
        sendTo(ws, { type: "fs_file_history_result", path: histPath, entries: [] });
        return true;
      }
      var histRelPath = fileScope.resolveGitPath(cwd, histPath);
      if (!histRelPath) {
        sendTo(ws, { type: "fs_file_history_result", path: histPath, entries: [], error: "Access denied" });
        return true;
      }
      var absHistPath = path.resolve(cwd, histRelPath);
      var entries = [];

      // Collect session edits.
      // lr-2ea2a7: reads full history via a streaming disk scan
      // (sm.readSessionHistoryFromDisk) instead of session.history — the
      // heap array is now a bounded tail window and would silently miss
      // edits older than the trim point for a long-running session. The
      // disk read does not call loadSessionHistory() and does not mutate
      // session.history/_historyLoaded/LRU state.
      sm.sessions.forEach(function (session) {
        // Edits made in a session the caller cannot read stay unseen.
        if (!projectAccess.canReadSession(ws._clagenticUser, session, projectAccess.authOf(ws))) return;
        var sessionLocalId = session.localId;
        var sessionTitle = session.title || "Untitled";
        var history = sm.readSessionHistoryFromDisk(session);
        var histLen = history.length || 1;

        for (var hi = 0; hi < history.length; hi++) {
          var entry = history[hi];
          if (entry.type !== "tool_executing") continue;
          if (entry.name !== "Edit" && entry.name !== "Write") continue;
          if (!entry.input || !entry.input.file_path) continue;
          if (entry.input.file_path !== absHistPath) continue;

          // Find parent assistant UUID + message snippet by scanning backwards
          var assistantUuid = null;
          var uuidIndex = -1;
          for (var hj = hi - 1; hj >= 0; hj--) {
            if (history[hj].type === "message_uuid" && history[hj].messageType === "assistant") {
              assistantUuid = history[hj].uuid;
              uuidIndex = hj;
              break;
            }
          }

          // Find user prompt by scanning backwards from the assistant uuid
          var messageSnippet = "";
          var searchFrom = uuidIndex >= 0 ? uuidIndex : hi;
          for (var hk = searchFrom - 1; hk >= 0; hk--) {
            if (history[hk].type === "user_message" && history[hk].text) {
              messageSnippet = history[hk].text.trim().substring(0, 100);
              break;
            }
          }

          // Collect Claude's explanation: scan backwards from tool_executing
          // to find the nearest delta text block (skipping tool_start).
          // If no delta found immediately before this tool, scan past
          // intervening tool blocks to find the last delta text within
          // the same assistant turn.
          var assistantSnippet = "";
          var deltaChunks = [];
          for (var hd = hi - 1; hd >= 0; hd--) {
            var hEntry = history[hd];
            if (hEntry.type === "tool_start") continue;
            if (hEntry.type === "delta" && hEntry.text) {
              deltaChunks.unshift(hEntry.text);
            } else {
              break;
            }
          }
          if (deltaChunks.length === 0) {
            // No delta immediately before; scan past tool blocks
            // to find the nearest preceding delta in the same turn
            for (var hd2 = hi - 1; hd2 >= 0; hd2--) {
              var hEntry2 = history[hd2];
              if (hEntry2.type === "tool_start" || hEntry2.type === "tool_executing" || hEntry2.type === "tool_result") continue;
              if (hEntry2.type === "delta" && hEntry2.text) {
                // Found a delta before an earlier tool in the same turn.
                // Collect this contiguous block of deltas.
                for (var hd3 = hd2; hd3 >= 0; hd3--) {
                  var hEntry3 = history[hd3];
                  if (hEntry3.type === "tool_start") continue;
                  if (hEntry3.type === "delta" && hEntry3.text) {
                    deltaChunks.unshift(hEntry3.text);
                  } else {
                    break;
                  }
                }
                break;
              } else {
                // Hit message_uuid, user_message, etc. Stop.
                break;
              }
            }
          }
          assistantSnippet = deltaChunks.join("").trim().substring(0, 150);

          // Approximate timestamp: interpolate between session creation and last activity
          var tStart = session.createdAt || 0;
          var tEnd = session.lastActivity || tStart;
          var ts = tStart + Math.floor((hi / histLen) * (tEnd - tStart));

          var editRecord = {
            source: "session",
            timestamp: ts,
            sessionLocalId: sessionLocalId,
            sessionTitle: sessionTitle,
            assistantUuid: assistantUuid,
            toolId: entry.id,
            messageSnippet: messageSnippet,
            assistantSnippet: assistantSnippet,
            toolName: entry.name,
          };

          if (entry.name === "Edit") {
            editRecord.old_string = entry.input.old_string || "";
            editRecord.new_string = entry.input.new_string || "";
          } else {
            editRecord.isFullWrite = true;
          }

          entries.push(editRecord);
        }
      });

      // Collect git commits
      try {
        var gitLog = gitFor(["log", "--format=%H|%at|%an|%s", "--follow", "--", histRelPath]);
        var gitLines = gitLog.trim().split("\n");
        for (var gi = 0; gi < gitLines.length; gi++) {
          if (!gitLines[gi]) continue;
          var parts = gitLines[gi].split("|");
          if (parts.length < 4) continue;
          entries.push({
            source: "git",
            hash: parts[0],
            timestamp: parseInt(parts[1], 10) * 1000,
            author: parts[2],
            message: parts.slice(3).join("|"),
          });
        }
      } catch (e) {
        // Not a git repo or file not tracked, that is fine
      }

      // Sort by timestamp descending (newest first)
      entries.sort(function (a, b) { return b.timestamp - a.timestamp; });

      sendTo(ws, { type: "fs_file_history_result", path: histPath, entries: entries });
      return true;
    }

    // --- Git diff for file history ---
    if (msg.type === "fs_git_diff") {
      var diffPath = msg.path;
      var hash = msg.hash;
      var hash2 = msg.hash2 || null;
      if (!diffPath || !hash) {
        sendTo(ws, { type: "fs_git_diff_result", hash: hash, path: diffPath, diff: "", error: "Missing params" });
        return true;
      }
      // A revision is an object name, never anything git could read as an option.
      var diffRelPath = fileScope.resolveGitPath(cwd, diffPath);
      if (!projectGit.isCommitHash(hash) || (hash2 && !projectGit.isCommitHash(hash2)) || !diffRelPath) {
        sendTo(ws, { type: "fs_git_diff_result", hash: hash, hash2: hash2, path: diffPath, diff: "", error: "Invalid params" });
        return true;
      }
      try {
        var diff;
        if (hash2) {
          diff = gitFor(["diff", hash, hash2, "--", diffRelPath]);
        } else {
          diff = gitFor(["show", hash, "--format=", "--", diffRelPath]);
        }
        sendTo(ws, { type: "fs_git_diff_result", hash: hash, hash2: hash2, path: diffPath, diff: diff || "" });
      } catch (e) {
        sendTo(ws, { type: "fs_git_diff_result", hash: hash, hash2: hash2, path: diffPath, diff: "", error: e.message });
      }
      return true;
    }

    // --- File content at a git commit ---
    if (msg.type === "fs_file_at") {
      var atPath = msg.path;
      var atHash = msg.hash;
      if (!atPath || !atHash) {
        sendTo(ws, { type: "fs_file_at_result", hash: atHash, path: atPath, content: "", error: "Missing params" });
        return true;
      }
      // git show wants hash:repo-relative-path
      var atRelPath = fileScope.resolveGitPath(cwd, atPath);
      if (!projectGit.isCommitHash(atHash) || !atRelPath) {
        sendTo(ws, { type: "fs_file_at_result", hash: atHash, path: atPath, content: "", error: "Invalid params" });
        return true;
      }
      try {
        var content = gitFor(["show", atHash + ":" + atRelPath]);
        sendTo(ws, { type: "fs_file_at_result", hash: atHash, path: atPath, content: content });
      } catch (e) {
        sendTo(ws, { type: "fs_file_at_result", hash: atHash, path: atPath, content: "", error: e.message });
      }
      return true;
    }

    return false;
  }

  return {
    handleFilesystemMessage: handleFilesystemMessage,
  };
}

module.exports = { attachFilesystem: attachFilesystem };
