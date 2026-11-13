import { copyToClipboard } from './utils.js';
import { showOverlay } from './overlay.js';

function getShareUrl() {
  var url = window.location.href;
  var h = window.location.hostname;
  if ((h === "localhost" || h === "127.0.0.1") && window.__lanHost) {
    url = url.replace(h + ":" + window.location.port, window.__lanHost);
  }
  return url;
}

export function triggerShare() {
  var url = getShareUrl();

  // Use Web Share API on mobile only
  var isMobile = window.innerWidth <= 768 || /Mobi|Android/i.test(navigator.userAgent);
  if (isMobile && navigator.share) {
    navigator.share({ title: document.title || "Clagentic: Console", url: url }).catch(function () {});
    return;
  }

  // Show QR overlay
  var qrOverlay = document.getElementById("qr-overlay");
  var qrCanvas = document.getElementById("qr-canvas");
  var qrUrl = document.getElementById("qr-url");
  var qrShareBtn = document.getElementById("qr-share-btn");

  var qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  qrCanvas.innerHTML = qr.createSvgTag(5, 0);
  qrUrl.innerHTML = url + '<span class="qr-hint">click to copy</span>';

  // Show browser share button if Web Share API is available
  if (qrShareBtn) {
    if (navigator.share) {
      qrShareBtn.classList.remove("hidden");
    } else {
      qrShareBtn.classList.add("hidden");
    }
  }

  // Escape, the scrim and the shared close control close it.
  showOverlay({ kind: "modal", el: qrOverlay });
}

export function initQrCode() {
  var qrUrl = document.getElementById("qr-url");

  // click URL to copy
  qrUrl.addEventListener("click", function () {
    var url = getShareUrl();
    copyToClipboard(url).then(function () {
      qrUrl.innerHTML = "Copied!";
      qrUrl.classList.add("copied");
      setTimeout(function () {
        qrUrl.innerHTML = url + '<span class="qr-hint">click to copy</span>';
        qrUrl.classList.remove("copied");
      }, 1500);
    });
  });

  // Browser share button
  var qrShareBtn = document.getElementById("qr-share-btn");
  if (qrShareBtn) {
    qrShareBtn.addEventListener("click", function () {
      var url = getShareUrl();
      navigator.share({ title: document.title || "Clagentic: Console", url: url }).catch(function () {});
    });
  }
}
