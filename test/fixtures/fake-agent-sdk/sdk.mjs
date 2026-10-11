// A stand-in for @anthropic-ai/claude-agent-sdk, loaded by a real
// claude-worker.js process in test/claude-worker-process.test.js (see
// register.mjs). Its Query has the control surface the real 0.3.x Query has
// and none it lacks: applyFlagSettings and setPermissionMode, and no
// setEffort. Every control call is reported back as a fake_probe event on the
// query's stream, which the worker forwards to the test over its socket.
//
// A user message whose text is "ask" makes the query ask its canUseTool
// callback for permission, carrying the presentation hints an SDK ask can
// carry, and report the answer it got.

export function query({ prompt, options }) {
  const events = [];
  let wake = null;
  function emit(event) {
    events.push(event);
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  }

  (async function readPrompt() {
    for await (const message of prompt) {
      const parts = message && message.message && message.message.content;
      const text = Array.isArray(parts) && parts[0] ? parts[0].text : "";
      if (text !== "ask") continue;
      const abort = new AbortController();
      const result = await options.canUseTool("Bash", { command: "make" }, {
        toolUseID: "tu-fake",
        decisionReason: "a rule asks",
        signal: abort.signal,
        suppressAlwaysAllowRule: true,
        defaultToNo: true,
        matchedAskRule: { source: "projectSettings", toolName: "Bash", ruleContent: "make:*" },
      });
      emit({ type: "fake_probe", call: "canUseTool", result });
    }
  })();

  emit({ type: "system", subtype: "init" });

  return {
    async applyFlagSettings(settings) {
      emit({ type: "fake_probe", call: "applyFlagSettings", args: settings });
      if (settings.effortLevel === "max") throw new Error("organization effort limit");
    },
    async setPermissionMode(mode) {
      emit({ type: "fake_probe", call: "setPermissionMode", args: mode });
    },
    async getContextUsage() {
      return null;
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (!events.length) await new Promise((resolve) => { wake = resolve; });
          return { value: events.shift(), done: false };
        },
      };
    },
  };
}
