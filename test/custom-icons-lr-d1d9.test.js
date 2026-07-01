// custom-icons-lr-d1d9.test.js — lr-d1d9: Custom Icons management interface.
//
// Coverage:
//   1. Shared client-side helper (lib/public/modules/custom-icons.js):
//      slugifyFilename, fetchCustomIconList, uploadCustomIcon, deleteCustomIcon.
//   2. rename_custom_icon daemon-side logic (atomic file rename + reference
//      rewrite across config.projects/folderMeta, 409-equivalent on existing
//      newSlug, SLUG_RE rejection). The production function lives in
//      lib/daemon.js (onRenameCustomIcon) which cannot be safely required in
//      a unit test (module-load side effects: reads config, starts servers).
//      Following the existing convention (see single-user-migration.test.js),
//      the algorithm is replicated here as a pure function operating on a
//      real tmp directory + in-memory config object, reusing the real
//      SLUG_RE/CUSTOM_EMOJI_CT exported from lib/server-settings.js so the
//      validation rules can never silently drift from production.
//   3. Client-side usage computation (the "Used by N" logic) — pure function
//      mirroring custom-icons-settings.js's computeUsage(), verified against
//      the real regex/shape used there.

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { SLUG_RE, CUSTOM_EMOJI_CT } = require("../lib/server-settings");

// ============================================================
// 1. Shared helper module — custom-icons.js
// ============================================================

test("slugifyFilename: strips extension, lowercases, collapses non-slug chars", async () => {
  var { slugifyFilename } = await import("../lib/public/modules/custom-icons.js");
  assert.equal(slugifyFilename("My Icon.PNG"), "my-icon");
  assert.equal(slugifyFilename("weird!!chars??.gif"), "weird-chars");
  assert.equal(slugifyFilename("already-valid_123.webp"), "already-valid_123");
});

test("slugifyFilename: falls back to 'custom' when result would be empty", async () => {
  var { slugifyFilename } = await import("../lib/public/modules/custom-icons.js");
  assert.equal(slugifyFilename("???.png"), "custom");
  assert.equal(slugifyFilename(".png"), "custom");
  assert.equal(slugifyFilename(""), "custom");
});

test("slugifyFilename: truncates to 64 chars", async () => {
  var { slugifyFilename } = await import("../lib/public/modules/custom-icons.js");
  var longName = "a".repeat(100) + ".png";
  var result = slugifyFilename(longName);
  assert.ok(result.length <= 64, "slug must be capped at 64 chars, got " + result.length);
});

test("fetchCustomIconList: resolves to [] on fetch rejection (network error)", async () => {
  var origFetch = global.fetch;
  global.fetch = function () { return Promise.reject(new Error("network down")); };
  try {
    var { fetchCustomIconList } = await import("../lib/public/modules/custom-icons.js?t=" + Date.now());
    var list = await fetchCustomIconList();
    assert.deepEqual(list, []);
  } finally {
    global.fetch = origFetch;
  }
});

test("fetchCustomIconList: resolves to [] when server returns a non-array", async () => {
  var origFetch = global.fetch;
  global.fetch = function () {
    return Promise.resolve({ json: function () { return Promise.resolve({ error: "not an array" }); } });
  };
  try {
    var { fetchCustomIconList } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 1));
    var list = await fetchCustomIconList();
    assert.deepEqual(list, []);
  } finally {
    global.fetch = origFetch;
  }
});

test("fetchCustomIconList: passes through the real list shape from the server", async () => {
  var origFetch = global.fetch;
  var served = [{ slug: "rocket", url: "/api/custom-emoji/rocket", size: 1234, ext: "png" }];
  global.fetch = function (url) {
    assert.equal(url, "/api/custom-emoji");
    return Promise.resolve({ json: function () { return Promise.resolve(served); } });
  };
  try {
    var { fetchCustomIconList } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 2));
    var list = await fetchCustomIconList();
    assert.deepEqual(list, served);
  } finally {
    global.fetch = origFetch;
  }
});

test("deleteCustomIcon: issues a DELETE to the encoded slug URL and resolves ok:true", async () => {
  var origFetch = global.fetch;
  var calledWith = null;
  global.fetch = function (url, options) {
    calledWith = { url: url, options: options };
    return Promise.resolve({ ok: true });
  };
  try {
    var { deleteCustomIcon } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 3));
    var result = await deleteCustomIcon("my icon"); // deliberately unsafe chars to verify encoding
    assert.equal(calledWith.url, "/api/custom-emoji/" + encodeURIComponent("my icon"));
    assert.equal(calledWith.options.method, "DELETE");
    assert.deepEqual(result, { ok: true });
  } finally {
    global.fetch = origFetch;
  }
});

test("deleteCustomIcon: resolves ok:false on network error rather than rejecting", async () => {
  var origFetch = global.fetch;
  global.fetch = function () { return Promise.reject(new Error("boom")); };
  try {
    var { deleteCustomIcon } = await import("../lib/public/modules/custom-icons.js?t=" + (Date.now() + 4));
    var result = await deleteCustomIcon("slug1");
    assert.deepEqual(result, { ok: false });
  } finally {
    global.fetch = origFetch;
  }
});

// ============================================================
// 2. rename_custom_icon daemon-side logic (replicated pure function)
// ============================================================
//
// Mirrors lib/daemon.js's onRenameCustomIcon. Kept here (not required from
// daemon.js) because daemon.js has module-load side effects (reads real
// config, starts IPC/HTTP servers) unsafe for a unit test — same rationale
// as single-user-migration.test.js's replicated migration function.

function renameCustomIcon(config, customEmojiDir, oldSlug, newSlug) {
  if (typeof oldSlug !== "string" || typeof newSlug !== "string") {
    return { ok: false, error: "Missing oldSlug or newSlug" };
  }
  if (!SLUG_RE.test(oldSlug) || !SLUG_RE.test(newSlug)) {
    return { ok: false, error: "Invalid slug" };
  }
  if (oldSlug === newSlug) {
    return { ok: false, error: "New slug must differ from the current slug" };
  }

  var oldFile = null;
  var oldExt = null;
  var newSlugExists = false;
  try {
    // Scan the FULL directory (no early break) — see lr-d1d9 fix in
    // lib/daemon.js onRenameCustomIcon: an early break on the oldSlug match
    // can skip the newSlug collision check entirely depending on readdirSync
    // ordering (e.g. alphabetically-earlier oldSlug sorts before newSlug).
    var existingFiles = fs.readdirSync(customEmojiDir);
    for (var efi = 0; efi < existingFiles.length; efi++) {
      var ef = existingFiles[efi];
      var efExt = path.extname(ef).slice(1);
      if (!CUSTOM_EMOJI_CT[efExt]) continue;
      var efBasename = path.basename(ef, "." + efExt);
      if (efBasename === oldSlug) { oldFile = ef; oldExt = efExt; }
      if (efBasename === newSlug) { newSlugExists = true; }
    }
  } catch (e) {
    return { ok: false, error: "Custom icon storage unavailable" };
  }
  if (newSlugExists) {
    return { ok: false, error: "A custom icon named \"" + newSlug + "\" already exists" };
  }
  if (!oldFile) {
    return { ok: false, error: "Custom icon \"" + oldSlug + "\" not found" };
  }

  var oldPath = path.join(customEmojiDir, oldFile);
  var newFile = newSlug + "." + oldExt;
  var newPath = path.join(customEmojiDir, newFile);
  var resolvedOld = path.resolve(customEmojiDir, oldFile);
  var resolvedNew = path.resolve(customEmojiDir, newFile);
  if (!resolvedOld.startsWith(customEmojiDir + path.sep) || !resolvedNew.startsWith(customEmojiDir + path.sep)) {
    return { ok: false, error: "Invalid path" };
  }

  fs.renameSync(oldPath, newPath);

  var oldSentinel = ":" + oldSlug + ":";
  var newSentinel = ":" + newSlug + ":";
  for (var pi = 0; pi < config.projects.length; pi++) {
    if (config.projects[pi].icon === oldSentinel) {
      config.projects[pi].icon = newSentinel;
    }
  }
  if (config.folderMeta) {
    var folderNames = Object.keys(config.folderMeta);
    for (var fni = 0; fni < folderNames.length; fni++) {
      var fMeta = config.folderMeta[folderNames[fni]];
      if (fMeta && fMeta.icon === oldSentinel) {
        fMeta.icon = newSentinel;
      }
    }
  }
  return { ok: true, slug: newSlug, url: "/api/custom-emoji/" + newSlug };
}

function makeTmpEmojiDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clagentic-custom-emoji-test-"));
}

test("rename_custom_icon: renames the file on disk and preserves extension", () => {
  var dir = makeTmpEmojiDir();
  fs.writeFileSync(path.join(dir, "old-slug.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  var config = { projects: [], folderMeta: {} };

  var result = renameCustomIcon(config, dir, "old-slug", "new-slug");

  assert.equal(result.ok, true);
  assert.equal(result.slug, "new-slug");
  assert.ok(!fs.existsSync(path.join(dir, "old-slug.png")), "old file must be gone");
  assert.ok(fs.existsSync(path.join(dir, "new-slug.png")), "new file must exist");
});

test("rename_custom_icon: rewrites config.projects[].icon references atomically", () => {
  var dir = makeTmpEmojiDir();
  fs.writeFileSync(path.join(dir, "team-logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  var config = {
    projects: [
      { slug: "proj-a", icon: ":team-logo:" },
      { slug: "proj-b", icon: ":other-icon:" },
      { slug: "proj-c", icon: "🚀" },
    ],
    folderMeta: {},
  };

  var result = renameCustomIcon(config, dir, "team-logo", "brand-mark");

  assert.equal(result.ok, true);
  assert.equal(config.projects[0].icon, ":brand-mark:", "referencing project must be rewritten");
  assert.equal(config.projects[1].icon, ":other-icon:", "unrelated custom icon must be untouched");
  assert.equal(config.projects[2].icon, "🚀", "unrelated emoji icon must be untouched");
});

test("rename_custom_icon: rewrites config.folderMeta[].icon references atomically", () => {
  var dir = makeTmpEmojiDir();
  fs.writeFileSync(path.join(dir, "folder-icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  var config = {
    projects: [],
    folderMeta: {
      Work: { icon: ":folder-icon:" },
      Personal: { icon: ":unrelated:" },
    },
  };

  var result = renameCustomIcon(config, dir, "folder-icon", "work-mark");

  assert.equal(result.ok, true);
  assert.equal(config.folderMeta.Work.icon, ":work-mark:");
  assert.equal(config.folderMeta.Personal.icon, ":unrelated:", "unrelated folder must be untouched");
});

test("rename_custom_icon: 409-equivalent when newSlug already exists", () => {
  var dir = makeTmpEmojiDir();
  fs.writeFileSync(path.join(dir, "old-slug.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(dir, "taken-slug.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  var config = { projects: [], folderMeta: {} };

  var result = renameCustomIcon(config, dir, "old-slug", "taken-slug");

  assert.equal(result.ok, false);
  assert.match(result.error, /already exists/);
  // Neither file should have moved.
  assert.ok(fs.existsSync(path.join(dir, "old-slug.png")));
  assert.ok(fs.existsSync(path.join(dir, "taken-slug.png")));
});

test("rename_custom_icon: SLUG_RE rejects invalid oldSlug/newSlug", () => {
  var dir = makeTmpEmojiDir();
  var config = { projects: [], folderMeta: {} };

  var badOld = renameCustomIcon(config, dir, "Not Valid!", "fine-slug");
  assert.equal(badOld.ok, false);
  assert.match(badOld.error, /Invalid slug/);

  fs.writeFileSync(path.join(dir, "fine-slug.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  var badNew = renameCustomIcon(config, dir, "fine-slug", "../escape");
  assert.equal(badNew.ok, false);
  assert.match(badNew.error, /Invalid slug/);
});

test("rename_custom_icon: rejects rename to the same slug", () => {
  var dir = makeTmpEmojiDir();
  fs.writeFileSync(path.join(dir, "same.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  var config = { projects: [], folderMeta: {} };

  var result = renameCustomIcon(config, dir, "same", "same");
  assert.equal(result.ok, false);
  assert.match(result.error, /differ/);
});

test("rename_custom_icon: 404-equivalent when oldSlug does not exist", () => {
  var dir = makeTmpEmojiDir();
  var config = { projects: [], folderMeta: {} };

  var result = renameCustomIcon(config, dir, "ghost-slug", "new-slug");
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
});

// ============================================================
// 3. Client-side usage computation (mirrors custom-icons-settings.js computeUsage)
// ============================================================

function slugOf(iconStr) {
  if (!iconStr || typeof iconStr !== "string") return null;
  var m = /^:([a-z0-9_-]{1,64}):$/.exec(iconStr);
  return m ? m[1] : null;
}

function computeUsage(projects, folderMeta) {
  var usage = {};
  function ensure(slug) {
    if (!usage[slug]) usage[slug] = { projects: [], folders: [] };
    return usage[slug];
  }
  for (var i = 0; i < projects.length; i++) {
    var slug = slugOf(projects[i].icon);
    if (slug) ensure(slug).projects.push(projects[i].title || projects[i].project || projects[i].slug);
  }
  var folderNames = Object.keys(folderMeta || {});
  for (var j = 0; j < folderNames.length; j++) {
    var fSlug = slugOf(folderMeta[folderNames[j]] && folderMeta[folderNames[j]].icon);
    if (fSlug) ensure(fSlug).folders.push(folderNames[j]);
  }
  return usage;
}

test("computeUsage: counts matching projects by customIconSlug", () => {
  var projects = [
    { slug: "a", title: "Alpha", icon: ":rocket:" },
    { slug: "b", title: "Beta", icon: ":rocket:" },
    { slug: "c", title: "Gamma", icon: "🚀" },
    { slug: "d", title: "Delta", icon: null },
  ];
  var usage = computeUsage(projects, {});
  assert.equal(usage.rocket.projects.length, 2);
  assert.deepEqual(usage.rocket.projects, ["Alpha", "Beta"]);
  assert.equal(Object.prototype.hasOwnProperty.call(usage, "🚀"), false, "emoji icons must not be tracked as slugs");
});

test("computeUsage: counts matching folders by customIconSlug", () => {
  var folderMeta = {
    Work: { icon: ":rocket:" },
    Play: { icon: ":balloon:" },
  };
  var usage = computeUsage([], folderMeta);
  assert.equal(usage.rocket.folders.length, 1);
  assert.deepEqual(usage.rocket.folders, ["Work"]);
  assert.equal(usage.balloon.folders.length, 1);
});

test("computeUsage: an icon used by nothing is simply absent from the usage map", () => {
  var usage = computeUsage([{ slug: "a", icon: ":other:" }], {});
  assert.equal(usage.unused_icon, undefined);
});

test("computeUsage: combines project + folder references for the same slug", () => {
  var projects = [{ slug: "a", title: "Alpha", icon: ":shared:" }];
  var folderMeta = { Team: { icon: ":shared:" } };
  var usage = computeUsage(projects, folderMeta);
  assert.equal(usage.shared.projects.length, 1);
  assert.equal(usage.shared.folders.length, 1);
});
