"use strict";

// client-build-id.js — the one identity a browser compares to decide whether the
// client code it is running still matches the daemon that serves it.
//
// It is keyed on the BUILD, not on package.json's version: two builds can share
// a version (consecutive betas do), and a client keyed on the version then never
// notices the restart onto the newer one. The build SHA the daemon loaded at
// startup is used when the install carries one; a checkout without
// lib/build-sha.json gets a per-start nonce, so a restart still changes the id.

var crypto = require("crypto");

var SERVICE_WORKER_CACHE_PATTERN = /var CACHE_NAME = "clagentic-console-offline-[^"]*"/;

var current = null;

function newNonce() {
  return "start-" + crypto.randomBytes(6).toString("hex");
}

/**
 * Fixes the id for this process. Called once, with the SHA the daemon captured
 * at startup (null when the install has none). Later calls are ignored: an id
 * that moved mid-process would tell clients to reload for no deploy.
 */
function init(buildSha) {
  if (current) return current;
  current = typeof buildSha === "string" && buildSha ? buildSha : newNonce();
  return current;
}

/** The id for this process; a nonce when init was never given a SHA. */
function get() {
  return current || init(null);
}

// Cache names are restricted to a conservative alphabet: the id is embedded in
// served JavaScript, and a hand-edited build-sha.json must not break out of it.
function cacheSafe(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * The service worker source with its cache name stamped for `buildId`. A
 * different id yields different bytes, which is what makes the browser install
 * the new worker after a restart onto a new build.
 */
function stampServiceWorker(source, buildId) {
  return source.replace(
    SERVICE_WORKER_CACHE_PATTERN,
    'var CACHE_NAME = "clagentic-console-offline-v' + cacheSafe(buildId) + '"'
  );
}

/** Test seam: forget the fixed id so a test can start from a clean process. */
function resetForTest() {
  current = null;
}

module.exports = { init: init, get: get, stampServiceWorker: stampServiceWorker, resetForTest: resetForTest };
