"use strict";

// The notification types the core knows. A new type is one register() call:
// the core derives its tag, payload and close behaviour from what is declared
// here, so no emitter carries any of it.

var COLLAPSE = ["request", "session"];
// Who a type's notification reaches: "target" follows the owner the emitter
// names (the session's owner, a message's recipient); "admins" is fixed by the
// type, whatever the emitter passes.
var AUDIENCE = ["target", "admins"];

function defaultFormat(content) {
  return { title: content.title, body: content.body };
}

function createTypeRegistry() {
  var types = Object.create(null);

  /**
   * @param {string} name the push payload type.
   * @param {object} def
   * @param {string} def.category the notification-prefs category (documentation
   *   of what lib/notification-prefs.js filters the type under).
   * @param {"request"|"session"} def.collapse "request": one notification per
   *   prompt; "session": one per session, a repeat replaces it.
   * @param {boolean} def.persistent stays on screen until acted on.
   * @param {boolean} [def.renotify] a replacement alerts again.
   * @param {boolean} [def.closeOnResolve] the notification is closed when its
   *   target resolves (default true).
   * @param {boolean} [def.banner] the type also shows as an in-app banner,
   *   closed with the notification (default false).
   * @param {boolean} [def.liveInState] the page can verify the notification
   *   against notifications_state (default false).
   * @param {boolean} [def.pushUnlessOnline] no push to a person who is online
   *   in the app: their banner already reaches them (default false).
   * @param {"target"|"admins"} [def.audience] who receives it (default
   *   "target"). "admins": the admins in a multi-user install, the one person
   *   otherwise; the emitter cannot widen it.
   * @param {boolean} [def.ephemeral] its banner does not outlive a daemon
   *   restart: what it announces is rebuilt from live state (default false).
   * @param {boolean} [def.survivesClearAll] a clear-all of the notifications
   *   leaves it standing: it asks the operator for a decision, so only its own
   *   close (or its resolve) ends it (default false).
   * @param {function(object): {title: string, body: string}} [def.format]
   */
  function register(name, def) {
    if (typeof name !== "string" || !name) throw new Error("notification type needs a name");
    if (types[name]) throw new Error("notification type already registered: " + name);
    if (!def || COLLAPSE.indexOf(def.collapse) === -1) {
      throw new Error("notification type " + name + " needs collapse: request|session");
    }
    if (def.audience !== undefined && AUDIENCE.indexOf(def.audience) === -1) {
      throw new Error("notification type " + name + " needs audience: target|admins");
    }
    types[name] = Object.freeze({
      name: name,
      category: def.category || null,
      collapse: def.collapse,
      persistent: def.persistent === true,
      renotify: def.renotify === true,
      closeOnResolve: def.closeOnResolve !== false,
      banner: def.banner === true,
      liveInState: def.liveInState === true,
      pushUnlessOnline: def.pushUnlessOnline === true,
      audience: def.audience || "target",
      ephemeral: def.ephemeral === true,
      survivesClearAll: def.survivesClearAll === true,
      format: typeof def.format === "function" ? def.format : defaultFormat,
    });
    return types[name];
  }

  function get(name) {
    return typeof name === "string" && Object.prototype.hasOwnProperty.call(types, name) ? types[name] : null;
  }

  function names() {
    return Object.keys(types);
  }

  return { register: register, get: get, names: names };
}

module.exports = { createTypeRegistry: createTypeRegistry, COLLAPSE: COLLAPSE };
