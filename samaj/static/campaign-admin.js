/**
 * Campaign Admin Tab Logic
 *
 * Handles the Admin tab in the campaign manager for campaign_admin users.
 * Provides:
 * 1. Template Approvals — review, approve, or reject user-submitted templates
 * 2. Payment Confirmations — confirm or reject pending UPI payments
 */
(function () {
  "use strict";

  // Only run if the admin tab exists (campaign_admin role).
  if (!window.IS_CAMPAIGN_ADMIN) return;

  // =========================================================================
  // Sub-tab switching
  // =========================================================================
  var subtabBtns = document.querySelectorAll("[data-admin-subtab]");
  var subpanels = document.querySelectorAll(".cm-admin-subpanel");

  subtabBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = btn.getAttribute("data-admin-subtab");

      // Update button styles
      subtabBtns.forEach(function (b) {
        if (b.getAttribute("data-admin-subtab") === target) {
          b.className = "px-4 py-2 text-sm font-semibold rounded-lg bg-white text-emerald-700 shadow-sm border border-slate-200";
        } else {
          b.className = "px-4 py-2 text-sm font-semibold rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-50";
        }
      });

      // Show/hide panels
      document.getElementById("cm-admin-panel-templates").classList.toggle("hidden", target !== "templates");
      document.getElementById("cm-admin-panel-payments").classList.toggle("hidden", target !== "payments");
    });
  });

  // =========================================================================
  // Template Approvals
  // =========================================================================
  var tplBody = document.getElementById("cm-admin-tpl-body");
  var tplEmpty = document.getElementById("cm-admin-tpl-empty");
  var tplStatus = document.getElementById("cm-admin-tpl-status");
  var tplRefreshBtn = document.getElementById("cm-admin-tpl-refresh");

  function loadPendingTemplates() {
    if (tplStatus) tplStatus.textContent = "Loading...";
    if (tplEmpty) tplEmpty.classList.add("hidden");

    fetch("/api/wa-web/templates", { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("Failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var templates = (data.templates || []).filter(function (t) {
          return t.status === "pending";
        });

        if (templates.length === 0) {
          tplBody.innerHTML = "";
          if (tplEmpty) tplEmpty.classList.remove("hidden");
          if (tplStatus) tplStatus.textContent = "";
          return;
        }

        if (tplEmpty) tplEmpty.classList.add("hidden");
        tplBody.innerHTML = "";

        templates.forEach(function (t) {
          var tr = document.createElement("tr");
          tr.className = "hover:bg-slate-50";

          var mediaInfo = t.mediaType
            ? '<span class="inline-block px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">' + esc(t.mediaType) + '</span>'
            : '<span class="text-slate-400">—</span>';

          var bodyPreview = (t.bodyText || "").length > 80
            ? esc(t.bodyText.slice(0, 80)) + "…"
            : esc(t.bodyText || "");

          tr.innerHTML =
            '<td class="px-4 py-3 font-medium text-slate-800">' + esc(t.name) + '</td>' +
            '<td class="px-4 py-3 text-slate-600 max-w-[200px]"><span class="block truncate" title="' + esc(t.bodyText || "") + '">' + bodyPreview + '</span></td>' +
            '<td class="px-4 py-3 text-slate-600">' + esc(t.language || "hi") + '</td>' +
            '<td class="px-4 py-3">' + mediaInfo + '</td>' +
            '<td class="px-4 py-3 text-slate-500 whitespace-nowrap">' + formatDate(t.createdAt) + '</td>' +
            '<td class="px-4 py-3 whitespace-nowrap">' +
            '<button class="approve-tpl-btn px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold rounded-lg mr-2 transition-colors" data-id="' + esc(t._id) + '">Approve</button>' +
            '<button class="reject-tpl-btn px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs font-semibold rounded-lg transition-colors" data-id="' + esc(t._id) + '">Reject</button>' +
            '</td>';
          tplBody.appendChild(tr);
        });

        if (tplStatus) tplStatus.textContent = templates.length + " template" + (templates.length === 1 ? "" : "s") + " pending";

        // Wire approve buttons
        tplBody.querySelectorAll(".approve-tpl-btn").forEach(function (btn) {
          btn.addEventListener("click", function () {
            approveTemplate(btn.getAttribute("data-id"), btn);
          });
        });

        // Wire reject buttons
        tplBody.querySelectorAll(".reject-tpl-btn").forEach(function (btn) {
          btn.addEventListener("click", function () {
            rejectTemplate(btn.getAttribute("data-id"), btn);
          });
        });
      })
      .catch(function (err) {
        tplBody.innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-red-500">Error loading templates.</td></tr>';
        if (tplStatus) tplStatus.textContent = err.message || "Error";
      });
  }

  function approveTemplate(templateId, btn) {
    if (!confirm("Approve this template? It will become available for all campaigners to use.")) return;
    btn.disabled = true;
    btn.textContent = "Approving...";
    btn.style.opacity = "0.6";

    fetch("/api/wa-web/templates/" + encodeURIComponent(templateId) + "/approve", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || "Failed"); });
        return res.json();
      })
      .then(function () {
        btn.textContent = "Approved ✓";
        btn.style.background = "#059669";
        btn.style.opacity = "1";
        setTimeout(loadPendingTemplates, 1500);
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Approve";
        btn.style.opacity = "1";
        alert("Error: " + (err.message || "Unknown error"));
      });
  }

  function rejectTemplate(templateId, btn) {
    var reason = prompt("Reject this template?\n\nEnter the reason (e.g. inappropriate content, unclear message):");
    if (reason === null) return;
    if (!reason.trim()) {
      alert("Please provide a reason for rejection.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Rejecting...";
    btn.style.opacity = "0.6";

    fetch("/api/wa-web/templates/" + encodeURIComponent(templateId) + "/reject", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason.trim() }),
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || "Failed"); });
        return res.json();
      })
      .then(function () {
        btn.textContent = "Rejected ✗";
        btn.style.background = "#991b1b";
        btn.style.opacity = "1";
        setTimeout(loadPendingTemplates, 1500);
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Reject";
        btn.style.opacity = "1";
        alert("Error: " + (err.message || "Unknown error"));
      });
  }

  // =========================================================================
  // Payment Confirmations
  // =========================================================================
  var payBody = document.getElementById("cm-admin-pay-body");
  var payEmpty = document.getElementById("cm-admin-pay-empty");
  var payStatus = document.getElementById("cm-admin-pay-status");
  var payRefreshBtn = document.getElementById("cm-admin-pay-refresh");

  function loadPendingPayments() {
    if (payStatus) payStatus.textContent = "Loading...";
    if (payEmpty) payEmpty.classList.add("hidden");

    fetch("/api/campaigns/pending-payments", { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("Failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var payments = data.payments || [];

        if (payments.length === 0) {
          payBody.innerHTML = "";
          if (payEmpty) payEmpty.classList.remove("hidden");
          if (payStatus) payStatus.textContent = "";
          return;
        }

        if (payEmpty) payEmpty.classList.add("hidden");
        payBody.innerHTML = "";

        payments.forEach(function (p) {
          var tr = document.createElement("tr");
          tr.className = "hover:bg-slate-50";
          tr.innerHTML =
            '<td class="px-4 py-3 font-medium text-slate-800">' + esc(p.campaignName) + '</td>' +
            '<td class="px-4 py-3"><strong class="text-slate-800">₹' + (p.amount || 0) + '</strong></td>' +
            '<td class="px-4 py-3 text-slate-600">' + (p.recipientCount || 0) + '</td>' +
            '<td class="px-4 py-3"><code class="text-xs bg-slate-100 px-2 py-0.5 rounded">' + esc(p.upiTransactionRef || "—") + '</code></td>' +
            '<td class="px-4 py-3"><code class="text-xs bg-slate-100 px-2 py-0.5 rounded">' + esc(p.transactionNote || "") + '</code></td>' +
            '<td class="px-4 py-3 text-slate-500 whitespace-nowrap">' + formatDate(p.createdAt) + '</td>' +
            '<td class="px-4 py-3 whitespace-nowrap">' +
            '<button class="confirm-pay-btn px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold rounded-lg mr-2 transition-colors" data-id="' + esc(p.campaignId) + '">Confirm</button>' +
            '<button class="reject-pay-btn px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs font-semibold rounded-lg transition-colors" data-id="' + esc(p.campaignId) + '">Reject</button>' +
            '</td>';
          payBody.appendChild(tr);
        });

        if (payStatus) payStatus.textContent = payments.length + " payment" + (payments.length === 1 ? "" : "s") + " pending";

        // Wire confirm buttons
        payBody.querySelectorAll(".confirm-pay-btn").forEach(function (btn) {
          btn.addEventListener("click", function () {
            confirmPayment(btn.getAttribute("data-id"), btn);
          });
        });

        // Wire reject buttons
        payBody.querySelectorAll(".reject-pay-btn").forEach(function (btn) {
          btn.addEventListener("click", function () {
            rejectPayment(btn.getAttribute("data-id"), btn);
          });
        });
      })
      .catch(function (err) {
        payBody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-red-500">Error loading payments.</td></tr>';
        if (payStatus) payStatus.textContent = err.message || "Error";
      });
  }

  function confirmPayment(campaignId, btn) {
    if (!confirm("Confirm this payment and trigger campaign sending?\n\nThis will send WhatsApp messages to all recipients immediately.")) return;
    btn.disabled = true;
    btn.textContent = "Confirming...";
    btn.style.opacity = "0.6";

    fetch("/api/campaigns/" + encodeURIComponent(campaignId) + "/confirm-payment", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || "Failed"); });
        return res.json();
      })
      .then(function () {
        btn.textContent = "Confirmed ✓";
        btn.style.background = "#059669";
        btn.style.opacity = "1";
        if (payStatus) payStatus.textContent = "Payment confirmed. Campaign sending triggered.";
        setTimeout(loadPendingPayments, 2000);
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Confirm";
        btn.style.opacity = "1";
        alert("Error: " + (err.message || "Unknown error"));
      });
  }

  function rejectPayment(campaignId, btn) {
    var reason = prompt("Reject this payment?\n\nEnter the reason (e.g. Fake UTR, Amount mismatch, Payment not found):");
    if (reason === null) return;
    if (!reason.trim()) {
      alert("Please provide a reason for rejection.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Rejecting...";
    btn.style.opacity = "0.6";

    fetch("/api/campaigns/" + encodeURIComponent(campaignId) + "/reject-payment", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason.trim() }),
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || "Failed"); });
        return res.json();
      })
      .then(function () {
        btn.textContent = "Rejected ✗";
        btn.style.background = "#991b1b";
        btn.style.opacity = "1";
        if (payStatus) payStatus.textContent = "Payment rejected. Campaign will not be sent.";
        setTimeout(loadPendingPayments, 2000);
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Reject";
        btn.style.opacity = "1";
        alert("Error: " + (err.message || "Unknown error"));
      });
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  function esc(str) {
    var div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  function formatDate(dateStr) {
    if (!dateStr) return "—";
    try {
      var d = new Date(dateStr.$date || dateStr);
      return d.toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch (e) {
      return String(dateStr);
    }
  }

  // =========================================================================
  // Initialization
  // =========================================================================
  if (tplRefreshBtn) tplRefreshBtn.addEventListener("click", loadPendingTemplates);
  if (payRefreshBtn) payRefreshBtn.addEventListener("click", loadPendingPayments);

  // Load data when the admin tab becomes active.
  var adminTabLoaded = false;
  document.addEventListener("cm:tab-changed", function (e) {
    if (e.detail && e.detail.tab === "admin" && !adminTabLoaded) {
      loadPendingTemplates();
      loadPendingPayments();
      adminTabLoaded = true;
    }
  });
})();
