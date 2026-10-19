import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { resolveInjectedIdentity } from "../lib/public/modules/injected-identity.js";
import { injectedSenderName, injectedLabel, injectedSessionNote, injectedFromMessage } from "../lib/public/modules/injected-label.js";
import { mateAvatarUrl } from "../lib/public/modules/avatar.js";

const require = createRequire(import.meta.url);
const senderRef = require("../lib/sender-ref");
const sender = require("../lib/injected-sender");
const turnInitiator = require("../lib/turn-initiator");
const runtimeEnv = require("../lib/runtime-env");
const { createSessionInput } = require("../lib/session-input");
const { handleSessionCommand } = require("../lib/session-input-ipc");
const { withSenderRef } = require("../lib/cli/session-subcommands");

function liveSession(localId, extra) {
  return Object.assign({
    localId: localId, cliSessionId: "cli-" + localId, history: [], title: "t", cwd: null,
    isProcessing: false, queryInstance: {}, sentToolResults: {},
  }, extra || {});
}

function makeProject(sessions, opts) {
  opts = opts || {};
  const map = new Map();
  sessions.forEach((s) => map.set(s.localId, s));
  return {
    sm: {
      sessions: map,
      defaultVendor: "claude",
      recordHistoryEntry(sess, obj) { sess.history.push(obj); },
      appendToSessionFile() {},
    },
    sdk: { pushMessage() {}, startQuery() {} },
    onProcessingChanged() {},
    getLinuxUserForSession: opts.linuxUser || (() => null),
  };
}

function world() {
  const alpha = makeProject([
    liveSession(7, { agentName: "Lane A", vendor: "claude" }),
    liveSession(8, { vendor: "claude" }),
    liveSession(9, { agentName: "Idle", vendor: "claude", queryInstance: null }),
    liveSession(10, { agentName: "Other", vendor: "claude" }),
  ]);
  const beta = makeProject([liveSession(21, { vendor: "claude" })]);
  const projects = { alpha, beta };
  const input = createSessionInput({ getProject: (slug) => projects[slug] || null });
  return { alpha, beta, input };
}

function lastEntry(project, localId) {
  const s = project.sm.sessions.get(localId);
  return s.history[s.history.length - 1];
}

// --- the reference ---

test("a Claude process environment carries the project and session id, nothing else added", () => {
  const env = turnInitiator.claudeProcessEnv({ PATH: "/bin" }, null, undefined, { project: "alpha", sessionId: 7 });
  assert.equal(env[senderRef.PROJECT_ENV], "alpha");
  assert.equal(env[senderRef.SESSION_ENV], "7");
  assert.match(senderRef.PROJECT_ENV, /^CLAGENTIC_CONSOLE_/);
  assert.match(senderRef.SESSION_ENV, /^CLAGENTIC_CONSOLE_/);
});

test("an inherited reference is never passed on, for Claude or any other runtime", () => {
  const inherited = { [senderRef.PROJECT_ENV]: "stale", [senderRef.SESSION_ENV]: "99", PATH: "/bin" };
  const claude = turnInitiator.claudeProcessEnv(inherited, null);
  assert.equal(senderRef.PROJECT_ENV in claude, false);
  assert.equal(senderRef.SESSION_ENV in claude, false);
  const other = runtimeEnv.composeRuntimeEnv(inherited, null);
  assert.equal(senderRef.SESSION_ENV in other, false, "the Codex app-server environment is built here");
  assert.equal(other.PATH, "/bin");
});

test("a malformed session reference sets nothing", () => {
  assert.deepEqual(senderRef.envFor({ project: "alpha", sessionId: "../x" }), {});
  assert.deepEqual(senderRef.envFor(null), {});
});

test("the CLI passes the reference from its environment, and nothing outside a console session", () => {
  const inside = withSenderRef({ cmd: "send_session_input" }, { [senderRef.PROJECT_ENV]: "alpha", [senderRef.SESSION_ENV]: "7" });
  assert.equal(inside.senderProject, "alpha");
  assert.equal(inside.senderSessionId, "7");
  const outside = withSenderRef({ cmd: "send_session_input" }, { PATH: "/bin" });
  assert.equal("senderProject" in outside, false);
});

test("the IPC handler hands the reference to session-input", () => {
  let seen;
  handleSessionCommand({ sendInput(r) { seen = r; } }, { cmd: "send_session_input", senderProject: "alpha", senderSessionId: "7" });
  assert.equal(seen.senderProject, "alpha");
  assert.equal(seen.senderSessionId, "7");
});

// --- resolution in the daemon's own store ---

test("resolve: a live named-agent session is agent@project", () => {
  const { input } = world();
  assert.ok(input);
  const r = senderRef.resolve((s) => ({ alpha: world().alpha }[s] || null), { project: "alpha", sessionId: "7" });
  assert.equal(r.name, "Lane A@alpha");
  assert.equal(r.agent, "Lane A");
  assert.equal(r.sessionId, "7");
});

test("resolve: no named agent uses the vendor name", () => {
  const w = world();
  const r = senderRef.resolve((s) => ({ alpha: w.alpha }[s] || null), { project: "alpha", sessionId: "8" });
  assert.equal(r.name, "claude@alpha");
  assert.equal(r.agent, null);
});

test("resolve: unknown project, unknown session, no live runtime, bad id and another OS user fall through", () => {
  const w = world();
  const get = (s) => ({ alpha: w.alpha }[s] || null);
  assert.equal(senderRef.resolve(get, { project: "nope", sessionId: "7" }), null);
  assert.equal(senderRef.resolve(get, { project: "alpha", sessionId: "404" }), null);
  assert.equal(senderRef.resolve(get, { project: "alpha", sessionId: "9" }), null, "a reaped session has no caller process");
  assert.equal(senderRef.resolve(get, { project: "alpha", sessionId: "../7" }), null);
  assert.equal(senderRef.resolve(get, { project: "alpha" }), null);
  const osUser = makeProject([liveSession(7, { agentName: "x" })], { linuxUser: () => "alice" });
  assert.equal(senderRef.resolve(() => osUser, { project: "alpha", sessionId: "7" }), null);
});

test("resolve: a reaped session that is resumed is found again under the same id", () => {
  const w = world();
  const get = (s) => ({ alpha: w.alpha }[s] || null);
  const idle = w.alpha.sm.sessions.get(9);
  assert.equal(senderRef.resolve(get, { project: "alpha", sessionId: "9" }), null);
  idle.queryInstance = {};
  assert.equal(senderRef.resolve(get, { project: "alpha", sessionId: "9" }).name, "Idle@alpha");
});

// --- recording ---

test("send-input from a session of another project records an extracted sender", () => {
  const w = world();
  const out = w.input.sendInput({ projectSlug: "beta", sessionId: "21", prompt: "report", senderProject: "alpha", senderSessionId: "7" });
  assert.equal(out.result, "delivered");
  const e = lastEntry(w.beta, 21);
  assert.equal(e.senderKind, "extracted");
  assert.equal(e.fromName, "Lane A@alpha");
  assert.equal(e.senderSessionId, "7");
  assert.equal(e.senderAgentSlug, "lane-a");
  assert.equal(e.from, "injected:trigger");
  assert.equal(e.declaredName, undefined);
});

test("the same-project case uses the same agent@project format", () => {
  const w = world();
  w.input.sendInput({ projectSlug: "alpha", sessionId: "10", prompt: "p", senderProject: "alpha", senderSessionId: "7" });
  assert.equal(lastEntry(w.alpha, 10).fromName, "Lane A@alpha");
});

test("open-session records the extracted sender too", () => {
  const w = world();
  const created = liveSession(30, { vendor: "claude" });
  w.beta.sm.createSession = () => { w.beta.sm.sessions.set(30, created); return created; };
  w.beta.sm.saveSessionFile = () => {};
  w.beta.sm.broadcastSessionList = () => {};
  w.beta.getLinuxUserForSession = () => null;
  const out = w.input.openSession({ projectSlug: "beta", prompt: "p", senderProject: "alpha", senderSessionId: "8" });
  assert.equal(out.result, "opened");
  assert.equal(created.history[0].senderKind, "extracted");
  assert.equal(created.history[0].fromName, "claude@alpha");
});

test("a --from that disagrees is recorded beside the extracted identity; one that agrees is not", () => {
  const w = world();
  w.input.sendInput({ projectSlug: "beta", sessionId: "21", prompt: "p", from: "someone-else", senderProject: "alpha", senderSessionId: "7" });
  const e = lastEntry(w.beta, 21);
  assert.equal(e.senderKind, "extracted");
  assert.equal(e.fromName, "Lane A@alpha");
  assert.equal(e.declaredName, "someone-else");
  w.input.sendInput({ projectSlug: "beta", sessionId: "21", prompt: "p", from: "lane a", senderProject: "alpha", senderSessionId: "7" });
  assert.equal(lastEntry(w.beta, 21).declaredName, undefined);
});

test("an unresolvable reference falls through to declared, or undeclared, never guessed", () => {
  const w = world();
  w.input.sendInput({ projectSlug: "beta", sessionId: "21", prompt: "p", from: "lore-a3", senderProject: "alpha", senderSessionId: "404" });
  assert.equal(lastEntry(w.beta, 21).senderKind, "declared");
  w.input.sendInput({ projectSlug: "beta", sessionId: "21", prompt: "p", senderProject: "alpha", senderSessionId: "404" });
  assert.equal(lastEntry(w.beta, 21).senderKind, "undeclared");
  w.input.sendInput({ projectSlug: "beta", sessionId: "21", prompt: "p" });
  const e = lastEntry(w.beta, 21);
  assert.equal(e.senderKind, "undeclared");
  assert.equal(e.senderSessionId, undefined);
});

test("an extracted entry survives the client path; a forged one without a name does not", () => {
  const ok = sender.forClient({ type: "user_message", source: "external-trigger", initiator: "trigger", senderKind: "extracted", fromName: "a@p", senderSessionId: "7" });
  assert.equal(ok.senderKind, "extracted");
  assert.equal(ok.fromName, "a@p");
  const bad = sender.forClient({ type: "user_message", source: "external-trigger", initiator: "trigger", senderKind: "extracted" });
  assert.equal(bad.senderKind, "unrecorded");
});

// --- display ---

const extractedMsg = {
  senderKind: "extracted", fromName: "Lane A@alpha", initiator: "trigger", contextNote: "lane report",
  senderAgent: "Lane A", senderAgentSlug: "lane-a", senderSessionId: "7",
};

test("label: agent@project, the extracted marker, no session id in the label", () => {
  const inj = injectedFromMessage(extractedMsg);
  assert.equal(injectedSenderName(inj), "Lane A@alpha");
  assert.equal(injectedLabel(inj), "trigger · lane report · extracted");
  assert.equal(injectedLabel(inj).includes("7"), false);
});

test("the full sender session id is available for hover or tap", () => {
  assert.equal(injectedSessionNote(injectedFromMessage(extractedMsg)), "session 7");
  assert.equal(injectedSessionNote({ senderKind: "declared", senderSessionId: "7" }), "");
});

test("a declared name beside the extracted one is shown in the label, not as the name", () => {
  const inj = injectedFromMessage(Object.assign({}, extractedMsg, { declaredName: "someone-else" }));
  assert.equal(injectedSenderName(inj), "Lane A@alpha");
  assert.equal(injectedLabel(inj), "trigger · lane report · extracted · declared as someone-else");
});

test("declared and undeclared labels keep their own text", () => {
  assert.equal(injectedLabel(injectedFromMessage({ senderKind: "declared", fromName: "x", initiator: "trigger" })), "trigger · declared");
  assert.equal(injectedSenderName(injectedFromMessage({ senderKind: "undeclared" })), "Undeclared sender");
});

test("avatar: a listed agent gets its own avatar with the agent@project name", () => {
  const known = [{ id: "lane-a", name: "Lane A", agentName: "Lane A", slug: "lane-a" }];
  const r = resolveInjectedIdentity(injectedFromMessage(extractedMsg), "injected:trigger", known, 36);
  assert.equal(r.matched, true);
  assert.equal(r.name, "Lane A@alpha");
  assert.equal(r.avatarUrl, mateAvatarUrl(known[0], 36));
});

test("avatar: an agent from another project keeps the avatar the list would give it", () => {
  const r = resolveInjectedIdentity(injectedFromMessage(extractedMsg), "injected:trigger", [], 36);
  assert.equal(r.name, "Lane A@alpha");
  assert.equal(r.avatarUrl, mateAvatarUrl({ id: "lane-a" }, 36));
});

test("avatar: a vendor-named sender gets a stable seeded avatar", () => {
  const inj = injectedFromMessage({ senderKind: "extracted", fromName: "claude@alpha", initiator: "trigger", senderSessionId: "8" });
  const a = resolveInjectedIdentity(inj, "injected:trigger", [], 36);
  assert.equal(a.name, "claude@alpha");
  assert.equal(a.avatarUrl, resolveInjectedIdentity(inj, "injected:trigger", [], 36).avatarUrl);
});
