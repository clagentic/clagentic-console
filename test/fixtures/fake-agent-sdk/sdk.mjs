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
  // The real SDK hands the Claude Code subprocess options.env when it is set
  // and REPLACES the inherited environment with it; without it the subprocess
  // inherits process.env. This is the environment that subprocess would get.
  const effectiveEnv = options.env === undefined ? { ...process.env } : { ...options.env };
  globalThis.__fakeAgentSdkQueries = globalThis.__fakeAgentSdkQueries || [];
  const record = {
    env: effectiveEnv,
    hasEnvOption: options.env !== undefined,
    cwd: options.cwd,
    model: options.model,
    // The options the SDK was called with: they decide the CLI's argv.
    options: options,
    // Every user message the query was handed, as the SDK received it.
    messages: [],
  };
  globalThis.__fakeAgentSdkQueries.push(record);

  const events = [];
  let wake = null;
  let closed = false;
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
      record.messages.push(message);
      emit({ type: "fake_probe", call: "message", message });
      const parts = message && message.message && message.message.content;
      const text = Array.isArray(parts) && parts[0] ? parts[0].text : "";
      // A title request: answer it so the caller's loop ends.
      if (typeof text === "string" && text.indexOf("Below is a conversation") === 0) {
        emit({ type: "result", subtype: "success" });
        continue;
      }
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
  emit({ type: "fake_probe", call: "env", env: effectiveEnv, optionKeys: Object.keys(options) });

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
    // Like the real Query, closing ends the stream.
    close() {
      closed = true;
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (!events.length && !closed) await new Promise((resolve) => { wake = resolve; });
          if (!events.length) return { value: undefined, done: true };
          return { value: events.shift(), done: false };
        },
      };
    },
  };
}
