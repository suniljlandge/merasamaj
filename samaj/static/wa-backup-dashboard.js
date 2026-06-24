/**
 * WhatsApp Backup Dashboard (Super Admin)
 * Shows all sessions, backup stats, and contact viewer with profile pictures.
 */
(function () {
  "use strict";

  const API = "/api/wa-web";
  let allContacts = [];
  let currentPage = 1;
  const PAGE_SIZE = 24;
  let selectedUserId = null;

  // =========================================================================
  // Load Sessions
  // =========================================================================

  async function loadSessions() {
    const tbody = document.getElementById("sessions-tbody");
    try {
      const resp = await fetch(`${API}/sessions`);
      const data = await resp.json();

      if (data.error) {
        tbody.innerHTML = `<tr><td colspan="5" style="color:var(--danger);">${data.error}</td></tr>`;
        return;
      }

      const sessions = data.sessions || [];
      const userSelect = document.getElementById("user-select");

      if (sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--steel);">No sessions found.</td></tr>';
        return;
      }

      tbody.innerHTML = sessions.map((s) => {
        const bs = s.backupStats || {};
        const lastBackup = bs.lastBackup ? formatDate(bs.lastBackup) : "Never";
        return `
        <tr>
          <td>${escHtml(s.userId)}</td>
          <td>${escHtml(s.phoneNumber || "—")}</td>
          <td><span class="status-badge status-${s.status}">${s.status}</span></td>
          <td>${s.connectedAt ? formatDate(s.connectedAt) : "—"}</td>
          <td>${s.lastActiveAt ? formatDate(s.lastActiveAt) : "—"}</td>
        </tr>
        <tr class="backup-status-row">
          <td colspan="5" style="padding:8px 16px 16px;border-bottom:2px solid var(--hairline);">
            <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
              <span style="font-size:12px;color:var(--steel);font-weight:600;">BACKUP:</span>
              <span style="font-size:13px;">📇 ${bs.contacts || 0} contacts</span>
              <span style="font-size:13px;">👥 ${bs.groups || 0} groups</span>
              <span style="font-size:13px;">🕐 Last: ${lastBackup}</span>
              <button type="button" class="backup-trigger-btn" data-user-id="${escHtml(s.userId)}"
                style="margin-left:auto;padding:4px 12px;font-size:12px;font-weight:600;border:1px solid var(--hairline-strong);border-radius:6px;background:var(--canvas);cursor:pointer;">
                Run Backup
              </button>
            </div>
            <div class="backup-progress-bar" data-user-id="${escHtml(s.userId)}" style="display:none;margin-top:8px;">
              <div style="height:4px;background:var(--hairline);border-radius:2px;overflow:hidden;">
                <div class="backup-progress-fill" style="height:100%;width:0%;background:var(--brand-green);transition:width 0.5s ease;"></div>
              </div>
              <span class="backup-progress-text" style="font-size:11px;color:var(--steel);margin-top:4px;display:block;"></span>
            </div>
          </td>
        </tr>`;
      }).join("");

      // Wire up backup trigger buttons
      tbody.querySelectorAll(".backup-trigger-btn").forEach((btn) => {
        btn.addEventListener("click", () => triggerBackup(btn.dataset.userId, btn));
      });

      // Update summary stats from first session
      if (sessions.length > 0) {
        let totalContacts = 0, totalGroups = 0;
        sessions.forEach((s) => {
          totalContacts += (s.backupStats?.contacts || 0);
          totalGroups += (s.backupStats?.groups || 0);
        });
        document.getElementById("bs-contacts").textContent = totalContacts;
        document.getElementById("bs-groups").textContent = totalGroups;
      }

      // Populate user select
      userSelect.innerHTML = '<option value="">Select user...</option>' +
        sessions.map((s) => `<option value="${escHtml(s.userId)}">${escHtml(s.userId)} (${s.status})</option>`).join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--danger);">Failed to load sessions: ${err.message}</td></tr>`;
    }
  }

  // =========================================================================
  // Trigger Backup for a specific user
  // =========================================================================

  async function triggerBackup(userId, btn) {
    btn.disabled = true;
    btn.textContent = "Starting...";

    const progressBar = document.querySelector(`.backup-progress-bar[data-user-id="${userId}"]`);
    const progressFill = progressBar?.querySelector(".backup-progress-fill");
    const progressText = progressBar?.querySelector(".backup-progress-text");

    if (progressBar) {
      progressBar.style.display = "block";
      progressFill.style.width = "10%";
      progressText.textContent = "Starting backup...";
    }

    try {
      const resp = await fetch(`${API}/backup/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: userId, includeProfilePics: true }),
      });
      const data = await resp.json();

      if (data.success) {
        btn.textContent = "✓ Running";
        if (progressFill) progressFill.style.width = "50%";
        if (progressText) progressText.textContent = "Backup running in background...";

        // Poll for completion
        let checks = 0;
        const pollInterval = setInterval(async () => {
          checks++;
          if (checks > 30) {
            clearInterval(pollInterval);
            btn.textContent = "Run Backup";
            btn.disabled = false;
            if (progressFill) progressFill.style.width = "100%";
            if (progressText) progressText.textContent = "Backup completed (or timed out). Refresh to see results.";
            setTimeout(() => loadSessions(), 2000);
            return;
          }

          try {
            const statusResp = await fetch(`${API}/backup/status?userId=${userId}`);
            const statusData = await statusResp.json();
            if (statusData.lastBackup) {
              clearInterval(pollInterval);
              if (progressFill) progressFill.style.width = "100%";
              if (progressText) progressText.textContent = `✓ Done — ${statusData.totalContacts} contacts, ${statusData.totalGroups} groups`;
              btn.textContent = "Run Backup";
              btn.disabled = false;
              setTimeout(() => loadSessions(), 1000);
            }
          } catch {}
        }, 3000);
      } else {
        btn.textContent = "Failed";
        if (progressText) progressText.textContent = data.error || "Backup failed";
        setTimeout(() => { btn.textContent = "Run Backup"; btn.disabled = false; }, 3000);
      }
    } catch (err) {
      btn.textContent = "Error";
      if (progressText) progressText.textContent = err.message;
      setTimeout(() => { btn.textContent = "Run Backup"; btn.disabled = false; }, 3000);
    }
  }

  // =========================================================================
  // Load Backup Stats
  // =========================================================================

  async function loadBackupStats() {
    if (!selectedUserId) return;
    try {
      const resp = await fetch(`${API}/backup/status?userId=${selectedUserId}`);
      const data = await resp.json();
      document.getElementById("bs-contacts").textContent = data.totalContacts || 0;
      document.getElementById("bs-groups").textContent = data.totalGroups || 0;

      if (data.lastBackup) {
        document.getElementById("bs-last").textContent = formatDate(data.lastBackup.completedAt);
        const picCount = data.lastBackup.results?.profilePics?.uploaded || "—";
        document.getElementById("bs-pics").textContent = picCount;
      } else {
        document.getElementById("bs-last").textContent = "Never";
        document.getElementById("bs-pics").textContent = "—";
      }
    } catch {}
  }

  // =========================================================================
  // Contact Viewer
  // =========================================================================

  document.getElementById("user-select").addEventListener("change", async (e) => {
    selectedUserId = e.target.value;
    if (!selectedUserId) {
      document.getElementById("contact-grid").innerHTML =
        '<p style="color:var(--steel);grid-column:1/-1;text-align:center;">Select a user session above to view contacts.</p>';
      document.getElementById("export-csv-btn").disabled = true;
      document.getElementById("export-json-btn").disabled = true;
      return;
    }

    document.getElementById("export-csv-btn").disabled = false;
    document.getElementById("export-json-btn").disabled = false;
    await loadContacts();
    loadBackupStats();
  });

  async function loadContacts() {
    const grid = document.getElementById("contact-grid");
    grid.innerHTML = '<p style="color:var(--steel);grid-column:1/-1;text-align:center;">Loading contacts...</p>';

    try {
      const resp = await fetch(`${API}/backup/export?format=json&userId=${selectedUserId}`);
      const data = await resp.json();
      allContacts = data.contacts || [];
      currentPage = 1;
      renderContacts();
    } catch (err) {
      grid.innerHTML = `<p style="color:var(--danger);grid-column:1/-1;text-align:center;">Error: ${err.message}</p>`;
    }
  }

  function renderContacts() {
    const grid = document.getElementById("contact-grid");
    const search = document.getElementById("contact-search").value.toLowerCase().trim();
    const pagination = document.getElementById("contact-pagination");

    let filtered = allContacts;
    if (search) {
      filtered = allContacts.filter((c) =>
        (c.phone || "").includes(search) ||
        (c.pushName || "").toLowerCase().includes(search)
      );
    }

    const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    if (pageItems.length === 0) {
      grid.innerHTML = '<p style="color:var(--steel);grid-column:1/-1;text-align:center;">No contacts found.</p>';
      pagination.style.display = "none";
      return;
    }

    grid.innerHTML = pageItems.map((c) => `
      <div class="contact-card" data-phone="${escHtml(c.phone)}">
        <div class="contact-pic" id="pic-${c.phone}">
          <span style="font-size:24px;color:var(--steel);">👤</span>
        </div>
        <div class="contact-info">
          <p class="contact-name">${escHtml(c.pushName || "Unknown")}</p>
          <p class="contact-phone">+${escHtml(c.phone)}</p>
          <p class="contact-source">${escHtml(c.source || "chat")}</p>
        </div>
      </div>
    `).join("");

    // Show pagination
    if (filtered.length > PAGE_SIZE) {
      pagination.style.display = "flex";
      document.getElementById("page-info").textContent = `Page ${currentPage} of ${totalPages} (${filtered.length} contacts)`;
      document.getElementById("prev-page-btn").disabled = currentPage <= 1;
      document.getElementById("next-page-btn").disabled = currentPage >= totalPages;
    } else {
      pagination.style.display = "none";
    }

    // Load profile pictures for visible contacts
    pageItems.forEach((c) => loadProfilePic(c.phone));
  }

  async function loadProfilePic(phone) {
    try {
      const resp = await fetch(`${API}/backup/profile-pic/${phone}?userId=${selectedUserId}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.url) {
        const el = document.getElementById(`pic-${phone}`);
        if (el) {
          el.innerHTML = `<img src="${data.url}" alt="Profile" style="width:48px;height:48px;border-radius:50%;object-fit:cover;">`;
        }
      }
    } catch {}
  }

  // Search
  document.getElementById("contact-search").addEventListener("input", () => {
    currentPage = 1;
    renderContacts();
  });

  // Pagination
  document.getElementById("prev-page-btn").addEventListener("click", () => {
    if (currentPage > 1) { currentPage--; renderContacts(); }
  });
  document.getElementById("next-page-btn").addEventListener("click", () => {
    currentPage++;
    renderContacts();
  });

  // =========================================================================
  // Export
  // =========================================================================

  document.getElementById("export-csv-btn").addEventListener("click", () => {
    if (!selectedUserId) return;
    window.open(`${API}/backup/export?format=csv&userId=${selectedUserId}`, "_blank");
  });

  document.getElementById("export-json-btn").addEventListener("click", () => {
    if (!selectedUserId) return;
    window.open(`${API}/backup/export?format=json&userId=${selectedUserId}`, "_blank");
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  function escHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  function formatDate(isoStr) {
    if (!isoStr) return "—";
    const d = new Date(isoStr);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // =========================================================================
  // Init
  // =========================================================================

  loadSessions();
})();
