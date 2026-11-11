var isValidThemeId = require("./theme-files").isValidThemeId;

function attachPreferences(deps) {
  var loadUsers = deps.loadUsers;
  var saveUsers = deps.saveUsers;

  // --- DM Favorites ---

  function getDmFavorites(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].dmFavorites || [];
      }
    }
    return [];
  }

  function addDmFavorite(userId, targetUserId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].dmFavorites) data.users[i].dmFavorites = [];
        if (data.users[i].dmFavorites.indexOf(targetUserId) === -1) {
          data.users[i].dmFavorites.push(targetUserId);
          saveUsers(data);
        }
        return data.users[i].dmFavorites;
      }
    }
    return [];
  }

  function removeDmFavorite(userId, targetUserId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].dmFavorites) data.users[i].dmFavorites = [];
        data.users[i].dmFavorites = data.users[i].dmFavorites.filter(function (id) {
          return id !== targetUserId;
        });
        saveUsers(data);
        return data.users[i].dmFavorites;
      }
    }
    return [];
  }

  // --- DM Hidden (dismissed from strip) ---

  function getDmHidden(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].dmHidden || [];
      }
    }
    return [];
  }

  function addDmHidden(userId, targetUserId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].dmHidden) data.users[i].dmHidden = [];
        if (data.users[i].dmHidden.indexOf(targetUserId) === -1) {
          data.users[i].dmHidden.push(targetUserId);
          saveUsers(data);
        }
        return data.users[i].dmHidden;
      }
    }
    return [];
  }

  function removeDmHidden(userId, targetUserId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].dmHidden) data.users[i].dmHidden = [];
        data.users[i].dmHidden = data.users[i].dmHidden.filter(function (id) {
          return id !== targetUserId;
        });
        saveUsers(data);
        return data.users[i].dmHidden;
      }
    }
    return [];
  }


  // --- Per-user chat layout setting ---

  function getChatLayout(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].chatLayout || "channel";
      }
    }
    return "channel";
  }

  function setChatLayout(userId, layout) {
    var val = (layout === "bubble") ? "bubble" : "channel";
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        data.users[i].chatLayout = val;
        saveUsers(data);
        return { ok: true, chatLayout: val };
      }
    }
    return { error: "User not found" };
  }

  // --- Per-user theme choice ---
  //
  // themeMode: "light" | "dark" | absent (follow the system).
  // themeId:   the id of a custom theme file, or absent. It overrides the mode
  //            while the file exists; choosing a mode clears it.
  // themeBrand is retired (the Classic brand is gone). migrateAllThemePrefs drops
  // it for every user when the server starts, so a stored value never
  // outlives the upgrade.

  function getThemeMode(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].themeMode || null;
      }
    }
    return null;
  }

  function setThemeMode(userId, mode) {
    var val = (mode === "light" || mode === "dark") ? mode : null;
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        data.users[i].themeMode = val;
        // A mode choice (Dark, Light or Follow system) replaces a custom theme.
        delete data.users[i].themeId;
        saveUsers(data);
        return { ok: true, themeMode: val };
      }
    }
    return { error: "User not found" };
  }

  function getThemeId(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return isValidThemeId(data.users[i].themeId) ? data.users[i].themeId : null;
      }
    }
    return null;
  }

  function setThemeId(userId, themeId) {
    var val = isValidThemeId(themeId) ? themeId : null;
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (val) data.users[i].themeId = val;
        else delete data.users[i].themeId;
        saveUsers(data);
        return { ok: true, themeId: val };
      }
    }
    return { error: "User not found" };
  }

  // One-time rewrite of every user's stored theme preferences. Dropping
  // themeBrand is the whole mapping: the stored mode already says dark or
  // light, and the Clagentic theme of that mode is what the browser applies
  // (a classic-brand user with no stored mode follows the system, as before).
  // A mode that is neither light nor dark, or a theme id that is not a legal
  // id, is dropped too. Saves only when something changed, so it runs once.
  // Returns { changed: <number of users rewritten> }.
  function migrateAllThemePrefs() {
    var data = loadUsers();
    var changed = 0;
    for (var i = 0; i < data.users.length; i++) {
      var user = data.users[i];
      var touched = false;
      if (Object.prototype.hasOwnProperty.call(user, "themeBrand")) {
        delete user.themeBrand;
        touched = true;
      }
      if (user.themeMode !== undefined && user.themeMode !== null && user.themeMode !== "light" && user.themeMode !== "dark") {
        delete user.themeMode;
        touched = true;
      }
      if (user.themeId !== undefined && !isValidThemeId(user.themeId)) {
        delete user.themeId;
        touched = true;
      }
      if (touched) changed++;
    }
    if (changed) saveUsers(data);
    return { changed: changed };
  }

  // --- Per-user auto-continue setting ---

  function getAutoContinue(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return !!data.users[i].autoContinueOnRateLimit;
      }
    }
    return false;
  }

  function setAutoContinue(userId, enabled) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        data.users[i].autoContinueOnRateLimit = !!enabled;
        saveUsers(data);
        return { ok: true, autoContinueOnRateLimit: !!enabled };
      }
    }
    return { error: "User not found" };
  }


  // --- Per-user tool palette preferences ---
  //
  // Each user can customize the sidebar tool grid by reordering or
  // hiding individual tools. Stored as an object keyed by palette name
  // ("session"), each holding { order: [...ids], hidden: [...ids] }.
  // Missing ids are treated as "use registry default at the end", so new
  // tools added in future releases show up for existing users without a
  // migration.

  var VALID_PALETTES = { session: true };

  function getToolPalettes(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].toolPalettes || {};
      }
    }
    return {};
  }

  function setToolPalette(userId, paletteName, order, hidden) {
    if (!VALID_PALETTES[paletteName]) {
      return { error: "Unknown palette" };
    }
    var safeOrder = Array.isArray(order)
      ? order.filter(function (s) { return typeof s === "string"; })
      : [];
    var safeHidden = Array.isArray(hidden)
      ? hidden.filter(function (s) { return typeof s === "string"; })
      : [];
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].toolPalettes) data.users[i].toolPalettes = {};
        data.users[i].toolPalettes[paletteName] = {
          order: safeOrder,
          hidden: safeHidden,
        };
        saveUsers(data);
        return { ok: true, palette: paletteName, order: safeOrder, hidden: safeHidden };
      }
    }
    return { error: "User not found" };
  }

  return {
    getDmFavorites: getDmFavorites,
    addDmFavorite: addDmFavorite,
    removeDmFavorite: removeDmFavorite,
    getDmHidden: getDmHidden,
    addDmHidden: addDmHidden,
    removeDmHidden: removeDmHidden,
    getChatLayout: getChatLayout,
    setChatLayout: setChatLayout,
    getThemeMode: getThemeMode,
    setThemeMode: setThemeMode,
    getThemeId: getThemeId,
    setThemeId: setThemeId,
    migrateAllThemePrefs: migrateAllThemePrefs,
    getAutoContinue: getAutoContinue,
    setAutoContinue: setAutoContinue,
    getToolPalettes: getToolPalettes,
    setToolPalette: setToolPalette,
  };
}

module.exports = { attachPreferences: attachPreferences };

