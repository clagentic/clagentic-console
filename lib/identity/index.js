"use strict";

// The identity surface of the console (contract version 1.0.0).
//
// At the start of an agent session the console asks its configured provider for
// an Identity Assertion, delivers it to the session's process through a private
// directory named by CLAGENTIC_IDENTITY_DIR, and removes the directory when the
// session ends. With nothing configured (the default) none of this runs: no
// provider is created, no file is touched, nothing is logged, and the session's
// environment is exactly what it was without the surface.
//
// When a provider is configured and cannot supply an identity, the session still
// starts, without CLAGENTIC_IDENTITY_DIR, and the person is told. Nothing is
// fabricated and no inherited identity is passed on.
//
// Runtimes. Claude sessions are covered. A Codex session is not: one Codex
// server process serves many threads, and an environment variable belongs to a
// process, so a per-session assertion cannot be told apart from another thread's.
// A Codex session therefore runs as class 3 (no assertion) and its record says so.

var contract = require("./contract");
var config = require("./config");
var delivery = require("./delivery");
var originMap = require("./origin");
var unavailableModule = require("./unavailable");
var gatekeeperProvider = require("./providers/gatekeeper");
var jwksSelfProvider = require("./providers/jwks-self");
var moduleProvider = require("./providers/module");

var unavailable = unavailableModule.unavailable;

var COVERED_RUNTIME = "claude-code";
var PROVIDER_TIMEOUT_MS = 15000;

// onTimeout runs when the limit wins the race, so the caller can cancel the
// provider and claim whatever it yields later.
function withTimeout(promise, ms, onTimeout) {
  var timer;
  var limit = new Promise(function (resolve) {
    timer = setTimeout(function () {
      // Settled before onTimeout runs: cancelling the provider can settle its own
      // promise synchronously, and that must not outrank the timeout.
      resolve(unavailable("provider_timeout", "the identity provider did not answer in time"));
      if (onTimeout) onTimeout();
    }, ms);
  });
  return Promise.race([promise, limit]).finally(function () { clearTimeout(timer); });
}

function createProvider(cfg, warn) {
  switch (cfg.provider) {
    case contract.PROVIDERS.GATEKEEPER: return gatekeeperProvider.createGatekeeperProvider(cfg, { warn: warn });
    case contract.PROVIDERS.JWKS_SELF: return jwksSelfProvider.createJwksSelfProvider(cfg);
    default: return moduleProvider.createModuleProvider(cfg, { warn: warn });
  }
}

function declaredLease(origin, result) {
  return {
    dir: null,
    record: { provider: contract.PROVIDERS.DECLARED, grade: null, origin: origin, unavailable: result.code },
    notice: result.quiet
      ? null
      : "Clagentic: Console could not obtain an identity for this session (" + result.reason + "). The session is running without one.",
    release: function () {},
  };
}

// options.getConfig() returns the `identity` block of the configuration (or
// undefined); it is read at every session start, so a change reaches the next one.
// options.providerTimeoutMs overrides how long a provider may take; it exists so a
// test can make a provider settle late, and nothing in the console sets it.
function createIdentity(options) {
  var warn = options.warn || console.warn;
  var providerTimeoutMs = options.providerTimeoutMs > 0 ? options.providerTimeoutMs : PROVIDER_TIMEOUT_MS;
  var current = { key: null, cfg: null, provider: null };

  function resolve() {
    var raw = options.getConfig();
    var key = raw === undefined || raw === null ? "" : JSON.stringify(raw);
    if (current.key !== key || current.cfg === null) {
      var cfg = config.resolveConfig(raw, options.configDir);
      current = {
        key: key,
        cfg: cfg,
        provider: cfg.provider === "none" || cfg.provider === "invalid" ? null : createProvider(cfg, warn),
      };
    }
    return current;
  }

  function isEnabled() {
    var raw = options.getConfig();
    return raw !== undefined && raw !== null && resolve().cfg.provider !== "none";
  }

  // request: { definition, initiator, rt, owner }
  //   definition  the persona agent's name, or null
  //   initiator   the turn's initiator (lib/turn-initiator.js)
  //   rt          the runtime id of the session
  //   owner       { uid, gid } of the OS user the session runs as, or null
  // Returns null when no provider is configured, else a lease:
  //   { dir, record, notice, release }
  async function begin(request) {
    var state = resolve();
    if (state.cfg.provider === "none") return null;
    var origin = originMap.originForInitiator(request.initiator);
    if (state.cfg.provider === "invalid") return declaredLease(origin, unavailable("config_invalid", state.cfg.reason));
    if (request.rt !== COVERED_RUNTIME) {
      return declaredLease(origin, unavailable("runtime_unsupported",
        "this runtime shares one process between sessions", { quiet: true }));
    }
    if (!delivery.supported()) return declaredLease(origin, unavailable("platform_unsupported", "identity delivery is not supported on this platform"));

    var owner = request.owner || null;
    var ownerUid = owner ? owner.uid : process.getuid();
    var created = new Set();
    var abandoned = false;
    var controller = new AbortController();
    var ctx = {
      owner: owner,
      // Aborted when the console stops waiting; a provider should stop its work.
      signal: controller.signal,
      allocateDir: function () {
        if (abandoned) throw new Error("the console no longer waits for this identity session");
        var dir = delivery.allocateDir(state.cfg.spawnRoot, owner);
        created.add(dir);
        return dir;
      },
    };
    function discard() {
      created.forEach(function (dir) { delivery.removeDelivery(dir, ownerUid, true); });
    }
    // Ends a session the provider yielded: its own release, then the directory.
    function releaseSession(session) {
      return Promise.resolve()
        .then(function () { return state.provider.release && state.provider.release({ provider: session.provider, dir: session.dir }); })
        .catch(function (err) { warn("[identity] provider release failed: " + (err && err.message)); })
        .then(function () { delivery.removeDelivery(session.dir, ownerUid, created.has(session.dir)); });
    }

    var result;
    try {
      var pending = Promise.resolve(state.provider.obtainSession(request.definition || null, origin, request.rt, ctx));
      result = await withTimeout(pending, providerTimeoutMs, function () {
        abandoned = true;
        controller.abort();
        // Whatever the provider yields after this point has no lease to carry it.
        pending.then(function (late) {
          discard();
          if (late && !unavailableModule.isUnavailable(late) && typeof late.dir === "string") return releaseSession(late);
          return undefined;
        }).catch(function (err) {
          discard();
          warn("[identity] the provider failed after the console stopped waiting: " + (err && err.message));
        });
      });
    } catch (err) {
      warn("[identity] provider failed: " + (err && err.message));
      result = unavailable((err && err.identityCode) || "provider_error", err && err.identityCode ? err.message : "the identity provider failed");
    }
    if (unavailableModule.isUnavailable(result)) {
      discard();
      return declaredLease(origin, result);
    }

    var claims;
    try {
      if (result.assertion !== undefined) delivery.writeAssertion(result.dir, result.assertion, owner);
      claims = delivery.inspect(result.dir, ownerUid);
      // Whatever a provider says, a turn the console did not know a person typed
      // is never delivered as a human one.
      if (claims.origin === "human" && origin !== "human") {
        throw Object.assign(new Error("the assertion claims a human origin for a turn a person did not type"), { identityCode: "origin_mismatch" });
      }
    } catch (err) {
      discard();
      // The provider's own directory is removed only if it passes the same checks.
      delivery.removeDelivery(result.dir, ownerUid, false);
      warn("[identity] the provider's session was refused: " + (err && err.message));
      return declaredLease(origin, unavailable((err && err.identityCode) || "delivery_invalid", "the identity provider returned a session the console could not accept"));
    }

    var released = false;
    return {
      dir: result.dir,
      record: { provider: result.provider, grade: claims.grade, origin: claims.origin },
      notice: null,
      release: function () {
        if (released) return;
        released = true;
        releaseSession(result);
      },
    };
  }

  // A lease for a session that is to run without an identity for a reason the
  // caller found before asking any provider.
  function declared(initiator, code, reason) {
    return declaredLease(originMap.originForInitiator(initiator), unavailable(code, reason));
  }

  return { isEnabled: isEnabled, begin: begin, declared: declared };
}

module.exports = { createIdentity: createIdentity };
