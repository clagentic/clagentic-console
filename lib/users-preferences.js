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

  // --- Per-user theme mode and brand settings ---

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
        saveUsers(data);
        return { ok: true, themeMode: val };
      }
    }
    return { error: "User not found" };
  }

  function getThemeBrand(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].themeBrand || null;
      }
    }
    return null;
  }

  function setThemeBrand(userId, brand) {
    var val = (brand === "classic" || brand === "clagentic") ? brand : null;
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        data.users[i].themeBrand = val;
        saveUsers(data);
        return { ok: true, themeBrand: val };
      }
    }
    return { error: "User not found" };
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
    getThemeBrand: getThemeBrand,
    setThemeBrand: setThemeBrand,
    getAutoContinue: getAutoContinue,
    setAutoContinue: setAutoContinue,
    getToolPalettes: getToolPalettes,
    setToolPalette: setToolPalette,
  };
}

module.exports = { attachPreferences: attachPreferences };

