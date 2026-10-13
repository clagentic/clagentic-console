// YOKE - Yoke Overrides Known Engines
// Public entry point.

var iface = require("./interface");
var instructions = require("./instructions");
var registry = require("./registry");
var installProbe = require("./install-probe");
var capabilities = require("./capabilities");
// Requiring the vendor modules registers the shipped agents. They are light on
// purpose: the adapters themselves are loaded when one is created.
require("./adapters/claude-vendor");
require("./adapters/codex-vendor");

/**
 * Wrap adapter.createQuery to inject cross-vendor project instructions.
 *
 * Scans the project directory for instruction files (CLAUDE.md, AGENTS.md,
 * .cursorrules, etc.) that the current vendor does NOT natively read,
 * and merges them into queryOpts.systemPrompt before calling the real
 * createQuery. This way every adapter gets project context regardless
 * of which vendor wrote the instruction file.
 */
function wrapCreateQuery(adapter, defaultCwd) {
  var originalCreateQuery = adapter.createQuery.bind(adapter);

  adapter.createQuery = function(queryOpts) {
    queryOpts = queryOpts || {};
    var projectDir = (queryOpts && queryOpts.cwd) || defaultCwd;
    var merged = instructions.scanAndMerge(projectDir, adapter.vendor);

    if (merged) {
      var parts = [];
      if (queryOpts.systemPrompt) parts.push(queryOpts.systemPrompt);
      parts.push(merged);
      queryOpts.systemPrompt = parts.join("\n\n");
    }

    return originalCreateQuery(queryOpts);
  };
}

// A vendor name that arrives from a client is checked here before it is used as
// a key or handed to a lookup.
function isKnownVendor(vendor) {
  return registry.isKnown(vendor);
}

/**
 * Create a YOKE adapter for a registered vendor.
 *
 * @param {object} opts
 * @param {string} [opts.vendor] - Registered vendor id (default: the most preferred)
 * @param {string} opts.cwd              - Project working directory
 * @param {object} [opts.adapterOpts]    - Vendor-specific adapter construction options
 * @returns {Adapter}
 * @throws {Error} code YOKE_UNKNOWN_VENDOR for a vendor that is not registered
 */
function createAdapter(opts) {
  var vendor = (opts && opts.vendor) || registry.ids()[0];
  var adapter = registry.get(vendor).createAdapter(opts);
  iface.validateAdapter(adapter);
  wrapCreateQuery(adapter, opts && opts.cwd);
  return adapter;
}

/**
 * Check which vendors have valid auth credentials.
 * Result is cached after first call (auth state doesn't change during runtime).
 * Call invalidateAuthCache() to force re-check (e.g. after login).
 */
var _authCache = null;
var _lastAuthLogKey = null;
var _lastAuthLogAt = 0;

function logAuthCheck(auth) {
  var key = JSON.stringify(auth || {});
  var now = Date.now();
  if (_lastAuthLogKey === key && now - _lastAuthLogAt < 30000) return;
  _lastAuthLogKey = key;
  _lastAuthLogAt = now;
  console.log("[yoke] Auth check: " + Object.keys(auth).map(function(id) { return id + "=" + auth[id]; }).join(" "));
}

function checkAuth() {
  if (_authCache) return _authCache;

  var result = {};
  registry.list().forEach(function(vendor) {
    result[vendor.id] = !!vendor.checkAuth();
  });
  _authCache = result;
  logAuthCheck(_authCache);
  return _authCache;
}

/**
 * Check which vendor binaries are installed (regardless of auth status).
 *
 * Result is cached at module scope because the check runs a subprocess per
 * vendor per invocation and is triggered once per project context on daemon
 * startup. With N projects that would cost N times the vendors synchronous
 * subprocesses; caching collapses it to one pass. The cache is invalidated
 * alongside the auth cache (via invalidateAuthCache) since "just installed" is
 * the same situation as "just logged in" from the daemon's perspective.
 */
var _installedCache = null;

function checkInstalled() {
  if (_installedCache) return _installedCache;

  var installedIds = installProbe.detectInstalledVendors(null);
  var result = {};
  registry.ids().forEach(function(id) { result[id] = installedIds.indexOf(id) !== -1; });
  _installedCache = result;
  return result;
}

function invalidateAuthCache() {
  _authCache = null;
  _installedCache = null;
  // A probe may remember what it found (a resolved binary and its version).
  registry.list().forEach(function(vendor) {
    if (typeof vendor.recheck === "function") vendor.recheck();
  });
}

/**
 * Create adapters for all installed vendors.
 * A vendor whose runtime is per project (the perProjectRuntime trait: its
 * app-server and bridge stay scoped to one project slug) is instantiated per
 * project; the others are shared across projects.
 * Returns { adapters: { vendor: Adapter }, auth: { vendor: boolean } }
 */
var _sharedAdapters = {};

function createAdapters(opts) {
  opts = opts || {};
  // Gate adapter creation on binary installation, not OAuth auth status.
  // Claude Code supports multiple auth modes (OAuth, Bedrock, Vertex, API key)
  // that `claude auth status` does not always detect. Runtime auth failures are
  // handled downstream via query-level error detection.
  var installed = checkInstalled();
  var auth = {};
  var adapters = {};

  registry.list().forEach(function(vendor) {
    auth[vendor.id] = false;
    if (!installed[vendor.id]) return;
    try {
      if (vendor.perProjectRuntime) {
        adapters[vendor.id] = createAdapter({ vendor: vendor.id, cwd: opts.cwd, slug: opts.slug, osUsers: !!opts.osUsers });
      } else {
        if (!_sharedAdapters[vendor.id]) {
          _sharedAdapters[vendor.id] = createAdapter({ vendor: vendor.id, cwd: opts.cwd });
        }
        adapters[vendor.id] = _sharedAdapters[vendor.id];
      }
      auth[vendor.id] = true;
      console.log("[yoke] Adapter created: " + vendor.id);
    } catch (e) {
      console.error("[yoke] Failed to create adapter for " + vendor.id + ":", e.message);
    }
  });

  return { adapters: adapters, auth: auth };
}

/**
 * Lazy-create an adapter for a vendor that wasn't available at startup.
 * Re-checks auth, creates adapter if now logged in.
 * Returns the adapter or null.
 *
 * onInit, when given, is called with what the adapter's init() resolved with
 * (its models and the capabilities the live session advertises), so the caller
 * records them: the init result is the only place those are reported.
 */
async function lazyCreateAdapter(adapters, vendor, opts, onInit) {
  opts = opts || {};

  // Force re-check since user may have logged in after server start
  invalidateAuthCache();
  var installed = checkInstalled();
  if (!installed[vendor]) return null;

  try {
    var ad = createAdapter({ vendor: vendor, cwd: opts.cwd, slug: opts.slug, osUsers: !!opts.osUsers });
    if (typeof ad.init === "function") {
      var initResult = await ad.init(opts || {});
      if (typeof onInit === "function") onInit(initResult);
    }
    console.log("[yoke] Lazy adapter created: " + vendor);
    adapters[vendor] = ad;
    return ad;
  } catch (e) {
    console.error("[yoke] Failed to lazy-create adapter for " + vendor + ":", e.message);
    return null;
  }
}

module.exports = {
  isKnownVendor: isKnownVendor,
  registry: registry,
  resolveCapabilities: capabilities.resolveCapabilities,
  completeCapabilities: iface.completeCapabilities,
  detectInstalledVendors: installProbe.detectInstalledVendors,
  detectVendorInstallState: installProbe.detectVendorInstallState,
  createAdapter: createAdapter,
  createAdapters: createAdapters,
  lazyCreateAdapter: lazyCreateAdapter,
  checkAuth: checkAuth,
  checkInstalled: checkInstalled,
  invalidateAuthCache: invalidateAuthCache,
  INTERFACE_VERSION: iface.INTERFACE_VERSION,
  TOOL_POLICIES: iface.TOOL_POLICIES,
  CAPABILITIES: iface.CAPABILITIES,
  DIAGNOSTIC_SEVERITIES: iface.DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES: iface.DIAGNOSTIC_SOURCES,
  validateAdapter: iface.validateAdapter,
  validateQueryHandle: iface.validateQueryHandle,
  validateDiagnosticEvent: iface.validateDiagnosticEvent,
};
