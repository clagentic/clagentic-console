#!/usr/bin/env node
'use strict';

// generate-model-catalog.js — release-time generator for
// lib/generated/claude-model-catalog.json (lr-f22787).
//
// Runs ONLY in CI (.github/workflows/release.yml, `stable` job), never at
// install time or runtime. Calls GET https://api.anthropic.com/v1/models
// using ANTHROPIC_API_KEY from the environment (injected as a GitHub
// Actions repo secret — never present on the operator's machine, never read
// by the daemon). This is NOT an LLM call (workspace CLAUDE.md rule 17 only
// governs the `claude` CLI invocation path for actual model inference), so
// using fetch() directly here does not violate the CLI-only rule.
//
// DESIGN DECISIONS (see PR body for lr-f22787 for the full write-up):
//
// (a) RETIRED MODELS — ADDITIVE, never overwrite. This script unions the
//     freshly-fetched model list with whatever is already committed in
//     lib/generated/claude-model-catalog.json. A model /v1/models stops
//     returning (retired) stays in the catalog rather than disappearing
//     out from under an operator who might still be running it — the
//     picker's "Catalog" badge marks it as unconfirmed-live rather than
//     hiding it.
//
// (b) MISSING SECRET / FETCH FAILURE — never fail the build, never emit an
//     empty catalog. If ANTHROPIC_API_KEY is absent, or the API call
//     returns any non-2xx status (401/402/403/429/5xx) or a network error,
//     this script now falls through to the credential-free deprecations-
//     page source (see "FALLBACK SOURCE" below) instead of giving up
//     immediately — this is what lets the very first release (before the
//     operator has wired the secret) still produce a real, non-degenerate
//     catalog rather than shipping only the empty/minimal state. Only if
//     BOTH sources fail does this script log a warning and exit 0 WITHOUT
//     touching the existing committed catalog file — the release proceeds
//     shipping the previously generated catalog. Stale is an acceptable,
//     visible-in-git-history degradation; empty is not.
//
// (c) The catalog itself carries no "deprecated" flag from the vendor
//     response (GET /v1/models simply omits retired IDs — see task
//     ground truth). Distinguishing "confirmed still in the vendor's live
//     list" from "carried forward from a previous generation, not
//     reconfirmed this run" is out of scope for the wire format the picker
//     consumes (lib/model-catalog.js's fromCatalog marker already
//     distinguishes catalog-sourced entries from the vendor's live
//     enumeration at runtime, which is the marker that actually matters to
//     an operator deciding whether to trust a row).
//
// FALLBACK SOURCE — the public deprecations page (lr-f22787 follow-up,
// route (a)): if /v1/models is unreachable (missing key, or a non-2xx —
// 402/403/429/5xx), this script falls back to
// https://platform.claude.com/docs/en/about-claude/model-deprecations, a
// credential-free, server-rendered docs page. CONFIRMED against the live
// raw HTML (not the markdown-converted view a browsing tool would show) —
// the page has 11 real <table><tr><td> tables. Model IDs are NOT scattered
// as plain text: they appear ONLY as the text content of two specific
// widget shapes, both distinguishable from doc-site navigation noise
// (href="...claude-on-vertex-ai..." style path segments, changelog anchor
// slugs like "#2026-04-14-claude-sonnet-4-and-claude-opus-4-models", and
// prose link text like "whats-new-opus-5") by their exact tag/class
// signature:
//   1. The MAIN STATUS TABLE (<thead> columns: "API model name", "Current
//      state", "Deprecated", "Tentative retirement date"): each <tr> has
//      the model ID in td[0] as a click-to-copy
//      <span ... data-state="closed" ...>MODEL_ID</span> widget, and the
//      LITERAL STATUS ("Active" / "Deprecated" / "Retired" — confirmed
//      verbatim against the live page, no other values appear in this
//      column) as plain text in td[1]. This table is the authoritative
//      status source (STATUS_TABLE_ROW_RE below).
//   2. Every per-release DEPRECATION-HISTORY TABLE ("Retirement date" /
//      "Deprecated model" / "Recommended replacement" columns): td[1] and
//      td[2] each hold a
//      <code class="relative inline bg-neutral-30 ...">MODEL_ID</code> tag
//      — td[1]'s ID is, by column meaning, always a deprecated/retired
//      model (these are HISTORICAL superseded IDs, most of which never
//      appear at all in the main status table because they retired before
//      this doc revision); td[2]'s ID is the currently-recommended
//      replacement. HISTORY_ROW_RE below captures both with that positional
//      meaning (fallback status only used for an ID the main table doesn't
//      already cover — see extractModelIdsFromHtml).
// A naive claude-[\w.-]+ scan over the raw page text (an earlier version of
// this script) also matched inside href attributes and link prose, pulling
// in dozens of doc-site slugs that are not model IDs at all (e.g.
// "claude-api-skill", "claude-on-vertex-ai", "claude-prompting-best-
// practices"). The row-scoped regexes below match only those two tag/class
// shapes, and MODEL_ID_VALUE_RE additionally requires the captured text
// itself to start with "claude-" (the last table on the page reuses the
// identical <code class="relative inline bg-neutral-30..."> class for
// non-model parameter names like "temperature"/"top_p"/"top_k", so
// tag-shape alone is not sufficient). This holds no hardcoded model ID
// list or status table — it is a structural extraction rule against the
// page's real, confirmed markup, so a future model release or a newly
// retired ID requires zero changes here (same discipline as
// model-families.js's family/version derivation).
//
// Row boundaries: the main status table's <span data-state="closed"...>
// opening tag contains an embedded literal newline in its class attribute
// (confirmed against the live page), so a per-LINE regex scan misses full
// rows there. STATUS_TABLE_ROW_RE / HISTORY_ROW_RE both use the `s` (dotall)
// flag and operate on the whole fetched HTML string, matching <tr>...</tr>
// boundaries directly rather than splitting into lines first.
const DEPRECATIONS_PAGE_URL = 'https://platform.claude.com/docs/en/about-claude/model-deprecations';
const MODEL_ID_VALUE_RE = /^claude-[a-z0-9][a-z0-9.-]*$/;
// Main status table row: captures the span-wrapped model ID (group 1) and
// the plain-text "Current state" cell (group 2) from the same <tr>.
const STATUS_TABLE_ROW_RE = /<tr\b[^>]*>\s*<td\b[^>]*><span\b[^>]*\bdata-state="closed"[^>]*>([^<]+)<\/span><\/td>\s*<td\b[^>]*>([^<]*)<\/td>/gs;
// Deprecation-history table row: captures the deprecated-model code tag
// (group 1) and the recommended-replacement code tag (group 2) from the
// same <tr> — td[0] (the retirement-date cell) is skipped by requiring
// exactly two <code>...</code> tags to follow it.
const HISTORY_ROW_RE = /<tr\b[^>]*>\s*<td\b[^>]*>[^<]*<\/td>\s*<td\b[^>]*><code\b[^>]*\bclass="[^"]*\bbg-neutral-30\b[^"]*"[^>]*>([^<]+)<\/code><\/td>\s*<td\b[^>]*><code\b[^>]*\bclass="[^"]*\bbg-neutral-30\b[^"]*"[^>]*>([^<]+)<\/code><\/td>/gs;
// Normalizes the page's three literal state strings to the catalog's
// lowercase status vocabulary (see STATUS_VALUES below). Anything else
// (should not happen against the confirmed page shape, but a doc-site
// wording change is not this script's business to guess at) falls back to
// "unknown" rather than silently mislabeling a model as active.
var STATUS_TABLE_TEXT_TO_STATUS = { Active: 'active', Deprecated: 'deprecated', Retired: 'retired' };

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', 'lib', 'generated', 'claude-model-catalog.json');
const API_BASE = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const PAGE_LIMIT = 1000;

function readExistingCatalog() {
  try {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.models)) return parsed.models;
  } catch (e) {
    // Missing or corrupt — treat as "nothing to union with" rather than failing.
  }
  return [];
}

// Paginate GET /v1/models fully via after_id, per the documented endpoint
// (supports after_id/before_id, limit up to 1000).
async function fetchAllModels(apiKey) {
  const collected = [];
  let afterId = null;
  for (;;) {
    const url = new URL(API_BASE);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (afterId) url.searchParams.set('after_id', afterId);

    const res = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GET /v1/models failed: ${res.status} ${res.statusText} ${text.slice(0, 300)}`);
    }

    const body = await res.json();
    const page = Array.isArray(body.data) ? body.data : [];
    for (const m of page) {
      if (m && m.id) {
        collected.push({
          id: m.id,
          displayName: m.display_name || m.id,
          createdAt: m.created_at || null,
          // GET /v1/models omits retired IDs outright (per the documented
          // endpoint behavior, and the task's own established ground
          // truth) — every entry it DOES return is, by construction,
          // currently active. There is no separate "deprecated" flag on
          // this endpoint to distinguish "active" from "deprecated but
          // still listed" (unlike the deprecations-page fallback source,
          // which has a real three-state column) — see status handling on
          // the deprecations-page path below for that finer grain.
          status: 'active',
        });
      }
    }

    if (!body.has_more || page.length === 0) break;
    const last = page[page.length - 1];
    if (!last || !last.id) break;
    afterId = last.id;
  }
  return collected;
}

function unionModels(existing, fresh) {
  const byId = {};
  for (const m of existing) if (m && m.id) byId[m.id] = m;
  for (const m of fresh) if (m && m.id) byId[m.id] = m; // fresh data wins on conflicting fields for the same ID
  return Object.keys(byId).sort().map(function (id) { return byId[id]; });
}

// Extract every model ID from raw deprecations-page HTML, WITH its status
// (active/deprecated/retired/unknown), keyed by id. Scoped to the row
// shapes confirmed against the live page (see the header comment above) —
// never a bare text scan, which would also match navigation hrefs and
// changelog anchor slugs. Exported separately from the fetch so the
// extraction logic itself is unit-testable against a fixed HTML fixture
// without a network call.
//
// Precedence: the main status table is authoritative — if an ID appears
// there, its literal state wins outright. An ID that ONLY appears in a
// history table (never in the main table — i.e. it retired before this doc
// revision and dropped out of the main table entirely) is treated as
// "retired": that is exactly what a "Deprecated model" column entry with no
// corresponding main-table row means. A history-table "Recommended
// replacement" ID that doesn't otherwise appear is treated as "active" —
// the page recommends it as a live replacement.
function extractModelStatusesFromHtml(html) {
  const statusById = {};

  STATUS_TABLE_ROW_RE.lastIndex = 0;
  let m;
  while ((m = STATUS_TABLE_ROW_RE.exec(html)) !== null) {
    const id = m[1].trim();
    if (!MODEL_ID_VALUE_RE.test(id)) continue;
    const stateText = m[2].trim();
    statusById[id] = STATUS_TABLE_TEXT_TO_STATUS[stateText] || 'unknown';
  }

  HISTORY_ROW_RE.lastIndex = 0;
  while ((m = HISTORY_ROW_RE.exec(html)) !== null) {
    const deprecatedId = m[1].trim();
    const replacementId = m[2].trim();
    if (MODEL_ID_VALUE_RE.test(deprecatedId) && !statusById[deprecatedId]) {
      statusById[deprecatedId] = 'retired';
    }
    if (MODEL_ID_VALUE_RE.test(replacementId) && !statusById[replacementId]) {
      statusById[replacementId] = 'active';
    }
  }

  return statusById;
}

// Backward-compat convenience wrapper: just the sorted id list, no status.
// Kept because it's a simpler surface for anything that only needs
// membership, not status (and to avoid breaking any external caller of the
// original extraction function's name/shape).
function extractModelIdsFromHtml(html) {
  return Object.keys(extractModelStatusesFromHtml(html)).sort();
}

// Fetch the credential-free deprecations page and extract every model ID it
// lists, with status, via extractModelStatusesFromHtml.
async function fetchDeprecationsPageModels() {
  const res = await fetch(DEPRECATIONS_PAGE_URL);
  if (!res.ok) {
    throw new Error(`GET ${DEPRECATIONS_PAGE_URL} failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const statusById = extractModelStatusesFromHtml(html);
  return Object.keys(statusById).sort().map(function (id) {
    return { id: id, displayName: id, createdAt: null, status: statusById[id] };
  });
}

// Resolves the freshest model list this run, trying the authoritative API
// first and falling back to the credential-free deprecations page. Returns
// { fresh, source } or null when NEITHER source produced anything usable —
// the caller treats null as "leave the committed catalog untouched."
async function resolveFreshModels() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const fresh = await fetchAllModels(apiKey);
      if (fresh.length) return { fresh: fresh, source: 'anthropic-api' };
      console.warn('[generate-model-catalog] GET /v1/models returned zero entries — falling back to the deprecations page.');
    } catch (err) {
      console.warn('[generate-model-catalog] GET /v1/models failed — falling back to the deprecations page: ' + (err.message || err));
    }
  } else {
    console.warn('[generate-model-catalog] ANTHROPIC_API_KEY not set — falling back to the deprecations page.');
  }

  try {
    const fresh = await fetchDeprecationsPageModels();
    if (fresh.length) return { fresh: fresh, source: 'deprecations-page' };
    console.warn('[generate-model-catalog] deprecations-page fallback returned zero entries.');
  } catch (err) {
    console.warn('[generate-model-catalog] deprecations-page fallback failed: ' + (err.message || err));
  }

  return null;
}

async function main() {
  const existing = readExistingCatalog();
  const resolved = await resolveFreshModels();

  if (!resolved) {
    console.warn('[generate-model-catalog] no source produced a model list this run — leaving the committed catalog untouched (never ship an empty catalog).');
    process.exit(0);
  }

  const merged = unionModels(existing, resolved.fresh);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: resolved.source,
    models: merged,
  };

  fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[generate-model-catalog] wrote ${CATALOG_PATH} (${merged.length} models, ${resolved.fresh.length} from this run via ${resolved.source}, ${existing.length} previously committed)`);
}

// Only run as a CLI entry point when invoked directly (CI / `node
// scripts/generate-model-catalog.js`) — requiring this file from a test
// must not trigger a real network call or process.exit().
if (require.main === module) {
  main().catch(function (err) {
    // Any unexpected error here is a bug in this script, not a vendor/secret
    // condition — those are already handled above with a graceful exit(0).
    // Fail loudly so it's visible in the workflow run, but this only affects
    // catalog freshness, never the release itself (this script's exit code
    // is not checked by the workflow step that invokes it — see release.yml).
    console.error('[generate-model-catalog] unexpected error: ' + (err && err.stack || err));
    process.exit(1);
  });
}

module.exports = {
  fetchAllModels: fetchAllModels,
  fetchDeprecationsPageModels: fetchDeprecationsPageModels,
  extractModelIdsFromHtml: extractModelIdsFromHtml,
  extractModelStatusesFromHtml: extractModelStatusesFromHtml,
  unionModels: unionModels,
  readExistingCatalog: readExistingCatalog,
  resolveFreshModels: resolveFreshModels,
  CATALOG_PATH: CATALOG_PATH,
  API_BASE: API_BASE,
  DEPRECATIONS_PAGE_URL: DEPRECATIONS_PAGE_URL,
  PAGE_LIMIT: PAGE_LIMIT,
};
