/**
 * WhatsApp Topbar Widget for the Campaign Manager.
 * Shows connection status as a compact dot in the topbar with a dropdown
 * showing stats and connect/disconnect actions.
 */
(function () {
  "use strict";

  var API = "/api/wa-web";

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    var topbarBtn = document.getElementById("wa-topbar-btn");
    var topbarDot = document.getElementById("wa-topbar-dot");
    var topbarLabel = document.getElementById("wa-topbar-label");
    var dropdown = document.getElementById("wa-topbar-dropdown");
    var ddDot = document.getElementById("wa-dd-dot");
    var ddStatus = document.getElementById("wa-dd-status");
    var ddStats = document.getElementById("wa-dd-stats");
    var ddAction = document.getElementById("wa-dd-action");
    var ddClose = document.getElementById("wa-dd-close");

    if (!topbarBtn) return;

    var STATUS_COLORS = {
      connected: "#10b981",
      connecting: "#f59e0b",
      reconnecting: "#f59e0b",
      waiting_qr: "#f59e0b",
      disconnected: "#94a3b8",
      unavailable: "#ef4444",
    };

    var isOpen = false;
    var currentStatus = "disconnected";
    var qrPollInterval = null;

    // Toggle dropdown
    topbarBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      isOpen = !isOpen;
      dropdown.classList.toggle("hidden", !isOpen);
      if (isOpen) refreshDropdown();
    });

    if (ddClose) {
      ddClose.addEventListener("click", function () {
        isOpen = false;
        dropdown.classList.add("hidden");
      });
    }

    // Close on outside click
    document.addEventListener("click", function (e) {
      if (isOpen && !dropdown.contains(e.target) && !topbarBtn.contains(e.target)) {
        isOpen = false;
        dropdown.classList.add("hidden");
      }
    });

    // Check status periodically
    function checkStatus() {
      fetch(API + "/status", { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          currentStatus = data.status || "disconnected";
          updateDot();
        })
        .catch(function () {
          currentStatus = "unavailable";
          updateDot();
        });
    }

    function updateDot() {
      var color = STATUS_COLORS[currentStatus] || STATUS_COLORS.disconnected;
      if (topbarDot) topbarDot.style.background = color;
      if (ddDot) ddDot.style.background = color;
      if (topbarLabel) {
        topbarLabel.textContent = currentStatus === "connected" ? "Connected" : "WhatsApp";
        topbarLabel.style.color = currentStatus === "connected" ? "#10b981" : "";
      }
    }

    function refreshDropdown() {
      var labels = {
        connected: "Connected",
        connecting: "Connecting...",
        reconnecting: "Reconnecting...",
        waiting_qr: "Scan QR...",
        disconnected: "Not Connected",
        unavailable: "Service Offline",
      };
      if (ddStatus) ddStatus.textContent = labels[currentStatus] || currentStatus;

      if (currentStatus === "connected") {
        // Show stats + disconnect
        if (ddStats) ddStats.classList.remove("hidden");
        loadStats();
        if (ddAction) {
          ddAction.innerHTML =
            '<button type="button" id="wa-dd-disconnect" class="w-full text-center text-xs text-red-500 hover:text-red-700 font-medium py-1.5">Disconnect</button>';
          document.getElementById("wa-dd-disconnect").addEventListener("click", doDisconnect);
        }
      } else {
        if (ddStats) ddStats.classList.add("hidden");
        if (ddAction) {
          ddAction.innerHTML =
            '<button type="button" id="wa-dd-connect-qr" class="w-full h-9 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold transition-colors">Connect with QR Code</button>' +
            '<div id="wa-dd-qr-area" class="hidden mt-3 text-center">' +
              '<div id="wa-dd-qr-image" class="inline-block bg-white p-2 rounded-lg border border-slate-200"></div>' +
              '<p class="text-[10px] text-slate-400 mt-1">Scan with WhatsApp → Linked Devices</p>' +
            '</div>';
          document.getElementById("wa-dd-connect-qr").addEventListener("click", doConnectQR);
        }
      }
    }

    function loadStats() {
      fetch(API + "/send-stats", { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var sent = document.getElementById("wa-dd-sent");
          var limit = document.getElementById("wa-dd-limit");
          var remaining = document.getElementById("wa-dd-remaining");
          if (sent) sent.textContent = data.sent || 0;
          if (limit) limit.textContent = data.limit || 20;
          if (remaining) remaining.textContent = data.remaining || 0;
        })
        .catch(function () {});
    }

    function doDisconnect() {
      if (!confirm("Disconnect WhatsApp?")) return;
      fetch(API + "/disconnect", { method: "POST", credentials: "same-origin" })
        .then(function () {
          currentStatus = "disconnected";
          updateDot();
          refreshDropdown();
        })
        .catch(function (err) { alert("Error: " + err.message); });
    }

    function doConnectQR() {
      var btn = document.getElementById("wa-dd-connect-qr");
      if (btn) { btn.disabled = true; btn.textContent = "Generating..."; }

      fetch(API + "/connect-qr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) {
            if (btn) { btn.disabled = false; btn.textContent = "Connect with QR Code"; }
            alert("Error: " + data.error);
            return;
          }

          var qrArea = document.getElementById("wa-dd-qr-area");
          var qrImage = document.getElementById("wa-dd-qr-image");
          if (btn) btn.classList.add("hidden");
          if (qrArea) qrArea.classList.remove("hidden");

          if (data.qr && qrImage && typeof QRCode !== "undefined") {
            qrImage.innerHTML = "";
            new QRCode(qrImage, { text: data.qr, width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M });
          }

          // Poll for connection
          if (qrPollInterval) clearInterval(qrPollInterval);
          var attempts = 0;
          qrPollInterval = setInterval(function () {
            attempts++;
            if (attempts > 60) { clearInterval(qrPollInterval); return; }
            fetch(API + "/qr", { credentials: "same-origin" })
              .then(function (r) { return r.json(); })
              .then(function (qrData) {
                if (qrData.status === "connected") {
                  clearInterval(qrPollInterval);
                  currentStatus = "connected";
                  updateDot();
                  refreshDropdown();
                } else if (qrData.qr && qrImage && typeof QRCode !== "undefined") {
                  qrImage.innerHTML = "";
                  new QRCode(qrImage, { text: qrData.qr, width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M });
                }
              }).catch(function () {});
          }, 2000);
        })
        .catch(function (err) {
          if (btn) { btn.disabled = false; btn.textContent = "Connect with QR Code"; }
          alert("Failed: " + err.message);
        });
    }

    // Initial check
    checkStatus();
    setInterval(checkStatus, 15000);
  }
})();
