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
var holderModule = require("./holder");
var originMap = require("./origin");
var unavailableModule = require("./unavailable");
var gatekeeperProvider = require("./providers/gatekeeper");
var jwksSelfProvider = require("./providers/jwks-self");
var moduleProvider = require("./providers/module");

var unavailable = unavailableModule.unavailable;

var COVERED_RUNTIME = "claude-code";
var PROVIDER_TIMEOUT_MS = 15000;

// Runs the provider's call and resolves with exactly one of
//   { value }      it answered (an answer may itself be an unavailability)
//   { error }      it threw or rejected
//   { timedOut }   it did not answer within `ms`
// When the limit wins, onTimeout(pending) runs so the caller can cancel the
// provider and claim whatever it yields later.
function askProvider(call, ms, onTimeout) {
  var pending = new Promise(function (resolve) { resolve(call()); });
  return new Promise(function (resolve) {
    var settled = false;
    function settle(outcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    }
    // The limit is decided before onTimeout runs: cancelling the provider can
    // settle its own promise synchronously, and that must not outrank the timeout.
    var timer = setTimeout(function () {
      settle({ timedOut: true });
      onTimeout(pending);
    }, ms);
    pending.then(function (value) { settle({ value: value }); }, function (error) { settle({ error: error || new Error("rejected") }); });
  });
}

// What a provider yields when it supplies a session: a directory, and so a
// thing to settle. An unavailability is not one.
function isSession(value) {
  return !!value && typeof value === "object" && !unavailableModule.isUnavailable(value) && typeof value.dir === "string";
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
// options.releaseTimeoutMs bounds how long a provider's release is waited on for a
// warning; it exists for the same reason.
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
    var holder = holderModule.createHolder({
      provider: state.provider, spawnRoot: state.cfg.spawnRoot, owner: owner, ownerUid: ownerUid,
      warn: warn, releaseTimeoutMs: options.releaseTimeoutMs,
    });
    var controller = new AbortController();
    var ctx = {
      owner: owner,
      // Aborted when the console stops waiting; a provider should stop its work.
      signal: controller.signal,
      allocateDir: holder.allocateDir,
      // The typed answer of a provider that cannot supply an identity.
      unavailable: unavailable,
    };

    // Every way this call can end goes through `holder`, once (lib/identity/holder.js):
    //   provider unavailable or failed     holder.end(null)
    //   console stops waiting (timeout)    holder.abandon(); the provider's late answer
    //                                      or failure then goes through holder.end
    //   session refused by the checks      holder.end(session)
    //   lease issued                       holder.end(session) on lease.release()
    var answer = await askProvider(
      function () { return state.provider.obtainSession(request.definition || null, origin, request.rt, ctx); },
      providerTimeoutMs,
      function (late) {
        holder.abandon();
        controller.abort();
        // Whatever the provider yields after this point has no lease to carry it.
        late.then(function (value) {
          holder.end(isSession(value) ? value : null);
        }, function (err) {
          holder.end(null);
          warn("[identity] the provider failed after the console stopped waiting: " + (err && err.message));
        });
      }
    );
    var result;
    if (answer.timedOut) {
      return declaredLease(origin, unavailable("provider_timeout", "the identity provider did not answer in time"));
    } else if (answer.error) {
      var err = answer.error;
      warn("[identity] provider failed: " + (err && err.message));
      result = unavailable((err && err.identityCode) || "provider_error", err && err.identityCode ? err.message : "the identity provider failed");
    } else {
      result = answer.value;
    }
    if (!isSession(result)) {
      holder.end(null);
      return declaredLease(origin, unavailableModule.isUnavailable(result)
        ? result
        : unavailable("provider_result_invalid", "the identity provider returned no session"));
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
    } catch (checkErr) {
      holder.end(result);
      warn("[identity] the provider's session was refused: " + (checkErr && checkErr.message));
      return declaredLease(origin, unavailable((checkErr && checkErr.identityCode) || "delivery_invalid", "the identity provider returned a session the console could not accept"));
    }

    return {
      dir: result.dir,
      record: { provider: result.provider, grade: claims.grade, origin: claims.origin },
      notice: null,
      release: function () { holder.end(result); },
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
