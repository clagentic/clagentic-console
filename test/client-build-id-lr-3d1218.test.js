import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createBuildGuard, showReloadBanner } from "../lib/public/modules/build-guard.js";
import { injectedSenderName, injectedLabel, injectedFromMessage } from "../lib/public/modules/injected-label.js";

const require = createRequire(import.meta.url);
const clientBuildId = require("../lib/client-build-id");
const injectedSender = require("../lib/injected-sender");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function guard(unsent) {
  const calls = { reload: 0, banner: 0 };
  const g = createBuildGuard({
    hasUnsent: () => unsent,
    reload: () => { calls.reload++; },
    showBanner: () => { calls.banner++; },
  });
  return { g, calls };
}

// --- (i) a client booted with one build id that is told another ---

test("the first id seen is the build the page booted with and does nothing", () => {
  const { g, calls } = guard(false);
  assert.equal(g.observe("A"), "booted");
  assert.deepEqual(calls, { reload: 0, banner: 0 });
});

test("a reconnect that reports the same id does nothing", () => {
  const { g, calls } = guard(false);
  g.observe("A");
  assert.equal(g.observe("A"), "same");
  assert.deepEqual(calls, { reload: 0, banner: 0 });
});

test("a reconnect that reports another id reloads when nothing is unsent", () => {
  const { g, calls } = guard(false);
  g.observe("A");
  assert.equal(g.observe("B"), "reload");
  assert.deepEqual(calls, { reload: 1, banner: 0 });
});

test("with unsent input it shows the banner instead of reloading", () => {
  const { g, calls } = guard(true);
  g.observe("A");
  assert.equal(g.observe("B"), "banner");
  assert.deepEqual(calls, { reload: 0, banner: 1 });
});

test("it acts once, however many connects report the new id", () => {
  const { g, calls } = guard(false);
  g.observe("A");
  g.observe("B");
  assert.equal(g.observe("B"), "pending");
  assert.equal(calls.reload, 1);
});

test("a message without an id is ignored, so an older daemon cannot trigger a reload", () => {
  const { g, calls } = guard(false);
  g.observe("A");
  assert.equal(g.observe(undefined), "ignored");
  assert.equal(g.observe(""), "ignored");
  assert.deepEqual(calls, { reload: 0, banner: 0 });
});

test("the banner is not dismissable and is added once", () => {
  const made = [];
  const doc = {
    body: { appendChild: (el) => made.push(el) },
    getElementById: (id) => made.find((el) => el.id === id) || null,
    createElement: () => ({
      id: "", className: "", textContent: "", children: [],
      classList: { add() {} },
      appendChild(c) { this.children.push(c); },
      addEventListener() {},
    }),
  };
  showReloadBanner(doc, () => {});
  showReloadBanner(doc, () => {});
  assert.equal(made.length, 1);
  assert.equal(made[0].children.length, 2, "text and reload button only");
  assert.match(made[0].children[0].textContent, /^Clagentic: Console /);
});

// A real server (test/access-harness.js) started under a given build id. The
// lib modules are dropped from the require cache first, so each start gets a
// fresh client-build-id and the id really is fixed by init for that run.
function freshLib() {
  const libDir = path.join(ROOT, "lib") + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(libDir)) delete require.cache[key];
  }
}

async function underBuildId(buildId, fn) {
  freshLib();
  const harness = require("./access-harness");
  require("../lib/client-build-id").init(buildId);
  const h = await harness.start({ users: [{ key: "u", username: "u", role: "admin" }], projects: [{ slug: "p", ownerKey: "u" }] });
  try {
    return await fn(h);
  } finally {
    await h.stop();
  }
}

// What the daemon sends under one build id: the WebSocket info message of a
// first connect, the /info response of a reconnect, and the served sw.js.
function serverShapes(buildId) {
  return underBuildId(buildId, async (h) => {
    const conn = await h.connect("p", "u");
    assert.equal(conn.ok, true);
    const wsInfo = await conn.waitFor((m) => m.type === "info");
    const httpInfo = JSON.parse((await h.request("GET", "/info", "u")).body);
    const sw = await h.request("GET", "/sw.js", "u");
    const swAgain = await h.request("GET", "/sw.js", "u");
    return { wsInfo, httpInfo, sw, swAgain };
  });
}

test("both info shapes the server sends reach the client guard: it fires on a mismatch and not on a match", async () => {
  const a = await serverShapes("sha-a");
  const b = await serverShapes("sha-b");
  assert.equal(a.wsInfo.buildId, "sha-a");
  assert.equal(a.httpInfo.buildId, "sha-a");

  // A tab booted on the WebSocket info of build A, then told A again by /info
  // (reconnect), then B by /info and by the WebSocket after the restart.
  const viaHttp = guard(false);
  assert.equal(viaHttp.g.observeInfo(a.wsInfo), "booted");
  assert.equal(viaHttp.g.observeInfo(a.httpInfo), "same");
  assert.equal(viaHttp.g.observeInfo(a.wsInfo), "same");
  assert.deepEqual(viaHttp.calls, { reload: 0, banner: 0 });
  assert.equal(viaHttp.g.observeInfo(b.httpInfo), "reload");
  assert.deepEqual(viaHttp.calls, { reload: 1, banner: 0 });

  const viaWs = guard(true);
  viaWs.g.observeInfo(a.httpInfo);
  assert.equal(viaWs.g.observeInfo(b.wsInfo), "banner");
  assert.deepEqual(viaWs.calls, { reload: 0, banner: 1 });
});

test("the client entry points both go through the guard's observeInfo", () => {
  assert.match(read("lib/public/modules/app-messages.js"), /observeBuildInfo\(msg\)/);
  assert.match(read("lib/public/modules/app-connection.js"), /observeBuildInfo\(info\)/);
  assert.match(read("lib/public/modules/app-connection.js"), /buildGuard\.observeInfo\(info\)/);
});

// --- (ii) sw.js changes with the build id, and only with it ---

test("the served sw.js differs under two build ids and is identical under the same id", async () => {
  const a = await serverShapes("sha-a");
  const b = await serverShapes("sha-b");
  assert.equal(a.sw.status, 200);
  assert.equal(a.sw.body, a.swAgain.body, "same id, same bytes");
  assert.notEqual(a.sw.body, b.sw.body, "a different id, different bytes");
  assert.match(a.sw.body, /var CACHE_NAME = "clagentic-console-offline-vsha-a"/);
  assert.match(b.sw.body, /var CACHE_NAME = "clagentic-console-offline-vsha-b"/);
  const again = await serverShapes("sha-a");
  assert.equal(again.sw.body, a.sw.body, "a restart onto the same build keeps the worker");
});

test("stampServiceWorker stamps only the cache name", () => {
  const source = read("lib/public/sw.js");
  const a1 = clientBuildId.stampServiceWorker(source, "sha-a");
  assert.equal(a1, clientBuildId.stampServiceWorker(source, "sha-a"));
  assert.notEqual(a1, clientBuildId.stampServiceWorker(source, "sha-b"));
});

test("a build id cannot break out of the stamped string", () => {
  const out = clientBuildId.stampServiceWorker(read("lib/public/sw.js"), 'x";alert(1);//');
  assert.doesNotMatch(out, /alert\(1\)/);
});

// Each process start is a fresh module instance, which is what a restart is.
function freshClientBuildId() {
  freshLib();
  return require("../lib/client-build-id");
}

test("the id is the daemon's build SHA when it has one, a per-start nonce otherwise, fixed once set", () => {
  const withSha = freshClientBuildId();
  assert.equal(withSha.init("abc123"), "abc123");
  assert.equal(withSha.init("other"), "abc123");
  assert.equal(withSha.get(), "abc123");

  const first = freshClientBuildId();
  const firstId = first.init(null);
  assert.match(firstId, /^start-[0-9a-f]+$/);
  assert.equal(first.get(), firstId);
  assert.notEqual(freshClientBuildId().init(null), firstId, "a restart without a SHA still changes the id");
});

test("the daemon fixes the id from the build SHA it loaded at start", () => {
  assert.match(read("lib/daemon.js"), /require\("\.\/client-build-id"\)\.init\(loadedBuildSha\)/);
  assert.equal(Object.keys(clientBuildId).includes("resetForTest"), false, "no test seam on the production export");
});

// --- (iii) an extracted entry renders as agent@project, live and on replay ---

const stored = {
  type: "user_message", source: "external-trigger", initiator: "trigger", text: "report",
  senderKind: "extracted", fromName: "holden@lore", senderProject: "lore",
  senderSessionId: "923", senderAgent: "holden", senderVendor: "claude",
};

function rendered(entry) {
  const inj = injectedFromMessage(injectedSender.forClient(entry));
  return { name: injectedSenderName(inj), label: injectedLabel(inj) };
}

test("live path: the entry sent to the client renders as agent@project with the extracted marker", () => {
  const r = rendered(stored);
  assert.equal(r.name, "holden@lore");
  assert.match(r.label, /extracted/);
});

test("replay path: the same stored entry, replayed after a reload, renders identically", () => {
  const live = rendered(stored);
  const replayed = rendered(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(replayed, live);
  assert.notEqual(replayed.name, "injected (sender not recorded)");
});
