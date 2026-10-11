var fs = require("fs");
var path = require("path");

// Most directory watches one connection may hold; each is an inotify handle.
var MAX_DIR_WATCHES_PER_CONNECTION = 64;

/**
 * Attach the file/directory watcher engine to a project context.
 *
 * Watches belong to the connection that asked for them. Every change is read
 * as that connection's user (an OS user in os-users mode) and is sent to that
 * connection only, so a watch can neither read a file the user may not read
 * nor show its contents to anyone else on the project.
 *
 * ctx fields:
 *   cwd, sendTo(ws, msg), safePath(base, requested)
 *   authorize(ws)        -> error string | null  (file-browser policy)
 *   readFile(ws, absFile) -> { kind: "text"|"binary"|"too_large", content, size }
 *   listDir(ws, absDir)   -> [{ name, isDir }]
 *   IGNORED_DIRS
 */
function attachFileWatch(ctx) {
  var cwd = ctx.cwd;
  var sendTo = ctx.sendTo;
  var safePath = ctx.safePath;
  var authorize = ctx.authorize;
  var readFile = ctx.readFile;
  var listDir = ctx.listDir;
  var IGNORED_DIRS = ctx.IGNORED_DIRS;

  // --- Single-file watch: at most one per connection ---
  var fileWatches = new Map(); // ws -> { relPath, watcher, debounce }

  function startFileWatch(ws, relPath) {
    if (authorize(ws)) return;
    var absPath = safePath(cwd, relPath);
    if (!absPath) return;
    var existing = fileWatches.get(ws);
    if (existing && existing.relPath === relPath) return;
    stopFileWatch(ws);
    var entry = { relPath: relPath, watcher: null, debounce: null };
    try {
      entry.watcher = fs.watch(absPath, function () {
        clearTimeout(entry.debounce);
        entry.debounce = setTimeout(function () {
          try {
            if (authorize(ws)) { stopFileWatch(ws); return; }
            var result = readFile(ws, absPath);
            if (result.kind !== "text") return;
            sendTo(ws, { type: "fs_file_changed", path: relPath, content: result.content, size: result.size });
          } catch (e) {
            stopFileWatch(ws);
          }
        }, 200);
      });
      entry.watcher.on("error", function () { stopFileWatch(ws); });
      fileWatches.set(ws, entry);
    } catch (e) {
      // The file vanished or cannot be watched; the client simply gets no events.
    }
  }

  function stopFileWatch(ws) {
    var entry = fileWatches.get(ws);
    if (!entry) return;
    clearTimeout(entry.debounce);
    try { entry.watcher.close(); } catch (e) {}
    fileWatches.delete(ws);
  }

  // --- Directory watches: any number per connection, up to the cap ---
  var dirWatches = new Map(); // ws -> Map(relPath -> { watcher, debounce })

  function startDirWatch(ws, relPath) {
    if (authorize(ws)) return;
    var mine = dirWatches.get(ws);
    if (mine && mine.has(relPath)) return;
    if (mine && mine.size >= MAX_DIR_WATCHES_PER_CONNECTION) return;
    var absPath = safePath(cwd, relPath);
    if (!absPath) return;
    var entry = { watcher: null, debounce: null };
    try {
      entry.watcher = fs.watch(absPath, function () {
        clearTimeout(entry.debounce);
        entry.debounce = setTimeout(function () {
          try {
            if (authorize(ws)) { stopDirWatch(ws, relPath); return; }
            var entries = [];
            var items = listDir(ws, absPath);
            for (var i = 0; i < items.length; i++) {
              if (items[i].isDir && IGNORED_DIRS.has(items[i].name)) continue;
              entries.push({
                name: items[i].name,
                type: items[i].isDir ? "dir" : "file",
                path: path.relative(cwd, path.join(absPath, items[i].name)).split(path.sep).join("/"),
              });
            }
            sendTo(ws, { type: "fs_dir_changed", path: relPath, entries: entries });
          } catch (e) {
            stopDirWatch(ws, relPath);
          }
        }, 300);
      });
      entry.watcher.on("error", function () { stopDirWatch(ws, relPath); });
      if (!mine) { mine = new Map(); dirWatches.set(ws, mine); }
      mine.set(relPath, entry);
    } catch (e) {
      // Not watchable; listing still works, it just will not refresh itself.
    }
  }

  function stopDirWatch(ws, relPath) {
    var mine = dirWatches.get(ws);
    var entry = mine && mine.get(relPath);
    if (!entry) return;
    clearTimeout(entry.debounce);
    try { entry.watcher.close(); } catch (e) {}
    mine.delete(relPath);
    if (mine.size === 0) dirWatches.delete(ws);
  }

  // Every directory watch one connection holds; with stopFileWatch(ws) this
  // releases everything the connection owns when it disconnects.
  function stopAllDirWatches(ws) {
    var mine = dirWatches.get(ws);
    if (!mine) return;
    Array.from(mine.keys()).forEach(function (relPath) { stopDirWatch(ws, relPath); });
  }

  function stopAll() {
    Array.from(fileWatches.keys()).forEach(stopFileWatch);
    Array.from(dirWatches.keys()).forEach(stopAllDirWatches);
  }

  return {
    startFileWatch: startFileWatch,
    stopFileWatch: stopFileWatch,
    startDirWatch: startDirWatch,
    stopDirWatch: stopDirWatch,
    stopAllDirWatches: stopAllDirWatches,
    stopAll: stopAll,
  };
}

module.exports = { attachFileWatch: attachFileWatch };
