var sessionSearch = require("./session-search");

function attachPalette(ctx) {
  var users = ctx.users;
  var projects = ctx.projects;
  var getMultiUserFromReq = ctx.getMultiUserFromReq;
  var onGetProjectAccess = ctx.onGetProjectAccess;

  function handleRequest(req, res, fullUrl) {
    if (req.method !== "GET" || fullUrl !== "/api/palette/search") return false;

    var paletteUser = getMultiUserFromReq(req);
    if (!paletteUser) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"error":"unauthorized"}');
      return true;
    }
    var pqs = req.url.indexOf("?") >= 0 ? req.url.substring(req.url.indexOf("?")) : "";
    var pQuery = new URLSearchParams(pqs).get("q") || "";
    var pResults = [];

    if (!pQuery) {
      // Recent mode: return all sessions sorted by lastActivity
      projects.forEach(function (pCtx, pSlug) {
        var status = pCtx.getStatus();
        if (status.isWorktree) return;
        if (paletteUser && onGetProjectAccess) {
          var pAccess = onGetProjectAccess(pSlug);
          if (pAccess && !pAccess.error && !users.canAccessProject(paletteUser.id, pAccess)) return;
        }
        pCtx.sm.sessions.forEach(function (session) {
          if (session.hidden) return;
          if (paletteUser) {
            var sAccess = onGetProjectAccess ? onGetProjectAccess(pSlug) : null;
            if (!users.canAccessSession(paletteUser.id, session, sAccess)) return;
          }
          var pItem = {
            projectSlug: pSlug,
            projectTitle: status.title || status.project,
            projectIcon: status.icon || null,
            sessionId: session.localId,
            sessionTitle: session.title || "New Session",
            lastActivity: session.lastActivity || session.createdAt || 0,
            matchType: null,
            snippet: null
          };
          pResults.push(pItem);
        });
      });
      pResults.sort(function (a, b) { return b.lastActivity - a.lastActivity; });
      if (pResults.length > 30) pResults = pResults.slice(0, 30);
    } else {
      // Search mode: BM25 ranked search across all sessions
      var projectSessions = [];
      // lr-a3e175: map each accessible session (by object identity) to its
      // owning sm so searchPalette can stream history from disk
      // (readSessionHistoryFromDisk) instead of reading the possibly-
      // unloaded/trimmed session.history heap array directly — mirrors the
      // lr-2ea2a7 streaming-search precedent in
      // sm.searchSessions/searchSessionContent. Keyed by object identity
      // (not localId) since localId is only unique within a single project's
      // sm and would otherwise collide across projects.
      var smBySession = new Map();
      projects.forEach(function (pCtx, pSlug) {
        var status = pCtx.getStatus();
        if (status.isWorktree) return;
        if (paletteUser && onGetProjectAccess) {
          var pAccess = onGetProjectAccess(pSlug);
          if (pAccess && !pAccess.error && !users.canAccessProject(paletteUser.id, pAccess)) return;
        }
        var accessibleSessions = [];
        pCtx.sm.sessions.forEach(function (session) {
          if (session.hidden) return;
          if (paletteUser) {
            var sAccess = onGetProjectAccess ? onGetProjectAccess(pSlug) : null;
            if (!users.canAccessSession(paletteUser.id, session, sAccess)) return;
          }
          smBySession.set(session, pCtx.sm);
          accessibleSessions.push(session);
        });
        if (accessibleSessions.length > 0) {
          projectSessions.push({
            projectSlug: pSlug,
            projectTitle: status.title || status.project,
            projectIcon: status.icon || null,
            sessions: accessibleSessions
          });
        }
      });
      pResults = sessionSearch.searchPalette(projectSessions, pQuery, {
        maxResults: 30,
        getHistory: function (session) {
          var ownerSm = smBySession.get(session);
          return ownerSm ? ownerSm.readSessionHistoryFromDisk(session) : session.history;
        }
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: pResults }));
    return true;
  }

  return {
    handleRequest: handleRequest,
  };
}

module.exports = { attachPalette: attachPalette };

