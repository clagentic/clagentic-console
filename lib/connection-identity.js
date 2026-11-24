// connection-identity.js - the OS identity a connection acts as, and the agent
// registry it is shown, resolved so that an account that cannot be run as is
// refused and never answered with the daemon's own identity (null).
//
// One resolver, shared by the project context and by the connection and session
// handlers' fallbacks, so no copy of it can fail open.

var { OsUserError, resolveUserAccount } = require("./os-users");
var { buildVendorRegistryMessage, buildRefusedVendorRegistryMessage } = require("./vendor-registry-message");

/**
 * Refuses a user record that has no Linux account mapped, with the named
 * OS_USER_UNMAPPED error. A mapped record passes without a lookup.
 * @param {object} user
 */
function requireMappedUser(user) {
  if (!user.linuxUser) resolveUserAccount(user);
}

/**
 * @param {object} o
 * @param {boolean} o.osUsers
 * @param {function(): object} o.getSm  the session manager, read when used
 * @param {function(object): void} [o.verify]  throws an OsUserError for a user
 *   record that cannot be run as; defaults to requireMappedUser
 * @returns {{getLinuxUserForWs: function, vendorRegistryFor: function}}
 */
function createConnectionIdentity(o) {
  var verify = o.verify || requireMappedUser;

  // null only for os-users off or no user record; otherwise the account name or
  // a thrown OsUserError.
  function getLinuxUserForWs(ws) {
    var user = ws._clagenticUser;
    if (!o.osUsers || !user) return null;
    verify(user);
    return user.linuxUser;
  }

  function vendorRegistryFor(ws) {
    try {
      return buildVendorRegistryMessage(o.getSm(), getLinuxUserForWs(ws));
    } catch (e) {
      if (!(e instanceof OsUserError)) throw e;
      return buildRefusedVendorRegistryMessage();
    }
  }

  return { getLinuxUserForWs: getLinuxUserForWs, vendorRegistryFor: vendorRegistryFor };
}

module.exports = {
  createConnectionIdentity: createConnectionIdentity,
  requireMappedUser: requireMappedUser,
};
