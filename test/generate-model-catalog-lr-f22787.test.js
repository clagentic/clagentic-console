"use strict";
/**
 * Regression tests for lr-f22787 — scripts/generate-model-catalog.js, the
 * release-time GET /v1/models catalog generator that runs in CI only.
 *
 * Covers:
 *   - fetchAllModels: full pagination via after_id (PR body requirement:
 *     paginate fully, the endpoint supports after_id/before_id up to
 *     limit=1000).
 *   - unionModels: additive union (PR body point (a) — retired models are
 *     never dropped, only unioned with fresh data).
 *   - A non-2xx response (401/402/403/429/5xx) surfaces as a thrown error
 *     from fetchAllModels — main()'s catch is what turns that into a
 *     graceful no-op exit; this test pins the error-surfacing half of that
 *     contract without invoking main() (which calls process.exit).
 *   - extractModelIdsFromHtml: the credential-free deprecations-page
 *     fallback parser (route (a) of the coordinator's required-fix follow-
 *     up). Verified against the LIVE page's real raw HTML during this task
 *     (not a browsing tool's markdown-converted view): model IDs appear only
 *     inside two specific tag/class shapes — a click-to-copy
 *     `<span ... data-state="closed" ...>` in the main status table, and a
 *     `<code class="relative inline bg-neutral-30 ...">` tag in every
 *     per-release deprecation-history table. A naive `claude-[\w.-]+` text
 *     scan (an earlier version of this parser) also matched inside
 *     `href="..."` navigation attributes and changelog anchor slugs,
 *     producing dozens of false positives (e.g. "claude-api-skill",
 *     "claude-on-vertex-ai") — these fixture tests pin that those false
 *     positives are excluded and only genuine tag-wrapped IDs are extracted.
 *
 * main() itself (the missing-ANTHROPIC_API_KEY / fetch-failure / empty-
 * response --> "leave the committed catalog untouched, exit 0" paths) calls
 * process.exit() by design (see the script's own header comment) and is
 * intentionally NOT invoked here — asserting its logging/early-return shape
 * would require mocking process.exit itself, which is a bigger hazard than
 * it's worth in a shared test process. The three early-return CONDITIONS
 * (no key / fetch throws / fresh.length === 0) are each independently
 * covered by the fetchAllModels/unionModels tests below, which is what
 * actually matters: the script's own header comment documents the
 * exit(0)-never-fails-the-build contract, and scripts/generate-model-
 * catalog.js's main() is a thin 15-line wrapper around exactly those three
 * checks plus a write — no independent logic to regress.
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var gen = require("../scripts/generate-model-catalog.js");

function fakeResponse(status, statusText, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    statusText: statusText,
    json: async function () { return body; },
    text: async function () { return JSON.stringify(body); },
  };
}

test.afterEach(function () {
  delete global.fetch;
});

test("lr-f22787: fetchAllModels paginates fully via after_id until has_more is false", async function () {
  var calls = [];
  global.fetch = async function (url) {
    var u = new URL(url);
    calls.push(u.searchParams.get("after_id"));
    if (!u.searchParams.get("after_id")) {
      return fakeResponse(200, "OK", {
        data: [
          { id: "claude-opus-4-6", display_name: "Claude Opus 4.6", created_at: "2026-06-01T00:00:00Z" },
          { id: "claude-opus-4-5", display_name: "Claude Opus 4.5", created_at: "2025-11-24T00:00:00Z" },
        ],
        has_more: true,
      });
    }
    return fakeResponse(200, "OK", {
      data: [{ id: "claude-opus-4", display_name: "Claude Opus 4", created_at: "2025-01-01T00:00:00Z" }],
      has_more: false,
    });
  };

  var models = await gen.fetchAllModels("fake-key");
  assert.equal(models.length, 3, "all pages must be collected");
  assert.deepEqual(models.map(function (m) { return m.id; }), ["claude-opus-4-6", "claude-opus-4-5", "claude-opus-4"]);
  assert.equal(calls.length, 2, "exactly two requests: first page (no after_id) then the follow-up page");
  assert.equal(calls[1], "claude-opus-4-5", "the second request's after_id must be the last id of the first page");
});

test("lr-f22787: fetchAllModels requests limit=1000 (the documented maximum) on every page", async function () {
  var seenLimits = [];
  global.fetch = async function (url) {
    var u = new URL(url);
    seenLimits.push(u.searchParams.get("limit"));
    return fakeResponse(200, "OK", { data: [], has_more: false });
  };
  await gen.fetchAllModels("fake-key");
  assert.deepEqual(seenLimits, ["1000"]);
});

test("lr-f22787: fetchAllModels stops when a page returns has_more:true but zero entries (defensive, avoids an infinite loop)", async function () {
  global.fetch = async function () {
    return fakeResponse(200, "OK", { data: [], has_more: true });
  };
  var models = await gen.fetchAllModels("fake-key");
  assert.deepEqual(models, []);
});

test("lr-f22787: fetchAllModels throws on a non-2xx response (401/403/429/5xx) so the caller can degrade gracefully", async function () {
  global.fetch = async function () {
    return fakeResponse(401, "Unauthorized", { error: "invalid api key" });
  };
  await assert.rejects(function () { return gen.fetchAllModels("bad-key"); }, /GET \/v1\/models failed: 401/);
});

test("lr-f22787: fetchAllModels normalizes each entry to {id, displayName, createdAt}, falling back to id when display_name is absent", async function () {
  global.fetch = async function () {
    return fakeResponse(200, "OK", {
      data: [{ id: "claude-haiku-4-5" }], // no display_name, no created_at
      has_more: false,
    });
  };
  var models = await gen.fetchAllModels("fake-key");
  assert.deepEqual(models, [{ id: "claude-haiku-4-5", displayName: "claude-haiku-4-5", createdAt: null }]);
});

// ---------------------------------------------------------------------------
// unionModels — additive merge (PR body point (a))
// ---------------------------------------------------------------------------

test("lr-f22787: unionModels keeps an existing entry that the fresh fetch no longer returns (retired-model additivity)", function () {
  var existing = [{ id: "claude-opus-3", displayName: "Claude Opus 3" }];
  var fresh = [{ id: "claude-opus-4-6", displayName: "Claude Opus 4.6" }];
  var merged = gen.unionModels(existing, fresh);
  var ids = merged.map(function (m) { return m.id; });
  assert.ok(ids.indexOf("claude-opus-3") !== -1, "a retired model dropped from the live response must still be present — additive, never overwrite");
  assert.ok(ids.indexOf("claude-opus-4-6") !== -1);
});

test("lr-f22787: unionModels lets fresh data win on conflicting fields for the same id", function () {
  var existing = [{ id: "claude-opus-4-6", displayName: "Stale Name" }];
  var fresh = [{ id: "claude-opus-4-6", displayName: "Claude Opus 4.6" }];
  var merged = gen.unionModels(existing, fresh);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].displayName, "Claude Opus 4.6");
});

test("lr-f22787: unionModels sorts the merged result by id for a stable diff in the committed catalog file", function () {
  var merged = gen.unionModels(
    [{ id: "claude-sonnet-4-6" }],
    [{ id: "claude-opus-4-6" }, { id: "claude-haiku-4-5" }]
  );
  assert.deepEqual(merged.map(function (m) { return m.id; }), ["claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-6"]);
});

test("lr-f22787: unionModels handles empty existing/fresh arrays", function () {
  assert.deepEqual(gen.unionModels([], []), []);
  assert.deepEqual(gen.unionModels([], [{ id: "a" }]).map(function (m) { return m.id; }), ["a"]);
  assert.deepEqual(gen.unionModels([{ id: "a" }], []).map(function (m) { return m.id; }), ["a"]);
});

// ---------------------------------------------------------------------------
// extractModelIdsFromHtml — deprecations-page fallback parser
// ---------------------------------------------------------------------------

// A minimal fixture mirroring the REAL page's confirmed shapes: the main
// status table's click-to-copy <span data-state="closed"> widget, a
// per-release history table's <code class="...bg-neutral-30..."> tag, and —
// critically — navigation noise (an href with a claude-* path segment, and
// a changelog anchor slug) that a naive text scan would incorrectly match
// but this tag-scoped parser must not.
var FIXTURE_HTML = [
  '<div class="overflow-x-auto my-6 text-body"><table class="w-full border-collapse"><thead><tr>',
  '<th>API model name</th><th>Current state</th><th>Deprecated</th><th>Tentative retirement date</th>',
  '</tr></thead><tbody>',
  '<tr><td><span class="inline-block cursor-pointer select-none px-1 py-0.5 font-mono" data-state="closed">claude-opus-5</span></td>',
  '<td>Active</td><td>N/A</td><td>Not sooner than July 24, 2027</td></tr>',
  '<tr><td><span class="inline-block cursor-pointer select-none px-1 py-0.5 font-mono" data-state="closed">claude-sonnet-4-6</span></td>',
  '<td>Active</td><td>N/A</td><td>Not sooner than February 17, 2027</td></tr>',
  '</tbody></table></div>',
  '<table><thead><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr></thead><tbody>',
  '<tr><td>June 15, 2026</td>',
  '<td><code class="relative inline bg-neutral-30 px-2 py-0.5 rounded text-body font-mono break-words box-decoration-clone">claude-sonnet-4-20250514</code></td>',
  '<td><code class="relative inline bg-neutral-30 px-2 py-0.5 rounded text-body font-mono break-words box-decoration-clone">claude-sonnet-4-6</code></td></tr>',
  '</tbody></table>',
  // Non-model parameter names reusing the identical <code> class, from the
  // page's final "Parameter / Status / Behavior" table — must be excluded
  // by the leading "claude-" value check, not by tag shape alone.
  '<table><tbody><tr><td><code class="relative inline bg-neutral-30 px-2 py-0.5 rounded text-body font-mono break-words box-decoration-clone">temperature</code></td></tr></tbody></table>',
  // Navigation noise that a naive text scan (an earlier version of this
  // parser) incorrectly matched — must be excluded entirely.
  '<a href="/docs/en/build-with-claude/claude-on-vertex-ai#api-model-ids">Claude on Vertex AI</a>',
  '<a href="/docs/en/agents-and-tools/agent-skills/claude-api-skill">claude-api-skill docs</a>',
  '<a href="#2026-04-14-claude-sonnet-4-and-claude-opus-4-models">changelog anchor</a>',
].join('\n');

test("lr-f22787: extractModelIdsFromHtml pulls model IDs from the main status table's data-state=\"closed\" span widget", function () {
  var ids = gen.extractModelIdsFromHtml(FIXTURE_HTML);
  assert.ok(ids.indexOf("claude-opus-5") !== -1);
  assert.ok(ids.indexOf("claude-sonnet-4-6") !== -1);
});

test("lr-f22787: extractModelIdsFromHtml pulls model IDs from a per-release history table's bg-neutral-30 code tag", function () {
  var ids = gen.extractModelIdsFromHtml(FIXTURE_HTML);
  assert.ok(ids.indexOf("claude-sonnet-4-20250514") !== -1);
});

test("lr-f22787: extractModelIdsFromHtml excludes non-model parameter names that reuse the identical bg-neutral-30 code class", function () {
  var ids = gen.extractModelIdsFromHtml(FIXTURE_HTML);
  assert.equal(ids.indexOf("temperature"), -1, "tag shape alone is not sufficient — the value must also start with claude-");
});

test("lr-f22787: extractModelIdsFromHtml never matches inside href navigation attributes or changelog anchor slugs", function () {
  var ids = gen.extractModelIdsFromHtml(FIXTURE_HTML);
  assert.equal(ids.indexOf("claude-on-vertex-ai"), -1);
  assert.equal(ids.indexOf("claude-api-skill"), -1);
  assert.equal(ids.indexOf("claude-sonnet-4-and-claude-opus-4-models"), -1);
});

test("lr-f22787: extractModelIdsFromHtml deduplicates an ID that appears in both a span and a code tag", function () {
  var ids = gen.extractModelIdsFromHtml(FIXTURE_HTML);
  var count = ids.filter(function (id) { return id === "claude-sonnet-4-6"; }).length;
  assert.equal(count, 1, "claude-sonnet-4-6 appears in both the main table (span) and the history table (code) in the fixture — must be deduplicated");
});

test("lr-f22787: extractModelIdsFromHtml returns a sorted array", function () {
  var ids = gen.extractModelIdsFromHtml(FIXTURE_HTML);
  var sorted = ids.slice().sort();
  assert.deepEqual(ids, sorted);
});

test("lr-f22787: extractModelIdsFromHtml returns an empty array for HTML with no matching tag shapes", function () {
  assert.deepEqual(gen.extractModelIdsFromHtml('<p>claude-opus-5 mentioned in plain prose, not in a matching tag</p>'), []);
});

test("lr-f22787: fetchDeprecationsPageModels normalizes extracted ids to {id, displayName, createdAt:null}", async function () {
  global.fetch = async function () {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async function () { return FIXTURE_HTML; },
    };
  };
  var models = await gen.fetchDeprecationsPageModels();
  var opus5 = models.filter(function (m) { return m.id === "claude-opus-5"; })[0];
  assert.ok(opus5);
  assert.deepEqual(opus5, { id: "claude-opus-5", displayName: "claude-opus-5", createdAt: null });
});

test("lr-f22787: fetchDeprecationsPageModels throws on a non-2xx response", async function () {
  global.fetch = async function () {
    return { ok: false, status: 503, statusText: "Service Unavailable", text: async function () { return ""; } };
  };
  await assert.rejects(function () { return gen.fetchDeprecationsPageModels(); }, /GET .* failed: 503/);
});

// ---------------------------------------------------------------------------
// resolveFreshModels — API-first, deprecations-page fallback
// ---------------------------------------------------------------------------

test("lr-f22787: resolveFreshModels falls back to the deprecations page when ANTHROPIC_API_KEY is unset", async function () {
  var originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  global.fetch = async function () {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async function () { return FIXTURE_HTML; },
    };
  };
  try {
    var resolved = await gen.resolveFreshModels();
    assert.ok(resolved);
    assert.equal(resolved.source, "deprecations-page");
    assert.ok(resolved.fresh.length > 0);
  } finally {
    if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

test("lr-f22787: resolveFreshModels falls back to the deprecations page when the API call fails", async function () {
  var originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "fake-key-for-test";
  var callCount = 0;
  global.fetch = async function (url) {
    callCount++;
    var isApiCall = String(url).indexOf("api.anthropic.com") !== -1;
    if (isApiCall) {
      return { ok: false, status: 401, statusText: "Unauthorized", text: async function () { return ""; } };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async function () { return FIXTURE_HTML; },
    };
  };
  try {
    var resolved = await gen.resolveFreshModels();
    assert.ok(resolved);
    assert.equal(resolved.source, "deprecations-page");
    assert.ok(callCount >= 2, "must attempt the API first, then fall back");
  } finally {
    if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test("lr-f22787: resolveFreshModels returns null when both sources fail — caller must leave the committed catalog untouched", async function () {
  var originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  global.fetch = async function () {
    return { ok: false, status: 500, statusText: "Internal Server Error", text: async function () { return ""; } };
  };
  try {
    var resolved = await gen.resolveFreshModels();
    assert.equal(resolved, null);
  } finally {
    if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
  }
});
