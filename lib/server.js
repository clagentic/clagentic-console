var http = require("http");
var fs = require("fs");
var path = require("path");
var { WebSocketServer } = require("ws");
var pages = require("./pages");
var smtp = require("./smtp");
var { createProjectContext } = require("./project");
var users = require("./users");
var dm = require("./dm");
var serverAuth = require("./server-auth");
var serverSkills = require("./server-skills");
var serverDm = require("./server-dm");
var serverAdmin = require("./server-admin");
var serverSettings = require("./server-settings");
var serverPalette = require("./server-palette");

var { CONFIG_DIR } = require("./config");
var { provisionLinuxUser } = require("./os-users");
var { detectLite } = require("./lite-detect");
var { readCappedBody } = require("./utils");
var { computeAllProjectSessions } = require("./server-hub-sessions");
var { resolveEffectiveProtocol } = require("./effective-protocol");

var https = require("https");
var pkg = require("../package.json");

var publicDir = path.join(__dirname, "public");
var bundledThemesDir = path.join(__dirname, "themes");
var userThemesDir = path.join(CONFIG_DIR, "themes");

// --- HTTP helpers (used by skills proxy and extension download) ---

function httpGetBinary(url) {
  return new Promise(function (resolve, reject) {
    var mod = url.startsWith("https") ? https : http;
    mod.get(url, { headers: { "User-Agent": "Clagentic/1.0" } }, function (resp) {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return httpGetBinary(resp.headers.location).then(resolve, reject);
      }
      if (resp.statusCode !== 200) {
        return reject(new Error("HTTP " + resp.statusCode));
      }
      var chunks = [];
      resp.on("data", function (c) { chunks.push(c); });
      resp.on("end", function () { resolve(Buffer.concat(chunks)); });
      resp.on("error", reject);
    }).on("error", reject);
  });
}


var MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(urlPath, res) {
  if (urlPath === "/") urlPath = "/index.html";

  // Special case: inject version into sw.js cache name at serve time
  if (urlPath === "/sw.js") {
    var swPath = path.join(publicDir, "sw.js");
    try {
      var swContent = fs.readFileSync(swPath, "utf8");
      var appVersion = pkg.version;
      // Replace the static cache name with a version-stamped one
      swContent = swContent.replace(
        /var CACHE_NAME = "clagentic-offline-[^"]*"/,
        'var CACHE_NAME = "clagentic-offline-v' + appVersion + '"'
      );
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "Service-Worker-Allowed": "/",
      });
      res.end(swContent);
      return true;
    } catch (e) {
      // Fall through to normal static serving on error
    }
  }

  var filePath = path.join(publicDir, urlPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  try {
    var content = fs.readFileSync(filePath);
    var ext = path.extname(filePath);
    var mime = MIME_TYPES[ext] || "application/octet-stream";
    var isImage = ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".svg" || ext === ".webp" || ext === ".ico";
    var cacheControl = isImage ? "public, max-age=86400, immutable" : "no-cache";
    res.writeHead(200, {
      "Content-Type": mime + (isImage ? "" : "; charset=utf-8"),
      "Cache-Control": cacheControl,
    });
    res.end(content);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Extract slug from URL path: /p/{slug}/... → slug
 * Returns null if path doesn't match /p/{slug}
 */
function extractSlug(urlPath) {
  var match = urlPath.match(/^\/p\/([a-z0-9_-]+)(\/|$)/);
  return match ? match[1] : null;
}

// WS_TICKET_SUBPROTOCOL_PREFIX must match the client (app-connection.js
// connect()): the client offers ['clagentic.auth.' + ticket] as the
// Sec-WebSocket-Protocol list; this extracts the raw ticket back out.
var WS_TICKET_SUBPROTOCOL_PREFIX = "clagentic.auth.";

/**
 * Extract a ws-ticket (lr-de5fcb) from a raw Sec-WebSocket-Protocol header
 * value. Returns null if the header is absent or carries no ticket-shaped
 * subprotocol entry.
 */
function extractWsTicketFromHeader(headerValue) {
  if (!headerValue) return null;
  var entries = headerValue.split(",");
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i].trim();
    if (entry.indexOf(WS_TICKET_SUBPROTOCOL_PREFIX) === 0) {
      return entry.slice(WS_TICKET_SUBPROTOCOL_PREFIX.length);
    }
  }
  return null;
}

/**
 * Strip the /p/{slug} prefix from URL path
 */
function stripPrefix(urlPath, slug) {
  var prefix = "/p/" + slug;
  var rest = urlPath.substring(prefix.length);
  return rest || "/";
}

// File extensions that identify a project-scoped sub-resource request
// (script/style/module/data/font asset) as opposed to a top-level document
// navigation. Used by isAssetOrApiPath() below.
var ASSET_EXTENSIONS = [
  ".js", ".mjs", ".css", ".map", ".json", ".woff", ".woff2", ".ttf", ".eot",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".wasm",
];

/**
 * lr-e33776: classify a project-scoped request path (already stripped of the
 * /p/{slug} prefix, e.g. "/app.js", "/modules/foo.js", "/api/x") as an
 * asset/module/API request rather than a top-level document navigation.
 *
 * Only document-navigation requests (e.g. "/", "/index.html") should ever
 * receive the 200 text/html login page from the unauthed project-route gate
 * — see server.js appHandler around isRequestAuthed(req). A .js/.css/module/
 * API request that falls through to that gate unauthenticated must never get
 * a 200 text/html body: browsers with X-Content-Type-Options: nosniff hard-
 * reject a <script type="module"> load whose response is HTML, breaking app
 * boot (proven root cause of lr-e33776 / the mobile "reconnecting" bug).
 */
function isAssetOrApiPath(projectUrlPath) {
  var pathOnly = projectUrlPath.split("?")[0].split("#")[0];
  if (pathOnly.indexOf("/api/") === 0) return true;
  if (pathOnly.indexOf("/modules/") === 0) return true;
  var ext = path.extname(pathOnly);
  return ASSET_EXTENSIONS.indexOf(ext) !== -1;
}

/**
 * lr-2895ea: classify a project-scoped request path (already stripped of the
 * /p/{slug} prefix) as a PUBLIC shell static asset — app.js, style.css, a
 * /modules/*.js chunk, or any other static file servable from lib/public/
 * (fonts, images, source maps, the manifest, etc). These files are byte-
 * identical for every user and carry no per-user data, so serving them to an
 * unauthenticated request is safe.
 *
 * This is intentionally narrower in one respect and identical in another to
 * isAssetOrApiPath(): it EXCLUDES /api/* (never public — per-user/data
 * endpoints must stay behind the auth gate) but otherwise reuses the same
 * extension/prefix allowlist, since every extension in ASSET_EXTENSIONS
 * (js/mjs/css/map/json/fonts/images/wasm) maps 1:1 to a real file under
 * lib/public/ served by serveStatic() — never to project or user data.
 *
 * MECHANISM (MILLER, lr-2895ea, conf 0.9): mobile browsers withhold the
 * SameSite=Lax session cookie on subresource requests (script/style/module
 * loads) even on an authenticated top-level document navigation. Gating
 * these shell assets behind the auth check made every such subresource 401
 * on mobile, so style.css never applied and app.js was nosniff-rejected —
 * the app never booted past the static "Reconnecting" overlay. Desktop
 * escaped because it does send the cookie on subresources. Serving these
 * public files before the gate removes the cookie dependency entirely.
 */
function isPublicShellAssetPath(projectUrlPath) {
  var pathOnly = projectUrlPath.split("?")[0].split("#")[0];
  if (pathOnly.indexOf("/api/") === 0) return false;
  if (pathOnly.indexOf("/modules/") === 0) return true;
  var ext = path.extname(pathOnly);
  return ASSET_EXTENSIONS.indexOf(ext) !== -1;
}

/**
 * Create a multi-project server.
 * opts: { tlsOptions, caPath, pinHash, port, debug, dangerouslySkipPermissions }
 */
function createServer(opts) {
  var tlsOptions = opts.tlsOptions || null;
  var caPath = opts.caPath || null;
  var portNum = opts.port || 2633;
  var debug = opts.debug || false;
  var dangerouslySkipPermissions = opts.dangerouslySkipPermissions || false;
  var osUsers = opts.osUsers || false;
  var lanHost = opts.lanHost || null;
  // lr-20e71c: operator-declared trust boundary for reading X-Forwarded-Proto
  // from a reverse proxy. See lib/effective-protocol.js.
  var trustedProxy = !!opts.trustedProxy;
  // lr-2ea2a7: daemon.json knob overriding the in-heap session-history tail cap.
  var historyInMemMax = opts.historyInMemMax;
  var onAddProject = opts.onAddProject || null;
  var onCreateProject = opts.onCreateProject || null;
  var onCloneProject = opts.onCloneProject || null;
  var onRemoveProject = opts.onRemoveProject || null;
  var onReorderProjects = opts.onReorderProjects || null;
  var onSetProjectTitle = opts.onSetProjectTitle || null;
  var onSetProjectIcon = opts.onSetProjectIcon || null;
  var onSetProjectPreferredAgent = opts.onSetProjectPreferredAgent || null;
  var onSetProjectFolder = opts.onSetProjectFolder || null;
  var onRenameProjectFolder = opts.onRenameProjectFolder || null;
  var onSetFolderIcon = opts.onSetFolderIcon || null;
  var onRenameCustomIcon = opts.onRenameCustomIcon || null;
  var getFolderMeta = opts.getFolderMeta || function () { return {}; };
  var onProjectOwnerChanged = opts.onProjectOwnerChanged || null;
  var onGetServerDefaultEffort = opts.onGetServerDefaultEffort || null;
  var onSetServerDefaultEffort = opts.onSetServerDefaultEffort || null;
  var onGetProjectDefaultEffort = opts.onGetProjectDefaultEffort || null;
  var onSetProjectDefaultEffort = opts.onSetProjectDefaultEffort || null;
  var onGetServerDefaultModel = opts.onGetServerDefaultModel || null;
  var onSetServerDefaultModel = opts.onSetServerDefaultModel || null;
  var onGetProjectDefaultModel = opts.onGetProjectDefaultModel || null;
  var onSetProjectDefaultModel = opts.onSetProjectDefaultModel || null;
  var onGetServerDefaultMode = opts.onGetServerDefaultMode || null;
  var onSetServerDefaultMode = opts.onSetServerDefaultMode || null;
  var onGetProjectDefaultMode = opts.onGetProjectDefaultMode || null;
  var onSetProjectDefaultMode = opts.onSetProjectDefaultMode || null;
  var onGetServerDefaultBetas = opts.onGetServerDefaultBetas || null;
  var onSetServerDefaultBetas = opts.onSetServerDefaultBetas || null;
  var onGetProjectDefaultBetas = opts.onGetProjectDefaultBetas || null;
  var onSetProjectDefaultBetas = opts.onSetProjectDefaultBetas || null;
  var onGetProjectMcpServers = opts.onGetProjectMcpServers || null;
  var onSetProjectMcpServers = opts.onSetProjectMcpServers || null;
  var onGetDaemonConfig = opts.onGetDaemonConfig || null;
  var onSetPin = opts.onSetPin || null;
  var onSetKeepAwake = opts.onSetKeepAwake || null;
  var onSetImageRetention = opts.onSetImageRetention || null;
  var onSetMemAvailableThreshold = opts.onSetMemAvailableThreshold || null;
  var onSetLiteAutoEnroll = opts.onSetLiteAutoEnroll || null;
  var onShutdown = opts.onShutdown || null;
  var onRestart = opts.onRestart || null;
  var onSetUpdateChannel = opts.onSetUpdateChannel || null;
  var onSetProjectVisibility = opts.onSetProjectVisibility || null;
  var onSetProjectAllowedUsers = opts.onSetProjectAllowedUsers || null;
  var onGetProjectAccess = opts.onGetProjectAccess || null;
  var onCreateWorktree = opts.onCreateWorktree || null;
  var onUserProvisioned = opts.onUserProvisioned || null;
  var onUserDeleted = opts.onUserDeleted || null;
  var getRemovedProjects = opts.getRemovedProjects || function () { return []; };

  // --- Auth module ---
  var auth = serverAuth.attachAuth({
    users: users,
    smtp: smtp,
    pages: pages,
    tlsOptions: tlsOptions,
    osUsers: osUsers,
    provisionLinuxUser: provisionLinuxUser,
    onUserProvisioned: onUserProvisioned,
  });
  var getMultiUserFromReq = auth.getMultiUserFromReq;
  var isRequestAuthed = auth.isRequestAuthed;
  var parseCookies = auth.parseCookies;

  var realVersion = require("../package.json").version;
  var currentVersion = debug ? "0.0.9" : realVersion;

  var caContent = caPath ? (function () { try { return fs.readFileSync(caPath); } catch (e) { return null; } })() : null;

  // --- Project registry ---
  var projects = new Map(); // slug → projectContext

  // --- Admin module ---
  var admin = serverAdmin.attachAdmin({
    users: users,
    smtp: smtp,
    getMultiUserFromReq: getMultiUserFromReq,
    projects: projects,
    osUsers: osUsers,
    tlsOptions: tlsOptions,
    portNum: portNum,
    provisionLinuxUser: provisionLinuxUser,
    onUserProvisioned: onUserProvisioned,
    onUserDeleted: onUserDeleted,
    revokeUserTokens: auth.revokeUserTokens,
    onSetProjectVisibility: onSetProjectVisibility,
    onSetProjectAllowedUsers: onSetProjectAllowedUsers,
    onGetProjectAccess: onGetProjectAccess,
    onProjectOwnerChanged: onProjectOwnerChanged,
  });

  var skills = serverSkills.attachSkills({
    users: users,
    osUsers: osUsers,
    getMultiUserFromReq: getMultiUserFromReq,
  });

  var settings = serverSettings.attachSettings({
    users: users,
    getMultiUserFromReq: getMultiUserFromReq,
    isRequestAuthed: isRequestAuthed,
    projects: projects,
    opts: opts,
    CONFIG_DIR: CONFIG_DIR,
  });

  var palette = serverPalette.attachPalette({
    users: users,
    projects: projects,
    getMultiUserFromReq: getMultiUserFromReq,
    onGetProjectAccess: onGetProjectAccess,
  });

  // --- Push module (global) ---
  var pushModule = null;
  try {
    var { initPush } = require("./push");
    pushModule = initPush();
  } catch (e) {}

  // --- Notifications module (global singleton, shared by all projects) ---
  var { attachNotifications: _attachNotifications } = require("./project-notifications");
  var _globalNotifications = _attachNotifications({
    broadcastAll: function (msg) { broadcastAll(msg); },
    sendToUser: function (userId, msg) { sendToUser(userId, msg); },
    pushModule: pushModule,
    isMultiUser: function () { return true; },
  });

  // --- External trigger watcher (global singleton) ---
  // Watches ~/.clagentic/external-triggers/ for JSON files dropped by external
  // processes. On valid file: spawns a session in the named project with
  // initialPrompt pre-loaded as the first user-turn. No UI notification is
  // emitted — the trigger carries its own notification channel (e.g. ntfy).
  var { attachExternalTrigger } = require("./project-external-trigger");
  var { EXTERNAL_TRIGGERS_DIR } = require("./config");
  var _externalTrigger = attachExternalTrigger({
    triggersDir: EXTERNAL_TRIGGERS_DIR,
    getProject: function (slug) { return projects.get(slug) || null; },
  });
  _externalTrigger.startWatcher();

  // --- Security headers ---
  var securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://esm.sh; worker-src 'self' https://cdn.jsdelivr.net blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src * data: blob:; connect-src 'self' ws: wss: https://cdn.jsdelivr.net https://esm.sh https://api.dicebear.com https://api.open-meteo.com https://ipapi.co; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net;",
  };
  if (tlsOptions) {
    securityHeaders["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }

  function setSecurityHeaders(res) {
    var keys = Object.keys(securityHeaders);
    for (var i = 0; i < keys.length; i++) {
      res.setHeader(keys[i], securityHeaders[keys[i]]);
    }
  }

  // --- HTTP handler ---
  var appHandler = function (req, res) {
    setSecurityHeaders(res);
    var fullUrl = req.url.split("?")[0];

    // --- Auth routes (delegated to server-auth) ---
    if (auth.handleRequest(req, res, fullUrl)) return;
    // CA certificate download
    if (req.url === "/ca/download" && req.method === "GET" && caContent) {
      res.writeHead(200, {
        "Content-Type": "application/x-pem-file",
        "Content-Disposition": 'attachment; filename="clagentic-ca.pem"',
      });
      res.end(caContent);
      return;
    }

    // Chrome extension download (proxy from GitHub)
    if (fullUrl === "/api/extension/download" && req.method === "GET") {
      if (!isRequestAuthed(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      var archiveUrl = "https://github.com/chadbyte/clay-chrome/archive/refs/heads/main.zip";
      httpGetBinary(archiveUrl).then(function (buf) {
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="clay-chrome-extension.zip"',
          "Content-Length": buf.length,
        });
        res.end(buf);
      }).catch(function (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to download extension: " + (err.message || "unknown error") }));
      });
      return;
    }

    // CORS preflight for cross-origin requests (HTTP onboarding → HTTPS)
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // Setup page
    if (fullUrl === "/setup" && req.method === "GET") {
      var host = req.headers.host || "localhost";
      var hostname = host.split(":")[0];
      var protocol = tlsOptions ? "https" : "http";
      var setupUrl = protocol + "://" + hostname + ":" + portNum;
      var lanMode = /[?&]mode=lan/.test(req.url);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(pages.setupPageHtml(setupUrl, setupUrl, !!caContent, lanMode));
      return;
    }

    // PWA install guide
    if (fullUrl === "/pwa" && req.method === "GET") {
      var host = req.headers.host || "localhost";
      var hostname = host.split(":")[0];
      var protocol = tlsOptions ? "https" : "http";
      var pwaUrl = protocol + "://" + hostname + ":" + portNum;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
      });
      res.end(pages.setupPageHtml(pwaUrl, pwaUrl, false, true));
      return;
    }

    // Global push endpoints (used by setup page)
    if (req.method === "GET" && fullUrl === "/api/vapid-public-key" && pushModule) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ publicKey: pushModule.publicKey }));
      return;
    }

    if (req.method === "POST" && fullUrl === "/api/push-subscribe" && pushModule) {
      readCappedBody(req).then(function (body) {
        try {
          var parsed = JSON.parse(body);
          var sub = parsed.subscription || parsed;
          var _httpPushUser = getMultiUserFromReq(req);
          pushModule.addSubscription(sub, parsed.replaceEndpoint, _httpPushUser ? _httpPushUser.id : null);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400);
          res.end("Bad request");
        }
      }).catch(function () {
        res.writeHead(413);
        res.end("Request body too large");
      });
      return;
    }

    // Health check endpoint
    // Unauthenticated: minimal liveness info only
    // Authenticated: full system details (memory, pid, version, sessions)
    if (req.method === "GET" && fullUrl === "/api/health") {
      var health = {
        status: "ok",
        timestamp: new Date().toISOString(),
      };
      if (isRequestAuthed(req)) {
        var mem = process.memoryUsage();
        var activeSessions = 0;
        projects.forEach(function (ctx) {
          if (ctx && ctx.clients) {
            activeSessions += ctx.clients.size || 0;
          }
        });
        health.uptime = process.uptime();
        health.version = pkg.version;
        health.node = process.version;
        health.sessions = activeSessions;
        health.projects = projects.size;
        health.memory = {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
        };
        health.pid = process.pid;
        // Cheap probe: if the process holds deleted inodes, its on-disk code was replaced
        // by a newer npm install while this daemon was still running.
        var staleInodes = false;
        if (process.platform === 'linux') {
          try {
            var mapsContent = fs.readFileSync('/proc/self/maps', 'utf8');
            staleInodes = mapsContent.split('\n').some(function(line) {
              return line.includes(' (deleted)');
            });
          } catch (_) {}
        }
        health.stale = staleInodes;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }

    // Theme list: bundled (lib/themes/) + user (~/.clagentic/themes/)
    if (req.method === "GET" && fullUrl === "/api/themes") {
      var bundled = {};
      var custom = {};
      // Read bundled themes
      try {
        var bFiles = fs.readdirSync(bundledThemesDir);
        for (var i = 0; i < bFiles.length; i++) {
          if (!bFiles[i].endsWith(".json")) continue;
          try {
            var raw = fs.readFileSync(path.join(bundledThemesDir, bFiles[i]), "utf8");
            var id = bFiles[i].replace(/\.json$/, "");
            bundled[id] = JSON.parse(raw);
          } catch (e) {}
        }
      } catch (e) {}
      // Read user themes (override bundled if same id)
      try {
        var uFiles = fs.readdirSync(userThemesDir);
        for (var j = 0; j < uFiles.length; j++) {
          if (!uFiles[j].endsWith(".json")) continue;
          try {
            var uRaw = fs.readFileSync(path.join(userThemesDir, uFiles[j]), "utf8");
            var uid = uFiles[j].replace(/\.json$/, "");
            custom[uid] = JSON.parse(uRaw);
          } catch (e) {}
        }
      } catch (e) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ bundled: bundled, custom: custom }));
      return;
    }

    if (settings.handleRequest(req, res, fullUrl)) return;

    // --- Admin API endpoints (multi-user mode only) ---
    if (admin.handleRequest(req, res, fullUrl)) return;

    // --- Palette search (delegated to server-palette) ---
    if (palette.handleRequest(req, res, fullUrl)) return;

    // Multi-user info endpoint (who am I?)
    if (req.method === "GET" && fullUrl === "/api/me") {
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      var meResp = { multiUser: true, smtpEnabled: smtp.isSmtpConfigured(), emailLoginEnabled: smtp.isEmailLoginEnabled(), user: { id: mu.id, username: mu.username, email: mu.email || null, displayName: mu.displayName, role: mu.role } };
      meResp.permissions = users.getEffectivePermissions(mu, osUsers);
      if (mu.mustChangePin) meResp.mustChangePin = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(meResp));
      return;
    }

    // WS upgrade ticket (lr-de5fcb): mints a short-TTL, single-use, non-cookie
    // credential the client can pass on the /ws upgrade via
    // Sec-WebSocket-Protocol when the SameSite=Lax session cookie isn't
    // attached to the script-initiated upgrade (mobile browsers). Requires
    // the session cookie on THIS request — the ticket is only handed to a
    // client that is already authenticated.
    if (req.method === "GET" && fullUrl === "/api/ws-ticket") {
      var ticketUser = getMultiUserFromReq(req);
      if (!ticketUser) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      var ticket = auth.mintWsTicket(ticketUser.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ticket: ticket }));
      return;
    }

    // --- Skills routes (delegated to server-skills) ---
    if (skills.handleRequest(req, res, fullUrl)) return;

    // Root path — redirect to first accessible project
    if (fullUrl === "/" && req.method === "GET") {
      if (!isRequestAuthed(req)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(auth.getAuthPage());
        return;
      }
      if (projects.size > 0) {
        var targetSlug = null;
        var reqUser = getMultiUserFromReq(req);
        // Check for last-visited project cookie
        var lastProject = parseCookies(req)["clagentic_last_project"] || parseCookies(req)["clay_last_project"];
        if (lastProject && projects.has(lastProject)) {
          if (reqUser && onGetProjectAccess) {
            var lpAccess = onGetProjectAccess(lastProject);
            if (lpAccess && !lpAccess.error && users.canAccessProject(reqUser.id, lpAccess)) {
              targetSlug = lastProject;
            }
          } else {
            targetSlug = lastProject;
          }
        }
        // Fall back to first accessible project
        if (!targetSlug) {
          projects.forEach(function (ctx, s) {
            if (targetSlug) return;
            if (reqUser && onGetProjectAccess) {
              var access = onGetProjectAccess(s);
              if (access && !access.error && users.canAccessProject(reqUser.id, access)) {
                targetSlug = s;
              }
            } else {
              targetSlug = s;
            }
          });
        }
        if (targetSlug) {
          res.writeHead(302, { "Location": "/p/" + targetSlug + "/" });
          res.end();
          return;
        }
      }
      // No accessible projects — show info page
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pages.noProjectsPageHtml());
      return;
    }

    // Global info endpoint (projects only for authenticated requests)
    if (req.method === "GET" && req.url === "/info") {
      if (!isRequestAuthed(req)) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ version: currentVersion, authenticated: false }));
        return;
      }
      var projectList = [];
      projects.forEach(function (ctx, slug) {
        projectList.push({ slug: slug, project: ctx.project });
      });
      var liteStatus = detectLite();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        projects: projectList,
        version: currentVersion,
        authenticated: true,
        liteInstalled: liteStatus.installed,
        liteHome: liteStatus.liteHome,
      }));
      return;
    }

    // Static files (favicon, manifest, icons, sw.js, etc.)
    if (!fullUrl.includes("..") && !fullUrl.startsWith("/p/") && !fullUrl.startsWith("/api/")) {
      if (serveStatic(fullUrl, res)) return;
    }

    // Project-scoped routes: /p/{slug}/...
    var slug = extractSlug(req.url.split("?")[0]);
    if (!slug) {
      // Not a project route and not handled above
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    var ctx = projects.get(slug);
    if (!ctx) {
      res.writeHead(302, { "Location": "/" });
      res.end();
      return;
    }

    // Redirect /p/{slug} → /p/{slug}/ (trailing slash required for relative paths)
    if (fullUrl === "/p/" + slug) {
      res.writeHead(301, { "Location": "/p/" + slug + "/" });
      res.end();
      return;
    }

    // Auth check for project routes
    // Bypass auth for MCP bridge endpoint (localhost only).
    // The mcp-bridge-server.js runs as a local child process and cannot carry cookies.
    var projectUrlForAuth = stripPrefix(req.url.split("?")[0], slug);
    // req.socket.remoteAddress may differ between HTTP/HTTPS (TLSSocket wraps net.Socket).
    // Also check req.connection.remoteAddress for compatibility.
    var remoteAddr = req.socket.remoteAddress
      || (req.connection && req.connection.remoteAddress)
      || "";
    var isLocalhost = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
    var isMcpBridgeLocal = projectUrlForAuth === "/api/mcp-bridge"
      && req.method === "POST"
      && isLocalhost;
    if (projectUrlForAuth === "/api/mcp-bridge") {
      console.log("[server] MCP bridge auth: method=" + req.method + " addr=" + remoteAddr + " bypass=" + isMcpBridgeLocal);
    }
    // lr-2895ea: serve public shell static assets (app.js, style.css,
    // /modules/*.js, fonts, images, maps) AHEAD of the auth gate, bypassing
    // it entirely for GET requests to these paths. These files are public
    // and identical for every user — gating them provided no security and
    // broke mobile app boot (see isPublicShellAssetPath() doc comment
    // above). The document navigation (/p/{slug}/), /api/*, and /ws remain
    // fully gated below; this branch never reaches those paths because
    // isPublicShellAssetPath() explicitly excludes /api/*.
    if (req.method === "GET" && isPublicShellAssetPath(projectUrlForAuth)) {
      if (serveStatic(projectUrlForAuth, res)) return;
      // Not found on disk — fall through to the auth gate below so the
      // existing unauthed-asset 401 behavior (lr-e33776) still applies to
      // nonexistent asset paths instead of silently 404ing pre-auth.
    }

    if (!isMcpBridgeLocal && !isRequestAuthed(req)) {
      // lr-e33776: an unauthenticated request to a project-scoped asset/
      // module/API path must never receive the 200 text/html login page —
      // that response breaks module-script boot (nosniff + wrong MIME) and
      // caused the mobile "raw HTML flash / reconnecting" bug. Reserve the
      // login page for top-level document navigation.
      if (debug) {
        console.log("[server] unauthed project route: path=" + projectUrlForAuth
          + " cookiePresent=" + !!(req.headers && req.headers.cookie));
      }
      if (isAssetOrApiPath(projectUrlForAuth)) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "unauthenticated" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(auth.getAuthPage());
      return;
    }

    // Set last-visited project cookie for root redirect
    res.setHeader("Set-Cookie", "clagentic_last_project=" + slug + "; Path=/; SameSite=Strict; Max-Age=31536000" + (tlsOptions ? "; Secure" : ""));

    // Check project access for HTTP requests
    if (onGetProjectAccess) {
      var httpUser = getMultiUserFromReq(req);
      if (httpUser) {
        var httpAccess = onGetProjectAccess(slug);
        if (httpAccess && !httpAccess.error && !users.canAccessProject(httpUser.id, httpAccess)) {
          res.writeHead(302, { "Location": "/" });
          res.end();
          return;
        }
      }
    }

    // Strip prefix for project-scoped handling
    var projectUrl = stripPrefix(req.url.split("?")[0], slug);
    // Re-attach query string for API routes
    var qsIdx = req.url.indexOf("?");
    var projectUrlWithQS = qsIdx >= 0 ? projectUrl + req.url.substring(qsIdx) : projectUrl;

    // Attach user info for project HTTP handler
    req._clayUser = getMultiUserFromReq(req);

    // Try project HTTP handler first (APIs)
    var origUrl = req.url;
    req.url = projectUrlWithQS;
    var handled = ctx.handleHTTP(req, res, projectUrlWithQS);
    req.url = origUrl;
    if (handled) return;

    // Static files (same assets for all projects)
    if (req.method === "GET") {
      if (serveStatic(projectUrl, res)) return;
    }

    res.writeHead(404);
    res.end("Not found");
  };

  // --- Server setup ---
  var server;
  if (tlsOptions) {
    server = require("https").createServer(tlsOptions, appHandler);
  } else {
    server = http.createServer(appHandler);
  }

  // --- HTTP onboarding server (only when TLS is active) ---
  var onboardingServer = null;
  if (tlsOptions) {
    onboardingServer = http.createServer(function (req, res) {
      var url = req.url.split("?")[0];

      // CA certificate download
      if (url === "/ca/download" && req.method === "GET" && caContent) {
        res.writeHead(200, {
          "Content-Type": "application/x-pem-file",
          "Content-Disposition": 'attachment; filename="clagentic-ca.pem"',
        });
        res.end(caContent);
        return;
      }

      // Setup page
      if (url === "/setup" && req.method === "GET") {
        var host = req.headers.host || "localhost";
        var hostname = host.split(":")[0];
        var httpsSetupUrl = "https://" + hostname + ":" + portNum;
        var httpSetupUrl = "http://" + hostname + ":" + (portNum + 1);
        var lanMode = /[?&]mode=lan/.test(req.url);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pages.setupPageHtml(httpsSetupUrl, httpSetupUrl, !!caContent, lanMode));
        return;
      }

      // /info — CORS-enabled, used by setup page to verify HTTPS
      if (url === "/info" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ version: currentVersion }));
        return;
      }

      // Static files at root (favicon, manifest, icons, etc.)
      if (url.lastIndexOf("/") === 0 && !url.includes("..")) {
        if (serveStatic(url, res)) return;
      }

      // Everything else → redirect to HTTPS setup
      var hostname = (req.headers.host || "localhost").split(":")[0];
      res.writeHead(302, { "Location": "https://" + hostname + ":" + portNum + "/setup" });
      res.end();
    });
  }

  // --- Drain state (lr-6b30) ---
  // Injected by daemon.js via setDrain() after the drain controller is created.
  var _drainController = null;

  function setDrain(drainController) {
    _drainController = drainController;
  }

  // --- WebSocket ---
  // handleProtocols echoes back the offered subprotocol whenever the client
  // offered one and the upgrade authenticated (via ticket OR cookie — see
  // lr-4c58ae): the WS spec requires the 101 response to echo an accepted
  // subprotocol when one was offered, on any auth path. req._clayAcceptedProtocol
  // is set by the upgrade handler below after auth resolves, BEFORE
  // wss.handleUpgrade() is called, so it is available here.
  var wss = new WebSocketServer({
    noServer: true,
    handleProtocols: function (protocols, req) {
      if (req._clayAcceptedProtocol && protocols.has(req._clayAcceptedProtocol)) {
        return req._clayAcceptedProtocol;
      }
      return false;
    },
  });

  server.on("upgrade", function (req, socket, head) {
    // Origin validation (CSRF prevention)
    var origin = req.headers.origin;
    if (origin) {
      try {
        var originUrl = new URL(origin);
        var originPort = String(originUrl.port || (originUrl.protocol === "https:" ? "443" : "80"));
        // Extract port from Host header for reverse proxy support.
        // Use URL parser to correctly handle IPv6 addresses (e.g. [::1])
        // and infer default port from origin protocol (not backend tlsOptions)
        // so TLS-terminating proxies on :443 with HTTP backends work.
        var hostPort;
        try {
          var hostUrl = new URL(originUrl.protocol + "//" + (req.headers.host || ""));
          hostPort = String(hostUrl.port || (originUrl.protocol === "https:" ? "443" : "80"));
        } catch (e2) {
          hostPort = String(portNum);
        }
        if (originPort !== String(portNum) && originPort !== hostPort) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
      } catch (e) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    // Auth (lr-de5fcb): primary path is the relay_auth_user session cookie
    // (desktop). Fallback path is a short-TTL single-use ticket offered via
    // Sec-WebSocket-Protocol, for clients (mobile browsers) that do not
    // reliably attach a SameSite=Lax cookie to a script-initiated upgrade —
    // see MILLER's diagnosis, lr-de5fcb comment #1. The ticket is minted by
    // GET /api/ws-ticket, which itself requires the cookie, so a client must
    // already have completed a normal top-level authenticated request.
    //
    // lr-4c58ae: app-connection.js's connect() always fetches a ticket and
    // always offers it as a Sec-WebSocket-Protocol subprotocol — including
    // on desktop, which is cookie-authed. extractWsTicketFromHeader() is a
    // pure parse (no consumption/validation side effect), so it is safe to
    // call unconditionally, purely to learn what the client offered for the
    // echo below. Only the *validating* consumeWsTicket() call stays gated
    // on !wsCookieUser — a cookie-authed request must never burn the
    // client's single-use ticket, since the cookie already authenticated it
    // and consuming would needlessly invalidate a ticket a racing tab might
    // legitimately need.
    var wsCookieUser = getMultiUserFromReq(req);
    var wsTicketUser = null;
    var offeredTicket = extractWsTicketFromHeader(req.headers["sec-websocket-protocol"]);
    if (!wsCookieUser && offeredTicket) {
      wsTicketUser = auth.consumeWsTicket(offeredTicket);
    }
    var wsAuthedUser = wsCookieUser || wsTicketUser;

    if (!wsAuthedUser) {
      // Observability (DRUMMER-flagged, lr-de5fcb): debug-gated only, never
      // logs the cookie or ticket value itself — just presence/shape, so a
      // future "mobile can't connect" report is diagnosable in one pass
      // instead of the two-pass investigation this task closed out.
      if (debug) {
        console.log(
          "[server] WS upgrade rejected 401: cookiePresent=" + !!(req.headers.cookie) +
          " ticketOffered=" + !!offeredTicket
        );
      }
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    // Echo the accepted subprotocol back in the 101 response whenever the
    // client offered one — the WS spec (RFC 6455 §4.1) requires the server
    // to select one of the offered subprotocols if it accepts any of them;
    // omitting Sec-WebSocket-Protocol from the 101 after the client offered
    // a list forces the browser to fail the connection outright (lr-4c58ae).
    // This must fire on EITHER auth path: wsTicketUser (the offered value
    // was already validated+consumed above) or wsCookieUser (the offered
    // value was merely parsed, never validated/consumed — the cookie is
    // what authenticated this request, so echo it as-is without burning it).
    // See the WebSocketServer handleProtocols hook above.
    if (offeredTicket && (wsTicketUser || wsCookieUser)) {
      req._clayAcceptedProtocol = "clagentic.auth." + offeredTicket;
    }

    // Drain gate (lr-6b30): reject new sessions while draining so in-flight
    // sessions can complete before the daemon exits.
    if (_drainController && _drainController.isDraining()) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\n" +
        "Content-Type: application/json\r\n" +
        "Connection: close\r\n" +
        "\r\n"
      );
      socket.end(JSON.stringify({
        type: "error",
        code: "server_draining",
        message: "Server is draining for restart. Please reconnect in a moment.",
      }));
      return;
    }

    // Extract slug from WS URL: /p/{slug}/ws
    var wsSlug = extractSlug(req.url);
    if (!wsSlug) {
      socket.destroy();
      return;
    }

    var ctx = projects.get(wsSlug);
    if (!ctx) {
      if (debug) console.log("[server] WS rejected: project not found for slug", wsSlug);
      socket.destroy();
      return;
    }

    // Attach user info to the WS connection. Reuse wsAuthedUser (resolved
    // above from the cookie or, on mobile, the ticket fallback) rather than
    // re-deriving from the cookie — a ticket-authed request has no cookie.
    var wsUser = wsAuthedUser;
    // Check project access
    if (wsUser && onGetProjectAccess) {
      // For worktree projects, inherit access from parent
      var accessSlug = (wsSlug.indexOf("--") !== -1) ? wsSlug.split("--")[0] : wsSlug;
      var projectAccess = onGetProjectAccess(accessSlug);
      if (debug) console.log("[server] WS access check:", wsSlug, "user:", wsUser.id, "role:", wsUser.role, "visibility:", projectAccess && projectAccess.visibility, "ownerId:", projectAccess && projectAccess.ownerId, "allowed:", projectAccess && projectAccess.allowedUsers);
      if (projectAccess && !projectAccess.error) {
        if (!users.canAccessProject(wsUser.id, projectAccess)) {
          if (debug) console.log("[server] WS rejected: access denied for", wsUser.id, "on", wsSlug);
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
      }
    }

    wss.handleUpgrade(req, socket, head, function (ws) {
      // Per-client socket faults (e.g. ECONNRESET) emit 'error' on the ws
      // instance. Registered here, before any other listener, so a socket
      // fault during setup (rate-limit wrapper, ctx.handleConnection) can
      // never reach the daemon's uncaughtException handler and trigger
      // gracefulShutdown for every project. Log and drop only this socket.
      ws.on("error", function (err) {
        console.error("[server] WS upgrade socket error for " + wsSlug + ":", err && err.message ? err.message : err);
        try { ws.terminate(); } catch (e) {}
      });

      // Apply rate limiting to WS messages
      var msgCount = 0;
      var msgWindowStart = Date.now();
      var WS_RATE_LIMIT = 60; // messages per second
      var origEmit = ws.emit;
      ws.emit = function (event) {
        if (event === "message") {
          var now = Date.now();
          if (now - msgWindowStart >= 1000) {
            msgCount = 0;
            msgWindowStart = now;
          }
          msgCount++;
          if (msgCount > WS_RATE_LIMIT) {
            try {
              ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded. Connection will be closed." }));
              ws.close(1008, "Rate limit exceeded");
            } catch (e) {}
            return false;
          }
        }
        return origEmit.apply(ws, arguments);
      };
      ws._clayUser = wsUser; // attach user context
      var remoteAddr = req.socket.remoteAddress || "";
      ws._clayLocal = (remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1");
      // lr-20e71c: resolve the real external protocol for THIS connection at
      // upgrade time, while req.headers is still in scope — project-sessions.js's
      // per-message dispatch only has ws/msg, not the original upgrade req.
      ws._clayEffectiveProtocol = resolveEffectiveProtocol({
        tlsOptions: tlsOptions,
        trustedProxy: trustedProxy,
        forwardedProtoHeader: req.headers["x-forwarded-proto"],
      });
      // Clear cross-project unread for this project when client connects.
      // lr-0aa7b6: map is keyed per-session ("slug::localId") now, so clear
      // every entry whose slug prefix matches the project just connected to.
      var unreadMap = getCrossProjectUnread(ws);
      var unreadPrefix = wsSlug + "::";
      var unreadKeys = Object.keys(unreadMap);
      for (var ui = 0; ui < unreadKeys.length; ui++) {
        if (unreadKeys[ui].indexOf(unreadPrefix) === 0) unreadMap[unreadKeys[ui]] = 0;
      }
      ctx.handleConnection(ws, wsUser);
    });
  });

  // --- Cross-project unread tracking ---
  // WeakMap<ws, { "slug::localId": count }> tracks how many done events
  // happened in other projects, keyed per SESSION rather than per project
  // (lr-0aa7b6). A slug-only key made every session in a notifying project
  // look equally "unread" — the Home Hub Recent Sessions row for a sibling,
  // non-notifying session in the same project would light up too. localId
  // alone is not sufficient either: each project's SessionManager keeps its
  // own nextLocalId counter (see lib/sessions.js), so localId 3 in project A
  // and localId 3 in project B are unrelated sessions that would collide if
  // used as a bare key — hence the composite "slug::localId" key below.
  var crossProjectUnread = new WeakMap();

  function crossUnreadKey(slug, localId) {
    return slug + "::" + localId;
  }

  function getCrossProjectUnread(ws) {
    var map = crossProjectUnread.get(ws);
    if (!map) { map = {}; crossProjectUnread.set(ws, map); }
    return map;
  }

  // Sum of all per-session unread entries belonging to a given project slug,
  // for a given client. Preserves the pre-lr-0aa7b6 project-badge contract
  // (proj.unread on the Projects-list) now that the underlying map is keyed
  // per-session rather than per-project — the badge is a rollup over the
  // restructured map, not a separate counter.
  function getCrossProjectUnreadForSlug(ws, projSlug) {
    var map = getCrossProjectUnread(ws);
    var prefix = projSlug + "::";
    var total = 0;
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(prefix) === 0) total += map[keys[i]] || 0;
    }
    return total;
  }

  // Per-session unread lookup used by the Home Hub Recent Sessions data path
  // (lib/project-loop.js hub_recent_sessions_list) to attribute the alert
  // state to the individual notifying session rather than the whole project.
  // ownSlug is the slug of the project ws is connected to: for that project,
  // unread is tracked per-session via ws._clayUnread[localId] (the existing
  // same-project mechanism in lib/sessions.js doSendAndRecord); for every
  // other project, unread is tracked via the composite crossProjectUnread map.
  function getSessionUnread(ws, ownSlug, sessSlug, localId) {
    if (sessSlug === ownSlug) {
      var ownMap = ws._clayUnread || {};
      return ownMap[localId] || 0;
    }
    var map = getCrossProjectUnread(ws);
    return map[crossUnreadKey(sessSlug, localId)] || 0;
  }

  function onSessionDone(sourceSlug, sourceLocalId) {
    // Increment unread for all clients NOT connected to sourceSlug, keyed to
    // the specific session that finished (lr-0aa7b6).
    var key = crossUnreadKey(sourceSlug, sourceLocalId);
    projects.forEach(function (ctx, projSlug) {
      if (projSlug === sourceSlug) return;
      ctx.forEachClient(function (ws) {
        var map = getCrossProjectUnread(ws);
        map[key] = (map[key] || 0) + 1;
      });
    });
    // Trigger a projects_updated broadcast so clients get updated unread counts
    broadcastProcessingChange();
  }

  // lr-13c047 (Badge A prune-on-delete): a deleted session's crossProjectUnread
  // entry previously had no clear path at all — onSessionDone is increment-only
  // and the only clears were on full project-switch reconnect (below) or the
  // same-project ws._clayUnread zeroing in switchSession. If the session that
  // accrued the unread count is deleted before any client ever reconnects to
  // its project, that count is now permanently unreachable (its key can never
  // be zeroed by the connect-time prefix clear, since the session no longer
  // exists to switch to) — a phantom that inflates the Projects-tab badge
  // forever. Delete the key for every client of every project so the rollup
  // (getCrossProjectUnreadForSlug) stops counting it on the next broadcast.
  function onSessionDeleted(sourceSlug, sourceLocalId) {
    var key = crossUnreadKey(sourceSlug, sourceLocalId);
    var sawEntry = false;
    projects.forEach(function (ctx) {
      ctx.forEachClient(function (ws) {
        var map = getCrossProjectUnread(ws);
        if (key in map) {
          sawEntry = true;
          delete map[key];
        }
      });
    });
    if (sawEntry) broadcastProcessingChange();
  }

  // lr-13c047 (Badge A non-switch clear path): zero every crossProjectUnread
  // entry for a given project slug, for one client, without requiring that
  // client to actually connect to (switch into) that project. Wired to a
  // client-initiated "mark_cross_project_read" WS message (lib/project-sessions.js)
  // so a user can dismiss the Projects-tab badge for a project they don't want
  // to open right now — previously the only clear path was the connect-time
  // prefix zero at :1069-1077 below, which requires a full navigation.
  function markCrossProjectRead(ws, projSlug) {
    var map = getCrossProjectUnread(ws);
    var prefix = projSlug + "::";
    var keys = Object.keys(map);
    var cleared = false;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(prefix) === 0 && map[keys[i]]) {
        map[keys[i]] = 0;
        cleared = true;
      }
    }
    if (cleared) broadcastProcessingChange();
  }

  // --- Debounced broadcast for processing status changes ---
  var processingUpdateTimer = null;
  function broadcastProcessingChange() {
    if (processingUpdateTimer) clearTimeout(processingUpdateTimer);
    processingUpdateTimer = setTimeout(function () {
      processingUpdateTimer = null;
      var allProjectsList = getProjects();
      // Always send per-client to include cross-project unread counts
      projects.forEach(function (ctx, projSlug) {
        ctx.forEachClient(function (ws) {
          var filtered = allProjectsList;
          if (onGetProjectAccess) {
            var wsUser = ws._clayUser;
            if (wsUser) {
              filtered = allProjectsList.filter(function (p) {
                var access = onGetProjectAccess(p.slug);
                if (!access || access.error) return true;
                return users.canAccessProject(wsUser.id, access);
              });
            }
          }
          // Attach per-project unread counts for this client. lr-0aa7b6:
          // crossProjectUnread is now keyed per-session ("slug::localId"),
          // not per-project — the Projects-list badge total is a rollup
          // (sum) over that client's per-session entries for the project,
          // preserving the pre-restructure proj.unread contract.
          var projectsWithUnread = filtered.map(function (p) {
            var copy = {};
            var keys = Object.keys(p);
            for (var i = 0; i < keys.length; i++) copy[keys[i]] = p[keys[i]];
            // For the current project, use session-level unread total
            if (p.slug === projSlug) {
              copy.unread = ctx.sm.getTotalUnread(ws);
            } else {
              copy.unread = getCrossProjectUnreadForSlug(ws, p.slug);
            }
            return copy;
          });
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: "projects_updated",
              projects: projectsWithUnread,
              projectCount: projectsWithUnread.length,
              removedProjects: getRemovedProjects(ws._clayUser ? ws._clayUser.id : null),
              folderMeta: getFolderMeta(),
            }));
          }
        });
      });
    }, 200);
  }

  // --- Project management ---
  function addProject(cwd, slug, title, icon, projectOwnerId, worktreeMeta, extraOpts) {
    if (projects.has(slug)) return false;
    var extra = extraOpts || {};
    var ctx = createProjectContext({
      cwd: cwd,
      slug: slug,
      title: title || null,
      icon: icon || null,
      folderName: extra.folderName || null,
      preferredAgent: extra.preferredAgent || null,
      projectOwnerId: projectOwnerId || null,
      worktreeMeta: worktreeMeta || null,
      pushModule: pushModule,
      debug: debug,
      dangerouslySkipPermissions: dangerouslySkipPermissions,
      osUsers: osUsers,
      currentVersion: currentVersion,
      lanHost: lanHost,
      port: portNum,
      tls: !!tlsOptions,
      historyInMemMax: historyInMemMax,
      getProjectCount: function () { return projects.size; },
      getProjectList: function (userId) {
        var list = [];
        projects.forEach(function (ctx, s) {
          var status = ctx.getStatus();
          if (userId && onGetProjectAccess) {
            var access = onGetProjectAccess(s);
            if (access && !access.error && !users.canAccessProject(userId, access)) return;
          }
          list.push(status);
        });
        return list;
      },
      // includeSelf: when true, the calling project's own sessions are included
      // in the uniform pass (so callers need not special-case self). The Hub
      // recent-sessions list uses this to gather every project identically —
      // matching the palette's behavior — so the global recency sort is honest
      // and the currently-connected project doesn't dominate the result.
      //
      // userId: REQUIRED to filter results to what the viewing user may
      // actually see. Unlike getProjectList/broadcastProcessingChange (which
      // the identical onGetProjectAccess + users.canAccessProject gate above
      // already protects), this function previously took no userId at all
      // and filtered only on `!s.hidden` -- it structurally could not
      // enforce per-project access or private-session visibility, leaking
      // cross-project and private sessions into the Home Hub recent-sessions
      // list. Fails CLOSED: no userId (or no onGetProjectAccess wiring) means
      // no sessions are returned. There is no legitimate no-auth caller of
      // this function -- the WS upgrade handler above rejects any connection
      // without an authenticated user (wsAuthedUser) with 401 before
      // ws._clayUser can ever be set, including in single-user/PIN mode
      // (still a real authenticated user, just one account) -- so failing
      // closed here never breaks a real deployment mode.
      getAllProjectSessions: function (includeSelf, userId) {
        return computeAllProjectSessions({
          projects: projects,
          users: users,
          onGetProjectAccess: onGetProjectAccess,
          callerSlug: slug,
          includeSelf: includeSelf,
          userId: userId,
        });
      },
      getHubSchedules: function () {
        var allSchedules = [];
        projects.forEach(function (ctx, s) {
          var status = ctx.getStatus();
          var recs = ctx.getSchedules();
          for (var i = 0; i < recs.length; i++) {
            // Shallow-copy full record and augment with project metadata
            var copy = {};
            var keys = Object.keys(recs[i]);
            for (var k = 0; k < keys.length; k++) copy[keys[k]] = recs[i][keys[k]];
            copy.projectSlug = s;
            copy.projectTitle = status.title || status.project;
            allSchedules.push(copy);
          }
        });
        return allSchedules;
      },
      // Move a schedule record from one project to another
      moveScheduleToProject: function (recordId, fromSlug, toSlug) {
        var fromCtx = projects.get(fromSlug);
        var toCtx = projects.get(toSlug);
        if (!fromCtx || !toCtx) return { ok: false, error: "Project not found" };
        var recs = fromCtx.getSchedules();
        var rec = null;
        for (var i = 0; i < recs.length; i++) {
          if (recs[i].id === recordId) { rec = recs[i]; break; }
        }
        if (!rec) return { ok: false, error: "Record not found" };
        // Copy full record data
        var data = {};
        var keys = Object.keys(rec);
        for (var k = 0; k < keys.length; k++) data[keys[k]] = rec[keys[k]];
        // Import into target, remove from source
        toCtx.importSchedule(data);
        fromCtx.removeSchedule(recordId);
        return { ok: true };
      },
      // Bulk move all schedules from one project to another
      moveAllSchedulesToProject: function (fromSlug, toSlug) {
        var fromCtx = projects.get(fromSlug);
        var toCtx = projects.get(toSlug);
        if (!fromCtx || !toCtx) return { ok: false, error: "Project not found" };
        var recs = fromCtx.getSchedules();
        for (var i = 0; i < recs.length; i++) {
          var data = {};
          var keys = Object.keys(recs[i]);
          for (var k = 0; k < keys.length; k++) data[keys[k]] = recs[i][keys[k]];
          toCtx.importSchedule(data);
        }
        // Remove all from source
        var ids = recs.map(function (r) { return r.id; });
        for (var j = 0; j < ids.length; j++) {
          fromCtx.removeSchedule(ids[j]);
        }
        return { ok: true };
      },
      // Get schedule count for a project slug
      getScheduleCount: function (slug) {
        var ctx = projects.get(slug);
        if (!ctx) return 0;
        return ctx.getSchedules().length;
      },
      onPresenceChange: broadcastPresenceChange,
      onProcessingChanged: broadcastProcessingChange,
      onSessionDone: function (localId) { onSessionDone(slug, localId); },
      // lr-13c047: prune crossProjectUnread['slug::localId'] for every client
      // when a session in this project is deleted — see onSessionDeleted's
      // header above.
      onSessionDeleted: function (localId) { onSessionDeleted(slug, localId); },
      // lr-13c047: expose the non-switch "mark read" clear path (see
      // markCrossProjectRead's header above) so lib/project-sessions.js can
      // wire a client-initiated mark_cross_project_read WS message without
      // reaching into server.js internals directly.
      markCrossProjectRead: function (ws, projSlug) { markCrossProjectRead(ws, projSlug); },
      // lr-0aa7b6: per-session unread lookup for the Home Hub Recent
      // Sessions data path — see getSessionUnread's header above for why
      // this must distinguish "own project" (ws._clayUnread) from
      // "other project" (composite crossProjectUnread map).
      getSessionUnread: function (ws, sessSlug, localId) { return getSessionUnread(ws, slug, sessSlug, localId); },
      onAddProject: onAddProject,
      onCreateProject: onCreateProject,
      onCloneProject: onCloneProject,
      onRemoveProject: onRemoveProject,
      onCreateWorktree: onCreateWorktree,
      onReorderProjects: onReorderProjects,
      onSetProjectTitle: onSetProjectTitle,
      onSetProjectIcon: onSetProjectIcon,
      onSetProjectPreferredAgent: onSetProjectPreferredAgent,
      onSetProjectFolder: onSetProjectFolder,
      onRenameProjectFolder: onRenameProjectFolder,
      onSetFolderIcon: onSetFolderIcon,
      onRenameCustomIcon: onRenameCustomIcon,
      onProjectOwnerChanged: onProjectOwnerChanged,
      onGetServerDefaultEffort: onGetServerDefaultEffort,
      onSetServerDefaultEffort: onSetServerDefaultEffort,
      onGetProjectDefaultEffort: onGetProjectDefaultEffort,
      onSetProjectDefaultEffort: onSetProjectDefaultEffort,
      onGetServerDefaultModel: onGetServerDefaultModel,
      onSetServerDefaultModel: onSetServerDefaultModel,
      onGetProjectDefaultModel: onGetProjectDefaultModel,
      onSetProjectDefaultModel: onSetProjectDefaultModel,
      onGetServerDefaultMode: onGetServerDefaultMode,
      onSetServerDefaultMode: onSetServerDefaultMode,
      onGetProjectDefaultMode: onGetProjectDefaultMode,
      onSetProjectDefaultMode: onSetProjectDefaultMode,
      onGetServerDefaultBetas: onGetServerDefaultBetas,
      onSetServerDefaultBetas: onSetServerDefaultBetas,
      onGetProjectDefaultBetas: onGetProjectDefaultBetas,
      onSetProjectDefaultBetas: onSetProjectDefaultBetas,
      onGetProjectMcpServers: onGetProjectMcpServers,
      onSetProjectMcpServers: onSetProjectMcpServers,
      onGetDaemonConfig: onGetDaemonConfig,
      onSetPin: onSetPin,
      onSetKeepAwake: onSetKeepAwake,
      onSetImageRetention: onSetImageRetention,
      onSetMemAvailableThreshold: onSetMemAvailableThreshold,
      onSetLiteAutoEnroll: onSetLiteAutoEnroll,
      onSetUpdateChannel: onSetUpdateChannel,
      updateChannel: onGetDaemonConfig ? (onGetDaemonConfig().updateChannel || "stable") : "stable",
      onShutdown: onShutdown,
      onRestart: onRestart,
      onDmMessage: handleDmMessage,
      broadcastAll: broadcastAll,
      notificationsModule: _globalNotifications,
      getProject: function (s) { return projects.get(s) || null; },
      isUserOnline: isUserOnline,
    });
    projects.set(slug, ctx);
    // ctx.warmup() is now deferred to the first websocket connection into
    // this project (see project-connection.js handleConnection). Warming
    // every project at startup spawned a CodexAppServer and an mcp-bridge
    // child for each one, which cost 30+ processes on daemons with many
    // projects even though the user typically only opens one.
    scheduleRegistryRefresh();
    return true;
  }

  // --- DM message handler (delegated to server-dm) ---
  var dmHandler = serverDm.attachDm({
    users: users,
    dm: dm,
    projects: projects,
    pushModule: pushModule,
  });

  function scheduleRegistryRefresh() {
    // Refresh the project registry for all projects after a project change
  }

  function handleDmMessage(ws, msg) {
    if (dmHandler.handleMessage(ws, msg)) return;
  }

  function removeProject(slug) {
    var ctx = projects.get(slug);
    if (!ctx) return false;
    var shutdownResult = ctx.destroy();
    projects.delete(slug);
    if (shutdownResult && typeof shutdownResult.catch === "function") {
      shutdownResult.catch(function(err) {
        console.error("[server] Project destroy failed for " + slug + ":", err && err.message ? err.message : err);
      });
    }
    scheduleRegistryRefresh();
    return true;
  }

  function getProjects() {
    var list = [];
    projects.forEach(function (ctx) {
      list.push(ctx.getStatus());
    });
    return list;
  }

  function reorderProjects(slugs) {
    var ordered = new Map();
    for (var i = 0; i < slugs.length; i++) {
      var ctx = projects.get(slugs[i]);
      if (ctx) ordered.set(slugs[i], ctx);
    }
    // Append any remaining (safety)
    projects.forEach(function (ctx, slug) {
      if (!ordered.has(slug)) ordered.set(slug, ctx);
    });
    projects.clear();
    ordered.forEach(function (ctx, slug) {
      projects.set(slug, ctx);
    });
  }

  function setProjectTitle(slug, title) {
    var ctx = projects.get(slug);
    if (!ctx) return false;
    ctx.setTitle(title);
    return true;
  }

  function setProjectIcon(slug, icon) {
    var ctx = projects.get(slug);
    if (!ctx) return false;
    ctx.setIcon(icon);
    return true;
  }

  function setProjectFolder(slug, folderName) {
    var ctx = projects.get(slug);
    if (!ctx) return false;
    ctx.setFolderName(folderName);
    return true;
  }

  function setProjectFolderName(oldName, newName) {
    projects.forEach(function (ctx) {
      var status = ctx.getStatus();
      if (status.folderName === oldName) {
        ctx.setFolderName(newName);
      }
    });
    return true;
  }

  function setProjectPreferredAgent(slug, agent) {
    var ctx = projects.get(slug);
    if (!ctx) return false;
    ctx.setPreferredAgent(agent);
    return true;
  }

  // Collect all unique users across all projects (for topbar server-wide presence)
  function getServerUsers() {
    var seen = {};
    var list = [];
    projects.forEach(function (ctx) {
      ctx.forEachClient(function (ws) {
        if (!ws._clayUser) return;
        var u = ws._clayUser;
        if (seen[u.id]) return;
        seen[u.id] = true;
        var p = u.profile || {};
        list.push({
          id: u.id,
          displayName: p.name || u.displayName || u.username,
          username: u.username,
          avatarStyle: p.avatarStyle || "thumbs",
          avatarSeed: p.avatarSeed || u.username,
          avatarCustom: p.avatarCustom || "",
        });
      });
    });
    return list;
  }

  // Debounced broadcast of projects_updated when presence changes
  // Sends per-user filtered project lists + server-wide user list
  var presenceTimer = null;
  function broadcastPresenceChange() {
    if (presenceTimer) clearTimeout(presenceTimer);
    presenceTimer = setTimeout(function () {
      presenceTimer = null;
      var serverUsers = getServerUsers();
      var allUsers = users.getAllUsers().map(function (u) {
        var p = u.profile || {};
        return {
          id: u.id,
          displayName: p.name || u.displayName || u.username,
          username: u.username,
          role: u.role,
          avatarStyle: p.avatarStyle || "thumbs",
          avatarSeed: p.avatarSeed || u.username,
          avatarColor: p.avatarColor || "#7c3aed",
          avatarCustom: p.avatarCustom || "",
        };
      });
      // Build per-user filtered lists, send individually
      var sentUsers = {};
      projects.forEach(function (ctx) {
        ctx.forEachClient(function (ws) {
          var userId = ws._clayUser ? ws._clayUser.id : null;
          var key = userId || "__anon__";
          if (sentUsers[key]) {
            // Already computed for this user, just send the cached msg
            ws.send(sentUsers[key]);
            return;
          }
          var filteredProjects = [];
          projects.forEach(function (pCtx, s) {
            var status = pCtx.getStatus();
            if (userId && onGetProjectAccess) {
              var access = onGetProjectAccess(s);
              if (access && !access.error && !users.canAccessProject(userId, access)) return;
            }
            filteredProjects.push(status);
          });
          // Per-user DM data
          var userDmFavorites = userId ? users.getDmFavorites(userId) : [];
          var userDmHidden = userId ? users.getDmHidden(userId) : [];
          var userDmConversations = [];
          if (userId) {
            var dmList = dm.getDmList(userId);
            for (var di = 0; di < dmList.length; di++) {
              if (userDmHidden.indexOf(dmList[di].otherUserId) === -1) {
                userDmConversations.push(dmList[di].otherUserId);
              }
            }
          }
          var msgStr = JSON.stringify({
            type: "projects_updated",
            projects: filteredProjects,
            projectCount: projects.size,
            serverUsers: serverUsers,
            allUsers: allUsers,
            dmFavorites: userDmFavorites,
            dmConversations: userDmConversations,
            removedProjects: getRemovedProjects(userId),
            folderMeta: getFolderMeta(),
          });
          sentUsers[key] = msgStr;
          ws.send(msgStr);
        });
      });
    }, 300);
  }

  function broadcastAll(msg) {
    projects.forEach(function (ctx) {
      ctx.send(msg);
    });
  }

  // Send a message to every live ws belonging to a specific user across all projects.
  // Used by user-targeted notifications (e.g. user-to-user @mentions).
  function sendToUser(userId, msg) {
    if (!userId) return;
    var data = JSON.stringify(msg);
    projects.forEach(function (ctx) {
      if (typeof ctx.forEachClient !== "function") return;
      ctx.forEachClient(function (ws) {
        if (ws._clayUser && ws._clayUser.id === userId && ws.readyState === 1) {
          ws.send(data);
        }
      });
    });
  }

  // True if the user has any live ws across any project.
  function isUserOnline(userId) {
    if (!userId) return false;
    var found = false;
    projects.forEach(function (ctx) {
      if (found) return;
      if (typeof ctx.forEachClient !== "function") return;
      ctx.forEachClient(function (ws) {
        if (found) return;
        if (ws._clayUser && ws._clayUser.id === userId && ws.readyState === 1) {
          found = true;
        }
      });
    });
    return found;
  }

  function forEachProject(fn) {
    projects.forEach(function (ctx, slug) {
      fn(ctx, slug);
    });
  }

  function destroyAll() {
    _externalTrigger.stopWatcher();
    var shutdowns = [];
    projects.forEach(function (ctx, slug) {
      console.log("[server] Destroying project:", slug);
      var result = ctx.destroy();
      if (result && typeof result.then === "function") {
        shutdowns.push(result.catch(function(err) {
          console.error("[server] Project destroy failed for " + slug + ":", err && err.message ? err.message : err);
          return false;
        }));
      }
    });
    projects.clear();
    return Promise.all(shutdowns);
  }

  // --- Periodic cleanup of old chat images ---
  var imagesBaseDir = path.join(CONFIG_DIR, "images");
  function getImageMaxAgeMs() {
    var days = onGetDaemonConfig ? onGetDaemonConfig().imageRetentionDays : undefined;
    if (days === undefined) days = 7;
    if (days === 0) return 0; // 0 = keep forever
    return days * 24 * 60 * 60 * 1000;
  }
  function cleanupOldImages() {
    var maxAge = getImageMaxAgeMs();
    if (maxAge === 0) return; // keep forever
    try {
      if (!fs.existsSync(imagesBaseDir)) return;
      var dirs = fs.readdirSync(imagesBaseDir);
      var now = Date.now();
      var removed = 0;
      for (var d = 0; d < dirs.length; d++) {
        var dirPath = path.join(imagesBaseDir, dirs[d]);
        try {
          var stat = fs.statSync(dirPath);
          if (!stat.isDirectory()) continue;
        } catch (e) { continue; }
        var files = fs.readdirSync(dirPath);
        for (var f = 0; f < files.length; f++) {
          var filePath = path.join(dirPath, files[f]);
          try {
            var fstat = fs.statSync(filePath);
            if (now - fstat.mtimeMs > maxAge) {
              fs.unlinkSync(filePath);
              removed++;
            }
          } catch (e) {}
        }
        // Remove empty directory
        try {
          var remaining = fs.readdirSync(dirPath);
          if (remaining.length === 0) fs.rmdirSync(dirPath);
        } catch (e) {}
      }
      if (removed > 0) console.log("[images] Cleaned up " + removed + " expired image(s)");
    } catch (e) {
      console.error("[images] Cleanup error:", e.message);
    }
  }
  cleanupOldImages();
  setInterval(cleanupOldImages, 24 * 60 * 60 * 1000);

  return {
    server: server,
    onboardingServer: onboardingServer,
    isTLS: !!tlsOptions,
    addProject: addProject,
    removeProject: removeProject,
    getProjects: getProjects,
    reorderProjects: reorderProjects,
    setProjectTitle: setProjectTitle,
    setProjectIcon: setProjectIcon,
    setProjectFolder: setProjectFolder,
    setProjectFolderName: setProjectFolderName,
    setProjectPreferredAgent: setProjectPreferredAgent,
    setRecovery: auth.setRecovery,
    clearRecovery: auth.clearRecovery,
    broadcastAll: broadcastAll,
    forEachProject: forEachProject,
    destroyProject: removeProject,
    destroyAll: destroyAll,
    // Drain controller injection (lr-6b30).
    setDrain: setDrain,
  };
}

module.exports = { createServer: createServer };
