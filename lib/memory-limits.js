// memory-limits.js — daemon.json advanced-settings override for systemd memory limits
// and MemoryHigh watermark detection (lr-de07, lr-c10f6d).
//
// DESIGN: The shipped unit file (deploy/clagentic-console.service) carries
// percentage-based defaults (MemoryHigh=70%, MemoryMax=85%) as a documentation
// fallback only. Inside an LXC container, systemd resolves a `%` directive
// against the cgroup-visible MemTotal at the HOST layer, not the container's
// true RAM — only userspace (via lxcfs) sees the container-true /proc/meminfo
// value. A `%` unit-file directive is therefore silently miscalibrated inside
// a container (lr-c10f6d). To make the ceiling actually operative, this module
// computes ABSOLUTE byte values from /proc/meminfo MemTotal in userspace and
// writes them into the drop-in unconditionally on every postinstall, so the
// applied cgroup limit always tracks the container-true RAM.
//
// Override reach: a systemd drop-in written to
//   /etc/systemd/system/clagentic-console.service.d/memory-overrides.conf
// overrides only the MemoryMax and MemoryHigh [Service] lines. All other unit
// settings remain exactly as shipped.
//
// Precedence (unchanged semantics from lr-de07): an explicit operator
// config.memoryHigh / config.memoryMax in daemon.json always wins over the
// computed default.

'use strict';

var fs = require('fs');
var path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var DROP_IN_DIR = '/etc/systemd/system/clagentic-console.service.d';
var DROP_IN_FILE = path.join(DROP_IN_DIR, 'memory-overrides.conf');

// Computed-default fractions (lr-c10f6d) — applied when the operator has not
// set an explicit memoryHigh/memoryMax override in daemon.json. Values are
// resolved against /proc/meminfo MemTotal (lxcfs-correct inside a container)
// and written as absolute bytes, since a `%` unit-file directive is resolved
// by systemd at the host cgroup layer and is wrong inside an LXC container.
var DEFAULT_MEMORY_HIGH_FRACTION = 0.60;
var DEFAULT_MEMORY_MAX_FRACTION = 0.75;

// Accepted units for absolute memory values.
// Systemd accepts K, M, G, T (case-insensitive) and bare bytes.
var ABS_PATTERN = /^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/i;
var PCT_PATTERN = /^(\d+(?:\.\d+)?)\s*%$/;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate a memory limit value accepted by systemd MemoryMax/MemoryHigh.
 *
 * Accepts:
 *   - Percentage string: '70%', '85%'  (0 < value <= 100)
 *   - Absolute with suffix: '6G', '512M', '2T', '1024K', '8192'
 *
 * Returns { ok: true, value: <normalized-string> } on success, where the
 * normalized value is the canonical string to write into the drop-in.
 * Returns { ok: false, error: <string> } on failure.
 *
 * @param {string} raw
 * @returns {{ ok: boolean, value?: string, error?: string }}
 */
function parseMemoryLimit(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'memory limit must be a non-empty string' };
  }
  var s = raw.trim();

  // Percentage
  var pctMatch = s.match(PCT_PATTERN);
  if (pctMatch) {
    var pct = parseFloat(pctMatch[1]);
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      return { ok: false, error: 'percentage must be between 0 (exclusive) and 100 (inclusive), got: ' + raw };
    }
    // Systemd requires integer percentages in unit files; reject fractional.
    if (pct !== Math.floor(pct)) {
      return { ok: false, error: 'percentage must be a whole number, got: ' + raw };
    }
    return { ok: true, value: Math.round(pct) + '%' };
  }

  // Absolute value with optional suffix
  var absMatch = s.match(ABS_PATTERN);
  if (absMatch) {
    var num = parseFloat(absMatch[1]);
    var suffix = (absMatch[2] || '').toUpperCase();
    if (isNaN(num) || num <= 0) {
      return { ok: false, error: 'absolute memory value must be positive, got: ' + raw };
    }
    // Reject fractional bytes (no suffix) — ambiguous.
    if (!suffix && num !== Math.floor(num)) {
      return { ok: false, error: 'bare byte count must be a whole number, got: ' + raw };
    }
    // Normalize: integer + suffix, e.g. '6G', '512M'
    var normalized = (Number.isInteger(num) ? num : num) + suffix;
    return { ok: true, value: normalized };
  }

  return { ok: false, error: 'unrecognized memory limit format (expected NNN%, NG, NM, NK, or bare bytes): ' + raw };
}

// ---------------------------------------------------------------------------
// Drop-in rendering
// ---------------------------------------------------------------------------

/**
 * Render the content of the systemd drop-in file for memory overrides.
 *
 * Only MemoryHigh and/or MemoryMax are emitted — one or both depending on
 * which overrides are present. If neither is set, returns null (no drop-in
 * should be written).
 *
 * The drop-in first resets each directive to empty (clears the shipped default)
 * then sets the operator-supplied value, per systemd drop-in semantics.
 *
 * @param {{ memoryHigh?: string, memoryMax?: string }} opts
 * @returns {string|null}
 */
function renderDropIn(opts) {
  var lines = ['# Generated by Clagentic: Console (lr-de07). Do not edit manually.',
               '# Remove this file and run systemctl daemon-reload to restore shipped defaults.',
               '[Service]'];
  var hasAny = false;

  if (opts.memoryHigh) {
    var hRes = parseMemoryLimit(opts.memoryHigh);
    if (!hRes.ok) throw new Error('memoryHigh: ' + hRes.error);
    // Reset then set (systemd drop-in semantics: empty value clears inherited).
    lines.push('MemoryHigh=');
    lines.push('MemoryHigh=' + hRes.value);
    hasAny = true;
  }

  if (opts.memoryMax) {
    var mRes = parseMemoryLimit(opts.memoryMax);
    if (!mRes.ok) throw new Error('memoryMax: ' + mRes.error);
    lines.push('MemoryMax=');
    lines.push('MemoryMax=' + mRes.value);
    hasAny = true;
  }

  if (!hasAny) return null;
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Drop-in apply (called from postinstall.js after root check)
// ---------------------------------------------------------------------------

/**
 * Read /proc/meminfo MemTotal in bytes.
 *
 * Inside an LXC container, lxcfs virtualizes this path so it reports the
 * container-true total rather than the host's — this is the value systemd's
 * own `%` resolution gets wrong (lr-c10f6d), so all default-limit computation
 * must read it directly in userspace rather than rely on a unit-file `%`.
 *
 * @param {string} [procMeminfoPath]  — override for testing (default '/proc/meminfo')
 * @returns {number|null}  MemTotal in bytes, or null if unreadable/unparsable
 */
function readMemTotalBytes(procMeminfoPath) {
  try {
    var raw = fs.readFileSync(procMeminfoPath || '/proc/meminfo', 'utf8');
    var match = raw.match(/^MemTotal:\s+(\d+)\s+kB/m);
    if (!match) return null;
    return parseInt(match[1], 10) * 1024;
  } catch (_) {
    return null;
  }
}

/**
 * Compute the default absolute MemoryHigh/MemoryMax values (as systemd
 * byte-suffix strings) from the container-true MemTotal.
 *
 * MemoryHigh = floor(60% of MemTotal), MemoryMax = floor(75% of MemTotal).
 * Returns null if MemTotal cannot be determined — callers must fall back to
 * leaving the shipped unit-file `%` defaults in place rather than writing a
 * bogus drop-in.
 *
 * @param {string} [procMeminfoPath]  — override for testing
 * @returns {{ memoryHigh: string, memoryMax: string, memTotalBytes: number }|null}
 */
function computeDefaultAbsoluteLimits(procMeminfoPath) {
  var memTotalBytes = readMemTotalBytes(procMeminfoPath);
  if (memTotalBytes === null || memTotalBytes <= 0) return null;

  var highBytes = Math.floor(memTotalBytes * DEFAULT_MEMORY_HIGH_FRACTION);
  var maxBytes = Math.floor(memTotalBytes * DEFAULT_MEMORY_MAX_FRACTION);

  return {
    memoryHigh: String(highBytes),
    memoryMax: String(maxBytes),
    memTotalBytes: memTotalBytes,
  };
}

/**
 * Write the memory-overrides drop-in based on daemon.json config.
 *
 * Precedence (unchanged from lr-de07): an explicit operator config.memoryHigh
 * / config.memoryMax always wins. When neither is set, a computed-absolute
 * default is written instead (lr-c10f6d) — floor(60%) / floor(75%) of the
 * container-true /proc/meminfo MemTotal, resolved in userspace because a `%`
 * unit-file directive is resolved by systemd against the wrong MemTotal
 * inside an LXC container. The drop-in is written unconditionally (every
 * postinstall) so it tracks RAM changes; if MemTotal cannot be determined,
 * any existing drop-in is removed so the shipped unit-file `%` lines apply
 * as a last-resort fallback.
 *
 * Validates values before writing — throws on invalid input so postinstall
 * can log and abort rather than silently writing a broken unit.
 *
 * @param {{ memoryHigh?: string, memoryMax?: string }} cfg  — subset of daemon.json
 * @param {function(string): void} [log]  — optional logger (defaults to console.log)
 * @param {string} [procMeminfoPath]  — override for testing (default '/proc/meminfo')
 */
function applyDropIn(cfg, log, procMeminfoPath) {
  var _log = log || function (msg) { console.log(msg); };

  var hasOverride = cfg && (cfg.memoryHigh || cfg.memoryMax);
  var effective;
  if (hasOverride) {
    effective = { memoryHigh: cfg.memoryHigh, memoryMax: cfg.memoryMax };
  } else {
    var computed = computeDefaultAbsoluteLimits(procMeminfoPath);
    if (!computed) {
      // MemTotal undeterminable — remove any stale drop-in so the shipped
      // unit-file % defaults apply (best available fallback).
      try {
        if (fs.existsSync(DROP_IN_FILE)) {
          fs.unlinkSync(DROP_IN_FILE);
          _log('[memory-limits] Removed ' + DROP_IN_FILE + ' (MemTotal undeterminable — shipped % defaults apply)');
        } else {
          _log('[memory-limits] WARNING: could not read /proc/meminfo MemTotal — shipped % defaults apply (inoperative inside a container, see lr-c10f6d)');
        }
      } catch (e) {
        _log('[memory-limits] WARNING: could not remove drop-in ' + DROP_IN_FILE + ': ' + e.message);
      }
      return;
    }
    effective = { memoryHigh: computed.memoryHigh, memoryMax: computed.memoryMax };
    _log('[memory-limits] No operator override — computing absolute defaults from MemTotal=' + computed.memTotalBytes + ' bytes '
      + '(MemoryHigh=' + computed.memoryHigh + ', MemoryMax=' + computed.memoryMax + ')');
  }

  // Render — throws on invalid format.
  var content = renderDropIn({ memoryHigh: effective.memoryHigh, memoryMax: effective.memoryMax });
  if (!content) return; // shouldn't happen given effective always sets both

  try {
    fs.mkdirSync(DROP_IN_DIR, { recursive: true });
  } catch (e) {
    throw new Error('Cannot create drop-in dir ' + DROP_IN_DIR + ': ' + e.message);
  }

  // Atomic write via tmp-rename.
  var tmp = DROP_IN_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, DROP_IN_FILE);
    _log('[memory-limits] Wrote memory-overrides drop-in to ' + DROP_IN_FILE);
    if (effective.memoryHigh) _log('[memory-limits]   MemoryHigh=' + effective.memoryHigh);
    if (effective.memoryMax)  _log('[memory-limits]   MemoryMax=' + effective.memoryMax);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error('Cannot write drop-in ' + DROP_IN_FILE + ': ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// MemoryHigh watermark watcher
// ---------------------------------------------------------------------------

// How often to poll for the MemoryHigh watermark (ms).
// Long enough to avoid hot-loop cost; short enough to catch a crossing quickly.
var POLL_INTERVAL_MS = 5000;

/**
 * Derive the MemoryHigh threshold in bytes from config and the live cgroup.
 *
 * Priority:
 *   1. config.memoryHigh (operator override, parsed to bytes)
 *   2. The live cgroup v2 memory.high value (covers both shipped % default and drop-in)
 *   3. null (no threshold determinable)
 *
 * @param {{ memoryHigh?: string }} cfg
 * @returns {number|null}  threshold in bytes, or null
 */
function resolveMemoryHighBytes(cfg) {
  // 1. Operator override in config.
  if (cfg && cfg.memoryHigh) {
    var parsed = parseMemoryLimit(cfg.memoryHigh);
    if (parsed.ok) {
      var b = memoryValueToBytes(parsed.value);
      if (b !== null) return b;
    }
  }

  // 2. Live cgroup v2 value (covers percentage defaults and already-applied drop-ins).
  try {
    var cgDir = '/sys/fs/cgroup/system.slice/clagentic-console.service';
    var highRaw = fs.readFileSync(cgDir + '/memory.high', 'utf8').trim();
    if (highRaw !== 'max' && highRaw !== '') {
      var highBytes = parseInt(highRaw, 10);
      if (!isNaN(highBytes) && highBytes > 0) return highBytes;
    }
  } catch (_) {}

  return null;
}

/**
 * Convert a normalized memory limit string to bytes.
 * Returns null if it cannot be resolved to a byte count at runtime
 * (e.g. a percentage string — percentage resolution requires total RAM).
 *
 * @param {string} value  — e.g. '6G', '512M', '70%'
 * @returns {number|null}
 */
function memoryValueToBytes(value) {
  if (!value) return null;

  // Percentage: resolve against /proc/meminfo MemTotal.
  var pctMatch = value.match(/^(\d+(?:\.\d+)?)%$/);
  if (pctMatch) {
    var totalBytes = readMemTotalBytes();
    if (totalBytes === null) return null;
    return Math.floor(totalBytes * parseFloat(pctMatch[1]) / 100);
  }

  // Absolute with suffix.
  var absMatch = value.match(/^(\d+(?:\.\d+)?)([KMGT]?)$/i);
  if (!absMatch) return null;
  var n = parseFloat(absMatch[1]);
  var unit = (absMatch[2] || '').toUpperCase();
  var multipliers = { '': 1, K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024, T: 1024 * 1024 * 1024 * 1024 };
  var mul = multipliers[unit];
  if (mul === undefined) return null;
  return Math.floor(n * mul);
}

/**
 * Read the cgroup v2 memory.events 'high' counter for the service cgroup.
 * Returns the counter value as a number, or null if unavailable.
 *
 * @returns {number|null}
 */
function readCgroupHighCounter() {
  try {
    var cgDir = '/sys/fs/cgroup/system.slice/clagentic-console.service';
    var raw = fs.readFileSync(cgDir + '/memory.events', 'utf8');
    var match = raw.match(/^high\s+(\d+)/m);
    if (match) return parseInt(match[1], 10);
  } catch (_) {}
  return null;
}

/**
 * Read the current cgroup v2 RSS (memory.current) in bytes, or null.
 *
 * @returns {number|null}
 */
function readCgroupCurrentBytes() {
  try {
    var cgDir = '/sys/fs/cgroup/system.slice/clagentic-console.service';
    var raw = fs.readFileSync(cgDir + '/memory.current', 'utf8').trim();
    var n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// Startup sanity check: applied cgroup ceiling vs container-true RAM (lr-c10f6d)
// ---------------------------------------------------------------------------

/**
 * Compare the applied cgroup memory.max ceiling against /proc/meminfo MemTotal.
 *
 * The postinstall drop-in computes MemoryMax from MemTotal itself, so under
 * normal operation this check always passes. It exists as a last-line-of-defense
 * sanity check for any host where the drop-in was not applied, was hand-edited,
 * or is stale relative to a MemTotal that changed without a re-run of postinstall
 * (e.g. hot RAM resize) — in any of those cases the ceiling is 'max' (unset) or
 * greater than the container's actual RAM, meaning OOMPolicy=kill can never fire
 * before the kernel host-level OOM killer wedges the box (the lr-2ea2a7 failure
 * mode this task exists to close off).
 *
 * @param {object} [opts]
 * @param {string} [opts.cgroupMemoryMaxPath]  — override for testing
 *   (default '/sys/fs/cgroup/system.slice/clagentic-console.service/memory.max')
 * @param {string} [opts.procMeminfoPath]  — override for testing (default '/proc/meminfo')
 * @returns {{
 *   ok: boolean,
 *   inoperative: boolean,
 *   reason: string|null,
 *   appliedMaxBytes: number|null,
 *   appliedMaxRaw: string|null,
 *   memTotalBytes: number|null
 * }}
 *   ok=false when either value could not be determined (nothing to compare —
 *   not itself a fault). inoperative=true when the applied ceiling is 'max'
 *   (unset) or >= MemTotal.
 */
function checkAppliedMemoryCeiling(opts) {
  var o = opts || {};
  var cgPath = o.cgroupMemoryMaxPath
    || '/sys/fs/cgroup/system.slice/clagentic-console.service/memory.max';

  var appliedRaw = null;
  try {
    appliedRaw = fs.readFileSync(cgPath, 'utf8').trim();
  } catch (e) {
    return {
      ok: false,
      inoperative: false,
      reason: 'cgroup memory.max unreadable at ' + cgPath + ': ' + e.message,
      appliedMaxBytes: null,
      appliedMaxRaw: null,
      memTotalBytes: null,
    };
  }

  var memTotalBytes = readMemTotalBytes(o.procMeminfoPath);
  if (memTotalBytes === null) {
    return {
      ok: false,
      inoperative: false,
      reason: 'MemTotal unreadable from /proc/meminfo',
      appliedMaxBytes: null,
      appliedMaxRaw: appliedRaw,
      memTotalBytes: null,
    };
  }

  if (appliedRaw === 'max') {
    return {
      ok: true,
      inoperative: true,
      reason: 'applied memory.max is \'max\' (no cgroup ceiling set) — OOM protection inoperative',
      appliedMaxBytes: null,
      appliedMaxRaw: appliedRaw,
      memTotalBytes: memTotalBytes,
    };
  }

  var appliedMaxBytes = parseInt(appliedRaw, 10);
  if (isNaN(appliedMaxBytes)) {
    return {
      ok: false,
      inoperative: false,
      reason: 'applied memory.max value is not parsable: ' + appliedRaw,
      appliedMaxBytes: null,
      appliedMaxRaw: appliedRaw,
      memTotalBytes: memTotalBytes,
    };
  }

  var inoperative = appliedMaxBytes >= memTotalBytes;
  return {
    ok: true,
    inoperative: inoperative,
    reason: inoperative
      ? 'applied memory.max (' + appliedMaxBytes + ' bytes) >= container MemTotal (' + memTotalBytes + ' bytes) — OOM protection inoperative'
      : null,
    appliedMaxBytes: appliedMaxBytes,
    appliedMaxRaw: appliedRaw,
    memTotalBytes: memTotalBytes,
  };
}

/**
 * Start polling for MemoryHigh watermark crossings and emit a structured log
 * event when the soft memory ceiling is breached.
 *
 * Detection strategy (in priority order):
 *   A. cgroup v2 memory.events 'high' counter increment — most accurate;
 *      fired by the kernel when the service's memory usage exceeds MemoryHigh.
 *   B. memory.current vs resolved MemoryHigh threshold — fallback when the
 *      cgroup path is not accessible (e.g. running outside systemd in dev).
 *
 * De-duplication: once a watermark-crossing event is emitted, no further events
 * are emitted until the memory drops back below the threshold and rises again
 * (for counter-based detection: until the last-seen counter value changes again
 * after a reset; for RSS-based: until RSS drops below threshold by a 5% hysteresis
 * before re-alerting).
 *
 * The emitted log line is a JSON object on stderr so that structured log
 * consumers (lr-6b30 and friends) can parse it without log-parsing fragility.
 *
 * @param {{ memoryHigh?: string, memoryMax?: string }} cfg  — subset of daemon.json
 * @param {object} [opts]
 * @param {number} [opts.pollIntervalMs]  — polling interval (default 5000)
 * @param {function(object): void} [opts.onCrossing]  — called with the same
 *   detail object that is written to the log whenever a watermark crossing is
 *   detected. Consumers (lr-6b30 drain) use this instead of parsing stderr.
 * @returns {{ stop: function(): void }}  handle to stop the watcher
 */
function startMemoryHighWatcher(cfg, opts) {
  var pollMs = (opts && opts.pollIntervalMs) || POLL_INTERVAL_MS;
  var onCrossing = (opts && typeof opts.onCrossing === 'function') ? opts.onCrossing : null;

  // State for de-duplication.
  var lastHighCounter = null;      // last 'high' counter value seen (strategy A)
  var isAboveThreshold = false;    // for strategy B hysteresis
  var HYSTERESIS_FRACTION = 0.05;  // 5% drop required before re-alerting

  var handle = setInterval(function () {
    try {
      _poll(cfg);
    } catch (e) {
      // Polling must never crash the daemon.
    }
  }, pollMs);

  // Unref so the watcher doesn't keep the process alive if everything else exits.
  if (handle && typeof handle.unref === 'function') handle.unref();

  function _emitWarning(detail) {
    var event = {
      event: 'memory_high_watermark',
      source: detail.source,
      timestamp: new Date().toISOString(),
    };
    if (detail.highCounter !== undefined) event.highCounter = detail.highCounter;
    if (detail.currentBytes !== undefined) event.currentBytes = detail.currentBytes;
    if (detail.thresholdBytes !== undefined) event.thresholdBytes = detail.thresholdBytes;
    // Emit as a prefixed JSON line on stderr (journald captures stderr to the journal).
    process.stderr.write('[memory-limits] WARN memory_high_watermark ' + JSON.stringify(event) + '\n');
    // Notify any registered crossing consumer (e.g. lr-6b30 drain controller).
    if (onCrossing) {
      try { onCrossing(event); } catch (_) {}
    }
  }

  function _poll(c) {
    // Strategy A: cgroup v2 memory.events high counter.
    var highCounter = readCgroupHighCounter();
    if (highCounter !== null) {
      if (lastHighCounter === null) {
        // First observation — record baseline, do not alert.
        lastHighCounter = highCounter;
        return;
      }
      if (highCounter > lastHighCounter) {
        // Counter advanced — kernel confirmed a MemoryHigh crossing.
        var currentBytes = readCgroupCurrentBytes();
        _emitWarning({
          source: 'cgroup.memory.events',
          highCounter: highCounter,
          currentBytes: currentBytes !== null ? currentBytes : undefined,
        });
        lastHighCounter = highCounter;
      }
      // Counter-based path is definitive — skip RSS fallback.
      return;
    }

    // Strategy B: compare RSS against resolved threshold.
    var threshold = resolveMemoryHighBytes(c);
    if (threshold === null) return; // no threshold determinable

    var currentB = readCgroupCurrentBytes();
    if (currentB === null) {
      // Fallback: use process.memoryUsage().rss when cgroup current is unavailable.
      currentB = process.memoryUsage().rss;
    }

    var hysteresisBytes = Math.floor(threshold * HYSTERESIS_FRACTION);
    if (!isAboveThreshold && currentB > threshold) {
      isAboveThreshold = true;
      _emitWarning({
        source: 'rss_vs_threshold',
        currentBytes: currentB,
        thresholdBytes: threshold,
      });
    } else if (isAboveThreshold && currentB < threshold - hysteresisBytes) {
      // Memory dropped back below threshold (with hysteresis) — reset so a
      // future crossing triggers another warning.
      isAboveThreshold = false;
    }
  }

  return {
    stop: function () {
      clearInterval(handle);
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  DROP_IN_FILE: DROP_IN_FILE,
  DEFAULT_MEMORY_HIGH_FRACTION: DEFAULT_MEMORY_HIGH_FRACTION,
  DEFAULT_MEMORY_MAX_FRACTION: DEFAULT_MEMORY_MAX_FRACTION,
  parseMemoryLimit: parseMemoryLimit,
  renderDropIn: renderDropIn,
  applyDropIn: applyDropIn,
  readMemTotalBytes: readMemTotalBytes,
  computeDefaultAbsoluteLimits: computeDefaultAbsoluteLimits,
  resolveMemoryHighBytes: resolveMemoryHighBytes,
  memoryValueToBytes: memoryValueToBytes,
  startMemoryHighWatcher: startMemoryHighWatcher,
  checkAppliedMemoryCeiling: checkAppliedMemoryCeiling,
};
