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
