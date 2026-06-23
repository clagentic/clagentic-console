var crypto = require("crypto");

function attachAuth(deps) {
  var loadUsers = deps.loadUsers;
  var saveUsers = deps.saveUsers;
  var findAdmin = deps.findAdmin;

  // --- Setup code ---

  function generateSetupCode() {
    var chars = "abcdefghijkmnpqrstuvwxyz23456789"; // no ambiguous chars
    var code = "";
    var bytes = crypto.randomBytes(6);
    for (var i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length];
    }
    return code;
  }

  function getSetupCode() {
    var data = loadUsers();
    if (data.setupCode) return data.setupCode;
    // Defensive: if multi-user is on, no admin, and no code, auto-generate one
    if (data.multiUser && !findAdmin(data)) {
      var code = generateSetupCode();
      data.setupCode = code;
      saveUsers(data);
      return code;
    }
    return null;
  }

  function clearSetupCode() {
    var data = loadUsers();
    data.setupCode = null;
    saveUsers(data);
  }

  function validateSetupCode(code) {
    var data = loadUsers();
    if (!data.setupCode) return false;
    return data.setupCode === code;
  }

  // --- Pin hashing with scrypt ---

  function hashPin(pin) {
    var salt = crypto.randomBytes(16).toString("hex");
    var hash = crypto.scryptSync(pin, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
    return "scrypt:" + salt + ":" + hash;
  }

  // Verify PIN against stored hash, supporting both scrypt and legacy SHA256
  function verifyPin(pin, storedHash) {
    if (!storedHash) return false;
    if (storedHash.startsWith("scrypt:")) {
      var parts = storedHash.split(":");
      if (parts.length !== 3) return false;
      var salt = parts[1];
      var expected = parts[2];
      var actual = crypto.scryptSync(pin, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
      // Constant-time comparison to prevent timing attacks
      if (actual.length !== expected.length) return false;
      return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
    }
    // Legacy SHA256 fallback
    var legacyHash = crypto.createHash("sha256").update("clay-user:" + pin).digest("hex");
    return legacyHash === storedHash;
  }

  // Generate a random 6-digit PIN
  function generatePin() {
    var digits = "";
    var bytes = crypto.randomBytes(6);
    for (var i = 0; i < 6; i++) {
      digits += (bytes[i] % 10).toString();
    }
    return digits;
  }

  // --- Authentication with lazy upgrade ---

  function authenticateUser(username, pin) {
    var data = loadUsers();
    var user = null;
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].username.toLowerCase() === username.toLowerCase()) {
        user = data.users[i];
        break;
      }
    }
    if (!user) return null;
    if (!verifyPin(pin, user.pinHash)) return null;
    // Lazy upgrade: if stored hash is legacy SHA256, re-hash with scrypt now
    if (user.pinHash && !user.pinHash.startsWith("scrypt:")) {
      user.pinHash = hashPin(pin);
      saveUsers(data);
    }
    return user;
  }

  // --- Auth tokens ---

  function generateUserAuthToken(userId) {
    var token = crypto.randomBytes(32).toString("hex");
    return userId + ":" + token;
  }

  function parseAuthCookie(cookieValue) {
    if (!cookieValue) return null;
    var idx = cookieValue.indexOf(":");
    if (idx < 0) return null;
    return {
      userId: cookieValue.substring(0, idx),
      token: cookieValue.substring(idx + 1),
    };
  }

  return {
    generateSetupCode: generateSetupCode,
    getSetupCode: getSetupCode,
    clearSetupCode: clearSetupCode,
    validateSetupCode: validateSetupCode,
    hashPin: hashPin,
    verifyPin: verifyPin,
    generatePin: generatePin,
    authenticateUser: authenticateUser,
    generateUserAuthToken: generateUserAuthToken,
    parseAuthCookie: parseAuthCookie,
  };
}

module.exports = { attachAuth: attachAuth };
