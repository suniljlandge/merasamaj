/**
 * WhatsApp Login — handles QR code and pairing code login flow.
 *
 * Users enter their mobile number, then choose between:
 * 1. Pairing Code: An 8-character code to enter on their phone
 * 2. QR Code: Scan with WhatsApp camera
 *
 * Both methods verify WhatsApp ownership and complete login.
 * After verification, a backup runs automatically. The user cannot
 * disconnect until the backup completes.
 */

const waPanel = document.querySelector("#whatsapp-login-panel");
const waMobileInput = document.querySelector("#wa-mobile");
const waHelpText = document.querySelector("#wa-help-text");
const waStartButtons = document.querySelector("#wa-start-buttons");
const waStartPairingButton = document.querySelector("#waStartPairingButton");
const waStartQrButton = document.querySelector("#waStartQrButton");
const waPairingPanel = document.querySelector("#wa-pairing-panel");
const waPairingCode = document.querySelector("#wa-pairing-code");
const waPairingStatus = document.querySelector("#wa-pairing-status");
const waQrPanel = document.querySelector("#wa-qr-panel");
const waQrCanvas = document.querySelector("#wa-qr-canvas");
const waQrStatus = document.querySelector("#wa-qr-status");
const waStatusNote = document.querySelector("#wa-status-note");

const WA_MOBILE_PATTERN = /^[6-9]\d{9}$/;
let waPollingInterval = null;
let waCurrentSessionId = null;
let waRedirectTo = null;
let waVerified = false;

if (waMobileInput) {
  waMobileInput.addEventListener("input", handleWaMobileInput);
  waMobileInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !waStartButtons.hidden) {
      startWhatsAppPairing();
    }
  });
}

if (waStartPairingButton) {
  waStartPairingButton.addEventListener("click", startWhatsAppPairing);
}

if (waStartQrButton) {
  waStartQrButton.addEventListener("click", startWhatsAppQr);
}

function getWaMobile() {
  return String(waMobileInput?.value || "")
    .replace(/\D/g, "")
    .slice(0, 10);
}

function handleWaMobileInput() {
  var mobileNumber = getWaMobile();
  var isValid = WA_MOBILE_PATTERN.test(mobileNumber);

  if (waStartButtons) waStartButtons.hidden = !isValid;

  if (!isValid) {
    hideWaPanels();
    if (waHelpText) {
      waHelpText.textContent = "Enter your mobile number linked to WhatsApp.";
    }
    return;
  }

  if (waHelpText) {
    waHelpText.textContent = "Choose how to verify your WhatsApp account.";
  }
}

function hideWaPanels() {
  if (waPairingPanel) waPairingPanel.hidden = true;
  if (waQrPanel) waQrPanel.hidden = true;
  if (waStatusNote) {
    waStatusNote.hidden = true;
    waStatusNote.textContent = "";
  }
  stopWaPolling();
}

function stopWaPolling() {
  if (waPollingInterval) {
    clearInterval(waPollingInterval);
    waPollingInterval = null;
  }
}

async function startWhatsAppPairing() {
  var mobileNumber = getWaMobile();
  if (!WA_MOBILE_PATTERN.test(mobileNumber)) {
    window.alert("Enter a valid 10-digit Indian mobile number.");
    return;
  }

  hideWaPanels();
  if (waStartPairingButton) waStartPairingButton.disabled = true;
  if (waStartQrButton) waStartQrButton.disabled = true;

  try {
    var response = await fetch("/api/public/whatsapp-login/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mobileNumber: mobileNumber }),
    });
    var body = await response.json();

    if (!response.ok) {
      throw new Error(body.error || "Failed to start WhatsApp login.");
    }

    waCurrentSessionId = body.sessionId;
    waVerified = false;

    if (body.pairingCode) {
      // Format pairing code with a dash in the middle for readability
      var code = body.pairingCode;
      var formatted = code.length === 8
        ? code.slice(0, 4) + " - " + code.slice(4)
        : code;
      if (waPairingCode) waPairingCode.textContent = formatted;
      if (waPairingPanel) waPairingPanel.hidden = false;
      if (waPairingStatus) waPairingStatus.textContent = "Waiting for you to link...";
    } else {
      if (waPairingPanel) waPairingPanel.hidden = false;
      if (waPairingCode) waPairingCode.textContent = "...";
      if (waPairingStatus) waPairingStatus.textContent = body.message || "Reconnecting...";
    }

    // Start polling for status
    startWaStatusPolling();
  } catch (error) {
    window.alert(error.message || "Failed to start WhatsApp login.");
  } finally {
    if (waStartPairingButton) waStartPairingButton.disabled = false;
    if (waStartQrButton) waStartQrButton.disabled = false;
  }
}

async function startWhatsAppQr() {
  var mobileNumber = getWaMobile();
  if (!WA_MOBILE_PATTERN.test(mobileNumber)) {
    window.alert("Enter a valid 10-digit Indian mobile number.");
    return;
  }

  hideWaPanels();
  if (waStartPairingButton) waStartPairingButton.disabled = true;
  if (waStartQrButton) waStartQrButton.disabled = true;

  try {
    var response = await fetch("/api/public/whatsapp-login/start-qr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mobileNumber: mobileNumber }),
    });
    var body = await response.json();

    if (!response.ok) {
      throw new Error(body.error || "Failed to start WhatsApp QR login.");
    }

    waCurrentSessionId = body.sessionId;
    waVerified = false;

    if (waQrPanel) waQrPanel.hidden = false;
    if (waQrStatus) waQrStatus.textContent = "Waiting for QR code...";

    // Render QR if we already have one
    if (body.qr) {
      renderQrCode(body.qr);
      if (waQrStatus) waQrStatus.textContent = "Scan this QR with WhatsApp.";
    }

    // Start polling for status + QR updates
    startWaStatusPolling();
  } catch (error) {
    window.alert(error.message || "Failed to start WhatsApp QR login.");
  } finally {
    if (waStartPairingButton) waStartPairingButton.disabled = false;
    if (waStartQrButton) waStartQrButton.disabled = false;
  }
}

function renderQrCode(qrData) {
  if (!waQrCanvas || !qrData) return;

  // Use the QRCode library loaded from CDN
  if (typeof QRCode !== "undefined" && QRCode.toCanvas) {
    QRCode.toCanvas(waQrCanvas, qrData, {
      width: 256,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    }, function (error) {
      if (error) {
        console.error("QR render error:", error);
      }
    });
  } else {
    // Fallback: show raw text
    waQrCanvas.style.display = "none";
    var container = document.querySelector("#wa-qr-container");
    if (container) {
      container.innerHTML = '<p style="word-break:break-all;font-size:0.75rem;">' +
        qrData + '</p>';
    }
  }
}

function startWaStatusPolling() {
  stopWaPolling();

  if (!waCurrentSessionId) return;

  // Poll every 2 seconds
  waPollingInterval = setInterval(pollWaStatus, 2000);
  // Also poll immediately
  pollWaStatus();
}

async function pollWaStatus() {
  if (!waCurrentSessionId) {
    stopWaPolling();
    return;
  }

  try {
    var response = await fetch(
      "/api/public/whatsapp-login/status/" + waCurrentSessionId
    );
    var body = await response.json();

    if (!response.ok) {
      if (response.status === 400 && body.status === "expired") {
        stopWaPolling();
        setWaStatus("Session expired. Please try again.", true);
        if (waPairingStatus) waPairingStatus.textContent = "Expired.";
        if (waQrStatus) waQrStatus.textContent = "Expired.";
        return;
      }
      return;
    }

    // Update QR if available
    if (body.qr && waQrPanel && !waQrPanel.hidden) {
      renderQrCode(body.qr);
      if (waQrStatus) waQrStatus.textContent = "Scan this QR with WhatsApp.";
    }

    // Check if verified / connected
    if (body.status === "verified" || body.ok === true) {
      if (!waVerified) {
        // First time seeing verified status
        waVerified = true;
        waRedirectTo = body.redirectTo || "/";

        // Hide pairing/QR panels, show backup status
        if (waPairingPanel) waPairingPanel.hidden = true;
        if (waQrPanel) waQrPanel.hidden = true;
        if (waStartButtons) waStartButtons.hidden = true;
        if (waHelpText) waHelpText.hidden = true;
        if (waMobileInput) waMobileInput.disabled = true;
      }

      // Check backup status
      if (body.backupRunning) {
        setWaStatus("✓ WhatsApp verified! Backing up contacts... Please wait.", false);
        // Keep polling to check when backup finishes
        return;
      }

      // Backup done — disconnect and redirect
      setWaStatus("✓ Backup complete! Redirecting...", false);
      stopWaPolling();

      // Disconnect the session (fire and forget)
      fetch("/api/public/whatsapp-login/disconnect/" + waCurrentSessionId, {
        method: "POST",
      }).catch(function () {});

      setTimeout(function () {
        window.location = waRedirectTo;
      }, 800);
      return;
    }

    // Update status text (pre-verification)
    if (body.status === "connecting") {
      if (waPairingStatus) waPairingStatus.textContent = "Waiting for you to link...";
      if (waQrStatus) waQrStatus.textContent = "Waiting for scan...";
    } else if (body.status === "waiting_qr") {
      if (waQrStatus) waQrStatus.textContent = "QR code ready. Scan with WhatsApp.";
    }
  } catch (error) {
    // Network error, keep polling
  }
}

function setWaStatus(text, isError) {
  if (!waStatusNote) return;
  waStatusNote.hidden = !text;
  waStatusNote.textContent = text;
  waStatusNote.style.color = isError ? "#dc2626" : "#16a34a";
}

/**
 * Expose activateWhatsAppMode for the login.js mode switcher.
 */
window.activateWhatsAppMode = function () {
  if (waMobileInput) {
    handleWaMobileInput();
    waMobileInput.focus();
  }
};
