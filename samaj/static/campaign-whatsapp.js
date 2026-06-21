/**
 * WhatsApp Tab logic for the Campaign Manager (mobile/public users).
 * Handles OTP pairing, connection status, quick send, and backup trigger.
 */
(function () {
  "use strict";

  var API = "/api/wa-web";

  // Wait for DOM to be ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    var dot = document.getElementById("wa-dot");
    var statusLabel = document.getElementById("wa-status-label");
    var statusMsg = document.getElementById("wa-status-msg");
    var connectForm = document.getElementById("wa-connect-form");
    var phoneInput = document.getElementById("wa-phone-input");
    var connectBtn = document.getElementById("wa-connect-btn");
    var pairingPanel = document.getElementById("wa-pairing-panel");
    var pairingCode = document.getElementById("wa-pairing-code");
    var connectedPanel = document.getElementById("wa-connected-panel");
    var connectedPhone = document.getElementById("wa-connected-phone");
    var disconnectBtn = document.getElementById("wa-disconnect-btn");
    var sendBtn = document.getElementById("wa-send-btn");
    var sendResult = document.getElementById("wa-send-result");

    // If elements don't exist (tab not visible yet), bail
    if (!dot) return;

    var STATUS_COLORS = {
      connected: "#10b981",
      connecting: "#f59e0b",
      reconnecting: "#f59e0b",
      disconnected: "#94a3b8",
      unavailable: "#ef4444",
    };

    // Pre-fill phone from session mobile if available
    var publicMobile = window.CURRENT_PUBLIC_MOBILE || "";
    if (publicMobile && phoneInput) {
      phoneInput.value = publicMobile;
    }

    // ===================================================================
    // Status
    // ===================================================================

    function checkStatus() {
      fetch(API + "/status", { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          updateUI(data.status || "disconnected");
        })
        .catch(function () {
          updateUI("unavailable");
        });
    }

    function updateUI(status) {
      dot.style.background = STATUS_COLORS[status] || STATUS_COLORS.disconnected;
      var labels = {
        connected: "Connected",
        connecting: "Connecting...",
        reconnecting: "Reconnecting...",
        disconnected: "Not connected",
        unavailable: "Service unavailable",
      };
      statusLabel.textContent = labels[status] || status;

      if (status === "connected") {
        connectForm.classList.add("hidden");
        pairingPanel.classList.add("hidden");
        connectedPanel.classList.remove("hidden");
        statusMsg.textContent = "";
        loadStats();
      } else if (status === "connecting" || status === "reconnecting") {
        statusMsg.textContent = "Waiting for confirmation...";
      } else {
        connectForm.classList.remove("hidden");
        connectedPanel.classList.add("hidden");
        pairingPanel.classList.add("hidden");
        if (status === "unavailable") {
          statusMsg.textContent = "WhatsApp service is offline.";
          connectBtn.disabled = true;
        } else {
          statusMsg.textContent = "";
          connectBtn.disabled = false;
        }
      }
    }

    // ===================================================================
    // Connect
    // ===================================================================

    connectBtn.addEventListener("click", function () {
      var phone = phoneInput.value.trim();
      if (!phone) { phoneInput.focus(); return; }

      connectBtn.disabled = true;
      connectBtn.textContent = "Requesting...";

      fetch(API + "/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone }),
        credentials: "same-origin",
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) {
            alert("Error: " + data.error);
            return;
          }
          if (data.pairingCode) {
            pairingCode.textContent = data.pairingCode;
            pairingPanel.classList.remove("hidden");
            connectForm.classList.add("hidden");
            pollConnection();
          } else {
            updateUI("connected");
            connectedPhone.textContent = phone;
          }
        })
        .catch(function (err) {
          alert("Failed: " + err.message);
        })
        .finally(function () {
          connectBtn.disabled = false;
          connectBtn.textContent = "Get Pairing Code";
        });
    });

    function pollConnection() {
      var attempts = 0;
      var interval = setInterval(function () {
        attempts++;
        if (attempts > 30) {
          clearInterval(interval);
          pairingPanel.classList.add("hidden");
          connectForm.classList.remove("hidden");
          statusMsg.textContent = "Timed out. Try again.";
          return;
        }
        fetch(API + "/status", { credentials: "same-origin" })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.status === "connected") {
              clearInterval(interval);
              updateUI("connected");
              connectedPhone.textContent = phoneInput.value.trim();
              pairingPanel.classList.add("hidden");
            }
          })
          .catch(function () {});
      }, 2000);
    }

    // ===================================================================
    // Disconnect
    // ===================================================================

    disconnectBtn.addEventListener("click", function () {
      if (!confirm("Disconnect WhatsApp? You'll need to pair again.")) return;
      fetch(API + "/disconnect", { method: "POST", credentials: "same-origin" })
        .then(function () { updateUI("disconnected"); })
        .catch(function (err) { alert("Error: " + err.message); });
    });

    // ===================================================================
    // Stats
    // ===================================================================

    function loadStats() {
      fetch(API + "/send-stats", { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var sent = document.getElementById("wa-stat-sent");
          var limit = document.getElementById("wa-stat-limit");
          var remaining = document.getElementById("wa-stat-remaining");
          if (sent) sent.textContent = data.sent || 0;
          if (limit) limit.textContent = data.limit || 20;
          if (remaining) remaining.textContent = data.remaining || 0;
        })
        .catch(function () {});
    }

    // ===================================================================
    // Send Message
    // ===================================================================

    sendBtn.addEventListener("click", function () {
      var phone = document.getElementById("wa-send-phone").value.trim();
      var text = document.getElementById("wa-send-text").value.trim();
      if (!phone || !text) {
        sendResult.textContent = "Fill in both fields.";
        sendResult.className = "text-xs text-red-500";
        return;
      }
      sendBtn.disabled = true;

      fetch(API + "/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientPhone: phone, text: text }),
        credentials: "same-origin",
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.channel === "cloud_api") {
            sendResult.textContent = "→ Routed to Cloud API: " + (data.reason || "");
            sendResult.className = "text-xs text-slate-500";
          } else if (data.success) {
            sendResult.textContent = "✓ Sent via WhatsApp";
            sendResult.className = "text-xs text-emerald-600";
            document.getElementById("wa-send-text").value = "";
            loadStats();
          } else {
            sendResult.textContent = "✗ " + (data.error || "Failed");
            sendResult.className = "text-xs text-red-500";
          }
        })
        .catch(function (err) {
          sendResult.textContent = "✗ " + err.message;
          sendResult.className = "text-xs text-red-500";
        })
        .finally(function () {
          sendBtn.disabled = false;
        });
    });

    // ===================================================================
    // Init
    // ===================================================================

    checkStatus();
    setInterval(checkStatus, 15000);
  }
})();
