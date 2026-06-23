var fs = require("fs");
var path = require("path");
var audit = require("./audit");

function attachSettings(ctx) {
  var users = ctx.users;
  var getMultiUserFromReq = ctx.getMultiUserFromReq;
  var isRequestAuthed = ctx.isRequestAuthed;
  var projects = ctx.projects;
  var opts = ctx.opts;
  var CONFIG_DIR = ctx.CONFIG_DIR;

  var profilePath = path.join(CONFIG_DIR, "profile.json");

  function handleRequest(req, res, fullUrl) {
    // GET /api/profile
    if (req.method === "GET" && fullUrl === "/api/profile") {
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return true;
      }
      var profile = mu.profile || { name: "", lang: "en-US", avatarColor: "#7c3aed", avatarStyle: "thumbs", avatarSeed: "", avatarCustom: "" };
      profile.username = mu.username;
      profile.userId = mu.id;
      profile.role = mu.role;
      profile.pinEnabled = !!mu.pinHash;
      profile.autoContinueOnRateLimit = !!mu.autoContinueOnRateLimit;
      profile.chatLayout = mu.chatLayout || "channel";
      profile.themeMode = mu.themeMode || null;
      profile.themeBrand = mu.themeBrand || null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(profile));
      return true;
    }

    // PUT /api/profile
    if (req.method === "PUT" && fullUrl === "/api/profile") {
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          var profile = {};
          if (typeof data.name === "string") profile.name = data.name.substring(0, 50);
          if (typeof data.lang === "string") profile.lang = data.lang.substring(0, 10);
          if (typeof data.avatarColor === "string" && /^#[0-9a-fA-F]{6}$/.test(data.avatarColor)) {
            profile.avatarColor = data.avatarColor;
          }
          if (typeof data.avatarStyle === "string") profile.avatarStyle = data.avatarStyle.substring(0, 30);
          if (typeof data.avatarSeed === "string") profile.avatarSeed = data.avatarSeed.substring(0, 30);
          if (typeof data.avatarCustom === "string") profile.avatarCustom = data.avatarCustom;
          if (data.avatarCustom === null || data.avatarCustom === "") profile.avatarCustom = undefined;
          var mu = getMultiUserFromReq(req);
          if (!mu) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end('{"error":"unauthorized"}');
            return;
          }
          users.updateUserProfile(mu.id, profile);
          // Broadcast updated avatar/presence to all projects
          projects.forEach(function (pCtx) {
            pCtx.refreshUserProfile(mu.id);
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(profile));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
      return true;
    }

    // Upload custom avatar image
    if (req.method === "POST" && fullUrl === "/api/avatar") {
      var chunks = [];
      var totalSize = 0;
      var maxSize = 2 * 1024 * 1024; // 2MB
      req.on("data", function (chunk) {
        totalSize += chunk.length;
        if (totalSize <= maxSize) chunks.push(chunk);
      });
      req.on("end", function () {
        if (totalSize > maxSize) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end('{"error":"File too large (max 2MB)"}');
          return;
        }
        var raw = Buffer.concat(chunks);
        // Detect content type from magic bytes
        var ct = null;
        if (raw[0] === 0xFF && raw[1] === 0xD8) ct = "image/jpeg";
        else if (raw[0] === 0x89 && raw[1] === 0x50) ct = "image/png";
        else if (raw[0] === 0x47 && raw[1] === 0x49) ct = "image/gif";
        else if (raw[0] === 0x52 && raw[1] === 0x49) ct = "image/webp";
        if (!ct) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Unsupported image format"}');
          return;
        }
        var ext = ct.split("/")[1] === "jpeg" ? "jpg" : ct.split("/")[1];
        var avatarDir = path.join(CONFIG_DIR, "avatars");
        fs.mkdirSync(avatarDir, { recursive: true });

        var mu = getMultiUserFromReq(req);
        if (!mu) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end('{"error":"unauthorized"}');
          return;
        }
        var userId = mu.id;
        var filename = userId + "." + ext;
        // Remove old avatar files for this user
        try {
          var existing = fs.readdirSync(avatarDir);
          for (var ei = 0; ei < existing.length; ei++) {
            if (existing[ei].startsWith(userId + ".")) {
              fs.unlinkSync(path.join(avatarDir, existing[ei]));
            }
          }
        } catch (e) {}
        var avatarFilePath = path.join(avatarDir, filename);
        fs.writeFileSync(avatarFilePath, raw);
        try { fs.chmodSync(avatarFilePath, 0o644); } catch (e) {}
        try { fs.chmodSync(avatarDir, 0o755); } catch (e) {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, avatar: "/api/avatar/" + userId + "?v=" + Date.now() }));
      });
      return true;
    }

    // Serve custom avatar image
    if (req.method === "GET" && fullUrl.startsWith("/api/avatar/")) {
      var avatarUserId = fullUrl.split("/api/avatar/")[1].split("?")[0];
      var avatarDir = path.join(CONFIG_DIR, "avatars");
      try {
        var files = fs.readdirSync(avatarDir);
        var match = null;
        for (var fi = 0; fi < files.length; fi++) {
          if (files[fi].startsWith(avatarUserId + ".")) {
            match = files[fi];
            break;
          }
        }
        if (match) {
          var ext = match.split(".").pop();
          var ctMap = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
          res.writeHead(200, {
            "Content-Type": ctMap[ext] || "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          res.end(fs.readFileSync(path.join(avatarDir, match)));
          return true;
        }
      } catch (e) {}
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"not found"}');
      return true;
    }

    // Change own PIN
    if (req.method === "PUT" && fullUrl === "/api/user/pin") {
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          if (!data.newPin || typeof data.newPin !== "string" || !/^\d{6}$/.test(data.newPin)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"PIN must be exactly 6 digits"}');
            return;
          }
          // Forced PIN change after temporary PIN login: skip currentPin
          // verification. The user authenticated with the temp PIN to
          // establish this session, so requiring them to re-enter it adds
          // friction without security benefit. The session cookie is the
          // proof of possession.
          if (mu.pinHash && !mu.mustChangePin) {
            if (!data.currentPin || typeof data.currentPin !== "string" || !/^\d{6}$/.test(data.currentPin)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end('{"error":"Current PIN is required"}');
              return;
            }
            if (!users.verifyPin(data.currentPin, mu.pinHash)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end('{"error":"Current PIN is incorrect"}');
              return;
            }
          }
          var result = users.updateUserPin(mu.id, data.newPin);
          if (result.error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // PUT /api/user/auto-continue
    if (req.method === "PUT" && fullUrl === "/api/user/auto-continue") {
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          var result = users.setAutoContinue(mu.id, !!data.enabled);
          if (result.error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, autoContinueOnRateLimit: result.autoContinueOnRateLimit }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // PUT /api/user/chat-layout
    if (req.method === "PUT" && fullUrl === "/api/user/chat-layout") {
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          var result = users.setChatLayout(mu.id, data.layout);
          if (result.error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, chatLayout: result.chatLayout }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // PUT /api/user/theme-mode
    if (req.method === "PUT" && fullUrl === "/api/user/theme-mode") {
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          var mode = (data.themeMode === "light" || data.themeMode === "dark") ? data.themeMode : null;
          var result = users.setThemeMode(mu.id, mode);
          if (result.error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, themeMode: result.themeMode }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // PUT /api/user/theme-brand
    if (req.method === "PUT" && fullUrl === "/api/user/theme-brand") {
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          var brand = (data.themeBrand === "classic" || data.themeBrand === "clagentic") ? data.themeBrand : null;
          var result = users.setThemeBrand(mu.id, brand);
          if (result.error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, themeBrand: result.themeBrand }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // GET /api/user/tool-palettes
    if (req.method === "GET" && fullUrl === "/api/user/tool-palettes") {
      var muGet = getMultiUserFromReq(req);
      if (!muGet) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return true;
      }
      var palettes = users.getToolPalettes(muGet.id) || {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(palettes));
      return true;
    }

    // PUT /api/user/tool-palettes
    if (req.method === "PUT" && fullUrl === "/api/user/tool-palettes") {
      var muPut = getMultiUserFromReq(req);
      if (!muPut) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return true;
      }
      var bodyTp = "";
      req.on("data", function (chunk) { bodyTp += chunk; });
      req.on("end", function () {
        try {
          var dataTp = JSON.parse(bodyTp);
          var paletteName = dataTp.palette;
          var order = dataTp.order;
          var hidden = dataTp.hidden;
          var result = users.setToolPalette(muPut.id, paletteName, order, hidden);
          if (result && result.error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // GET /api/user/auto-continue
    if (req.method === "GET" && fullUrl === "/api/user/auto-continue") {
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return true;
      }
      var val = users.getAutoContinue(mu.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ autoContinueOnRateLimit: val }));
      return true;
    }

    return false;
  }

  return { handleRequest: handleRequest };
}

module.exports = { attachSettings: attachSettings };

