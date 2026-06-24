/**
 * WhatsApp Web Connection Page
 * Handles OTP pairing, status display, quick message sending.
 */
(function () {
  "use strict";

  const API = "/api/wa-web";

  // DOM elements
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const statusDetail = document.getElementById("status-detail");
  const connectFormPanel = document.getElementById("connect-form-panel");
  const phoneInput = document.getElementById("phone-input");
  const connectBtn = document.getElementById("connect-btn");
  const pairingCodePanel = document.getElementById("pairing-code-panel");
  const pairingCodeEl = document.getElementById("pairing-code");
  const connectedPanel = document.getElementById("connected-panel");
  const connectedPhone = document.getElementById("connected-phone");
  const disconnectBtn = document.getElementById("disconnect-btn");
  const backupNowBtn = document.getElementById("backup-now-btn");
  const statsSection = document.getElementById("stats-section");
  const sendSection = document.getElementById("send-section");

  // Status colors
  const STATUS_COLORS = {
    connected: "#00ed64",
    connecting: "#f5a623",
    reconnecting: "#f5a623",
    disconnected: "#c1ccd6",
    unavailable: "#b42318",
  };

  // Flag to prevent status poller from hiding pairing code
  let isPairingInProgress = false;

  // =========================================================================
  // Status Polling
  // =========================================================================

  async function checkStatus() {
    try {
      const resp = await fetch(`${API}/status`);
      const data = await resp.json();
      // Don't override UI while user is entering pairing code
      if (isPairingInProgress && data.status !== "connected") return;
      updateStatusUI(data.status || "disconnected");
    } catch {
      if (!isPairingInProgress) updateStatusUI("unavailable");
    }
  }

  function updateStatusUI(status) {
    statusDot.style.background = STATUS_COLORS[status] || STATUS_COLORS.disconnected;
    const labels = {
      connected: "Connected",
      connecting: "Connecting...",
      reconnecting: "Reconnecting...",
      disconnected: "Disconnected",
      unavailable: "Service Unavailable",
    };
    statusText.textContent = labels[status] || status;

    if (status === "connected") {
      connectFormPanel.style.display = "none";
      pairingCodePanel.style.display = "none";
      connectedPanel.style.display = "block";
      statsSection.style.display = "block";
      sendSection.style.display = "block";
      loadStats();
    } else if (status === "connecting" || status === "reconnecting") {
      connectFormPanel.style.display = "none";
      connectedPanel.style.display = "none";
      statusDetail.textContent = "Waiting for pairing code confirmation...";
    } else {
      connectFormPanel.style.display = "block";
      connectedPanel.style.display = "none";
      statsSection.style.display = "none";
      sendSection.style.display = "none";
      if (status === "unavailable") {
        statusDetail.textContent = "WhatsApp Web service is not running. Contact administrator.";
        connectBtn.disabled = true;
      } else {
        statusDetail.textContent = "";
        connectBtn.disabled = false;
      }
    }
  }

  // =========================================================================
  // Connect (OTP Pairing)
  // =========================================================================

  connectBtn.addEventListener("click", async () => {
    const phone = phoneInput.value.trim();
    if (!phone) {
      phoneInput.focus();
      return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = "Requesting...";

    try {
      const resp = await fetch(`${API}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone }),
      });
      const data = await resp.json();

      if (data.error) {
        alert("Error: " + data.error);
        return;
      }

      if (data.pairingCode) {
        // Show pairing code
        pairingCodeEl.textContent = data.pairingCode;
        pairingCodePanel.style.display = "block";
        connectFormPanel.style.display = "none";
        isPairingInProgress = true;

        // Poll for connection
        pollForConnection();
      } else {
        // Already authenticated
        updateStatusUI("connected");
        connectedPhone.textContent = phone;
      }
    } catch (err) {
      alert("Connection failed: " + err.message);
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = "Get Pairing Code";
    }
  });

  function pollForConnection() {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > 60) {
        // 2 minutes total — give up
        clearInterval(interval);
        isPairingInProgress = false;
        pairingCodePanel.style.display = "none";
        connectFormPanel.style.display = "block";
        statusDetail.textContent = "Pairing timed out. Try again.";
        return;
      }

      try {
        const resp = await fetch(`${API}/status`);
        const data = await resp.json();
        if (data.status === "connected") {
          clearInterval(interval);
          isPairingInProgress = false;
          updateStatusUI("connected");
          connectedPhone.textContent = phoneInput.value.trim();
          pairingCodePanel.style.display = "none";
        }
      } catch {}
    }, 2000);
  }

  // Retry pairing — get a new code
  const retryBtn = document.getElementById("retry-pairing-btn");
  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      isPairingInProgress = false;
      pairingCodePanel.style.display = "none";
      connectFormPanel.style.display = "block";
      connectBtn.click();
    });
  }

  // =========================================================================
  // Disconnect
  // =========================================================================

  disconnectBtn.addEventListener("click", async () => {
    if (!confirm("Disconnect your WhatsApp session? You'll need to pair again.")) return;

    try {
      await fetch(`${API}/disconnect`, { method: "POST" });
      updateStatusUI("disconnected");
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // =========================================================================
  // Backup
  // =========================================================================

  backupNowBtn.addEventListener("click", async () => {
    backupNowBtn.disabled = true;
    backupNowBtn.textContent = "Starting...";
    try {
      const resp = await fetch(`${API}/backup/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeProfilePics: true }),
      });
      const data = await resp.json();
      if (data.success) {
        backupNowBtn.textContent = "✓ Backup Running";
        setTimeout(() => {
          backupNowBtn.textContent = "Backup Now";
          backupNowBtn.disabled = false;
        }, 5000);
      } else {
        alert("Backup failed: " + (data.error || "Unknown error"));
        backupNowBtn.textContent = "Backup Now";
        backupNowBtn.disabled = false;
      }
    } catch (err) {
      alert("Error: " + err.message);
      backupNowBtn.textContent = "Backup Now";
      backupNowBtn.disabled = false;
    }
  });

  // =========================================================================
  // Stats
  // =========================================================================

  async function loadStats() {
    try {
      const resp = await fetch(`${API}/send-stats`);
      const data = await resp.json();
      document.getElementById("stat-sent").textContent = data.sent || 0;
      document.getElementById("stat-limit").textContent = data.limit || 20;
      document.getElementById("stat-remaining").textContent = data.remaining || 0;
    } catch {}
  }

  // =========================================================================
  // Send Message
  // =========================================================================

  document.getElementById("send-btn").addEventListener("click", async () => {
    const phone = document.getElementById("send-phone").value.trim();
    const text = document.getElementById("send-text").value.trim();
    const resultEl = document.getElementById("send-result");

    if (!phone || !text) {
      resultEl.textContent = "Please fill in both fields.";
      resultEl.style.color = "var(--danger)";
      return;
    }

    const btn = document.getElementById("send-btn");
    btn.disabled = true;

    try {
      const resp = await fetch(`${API}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientPhone: phone, text }),
      });
      const data = await resp.json();

      if (data.channel === "cloud_api") {
        resultEl.textContent = "→ Routed to Cloud API: " + data.reason;
        resultEl.style.color = "var(--steel)";
      } else if (data.success) {
        resultEl.textContent = "✓ Sent via WhatsApp Web";
        resultEl.style.color = "var(--brand-green-dark)";
        document.getElementById("send-text").value = "";
        loadStats();
      } else {
        resultEl.textContent = "✗ " + (data.error || "Send failed");
        resultEl.style.color = "var(--danger)";
      }
    } catch (err) {
      resultEl.textContent = "✗ " + err.message;
      resultEl.style.color = "var(--danger)";
    } finally {
      btn.disabled = false;
    }
  });

  // =========================================================================
  // Init
  // =========================================================================

  checkStatus();
  // Re-check every 10 seconds
  setInterval(checkStatus, 10000);
})();
