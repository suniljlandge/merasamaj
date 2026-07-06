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
  const tnNameCache = new Map(); // phone (10-digit) -> verified name

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

    // Capture the previous backup completion time so we can detect a NEW one.
    // (Without this, an old backup log makes the poll falsely report "done".)
    let prevCompletedAt = null;
    try {
      const pre = await (await fetch(`${API}/backup/status?userId=${userId}`)).json();
      prevCompletedAt = pre?.lastBackup?.completedAt || null;
    } catch {}

    try {
      const resp = await fetch(`${API}/backup/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: userId, includeProfilePics: true }),
      });
      const data = await resp.json();

      if (data.success) {
        btn.textContent = "✓ Running";
        if (progressFill) progressFill.style.width = "40%";
        if (progressText) progressText.textContent = "Backup running in background...";

        const finish = (text) => {
          if (progressFill) progressFill.style.width = "100%";
          if (progressText) progressText.textContent = text;
          btn.textContent = "Run Backup";
          btn.disabled = false;
          setTimeout(() => loadSessions(), 1000);
        };

        // Poll for completion. Backups can take several minutes for large
        // contact lists, so allow a generous window (~10 min) and detect
        // completion via the `running` flag flipping false + a fresh log.
        let checks = 0;
        const maxChecks = 200; // 200 × 3s = 10 minutes
        let sawRunning = false;
        const pollInterval = setInterval(async () => {
          checks++;
          if (checks > maxChecks) {
            clearInterval(pollInterval);
            finish("Backup is taking a while — still running in background. Refresh later to see results.");
            return;
          }

          try {
            const statusResp = await fetch(`${API}/backup/status?userId=${userId}`);
            const statusData = await statusResp.json();

            if (statusData.running) {
              sawRunning = true;
              // Creep the progress bar forward while running (40% → 90%)
              if (progressFill) {
                const pct = Math.min(90, 40 + checks * 2);
                progressFill.style.width = pct + "%";
              }
              if (progressText) progressText.textContent = `Backing up… ${statusData.totalContacts || 0} contacts so far`;
              return;
            }

            // Not running. Did a NEW backup log appear?
            const completedAt = statusData?.lastBackup?.completedAt || null;
            const isNew = completedAt && completedAt !== prevCompletedAt;

            if (isNew || sawRunning) {
              clearInterval(pollInterval);
              const r = statusData?.lastBackup?.results?.profilePics;
              const picNote = r ? ` · ${r.uploaded} pics` : "";
              finish(`✓ Done — ${statusData.totalContacts} contacts, ${statusData.totalGroups} groups${picNote}`);
            }
            // else: backup hasn't registered as running yet — keep polling.
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
      document.getElementById("refresh-contacts-btn").disabled = true;
      return;
    }

    document.getElementById("export-csv-btn").disabled = false;
    document.getElementById("export-json-btn").disabled = false;
    document.getElementById("refresh-contacts-btn").disabled = false;
    await loadContacts();
    loadBackupStats();
  });

  // Refresh button — reload contacts and clear cache
  document.getElementById("refresh-contacts-btn").addEventListener("click", async () => {
    if (!selectedUserId) return;
    picUrlCache.clear();
    await loadContacts();
    loadBackupStats();
  });

  async function loadContacts() {
    const grid = document.getElementById("contact-grid");
    grid.innerHTML = '<p style="color:var(--steel);grid-column:1/-1;text-align:center;">Loading contacts...</p>';

    try {
      let resp = await fetch(`${API}/backup/export?format=json&userId=${selectedUserId}`);
      let data = await resp.json();

      // If we get a connection error message (sidecar restarting), retry once after 3s
      if (data.error && data.error.includes("Connection refused")) {
        grid.innerHTML = '<p style="color:var(--steel);grid-column:1/-1;text-align:center;">Sidecar restarting, retrying...</p>';
        await new Promise(r => setTimeout(r, 3000));
        resp = await fetch(`${API}/backup/export?format=json&userId=${selectedUserId}`);
        data = await resp.json();
      }

      if (!resp.ok || data.error) {
        grid.innerHTML = `<p style="color:var(--danger);grid-column:1/-1;text-align:center;">Failed to load contacts: ${data.error || resp.statusText}</p>`;
        return;
      }

      allContacts = data.contacts || [];
      if (allContacts.length === 0 && data.total === undefined) {
        console.warn("Unexpected contacts response:", data);
      }
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

    grid.innerHTML = pageItems.map((c) => {
      const mobile10 = (c.phone || "").replace(/^91/, "");
      const isIndian = /^[6-9]\d{9}$/.test(mobile10);
      const cachedName = tnNameCache.get(mobile10);
      const tnHtml = isIndian
        ? (cachedName
          ? `<p class="contact-tn" style="font-size:11px;color:#10b981;font-weight:600;margin:2px 0 0;" title="Verified UPI name (cached)">✓ ${escHtml(cachedName)}</p>`
          : `<button type="button" class="tn-lookup-btn" data-mobile="${escHtml(mobile10)}" style="margin-top:4px;padding:2px 8px;font-size:11px;border:1px solid var(--hairline);border-radius:4px;background:var(--canvas);cursor:pointer;color:var(--brand-teal-deep);font-weight:600;">🔍 TN Lookup</button>`)
        : "";
      return `
      <div class="contact-card" data-phone="${escHtml(c.phone)}">
        <div class="contact-pic" id="pic-${c.phone}">
          <span style="font-size:24px;color:var(--steel);">👤</span>
        </div>
        <div class="contact-info">
          <p class="contact-name">${escHtml(c.pushName || "Unknown")}</p>
          <p class="contact-phone">+${escHtml(c.phone)}</p>
          <p class="contact-source">${escHtml(c.source || "chat")}</p>
          ${tnHtml}
        </div>
      </div>
    `;
    }).join("");

    // Show pagination
    if (filtered.length > PAGE_SIZE) {
      pagination.style.display = "flex";
      document.getElementById("page-info").textContent = `Page ${currentPage} of ${totalPages} (${filtered.length} contacts)`;
      document.getElementById("prev-page-btn").disabled = currentPage <= 1;
      document.getElementById("next-page-btn").disabled = currentPage >= totalPages;
    } else {
      pagination.style.display = "none";
    }

    // Load profile pictures only for contacts that have them (fast — skip the rest)
    const phonesWithPics = pageItems.filter((c) => c.hasProfilePic).map((c) => c.phone);
    if (phonesWithPics.length) loadProfilePicsBatch(phonesWithPics);

    // Click handler: pic opens lightbox, rest of card opens chat
    grid.querySelectorAll(".contact-card").forEach((card) => {
      card.style.cursor = "pointer";
      const picEl = card.querySelector(".contact-pic");
      picEl.style.cursor = "zoom-in";
      picEl.addEventListener("click", (e) => {
        e.stopPropagation();
        const img = picEl.querySelector("img");
        if (img) openProfilePicModal(card.dataset.phone, card.querySelector(".contact-name").textContent);
      });
      card.addEventListener("click", () => openChatPopup(card.dataset.phone));
    });

    // TN Lookup buttons on each card
    grid.querySelectorAll(".tn-lookup-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        tnLookupSingle(btn);
      });
    });
  }

  // =========================================================================
  // Fast Profile Pic Loading — batch + parallel + cached
  // =========================================================================

  const picUrlCache = new Map(); // phone -> url

  async function loadProfilePicsBatch(phones) {
    // Filter out already-cached phones
    const uncached = phones.filter((p) => !picUrlCache.has(p));

    // Apply cached ones immediately
    phones.forEach((p) => { if (picUrlCache.has(p)) applyPicToEl(p, picUrlCache.get(p)); });

    if (!uncached.length) return;

    // Single batch request for all uncached pics
    try {
      const resp = await fetch(`${API}/backup/profile-pics-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: selectedUserId, phones: uncached }),
      });
      const data = await resp.json();
      const urls = data.urls || {};
      for (const [phone, url] of Object.entries(urls)) {
        picUrlCache.set(phone, url);
        applyPicToEl(phone, url);
      }
    } catch {
      // Fallback: load individually in parallel
      await Promise.allSettled(uncached.map((p) => loadProfilePicSingle(p)));
    }
  }

  async function loadProfilePicSingle(phone) {
    try {
      const resp = await fetch(`${API}/backup/profile-pic/${phone}?userId=${selectedUserId}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.url) {
        picUrlCache.set(phone, data.url);
        applyPicToEl(phone, data.url);
      }
    } catch {}
  }

  function applyPicToEl(phone, url) {
    const el = document.getElementById(`pic-${phone}`);
    if (!el) return;
    const img = new Image();
    img.onload = () => {
      el.innerHTML = "";
      img.style.cssText = "width:48px;height:48px;border-radius:50%;object-fit:cover;";
      img.alt = "Profile";
      el.appendChild(img);
    };
    img.src = url;
  }

  // =========================================================================
  // Profile Picture Lightbox Modal with History
  // =========================================================================

  async function openProfilePicModal(phone, name) {
    // Remove existing modal if any
    const existing = document.getElementById("profile-pic-modal");
    if (existing) existing.remove();

    // Show modal IMMEDIATELY with the already-cached pic
    const cachedUrl = picUrlCache.get(phone);
    let history = cachedUrl ? [{ url: cachedUrl, capturedAt: null }] : [];

    let currentIdx = 0;

    const modal = document.createElement("div");
    modal.id = "profile-pic-modal";
    modal.style.cssText = `
      position:fixed;inset:0;z-index:9999;display:flex;align-items:center;
      justify-content:center;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);
      animation:fadeIn 0.15s ease;
    `;

    function renderModal() {
      const entry = history[currentIdx];
      const dateStr = entry.capturedAt
        ? new Date(entry.capturedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
        : "";
      const counterText = history.length > 1 ? `${currentIdx + 1} / ${history.length}` : "";

      modal.innerHTML = `
        <div style="position:relative;max-width:90vw;max-height:90vh;text-align:center;">
          <img src="${entry.url}" alt="${escHtml(name)}" style="max-width:80vw;max-height:70vh;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);object-fit:contain;">
          <p style="color:#fff;margin-top:12px;font-size:16px;font-weight:600;">${escHtml(name)}</p>
          ${dateStr ? `<p style="color:#ccc;margin-top:4px;font-size:13px;">${dateStr}</p>` : ""}
          ${counterText ? `<p style="color:#999;margin-top:4px;font-size:12px;">${counterText}</p>` : ""}
          ${history.length > 1 ? `
            <div style="display:flex;justify-content:center;gap:16px;margin-top:12px;">
              <button id="pp-prev" ${currentIdx >= history.length - 1 ? 'disabled' : ''} style="
                padding:8px 20px;border-radius:8px;border:none;background:rgba(255,255,255,0.15);
                color:#fff;font-size:14px;cursor:pointer;${currentIdx >= history.length - 1 ? 'opacity:0.3;cursor:not-allowed;' : ''}
              ">← Older</button>
              <button id="pp-next" ${currentIdx <= 0 ? 'disabled' : ''} style="
                padding:8px 20px;border-radius:8px;border:none;background:rgba(255,255,255,0.15);
                color:#fff;font-size:14px;cursor:pointer;${currentIdx <= 0 ? 'opacity:0.3;cursor:not-allowed;' : ''}
              ">Newer →</button>
            </div>
          ` : ""}
          <button id="pp-close" style="
            position:absolute;top:-12px;right:-12px;width:36px;height:36px;
            border-radius:50%;border:none;background:#fff;color:#333;font-size:20px;
            cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;
            align-items:center;justify-content:center;
          ">&times;</button>
        </div>
      `;

      modal.querySelector("#pp-close").addEventListener("click", closeModal);
      const prevBtn = modal.querySelector("#pp-prev");
      const nextBtn = modal.querySelector("#pp-next");
      if (prevBtn && !prevBtn.disabled) prevBtn.addEventListener("click", () => { currentIdx++; renderModal(); });
      if (nextBtn && !nextBtn.disabled) nextBtn.addEventListener("click", () => { currentIdx--; renderModal(); });
    }

    function closeModal() {
      modal.remove();
      document.removeEventListener("keydown", onKey);
    }

    const onKey = (e) => {
      if (e.key === "Escape") closeModal();
      if (e.key === "ArrowLeft" && currentIdx < history.length - 1) { currentIdx++; renderModal(); }
      if (e.key === "ArrowRight" && currentIdx > 0) { currentIdx--; renderModal(); }
    };

    // Show immediately with cached pic
    if (history.length) renderModal();
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
    document.body.appendChild(modal);
    document.addEventListener("keydown", onKey);

    // Load full history in background, then re-render with navigation
    try {
      const resp = await fetch(`${API}/backup/profile-pic-history/${phone}?userId=${selectedUserId}`);
      const data = await resp.json();
      if (data.history && data.history.length > 0) {
        // Reuse the already-displayed cached URL for the newest pic so its <img>
        // src doesn't change (a fresh signed URL would force a needless reload/flicker).
        if (cachedUrl) {
          data.history[0] = { ...data.history[0], url: cachedUrl };
        }

        // If there's only one picture and we're already showing it, skip re-render
        // entirely to avoid swapping the <img> (which causes the reload flicker).
        const onlyOneAndShown = data.history.length === 1 && cachedUrl && !data.history[0].capturedAt;
        history = data.history;
        currentIdx = 0;
        // Preload first few images for instant switching
        history.slice(0, 4).forEach((entry) => { const i = new Image(); i.src = entry.url; });
        if (!onlyOneAndShown && document.getElementById("profile-pic-modal")) renderModal();
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
  // Template Approvals
  // =========================================================================

  async function loadTemplates() {
    const pendingTbody = document.getElementById("tpl-pending-tbody");
    const reviewedTbody = document.getElementById("tpl-reviewed-tbody");
    if (!pendingTbody || !reviewedTbody) return;

    try {
      const resp = await fetch(`${API}/templates`, { credentials: "same-origin" });
      const data = await resp.json();
      const templates = data.templates || [];

      const pending = templates.filter((t) => t.status === "pending");
      const reviewed = templates.filter((t) => t.status === "approved" || t.status === "rejected");

      // Render pending
      if (pending.length === 0) {
        pendingTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--steel);">No pending templates.</td></tr>';
      } else {
        pendingTbody.innerHTML = pending.map((t) => `
          <tr data-tpl-id="${escHtml(t._id)}">
            <td>${escHtml(t.name)}</td>
            <td title="${escHtml(t.bodyText || "")}">${escHtml((t.bodyText || "").substring(0, 80))}${(t.bodyText || "").length > 80 ? "…" : ""}</td>
            <td>${escHtml(t.language || "")}</td>
            <td>${escHtml(t.createdBy || "—")}</td>
            <td>${t.createdAt ? formatDate(t.createdAt) : "—"}</td>
            <td style="white-space:nowrap;">
              <button type="button" class="tpl-approve-btn" data-id="${escHtml(t._id)}"
                style="padding:4px 10px;font-size:12px;font-weight:600;color:#fff;background:#10b981;border:none;border-radius:4px;cursor:pointer;margin-right:4px;">
                Approve
              </button>
              <button type="button" class="tpl-reject-btn" data-id="${escHtml(t._id)}"
                style="padding:4px 10px;font-size:12px;font-weight:600;color:#fff;background:#ef4444;border:none;border-radius:4px;cursor:pointer;">
                Reject
              </button>
            </td>
          </tr>
        `).join("");
      }

      // Render reviewed
      if (reviewed.length === 0) {
        reviewedTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--steel);">No reviewed templates yet.</td></tr>';
      } else {
        reviewedTbody.innerHTML = reviewed.map((t) => {
          const statusColor = t.status === "approved" ? "color:#10b981;" : "color:#ef4444;";
          const statusLabel = t.status === "approved" ? "✓ Approved" : "✗ Rejected";
          const extra = t.status === "rejected" && t.rejectionReason ? ` — ${escHtml(t.rejectionReason)}` : "";
          return `
          <tr>
            <td>${escHtml(t.name)}</td>
            <td title="${escHtml(t.bodyText || "")}">${escHtml((t.bodyText || "").substring(0, 80))}${(t.bodyText || "").length > 80 ? "…" : ""}</td>
            <td>${escHtml(t.language || "")}</td>
            <td style="${statusColor}font-weight:600;font-size:12px;">${statusLabel}${extra}</td>
            <td>${escHtml(t.reviewedBy || "—")}</td>
            <td>${t.reviewedAt ? formatDate(t.reviewedAt) : "—"}</td>
          </tr>`;
        }).join("");
      }

      // Wire approve/reject buttons
      document.querySelectorAll(".tpl-approve-btn").forEach((btn) => {
        btn.addEventListener("click", () => approveTemplate(btn.dataset.id));
      });
      document.querySelectorAll(".tpl-reject-btn").forEach((btn) => {
        btn.addEventListener("click", () => rejectTemplate(btn.dataset.id));
      });
    } catch (err) {
      if (pendingTbody) pendingTbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger);">Failed to load: ${err.message}</td></tr>`;
    }
  }

  async function approveTemplate(id) {
    try {
      const resp = await fetch(`${API}/templates/${id}/approve`, {
        method: "POST",
        credentials: "same-origin",
      });
      const data = await resp.json();
      if (data.error) { alert("Error: " + data.error); return; }
      loadTemplates();
    } catch (err) {
      alert("Failed to approve: " + err.message);
    }
  }

  async function rejectTemplate(id) {
    const reason = prompt("Rejection reason:");
    if (reason === null) return; // cancelled
    try {
      const resp = await fetch(`${API}/templates/${id}/reject`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason }),
      });
      const data = await resp.json();
      if (data.error) { alert("Error: " + data.error); return; }
      loadTemplates();
    } catch (err) {
      alert("Failed to reject: " + err.message);
    }
  }

  // Wire refresh button
  const tplRefreshBtn = document.getElementById("tpl-refresh-btn");
  if (tplRefreshBtn) {
    tplRefreshBtn.addEventListener("click", loadTemplates);
  }

  // =========================================================================
  // Chat Popup
  // =========================================================================

  async function openChatPopup(phone) {
    // Find contact name
    const contact = allContacts.find((c) => c.phone === phone);
    const name = contact?.pushName || "Unknown";

    // Create modal
    let modal = document.getElementById("chat-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "chat-modal";
      document.body.appendChild(modal);
    }

    modal.innerHTML = `
      <div style="position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;">
        <div style="position:absolute;inset:0;background:rgba(15,23,42,0.5);" id="chat-modal-backdrop"></div>
        <div style="position:relative;width:100%;max-width:480px;height:80vh;max-height:600px;background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,0.2);display:flex;flex-direction:column;overflow:hidden;">
          <!-- Header -->
          <div style="padding:14px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:12px;flex-shrink:0;">
            <div style="width:36px;height:36px;border-radius:50%;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:16px;">👤</div>
            <div style="flex:1;min-width:0;">
              <p style="font-weight:600;font-size:14px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(name)}</p>
              <p style="font-size:12px;color:#64748b;margin:0;">+${escHtml(phone)}</p>
            </div>
            <button type="button" id="chat-modal-close" style="width:28px;height:28px;border:none;background:#f1f5f9;border-radius:50%;font-size:16px;cursor:pointer;color:#64748b;">×</button>
          </div>
          <!-- Messages -->
          <div id="chat-messages" style="flex:1;overflow-y:auto;padding:16px;background:#f8fafc;display:flex;flex-direction:column;gap:8px;">
            <p style="text-align:center;color:#94a3b8;font-size:13px;margin:auto;">Loading messages...</p>
          </div>
        </div>
      </div>
    `;

    // Close handlers
    document.getElementById("chat-modal-backdrop").addEventListener("click", closeChatPopup);
    document.getElementById("chat-modal-close").addEventListener("click", closeChatPopup);

    // Fetch messages
    try {
      const resp = await fetch(`${API}/messages/${phone}?userId=${selectedUserId}`);
      const data = await resp.json();
      const messages = data.messages || [];
      const msgContainer = document.getElementById("chat-messages");

      if (messages.length === 0) {
        msgContainer.innerHTML = '<p style="text-align:center;color:#94a3b8;font-size:13px;margin:auto;">No messages found for this contact.</p>';
        return;
      }

      // Filter out empty messages (history sync stubs with no content)
      const displayMessages = messages.filter((m) => m.text || m.mediaType || m.mediaUrl || (m.mediaInfo && m.mediaInfo._hasMedia));

      if (displayMessages.length === 0) {
        msgContainer.innerHTML = '<p style="text-align:center;color:#94a3b8;font-size:13px;margin:auto;">No readable messages found. Messages will appear here as new ones arrive.</p>';
        return;
      }

      msgContainer.innerHTML = displayMessages.map((m) => {
        const align = m.fromMe ? "margin-left:auto;" : "margin-right:auto;";
        const bg = m.fromMe ? "background:#dcfce7;" : "background:#fff;border:1px solid #e5e7eb;";
        const time = m.timestamp ? new Date(m.timestamp).toLocaleString([], { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }) : "";

        // Media rendering
        let mediaHtml = "";
        if (m.mediaType) {
          if (m.mediaUrl) {
            // Already downloaded — show inline
            if (m.mediaType === "image") {
              mediaHtml = `<img src="${escHtml(m.mediaUrl)}" style="max-width:100%;border-radius:8px;margin-bottom:4px;cursor:pointer;" onclick="window.open('${escHtml(m.mediaUrl)}','_blank')" alt="image">`;
            } else if (m.mediaType === "video") {
              mediaHtml = `<video src="${escHtml(m.mediaUrl)}" controls style="max-width:100%;border-radius:8px;margin-bottom:4px;"></video>`;
            } else {
              mediaHtml = `<a href="${escHtml(m.mediaUrl)}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:6px 10px;background:#f1f5f9;border-radius:6px;font-size:11px;color:#334155;text-decoration:none;margin-bottom:4px;">📄 Download ${m.mediaType}</a>`;
            }
          } else if (m.mediaInfo && m.mediaInfo._hasMedia) {
            // Has media data but not downloaded — show skeleton + download button
            const sizeText = m.mediaInfo.fileLength ? `(${(m.mediaInfo.fileLength / 1024).toFixed(0)} KB)` : "";
            mediaHtml = `<div class="media-skeleton" data-msg-id="${escHtml(m.id)}" data-phone="${escHtml(phone)}" style="background:#f1f5f9;border-radius:8px;padding:12px;margin-bottom:4px;text-align:center;">
              <div style="font-size:24px;margin-bottom:4px;">${m.mediaType === "image" ? "🖼️" : m.mediaType === "video" ? "🎬" : "📄"}</div>
              <p style="font-size:11px;color:#64748b;margin:0 0 6px;">${m.mediaType} ${sizeText}</p>
              <button type="button" class="media-download-btn" data-msg-id="${escHtml(m.id)}" data-phone="${escHtml(phone)}" style="padding:4px 12px;font-size:11px;font-weight:600;background:#fff;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;color:#334155;">⬇ Download</button>
            </div>`;
          } else {
            // No media data available (expired)
            mediaHtml = `<div style="background:#f8fafc;border-radius:6px;padding:8px;margin-bottom:4px;text-align:center;">
              <span style="font-size:11px;color:#94a3b8;">📎 ${m.mediaType} (unavailable)</span>
            </div>`;
          }
        }

        return `<div style="max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.4;${align}${bg}">
          ${mediaHtml}
          ${m.text && m.text !== `[${m.mediaType}]` ? `<span style="word-break:break-word;">${escHtml(m.text)}</span>` : (!mediaHtml ? `<span style="word-break:break-word;">${escHtml(m.text || "")}</span>` : "")}
          <span style="display:block;font-size:10px;color:#94a3b8;margin-top:4px;text-align:right;">${time}</span>
        </div>`;
      }).join("");

      // Add "Load older messages" button at the top
      const loadOlderBtn = `<div style="text-align:center;padding:8px 0;">
        <button type="button" id="chat-load-older" data-phone="${escHtml(phone)}" style="padding:6px 16px;font-size:12px;font-weight:500;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;color:#475569;">↑ Load older messages</button>
      </div>`;
      msgContainer.innerHTML = loadOlderBtn + msgContainer.innerHTML;

      // Wire load-older button
      const loadOlderEl = document.getElementById("chat-load-older");
      if (loadOlderEl) {
        loadOlderEl.addEventListener("click", () => fetchOlderMessages(loadOlderEl.dataset.phone, loadOlderEl));
      }

      // Wire download buttons
      msgContainer.querySelectorAll(".media-download-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          downloadMedia(btn.dataset.msgId, btn.dataset.phone, btn);
        });
      });

      // Scroll to bottom
      msgContainer.scrollTop = msgContainer.scrollHeight;
    } catch (err) {
      const msgContainer = document.getElementById("chat-messages");
      if (msgContainer) {
        msgContainer.innerHTML = `<p style="text-align:center;color:#ef4444;font-size:13px;margin:auto;">Error: ${err.message}</p>`;
      }
    }
  }

  async function fetchOlderMessages(phone, btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Requesting...";

    // Capture current message count so we can detect when older ones arrive
    let beforeCount = 0;
    try {
      const beforeResp = await fetch(`${API}/messages/${phone}?userId=${selectedUserId}&limit=500`);
      const beforeData = await beforeResp.json();
      beforeCount = (beforeData.messages || []).length;
    } catch {}

    try {
      const resp = await fetch(`${API}/messages/fetch-history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: selectedUserId, phone }),
      });
      const data = await resp.json();
      if (data.error) {
        btn.textContent = "⚠ " + data.error;
        setTimeout(() => { btn.textContent = "↑ Load older messages"; btn.disabled = false; }, 4000);
        return;
      }

      // Poll for new messages — on-demand sync arrives asynchronously (can take 10-30s)
      btn.textContent = "⏳ Waiting for phone…";
      let attempts = 0;
      const maxAttempts = 8; // ~32s total
      const poll = async () => {
        attempts++;
        try {
          const r = await fetch(`${API}/messages/${phone}?userId=${selectedUserId}&limit=500`);
          const d = await r.json();
          const nowCount = (d.messages || []).length;
          if (nowCount > beforeCount) {
            // Older messages arrived — reload the chat
            openChatPopup(phone);
            return;
          }
        } catch {}

        if (attempts >= maxAttempts) {
          btn.textContent = "No older messages available";
          btn.title = "WhatsApp returned no older history. The phone may be offline, or there are no more messages to sync.";
          setTimeout(() => { btn.textContent = "↑ Load older messages"; btn.disabled = false; }, 5000);
          return;
        }
        setTimeout(poll, 4000);
      };
      setTimeout(poll, 4000);
    } catch (err) {
      btn.textContent = "⚠ " + err.message;
      setTimeout(() => { btn.textContent = "↑ Load older messages"; btn.disabled = false; }, 4000);
    }
  }

  async function downloadMedia(messageId, phone, btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Downloading...";

    try {
      const resp = await fetch(`${API}/messages/download-media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: selectedUserId, phone, messageId }),
      });
      const data = await resp.json();

      if (data.error) {
        btn.textContent = "❌ " + (data.error.includes("expired") ? "Expired" : "Failed");
        btn.style.color = "#ef4444";
        return;
      }

      // Replace skeleton with actual media
      const skeleton = btn.closest(".media-skeleton");
      if (skeleton && data.url) {
        const mediaType = data.mediaType || "document";
        if (mediaType === "image") {
          skeleton.outerHTML = `<img src="${escHtml(data.url)}" style="max-width:100%;border-radius:8px;margin-bottom:4px;cursor:pointer;" onclick="window.open('${escHtml(data.url)}','_blank')" alt="image">`;
        } else if (mediaType === "video") {
          skeleton.outerHTML = `<video src="${escHtml(data.url)}" controls style="max-width:100%;border-radius:8px;margin-bottom:4px;"></video>`;
        } else {
          skeleton.outerHTML = `<a href="${escHtml(data.url)}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:6px 10px;background:#f1f5f9;border-radius:6px;font-size:11px;color:#334155;text-decoration:none;margin-bottom:4px;">📄 Open ${mediaType}</a>`;
        }
      }
    } catch (err) {
      btn.textContent = "❌ Error";
      btn.style.color = "#ef4444";
    }
  }

  function closeChatPopup() {
    const modal = document.getElementById("chat-modal");
    if (modal) modal.innerHTML = "";
  }

  // =========================================================================
  // TN Single Lookup (per-card button)
  // =========================================================================

  async function tnLookupSingle(btn) {
    const mobile = btn.dataset.mobile;
    btn.disabled = true;
    btn.textContent = "⏳…";

    try {
      const resp = await fetch(`/api/tn/lookup?mobile=${mobile}`);
      const data = await resp.json();

      if (data.name) {
        tnNameCache.set(mobile, data.name);
        // Replace button with the verified name
        btn.outerHTML = `<p class="contact-tn" style="font-size:11px;color:#10b981;font-weight:600;margin:2px 0 0;" title="Verified UPI name${data.cached ? ' (cached)' : ''}">✓ ${escHtml(data.name)}</p>`;
      } else {
        btn.textContent = "✗ " + (data.error || "Not found");
        btn.style.color = "#ef4444";
        btn.style.borderColor = "#ef4444";
        btn.disabled = false;
        setTimeout(() => {
          btn.textContent = "🔍 TN Lookup";
          btn.style.color = "";
          btn.style.borderColor = "";
        }, 3000);
      }
    } catch (err) {
      btn.textContent = "❌ Error";
      btn.disabled = false;
      setTimeout(() => { btn.textContent = "🔍 TN Lookup"; }, 3000);
    }
  }

  // Load cached TN names on page load so cards show them immediately
  async function loadTnCache() {
    try {
      const resp = await fetch("/api/tn/cache");
      const data = await resp.json();
      const cache = data.cache || {};
      for (const [mobile, name] of Object.entries(cache)) {
        tnNameCache.set(mobile, name);
      }
    } catch {}
  }

  // =========================================================================
  // True Name Batch Lookup
  // =========================================================================

  let tnBatchResults = [];

  function parseMobiles(raw) {
    // Accept newlines, commas, spaces, or semicolons as separators
    return raw
      .split(/[\n,;\s]+/)
      .map((s) => s.replace(/[^0-9]/g, "").trim())
      .filter((s) => s.length >= 10)
      .map((s) => s.slice(-10)); // take last 10 digits (strip country code)
  }

  document.getElementById("tn-batch-btn").addEventListener("click", async () => {
    const input = document.getElementById("tn-batch-input").value.trim();
    if (!input) return;
    const mobiles = parseMobiles(input);
    if (!mobiles.length) {
      document.getElementById("tn-batch-status").textContent = "No valid mobile numbers found.";
      return;
    }
    await runBatchLookup(mobiles);
  });

  // "Lookup Loaded Contacts" — uses phones from the Contact Viewer
  document.getElementById("tn-batch-contacts-btn").addEventListener("click", async () => {
    if (!allContacts.length) return;
    // Extract 10-digit Indian mobiles from loaded contacts (strip 91 country code)
    const mobiles = allContacts
      .map((c) => (c.phone || "").replace(/^91/, ""))
      .filter((m) => /^[6-9]\d{9}$/.test(m));
    if (!mobiles.length) {
      document.getElementById("tn-batch-status").textContent = "No valid Indian mobile numbers in loaded contacts.";
      return;
    }
    // Pre-fill the textarea for visibility
    document.getElementById("tn-batch-input").value = mobiles.join("\n");
    await runBatchLookup(mobiles);
  });

  async function runBatchLookup(mobiles) {
    const btn = document.getElementById("tn-batch-btn");
    const status = document.getElementById("tn-batch-status");
    const tbody = document.getElementById("tn-batch-tbody");
    const wrapper = document.getElementById("tn-batch-results-wrapper");
    const exportRow = document.getElementById("tn-batch-export-row");

    btn.disabled = true;
    status.textContent = `Looking up ${mobiles.length} number(s)…`;
    tbody.innerHTML = "";
    wrapper.style.display = "none";
    exportRow.style.display = "none";
    tnBatchResults = [];

    // Process in chunks of 20 (API limit)
    const chunks = [];
    for (let i = 0; i < mobiles.length; i += 20) {
      chunks.push(mobiles.slice(i, i + 20));
    }

    let completed = 0;
    for (const chunk of chunks) {
      try {
        const resp = await fetch("/api/tn/batch-lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mobiles: chunk }),
        });
        const data = await resp.json();
        if (data.error) {
          status.textContent = `Error: ${data.error}`;
          btn.disabled = false;
          return;
        }
        const batchItems = data.results || [];
        tnBatchResults.push(...batchItems);
        // Update local cache with resolved names
        batchItems.forEach((r) => { if (r.name) tnNameCache.set(r.mobile, r.name); });
      } catch (err) {
        status.textContent = `Network error: ${err.message}`;
        btn.disabled = false;
        return;
      }
      completed += chunk.length;
      status.textContent = `Processed ${completed} / ${mobiles.length}…`;
    }

    // Render results
    wrapper.style.display = "block";
    exportRow.style.display = "flex";

    const successCount = tnBatchResults.filter((r) => r.name).length;
    status.textContent = `Done — ${successCount} resolved out of ${tnBatchResults.length}`;

    tbody.innerHTML = tnBatchResults.map((r) => {
      const statusBadge = r.name
        ? '<span style="color:#10b981;font-weight:600;font-size:12px;">✓ Found</span>'
        : `<span style="color:#ef4444;font-size:12px;">${escHtml(r.error || "not_found")}</span>`;
      return `
        <tr>
          <td style="font-family:monospace;">${escHtml(r.mobile)}</td>
          <td style="font-weight:${r.name ? '600' : '400'};">${r.name ? escHtml(r.name) : '—'}</td>
          <td>${statusBadge}</td>
        </tr>`;
    }).join("");

    btn.disabled = false;

    // Re-render contact cards to show newly cached names
    renderContacts();
  }

  // Export results as CSV
  document.getElementById("tn-export-csv-btn").addEventListener("click", () => {
    if (!tnBatchResults.length) return;
    const header = "Mobile,Verified Name,Status\n";
    const rows = tnBatchResults.map((r) => {
      const name = (r.name || "").replace(/"/g, '""');
      const st = r.name ? "found" : (r.error || "not_found");
      return `${r.mobile},"${name}",${st}`;
    }).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tn-batch-results-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Enable the "Lookup Loaded Contacts" button when contacts are loaded
  const _origLoadContacts = loadContacts;
  loadContacts = async function () {
    await _origLoadContacts();
    const btn = document.getElementById("tn-batch-contacts-btn");
    if (btn) btn.disabled = !allContacts.length;
  };

  // =========================================================================
  // Init
  // =========================================================================

  loadTnCache();
  loadSessions();
  loadTemplates();
})();
