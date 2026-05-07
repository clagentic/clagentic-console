/**
 * Memory engine stub — memory was a Clay Mates feature.
 * Mates have been removed (lr-316f). This stub satisfies the
 * project.js interface so existing call sites compile cleanly.
 *
 * handleMemoryList / handleMemorySearch / handleMemoryDelete are
 * kept as no-ops; the WS message types (memory_list etc.) still
 * exist in ws-schema.js and project.js routes them here.
 */
function attachMemory(ctx) {
  var sendTo = ctx.sendTo;

  function gateMemory() {}
  function updateMemorySummary() {}
  function initMemorySummary() {}

  function handleMemoryList(ws) {
    sendTo(ws, { type: "memory_list", digests: [] });
  }

  function handleMemorySearch(ws) {
    sendTo(ws, { type: "memory_search_results", results: [] });
  }

  function handleMemoryDelete(ws) {
    sendTo(ws, { type: "memory_deleted" });
  }

  return {
    gateMemory: gateMemory,
    updateMemorySummary: updateMemorySummary,
    initMemorySummary: initMemorySummary,
    handleMemoryList: handleMemoryList,
    handleMemorySearch: handleMemorySearch,
    handleMemoryDelete: handleMemoryDelete,
  };
}

module.exports = { attachMemory };
