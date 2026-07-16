// lib/cli/net-detect.js
//
// Network/cert detection helpers for bin/cli.js: LAN/Tailscale IP discovery,
// port-availability checks, and mkcert-based TLS cert provisioning.
// Extracted verbatim from bin/cli.js (lr-4e49 Part 1), no behavior change.

var os = require("os");
var fs = require("fs");
var path = require("path");
var net = require("net");
var execSync = require("child_process").execSync;
var execFileSync = require("child_process").execFileSync;

// --- Network ---
function getLocalIP() {
  var interfaces = os.networkInterfaces();

  // Prefer Tailscale IP
  for (var name in interfaces) {
    if (/^(tailscale|utun)/.test(name)) {
      for (var j = 0; j < interfaces[name].length; j++) {
        var addr = interfaces[name][j];
        if (addr.family === "IPv4" && !addr.internal && addr.address.startsWith("100.")) {
          return addr.address;
        }
      }
    }
  }

  // All interfaces for Tailscale CGNAT range
  for (var addrs of Object.values(interfaces)) {
    for (var k = 0; k < addrs.length; k++) {
      if (addrs[k].family === "IPv4" && !addrs[k].internal && addrs[k].address.startsWith("100.")) {
        return addrs[k].address;
      }
    }
  }

  // Fall back to LAN IP
  for (var addrs2 of Object.values(interfaces)) {
    for (var m = 0; m < addrs2.length; m++) {
      if (addrs2[m].family === "IPv4" && !addrs2[m].internal) {
        return addrs2[m].address;
      }
    }
  }

  return "localhost";
}

// --- Certs ---
function isRoutableIP(addr) {
  if (addr.startsWith("10.")) return true;
  if (addr.startsWith("192.168.")) return true;
  if (addr.startsWith("100.")) {
    var second = parseInt(addr.split(".")[1], 10);
    return second >= 64 && second <= 127; // CGNAT (Tailscale)
  }
  if (addr.startsWith("172.")) {
    var second = parseInt(addr.split(".")[1], 10);
    return second >= 16 && second <= 31;
  }
  return false;
}

function getAllIPs() {
  var ips = [];
  var ifaces = os.networkInterfaces();
  for (var addrs of Object.values(ifaces)) {
    for (var j = 0; j < addrs.length; j++) {
      if (addrs[j].family === "IPv4" && !addrs[j].internal && isRoutableIP(addrs[j].address)) {
        ips.push(addrs[j].address);
      }
    }
  }
  return ips;
}

/**
 * Ensure a TLS cert exists for the given IP, generating one with mkcert if
 * needed. `configDir` is the console config directory (CONFIG_DIR);
 * `forceMkcert` mirrors the CLI --local-cert flag (suppresses the migration
 * notice / mkcertDetected flag downstream).
 */
function ensureCerts(ip, configDir, forceMkcert) {
  // certs/ now lives under CONFIG_DIR (= ~/.clagentic/console/).
  // Old location was ~/.clagentic/certs/ — migration runs in daemon.js on startup.
  var certDir = path.join(configDir, "certs");
  var keyPath = path.join(certDir, "key.pem");
  var certPath = path.join(certDir, "cert.pem");


  var mkcertInstalled = hasMkcert();

  var caRoot = null;
  if (mkcertInstalled) {
    try {
      caRoot = path.join(
        execSync("mkcert -CAROOT", { encoding: "utf8" }).trim(),
        "rootCA.pem"
      );
      if (!fs.existsSync(caRoot)) caRoot = null;
    } catch (e) {}
  }

  // Collect all IPv4 addresses (Tailscale + LAN)
  var allIPs = getAllIPs();

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    var needRegen = false;
    var isMkcertCert = false;
    try {
      var certText = execFileSync("openssl", ["x509", "-in", certPath, "-text", "-noout"], { encoding: "utf8" });
      // If cert is from an external CA (e.g. Tailscale/Let's Encrypt), never regenerate
      if (certText.indexOf("mkcert") === -1) return { key: keyPath, cert: certPath, caRoot: caRoot };
      isMkcertCert = true;
      for (var i = 0; i < allIPs.length; i++) {
        if (certText.indexOf(allIPs[i]) === -1) {
          needRegen = true;
          break;
        }
      }
    } catch (e) { needRegen = true; }
    // mkcert cert but mkcert uninstalled: CA is gone, cert is untrusted. Skip it.
    if (isMkcertCert && !mkcertInstalled) needRegen = true;
    if (!needRegen) {
      return { key: keyPath, cert: certPath, caRoot: caRoot, mkcertDetected: mkcertInstalled && !forceMkcert };
    }
  }

  // mkcert installed: generate local cert (legacy behavior)
  if (mkcertInstalled) {
    fs.mkdirSync(certDir, { recursive: true });

    var domains = ["localhost", "127.0.0.1", "::1"];
    for (var i = 0; i < allIPs.length; i++) {
      if (domains.indexOf(allIPs[i]) === -1) domains.push(allIPs[i]);
    }

    try {
      var mkcertArgs = ["-key-file", keyPath, "-cert-file", certPath].concat(domains);
      execFileSync("mkcert", mkcertArgs, { stdio: "pipe" });
    } catch (err) {
      // mkcert generation failed
    }

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return { key: keyPath, cert: certPath, caRoot: caRoot, mkcertDetected: !forceMkcert };
    }
  }

  return null;
}

// --- Port availability ---

function isPortFree(p) {
  return new Promise(function (resolve) {
    var srv = net.createServer();
    srv.once("error", function () { resolve(false); });
    srv.once("listening", function () { srv.close(function () { resolve(true); }); });
    srv.listen(p);
  });
}

// --- Detect tools ---
function getTailscaleIP() {
  var interfaces = os.networkInterfaces();
  for (var name in interfaces) {
    if (/^(tailscale|utun)/.test(name)) {
      for (var i = 0; i < interfaces[name].length; i++) {
        var addr = interfaces[name][i];
        if (addr.family === "IPv4" && !addr.internal && addr.address.startsWith("100.")) {
          return addr.address;
        }
      }
    }
  }
  for (var addrs of Object.values(interfaces)) {
    for (var j = 0; j < addrs.length; j++) {
      if (addrs[j].family === "IPv4" && !addrs[j].internal && addrs[j].address.startsWith("100.")) {
        return addrs[j].address;
      }
    }
  }
  return null;
}

function hasTailscale() {
  return getTailscaleIP() !== null;
}

function hasMkcert() {
  try {
    execSync("mkcert -CAROOT", { stdio: "pipe", encoding: "utf8" });
    return true;
  } catch (e) { return false; }
}

module.exports = {
  getLocalIP: getLocalIP,
  isRoutableIP: isRoutableIP,
  getAllIPs: getAllIPs,
  ensureCerts: ensureCerts,
  isPortFree: isPortFree,
  getTailscaleIP: getTailscaleIP,
  hasTailscale: hasTailscale,
  hasMkcert: hasMkcert,
};
