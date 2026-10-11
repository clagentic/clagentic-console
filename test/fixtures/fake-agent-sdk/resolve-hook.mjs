// Resolves the Claude Agent SDK's package name to the stand-in beside this file.
const FAKE = new URL("./sdk.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@anthropic-ai/claude-agent-sdk") return { url: FAKE, shortCircuit: true };
  return nextResolve(specifier, context);
}
