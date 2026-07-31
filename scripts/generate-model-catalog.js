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
//     this script logs a warning and exits 0 WITHOUT touching the existing
//     committed catalog file. The release proceeds shipping the previously
//     generated catalog — stale is an acceptable, visible-in-git-history
//     degradation; empty is not.
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
// DOCUMENTED FALLBACK (not built — see PR body point under "documented
// fallback"): if /v1/models ever starts rejecting the CI key outright
// (402/403/429 sustained), https://platform.claude.com/docs/en/about-claude/
// model-deprecations is a credential-free, server-rendered HTML page
// listing active + deprecated + retired IDs that could be scraped as a
// last-resort source. Not implemented here — recorded for a future task if
// the API path ever stops working.

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

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[generate-model-catalog] ANTHROPIC_API_KEY not set — leaving the committed catalog untouched.');
    process.exit(0);
  }

  const existing = readExistingCatalog();
  let fresh;
  try {
    fresh = await fetchAllModels(apiKey);
  } catch (err) {
    console.warn('[generate-model-catalog] fetch failed — leaving the committed catalog untouched: ' + (err.message || err));
    process.exit(0);
  }

  if (!fresh.length) {
    console.warn('[generate-model-catalog] /v1/models returned zero entries — leaving the committed catalog untouched (never ship an empty catalog).');
    process.exit(0);
  }

  const merged = unionModels(existing, fresh);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'generated',
    models: merged,
  };

  fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[generate-model-catalog] wrote ${CATALOG_PATH} (${merged.length} models, ${fresh.length} from this fetch, ${existing.length} previously committed)`);
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
  unionModels: unionModels,
  readExistingCatalog: readExistingCatalog,
  CATALOG_PATH: CATALOG_PATH,
  API_BASE: API_BASE,
  PAGE_LIMIT: PAGE_LIMIT,
};
