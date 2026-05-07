var fs = require("fs");
var path = require("path");

/**
 * Attach knowledge file management to a project context.
 * ctx fields: cwd, sendTo
 *
 * Note: knowledge promote/depromote were mate-only features (lr-316f).
 * Those message types are kept as no-ops for safe handling.
 */
function attachKnowledge(ctx) {
  var cwd = ctx.cwd;
  var sendTo = ctx.sendTo;

  function listKnowledgeFiles() {
    var knowledgeDir = path.join(cwd, "knowledge");
    var files = [];
    try {
      var entries = fs.readdirSync(knowledgeDir);
      for (var ki = 0; ki < entries.length; ki++) {
        if (entries[ki] === "session-digests.jsonl") continue;
        if (entries[ki] === "sticky-notes.md") continue;
        if (entries[ki] === "memory-summary.md") continue;
        if (entries[ki].endsWith(".md") || entries[ki].endsWith(".jsonl")) {
          var stat = fs.statSync(path.join(knowledgeDir, entries[ki]));
          files.push({ name: entries[ki], size: stat.size, mtime: stat.mtimeMs, common: false });
        }
      }
    } catch (e) { /* dir may not exist */ }
    files.sort(function (a, b) { return b.mtime - a.mtime; });
    return files;
  }

  function handleKnowledgeMessage(ws, msg) {
    if (msg.type === "knowledge_list") {
      sendTo(ws, { type: "knowledge_list", files: listKnowledgeFiles() });
      return true;
    }

    if (msg.type === "knowledge_read") {
      if (!msg.name) return true;
      var safeName = path.basename(msg.name);
      var filePath = path.join(cwd, "knowledge", safeName);
      try {
        var content = fs.readFileSync(filePath, "utf8");
        sendTo(ws, { type: "knowledge_content", name: safeName, content: content });
      } catch (e) {
        sendTo(ws, { type: "knowledge_content", name: safeName, content: "", error: "File not found" });
      }
      return true;
    }

    if (msg.type === "knowledge_save") {
      if (!msg.name || typeof msg.content !== "string") return true;
      var safeName = path.basename(msg.name);
      if (!safeName.endsWith(".md") && !safeName.endsWith(".jsonl")) safeName += ".md";
      var knowledgeDir = path.join(cwd, "knowledge");
      fs.mkdirSync(knowledgeDir, { recursive: true });
      fs.writeFileSync(path.join(knowledgeDir, safeName), msg.content);
      sendTo(ws, { type: "knowledge_saved", name: safeName });
      sendTo(ws, { type: "knowledge_list", files: listKnowledgeFiles() });
      return true;
    }

    if (msg.type === "knowledge_delete") {
      if (!msg.name) return true;
      var safeName = path.basename(msg.name);
      var filePath = path.join(cwd, "knowledge", safeName);
      try { fs.unlinkSync(filePath); } catch (e) {}
      sendTo(ws, { type: "knowledge_deleted", name: safeName });
      sendTo(ws, { type: "knowledge_list", files: listKnowledgeFiles() });
      return true;
    }

    // knowledge_promote / knowledge_depromote were mate-only — no-op
    if (msg.type === "knowledge_promote" || msg.type === "knowledge_depromote") {
      return true;
    }

    return false;
  }

  return {
    handleKnowledgeMessage: handleKnowledgeMessage,
  };
}

module.exports = { attachKnowledge };
