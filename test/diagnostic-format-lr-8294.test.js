// Unit tests for diagnostic-format.js (lr-8294, epic lr-1a52 stage 4/5).
//
// diagnostic-format.js is a pure helper with no DOM dependencies — it is the
// testable seam extracted so that formatDiagnosticSource and
// formatDiagnosticSeverity can be verified without a browser runtime.
//
// Coverage:
//   - Known source identifiers map to human-readable labels.
//   - Unknown source identifiers pass through unchanged.
//   - Missing/empty source returns a safe fallback string.
//   - formatDiagnosticSeverity uppercases all three severity levels.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatDiagnosticSource,
  formatDiagnosticSeverity,
} from "../lib/public/modules/diagnostic-format.js";

// ============================================================
// formatDiagnosticSource
// ============================================================

test("formatDiagnosticSource: 'hook' maps to 'Hook'", () => {
  assert.strictEqual(formatDiagnosticSource("hook"), "Hook");
});

test("formatDiagnosticSource: 'cli' maps to 'CLI'", () => {
  assert.strictEqual(formatDiagnosticSource("cli"), "CLI");
});

test("formatDiagnosticSource: 'stderr' maps to 'CLI' (alias for cli source)", () => {
  // Stage 2/5 capture layer emits source:'stderr' for raw stderr lines.
  assert.strictEqual(formatDiagnosticSource("stderr"), "CLI");
});

test("formatDiagnosticSource: 'settings' maps to 'Settings'", () => {
  assert.strictEqual(formatDiagnosticSource("settings"), "Settings");
});

test("formatDiagnosticSource: 'preflight' maps to 'Preflight' (stage 5/5 lr-1a26)", () => {
  // Stage 5/5 adds Console-side settings.json preflight validation; its
  // diagnostics arrive via this same render path with source:'preflight'.
  assert.strictEqual(formatDiagnosticSource("preflight"), "Preflight");
});

test("formatDiagnosticSource: unknown source passes through unchanged", () => {
  assert.strictEqual(formatDiagnosticSource("mcp-server"), "mcp-server");
});

test("formatDiagnosticSource: empty string returns safe fallback", () => {
  const result = formatDiagnosticSource("");
  assert.strictEqual(typeof result, "string");
  assert.ok(result.length > 0, "empty source must not return an empty string");
});

test("formatDiagnosticSource: null/undefined returns safe fallback", () => {
  const r1 = formatDiagnosticSource(null);
  const r2 = formatDiagnosticSource(undefined);
  assert.strictEqual(typeof r1, "string");
  assert.ok(r1.length > 0, "null source must not return empty string");
  assert.strictEqual(typeof r2, "string");
  assert.ok(r2.length > 0, "undefined source must not return empty string");
});

// ============================================================
// formatDiagnosticSeverity
// ============================================================

test("formatDiagnosticSeverity: 'info' returns 'INFO'", () => {
  assert.strictEqual(formatDiagnosticSeverity("info"), "INFO");
});

test("formatDiagnosticSeverity: 'warning' returns 'WARNING'", () => {
  assert.strictEqual(formatDiagnosticSeverity("warning"), "WARNING");
});

test("formatDiagnosticSeverity: 'error' returns 'ERROR'", () => {
  assert.strictEqual(formatDiagnosticSeverity("error"), "ERROR");
});

test("formatDiagnosticSeverity: null/undefined returns safe fallback", () => {
  const r = formatDiagnosticSeverity(null);
  assert.strictEqual(typeof r, "string");
  assert.ok(r.length > 0, "null severity must not return empty string");
});
