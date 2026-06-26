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
    var qrBtn = document.getElementById("wa-qr-btn");
    var qrPanel = document.getElementById("wa-qr-panel");
    var qrImage = document.getElementById("wa-qr-image");
    var retryCodeBtn = document.getElementById("wa-retry-code-btn");

    // If elements don't exist (tab not visible yet), bail
    if (!dot) return;

    var STATUS_COLORS = {
      connected: "#10b981",
      connecting: "#f59e0b",
      reconnecting: "#f59e0b",
      waiting_qr: "#f59e0b",
      disconnected: "#94a3b8",
      unavailable: "#ef4444",
    };

    var qrInstance = null;
    var qrPollInterval = null;

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
        waiting_qr: "Scan QR Code...",
        disconnected: "Not connected",
        unavailable: "Service unavailable",
      };
      statusLabel.textContent = labels[status] || status;

      if (status === "connected") {
        connectForm.classList.add("hidden");
        pairingPanel.classList.add("hidden");
        if (qrPanel) qrPanel.classList.add("hidden");
        connectedPanel.classList.remove("hidden");
        statusMsg.textContent = "";
        if (qrPollInterval) { clearInterval(qrPollInterval); qrPollInterval = null; }
        loadStats();
      } else if (status === "connecting" || status === "reconnecting" || status === "waiting_qr") {
        statusMsg.textContent = "Waiting for confirmation...";
      } else {
        connectForm.classList.remove("hidden");
        connectedPanel.classList.add("hidden");
        pairingPanel.classList.add("hidden");
        if (qrPanel) qrPanel.classList.add("hidden");
        if (status === "unavailable") {
          statusMsg.textContent = "WhatsApp service is offline.";
          connectBtn.disabled = true;
          if (qrBtn) qrBtn.disabled = true;
        } else {
          statusMsg.textContent = "";
          connectBtn.disabled = false;
          if (qrBtn) qrBtn.disabled = false;
        }
      }
    }

    // ===================================================================
    // Connect via QR Code
    // ===================================================================

    if (qrBtn) {
      qrBtn.addEventListener("click", function () {
        qrBtn.disabled = true;
        qrBtn.textContent = "Generating QR...";

        fetch(API + "/connect-qr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) {
              alert("Error: " + data.error);
              qrBtn.disabled = false;
              qrBtn.textContent = "Connect with QR Code (Recommended)";
              return;
            }

            // Show QR panel
            if (qrPanel) qrPanel.classList.remove("hidden");
            connectForm.querySelector("details")?.removeAttribute("open");

            // Render QR if available
            if (data.qr) {
              renderQR(data.qr);
            }

            // Start polling for QR updates and connection
            startQRPolling();
            qrBtn.textContent = "Waiting for scan...";
          })
          .catch(function (err) {
            alert("Failed: " + err.message);
            qrBtn.disabled = false;
            qrBtn.textContent = "Connect with QR Code (Recommended)";
          });
      });
    }

    function renderQR(qrString) {
      if (!qrImage) return;
      qrImage.innerHTML = "";
      qrInstance = new QRCode(qrImage, {
        text: qrString,
        width: 200,
        height: 200,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M,
      });
    }

    function startQRPolling() {
      if (qrPollInterval) clearInterval(qrPollInterval);
      var attempts = 0;
      qrPollInterval = setInterval(function () {
        attempts++;
        if (attempts > 60) { // 2 minutes
          clearInterval(qrPollInterval);
          qrPollInterval = null;
          if (qrPanel) qrPanel.classList.add("hidden");
          if (qrBtn) { qrBtn.disabled = false; qrBtn.textContent = "Connect with QR Code (Recommended)"; }
          statusMsg.textContent = "QR expired. Try again.";
          return;
        }

        fetch(API + "/qr", { credentials: "same-origin" })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.status === "connected") {
              clearInterval(qrPollInterval);
              qrPollInterval = null;
              updateUI("connected");
              return;
            }
            // Update QR if changed
            if (data.qr) {
              renderQR(data.qr);
            }
          })
          .catch(function () {});
      }, 2000);
    }

    // ===================================================================
    // Connect via Pairing Code
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

    // Retry pairing code button
    if (retryCodeBtn) {
      retryCodeBtn.addEventListener("click", function () {
        pairingPanel.classList.add("hidden");
        connectBtn.click();
      });
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
    // Custom Template Management
    // ===================================================================

    var tplMediaType = document.getElementById("wa-tpl-media-type");
    var tplMediaUrl = document.getElementById("wa-tpl-media-url");
    var tplSubmit = document.getElementById("wa-tpl-submit");
    var tplResult = document.getElementById("wa-tpl-result");

    // Show/hide media URL field based on media type selection
    if (tplMediaType) {
      tplMediaType.addEventListener("change", function () {
        if (tplMediaUrl) {
          tplMediaUrl.classList.toggle("hidden", !tplMediaType.value);
        }
      });
    }

    // Submit new template
    if (tplSubmit) {
      tplSubmit.addEventListener("click", function () {
        var name = document.getElementById("wa-tpl-name").value.trim();
        var bodyText = document.getElementById("wa-tpl-body").value.trim();
        var language = document.getElementById("wa-tpl-language").value;
        var mediaType = tplMediaType ? tplMediaType.value : "";
        var mediaUrl = tplMediaUrl ? tplMediaUrl.value.trim() : "";

        if (!name || !bodyText) {
          tplResult.textContent = "Name and body are required.";
          tplResult.className = "text-xs text-red-500";
          return;
        }

        tplSubmit.disabled = true;
        tplResult.textContent = "Submitting...";
        tplResult.className = "text-xs text-slate-500";

        var payload = { name: name, bodyText: bodyText, language: language };
        if (mediaType) { payload.mediaType = mediaType; }
        if (mediaUrl) { payload.mediaUrl = mediaUrl; }

        fetch(API + "/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) {
              tplResult.textContent = "Error: " + data.error;
              tplResult.className = "text-xs text-red-500";
            } else {
              tplResult.textContent = "✓ Template submitted for approval";
              tplResult.className = "text-xs text-emerald-600";
              document.getElementById("wa-tpl-name").value = "";
              document.getElementById("wa-tpl-body").value = "";
              if (tplMediaUrl) tplMediaUrl.value = "";
              loadMyTemplates();
            }
          })
          .catch(function (err) {
            tplResult.textContent = "Error: " + err.message;
            tplResult.className = "text-xs text-red-500";
          })
          .finally(function () {
            tplSubmit.disabled = false;
          });
      });
    }

    // Load and display user's templates
    function loadMyTemplates() {
      var listEl = document.getElementById("wa-tpl-list");
      if (!listEl) return;

      fetch(API + "/templates", { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var templates = data.templates || [];
          if (templates.length === 0) {
            listEl.innerHTML = '<p class="text-xs text-slate-400 text-center py-4">No templates yet. Create one above.</p>';
            return;
          }
          listEl.innerHTML = templates.map(function (t) {
            var statusColors = { pending: "bg-yellow-100 text-yellow-800", approved: "bg-emerald-100 text-emerald-800", rejected: "bg-red-100 text-red-800" };
            var cls = statusColors[t.status] || "bg-slate-100 text-slate-700";
            var badge = '<span class="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ' + cls + '">' + (t.status || "unknown") + '</span>';
            var rejection = t.status === "rejected" && t.rejectionReason ? '<p class="text-xs text-red-500 mt-1">Reason: ' + escText(t.rejectionReason) + '</p>' : '';
            var deleteBtn = '<button type="button" class="wa-tpl-delete text-[11px] text-red-400 hover:text-red-600" data-id="' + escText(t._id) + '">Delete</button>';
            return '<div class="p-3 border border-slate-200 rounded-lg bg-white">' +
              '<div class="flex items-center justify-between gap-2 mb-1">' +
              '<span class="text-sm font-medium text-slate-800">' + escText(t.name) + '</span>' +
              '<div class="flex items-center gap-2">' + badge + deleteBtn + '</div>' +
              '</div>' +
              '<p class="text-xs text-slate-500 line-clamp-2">' + escText((t.bodyText || "").substring(0, 120)) + '</p>' +
              '<p class="text-[11px] text-slate-400 mt-1">' + (t.language || "") + (t.mediaType ? ' · ' + t.mediaType : '') + '</p>' +
              rejection +
              '</div>';
          }).join("");

          // Wire delete buttons
          listEl.querySelectorAll(".wa-tpl-delete").forEach(function (btn) {
            btn.addEventListener("click", function () {
              if (!confirm("Delete this template?")) return;
              fetch(API + "/templates/" + btn.dataset.id, {
                method: "DELETE",
                credentials: "same-origin",
              })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                  if (data.error) { alert("Error: " + data.error); return; }
                  loadMyTemplates();
                })
                .catch(function (err) { alert("Failed: " + err.message); });
            });
          });
        })
        .catch(function () {
          listEl.innerHTML = '<p class="text-xs text-red-400 text-center py-4">Failed to load templates.</p>';
        });
    }

    function escText(str) {
      var div = document.createElement("div");
      div.textContent = str || "";
      return div.innerHTML;
    }

    // Load templates on init if elements exist
    if (document.getElementById("wa-tpl-list")) {
      loadMyTemplates();
    }

    // ===================================================================
    // Init
    // ===================================================================

    checkStatus();
    setInterval(checkStatus, 15000);
  }
})();
