// vendor-auth.js - the "not logged in" facts for one agent, read from the YOKE
// registry so the title and the login command are written once and every
// surface (chat message, notification, terminal launcher) agrees.

var registry = require("./yoke").registry;

/**
 * @param {string} vendor  a registered vendor id
 * @returns {{vendor: string, displayName: string, title: string, loginCommand: string}}
 * @throws {Error} code YOKE_UNKNOWN_VENDOR when the vendor is not registered
 */
function authRequiredFacts(vendor) {
  var descriptor = registry.get(vendor);
  return {
    vendor: descriptor.id,
    displayName: descriptor.displayName,
    title: descriptor.displayName + " is not logged in.",
    loginCommand: descriptor.loginCommand,
  };
}

module.exports = { authRequiredFacts: authRequiredFacts };
