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

test("the info message and /info carry the build id; the client feeds both to the guard", () => {
  assert.match(read("lib/project-connection.js"), /type: "info"[^\n]*buildId: clientBuildId\.get\(\)/);
  assert.match(read("lib/project.js"), /type: "info"[^\n]*buildId: clientBuildId\.get\(\)/);
  assert.match(read("lib/server.js"), /buildId: clientBuildId\.get\(\)/);
  assert.match(read("lib/public/modules/app-messages.js"), /observeBuildId\(msg\.buildId\)/);
  assert.match(read("lib/public/modules/app-connection.js"), /observeBuildId\(info\.buildId\)/);
});

// --- (ii) sw.js changes with the build id, and only with it ---

test("sw.js differs under two build ids and is identical under the same id", () => {
  const source = read("lib/public/sw.js");
  const a1 = clientBuildId.stampServiceWorker(source, "sha-a");
  const a2 = clientBuildId.stampServiceWorker(source, "sha-a");
  const b = clientBuildId.stampServiceWorker(source, "sha-b");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, /var CACHE_NAME = "clagentic-console-offline-vsha-a"/);
});

test("a build id cannot break out of the stamped string", () => {
  const out = clientBuildId.stampServiceWorker(read("lib/public/sw.js"), 'x";alert(1);//');
  assert.doesNotMatch(out, /alert\(1\)/);
});

test("the id is the daemon's build SHA when it has one, a per-start nonce otherwise, fixed once set", () => {
  clientBuildId.resetForTest();
  assert.equal(clientBuildId.init("abc123"), "abc123");
  assert.equal(clientBuildId.init("other"), "abc123");
  assert.equal(clientBuildId.get(), "abc123");

  clientBuildId.resetForTest();
  const first = clientBuildId.init(null);
  assert.match(first, /^start-[0-9a-f]+$/);
  assert.equal(clientBuildId.get(), first);
  clientBuildId.resetForTest();
  assert.notEqual(clientBuildId.init(null), first, "a restart without a SHA still changes the id");
  clientBuildId.resetForTest();
});

test("server.js stamps sw.js from the build id, not the package version", () => {
  const server = read("lib/server.js");
  assert.match(server, /clientBuildId\.stampServiceWorker\(.*clientBuildId\.get\(\)\)/);
  assert.doesNotMatch(server, /var appVersion = pkg\.version/);
  assert.match(read("lib/daemon.js"), /require\("\.\/client-build-id"\)\.init\(loadedBuildSha\)/);
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
