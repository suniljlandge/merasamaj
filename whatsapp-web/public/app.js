/**
 * SAMAJ WhatsApp Web — Standalone Frontend App
 * Login, Session Management, Contact Viewer, TN Lookup, Messaging
 */
(function () {
  "use strict";

  // =========================================================================
  // CONFIG & STATE
  // =========================================================================

  let authToken = sessionStorage.getItem("wa_auth_token") || "";
  let allContacts = [];
  let currentPage = 1;
  const PAGE_SIZE = 24;
  let picFilter = "all";
  const tnNameCache = new Map();
  const picUrlCache = new Map();
  let tnAutoRunning = false;
  let selectedUserId = null; // currently selected user for contacts/messages

  const API_HEADERS = () => ({
    "Content-Type": "application/json",
    "X-Auth-Token": authToken,
  });

  function apiGet(path) {
    return fetch(path, { headers: API_HEADERS() });
  }
  function apiPost(path, body) {
    return fetch(path, { method: "POST", headers: API_HEADERS(), body: JSON.stringify(body) });
  }

  // =========================================================================
  // AUTH / LOGIN
  // =========================================================================

  const loginScreen = document.getElementById("login-screen");
  const appScreen = document.getElementById("app-screen");
  const loginBtn = document.getElementById("login-btn");
  const loginPassword = document.getElementById("login-password");
  const loginError = document.getElementById("login-error");

  function showApp() {
    loginScreen.classList.remove("active");
    appScreen.classList.add("active");
    initApp();
  }

  function showLogin() {
    appScreen.classList.remove("active");
    loginScreen.classList.add("active");
  }

  loginBtn.addEventListener("click", doLogin);
  loginPassword.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

  async function doLogin() {
    const pw = loginPassword.value.trim();
    if (!pw) { loginPassword.focus(); return; }
    loginBtn.disabled = true;
    loginError.hidden = true;

    try {
      const resp = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await resp.json();
      if (data.token) {
        authToken = data.token;
        sessionStorage.setItem("wa_auth_token", authToken);
        showApp();
      } else {
        loginError.textContent = data.error || "Invalid password";
        loginError.hidden = false;
      }
    } catch (err) {
      loginError.textContent = "Connection failed: " + err.message;
      loginError.hidden = false;
    } finally {
      loginBtn.disabled = false;
    }
  }

  document.getElementById("logout-btn").addEventListener("click", () => {
    authToken = "";
    sessionStorage.removeItem("wa_auth_token");
    showLogin();
  });

  // =========================================================================
  // TAB NAVIGATION
  // =========================================================================

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    });
  });

  // =========================================================================
  // SESSION MANAGEMENT
  // =========================================================================

  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const statusDetail = document.getElementById("status-detail");
  const sessionDot = document.getElementById("session-indicator");
  const sessionLabel = document.getElementById("session-status-label");
  let isPairing = false;
  let statusInterval = null;

  async function checkStatus() {
    try {
      const resp = await apiGet("/ui/status");
      if (resp.status === 401) { showLogin(); return; }
      const data = await resp.json();
      if (isPairing && data.status !== "connected") return;
      updateStatusUI(data.status || "disconnected");
    } catch {
      if (!isPairing) updateStatusUI("unavailable");
    }
  }

  function updateStatusUI(status) {
    // Status dot
    statusDot.className = "status-indicator " + status;
    sessionDot.className = "session-dot " + status;

    const labels = {
      connected: "Connected", connecting: "Connecting...",
      reconnecting: "Reconnecting...", disconnected: "Disconnected",
      unavailable: "Unavailable",
    };
    statusText.textContent = labels[status] || status;
    sessionLabel.textContent = labels[status] || status;

    const connectCard = document.getElementById("connect-card");
    const connectedCard = document.getElementById("connected-card");
    const statsCard = document.getElementById("stats-card");

    if (status === "connected") {
      connectCard.hidden = true;
      connectedCard.hidden = false;
      statsCard.hidden = false;
      loadStats();
    } else {
      connectCard.hidden = false;
      connectedCard.hidden = true;
      statsCard.hidden = true;
      if (status === "unavailable") {
        statusDetail.textContent = "Sidecar service is not responding.";
      } else {
        statusDetail.textContent = "";
      }
    }
  }

  // Connect OTP
  document.getElementById("connect-otp-btn").addEventListener("click", async () => {
    const phone = document.getElementById("phone-input").value.trim();
    if (!phone) { document.getElementById("phone-input").focus(); return; }
    const btn = document.getElementById("connect-otp-btn");
    btn.disabled = true; btn.textContent = "Requesting...";

    try {
      const resp = await apiPost("/ui/connect", { phoneNumber: phone });
      const data = await resp.json();
      if (data.pairingCode) {
        document.getElementById("pairing-code").textContent = data.pairingCode;
        document.getElementById("pairing-panel").hidden = false;
        document.getElementById("qr-panel").hidden = true;
        isPairing = true;
        pollForConnection();
      } else if (data.status === "connected") {
        updateStatusUI("connected");
      } else {
        alert(data.error || "Failed to start connection");
      }
    } catch (err) { alert("Error: " + err.message); }
    finally { btn.disabled = false; btn.textContent = "Get Pairing Code"; }
  });

  // Connect QR
  document.getElementById("connect-qr-btn").addEventListener("click", async () => {
    const btn = document.getElementById("connect-qr-btn");
    btn.disabled = true; btn.textContent = "Loading...";
    try {
      const resp = await apiPost("/ui/connect-qr", {});
      const data = await resp.json();
      document.getElementById("qr-panel").hidden = false;
      document.getElementById("pairing-panel").hidden = true;
      isPairing = true;
      pollForQR();
      pollForConnection();
    } catch (err) { alert("Error: " + err.message); }
    finally { btn.disabled = false; btn.textContent = "Show QR"; }
  });

  function pollForConnection() {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > 60) { clearInterval(interval); isPairing = false; return; }
      try {
        const resp = await apiGet("/ui/status");
        const data = await resp.json();
        if (data.status === "connected") {
          clearInterval(interval);
          isPairing = false;
          document.getElementById("pairing-panel").hidden = true;
          document.getElementById("qr-panel").hidden = true;
          updateStatusUI("connected");
        }
      } catch {}
    }, 2000);
  }

  function pollForQR() {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > 30 || !isPairing) { clearInterval(interval); return; }
      try {
        const resp = await apiGet("/ui/qr");
        const data = await resp.json();
        if (data.qr) {
          const container = document.getElementById("qr-container");
          // Use a simple text representation or generate QR image
          container.innerHTML = `<pre style="font-size:4px;line-height:4px;letter-spacing:1px;font-family:monospace;">${escHtml(data.qr)}</pre>`;
        }
        if (data.status === "connected") { clearInterval(interval); }
      } catch {}
    }, 2000);
  }

  // Disconnect
  document.getElementById("disconnect-btn").addEventListener("click", async () => {
    if (!confirm("Disconnect WhatsApp? You'll need to pair again.")) return;
    try {
      await apiPost("/ui/disconnect", {});
      updateStatusUI("disconnected");
    } catch (err) { alert("Error: " + err.message); }
  });

  // Backup
  document.getElementById("backup-btn").addEventListener("click", async () => {
    const btn = document.getElementById("backup-btn");
    btn.disabled = true; btn.textContent = "Starting...";
    const progress = document.getElementById("backup-progress");
    const fill = document.getElementById("backup-fill");
    const text = document.getElementById("backup-text");
    progress.hidden = false; fill.style.width = "10%";
    text.textContent = "Starting backup...";

    try {
      const resp = await apiPost("/ui/backup", { includeProfilePics: true });
      const data = await resp.json();
      if (data.success) {
        fill.style.width = "40%"; text.textContent = "Backup running...";
        // Poll for completion
        let checks = 0;
        const poll = setInterval(async () => {
          checks++;
          if (checks > 120) { clearInterval(poll); text.textContent = "Still running..."; btn.disabled = false; return; }
          try {
            const s = await (await apiGet("/ui/backup-status")).json();
            if (!s.running) {
              clearInterval(poll);
              fill.style.width = "100%";
              text.textContent = `Done — ${s.totalContacts || 0} contacts, ${s.totalGroups || 0} groups`;
              btn.textContent = "Run Backup"; btn.disabled = false;
              setTimeout(() => { progress.hidden = true; }, 5000);
            } else {
              fill.style.width = Math.min(90, 40 + checks) + "%";
            }
          } catch {}
        }, 3000);
      } else {
        text.textContent = data.error || "Failed"; btn.disabled = false; btn.textContent = "Run Backup";
      }
    } catch (err) { text.textContent = err.message; btn.disabled = false; btn.textContent = "Run Backup"; }
  });

  // Stats
  async function loadStats() {
    try {
      const resp = await apiGet("/ui/stats");
      const data = await resp.json();
      document.getElementById("stat-sent").textContent = data.sent || 0;
      document.getElementById("stat-limit").textContent = data.limit || 20;
      document.getElementById("stat-remaining").textContent = data.remaining || 0;
    } catch {}
  }

  // =========================================================================
  // SESSIONS OVERVIEW
  // =========================================================================

  async function loadSessions() {
    const tbody = document.getElementById("sessions-tbody");
    const userSelect = document.getElementById("user-select");
    try {
      const resp = await apiGet("/ui/sessions");
      if (resp.status === 401) { showLogin(); return; }
      const data = await resp.json();
      const sessions = data.sessions || [];

      if (!sessions.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-light);">No sessions found.</td></tr>';
        return;
      }

      // Populate sessions table
      let totalContacts = 0, totalGroups = 0;
      tbody.innerHTML = sessions.map((s) => {
        const bs = s.backupStats || {};
        totalContacts += bs.contacts || 0;
        totalGroups += bs.groups || 0;
        const status = s.liveStatus || s.status || "disconnected";
        const lastBackup = bs.lastBackup ? formatDate(bs.lastBackup) : "Never";
        const picCount = bs.lastResults?.profilePics?.uploaded || "—";
        return `
        <tr>
          <td style="font-weight:600;">${escHtml(s.userId)}</td>
          <td>${escHtml(s.phoneNumber || "—")}</td>
          <td><span class="status-badge ${status}">${status}</span></td>
          <td>${s.connectedAt ? formatDate(s.connectedAt) : "—"}</td>
          <td>${s.lastActiveAt ? formatDate(s.lastActiveAt) : "—"}</td>
          <td>
            <span style="font-size:12px;">📇 ${bs.contacts || 0} · 👥 ${bs.groups || 0}</span><br>
            <span style="font-size:11px;color:var(--text-light);">Last: ${lastBackup}</span>
          </td>
          <td>
            <button type="button" class="btn-secondary btn-sm backup-user-btn" data-user-id="${escHtml(s.userId)}" ${status !== "connected" ? "disabled" : ""}>Backup</button>
          </td>
        </tr>`;
      }).join("");

      // Summary stats
      document.getElementById("bs-contacts").textContent = totalContacts;
      document.getElementById("bs-groups").textContent = totalGroups;

      // Populate user select dropdown
      userSelect.innerHTML = '<option value="">Select user session...</option>' +
        sessions.map((s) => {
          const label = s.phoneNumber ? `${s.userId} (${s.phoneNumber})` : s.userId;
          return `<option value="${escHtml(s.userId)}">${escHtml(label)} — ${s.liveStatus || "unknown"}</option>`;
        }).join("");

      // Auto-select first connected session
      if (!selectedUserId) {
        const connected = sessions.find((s) => s.liveStatus === "connected");
        if (connected) {
          selectedUserId = connected.userId;
          userSelect.value = connected.userId;
        }
      } else {
        userSelect.value = selectedUserId;
      }

      // Wire backup buttons
      tbody.querySelectorAll(".backup-user-btn").forEach((btn) => {
        btn.addEventListener("click", () => triggerUserBackup(btn.dataset.userId, btn));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:var(--red);">${err.message}</td></tr>`;
    }
  }

  async function triggerUserBackup(userId, btn) {
    btn.disabled = true;
    btn.textContent = "Starting...";
    try {
      const resp = await apiPost(`/ui/backup/${userId}`, { includeProfilePics: true });
      const data = await resp.json();
      if (data.success) {
        btn.textContent = "✓ Running";
        setTimeout(() => { btn.textContent = "Backup"; btn.disabled = false; loadSessions(); }, 30000);
      } else {
        btn.textContent = "Failed";
        setTimeout(() => { btn.textContent = "Backup"; btn.disabled = false; }, 3000);
      }
    } catch (err) {
      btn.textContent = "Error";
      setTimeout(() => { btn.textContent = "Backup"; btn.disabled = false; }, 3000);
    }
  }

  // User select change handler
  document.getElementById("user-select").addEventListener("change", (e) => {
    selectedUserId = e.target.value || null;
    if (selectedUserId) {
      picUrlCache.clear();
      loadContacts();
    } else {
      allContacts = [];
      document.getElementById("contact-grid").innerHTML = '<p class="empty-state">Select a user session to view contacts.</p>';
    }
  });

  // Refresh sessions button
  document.getElementById("refresh-sessions-btn").addEventListener("click", loadSessions);

  function formatDate(isoStr) {
    if (!isoStr) return "—";
    const d = new Date(isoStr);
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + " " +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // =========================================================================
  // CONTACTS
  // =========================================================================

  document.getElementById("refresh-contacts-btn").addEventListener("click", () => {
    picUrlCache.clear();
    loadContacts();
  });

  async function loadContacts() {
    const grid = document.getElementById("contact-grid");
    if (!selectedUserId) {
      grid.innerHTML = '<p class="empty-state">Select a user session to view contacts.</p>';
      return;
    }
    grid.innerHTML = '<p class="empty-state">Loading contacts...</p>';
    try {
      const resp = await apiGet(`/ui/contacts/${selectedUserId}`);
      if (resp.status === 401) { showLogin(); return; }
      const data = await resp.json();
      allContacts = data.contacts || [];
      currentPage = 1;
      renderContacts();
      document.getElementById("tn-lookup-contacts-btn").disabled = !allContacts.length;
      autoLookupAllContacts();
    } catch (err) {
      grid.innerHTML = `<p class="empty-state" style="color:var(--red);">Error: ${err.message}</p>`;
    }
  }

  function renderContacts() {
    const grid = document.getElementById("contact-grid");
    const search = document.getElementById("contact-search").value.toLowerCase().trim();
    const pagination = document.getElementById("contact-pagination");
    const recentMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    let filtered = allContacts;
    if (picFilter === "updated") {
      filtered = filtered.filter((c) => c.profilePicUpdatedAt && (now - new Date(c.profilePicUpdatedAt).getTime()) < recentMs);
      filtered = [...filtered].sort((a, b) => new Date(b.profilePicUpdatedAt) - new Date(a.profilePicUpdatedAt));
    }
    if (search) {
      filtered = filtered.filter((c) => {
        const m = (c.phone || "").replace(/^91/, "");
        const tn = tnNameCache.get(m) || "";
        return (c.phone || "").includes(search) || (c.pushName || "").toLowerCase().includes(search) || tn.toLowerCase().includes(search);
      });
    }

    const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    if (!pageItems.length) {
      grid.innerHTML = '<p class="empty-state">No contacts found.</p>';
      pagination.hidden = true;
      return;
    }

    grid.innerHTML = pageItems.map((c) => {
      const m10 = (c.phone || "").replace(/^91/, "");
      const isIndian = /^[6-9]\d{9}$/.test(m10);
      const cachedName = tnNameCache.get(m10);
      let tnHtml = "";
      if (isIndian) {
        tnHtml = cachedName
          ? `<p class="contact-tn">✓ ${escHtml(cachedName)}</p>`
          : `<p class="contact-tn-pending" id="tn-${escHtml(m10)}"><span class="tn-spinner"></span> Looking up…</p>`;
      }
      const picBadge = c.profilePicUpdatedAt && (now - new Date(c.profilePicUpdatedAt).getTime()) < recentMs
        ? `<span class="pic-badge">↑</span>` : "";
      return `
      <div class="contact-card" data-phone="${escHtml(c.phone)}">
        <div class="contact-pic" id="pic-${c.phone}">
          <span style="font-size:20px;color:var(--text-light);">👤</span>
          ${picBadge}
        </div>
        <div class="contact-info">
          <p class="contact-name">${escHtml(c.pushName || "Unknown")}</p>
          <p class="contact-phone">+${escHtml(c.phone)}</p>
          ${tnHtml}
        </div>
      </div>`;
    }).join("");

    // Pagination
    if (filtered.length > PAGE_SIZE) {
      pagination.hidden = false;
      document.getElementById("page-info").textContent = `Page ${currentPage} of ${totalPages} (${filtered.length})`;
      document.getElementById("prev-page-btn").disabled = currentPage <= 1;
      document.getElementById("next-page-btn").disabled = currentPage >= totalPages;
    } else {
      pagination.hidden = true;
    }

    // Load profile pics
    const phonesWithPics = pageItems.filter((c) => c.hasProfilePic).map((c) => c.phone);
    if (phonesWithPics.length) loadProfilePicsBatch(phonesWithPics);

    // Click handlers
    grid.querySelectorAll(".contact-card").forEach((card) => {
      const picEl = card.querySelector(".contact-pic");
      picEl.style.cursor = "zoom-in";
      picEl.addEventListener("click", (e) => {
        e.stopPropagation();
        const img = picEl.querySelector("img");
        if (img) openPicModal(card.dataset.phone, card.querySelector(".contact-name").textContent);
      });
      card.addEventListener("click", () => openChat(card.dataset.phone));
    });
  }

  document.getElementById("contact-search").addEventListener("input", () => { currentPage = 1; renderContacts(); });
  document.getElementById("prev-page-btn").addEventListener("click", () => { if (currentPage > 1) { currentPage--; renderContacts(); } });
  document.getElementById("next-page-btn").addEventListener("click", () => { currentPage++; renderContacts(); });

  // Pic filter
  document.getElementById("pic-filter-btn").addEventListener("click", () => {
    const btn = document.getElementById("pic-filter-btn");
    picFilter = picFilter === "all" ? "updated" : "all";
    btn.style.background = picFilter === "updated" ? "var(--green)" : "";
    btn.style.color = picFilter === "updated" ? "#fff" : "";
    btn.style.borderColor = picFilter === "updated" ? "var(--green)" : "";
    currentPage = 1;
    renderContacts();
  });

  // Export
  document.getElementById("export-csv-btn").addEventListener("click", () => {
    window.open("/ui/contacts-export?format=csv", "_blank");
  });
  document.getElementById("export-json-btn").addEventListener("click", () => {
    window.open("/ui/contacts-export?format=json", "_blank");
  });

  // Profile pics batch
  async function loadProfilePicsBatch(phones) {
    const uncached = phones.filter((p) => !picUrlCache.has(p));
    phones.forEach((p) => { if (picUrlCache.has(p)) applyPic(p, picUrlCache.get(p)); });
    if (!uncached.length) return;
    try {
      const resp = await apiPost(`/ui/profile-pics-batch/${selectedUserId}`, { phones: uncached });
      const data = await resp.json();
      const urls = data.urls || {};
      for (const [phone, url] of Object.entries(urls)) {
        picUrlCache.set(phone, url);
        applyPic(phone, url);
      }
    } catch {}
  }

  function applyPic(phone, url) {
    const el = document.getElementById("pic-" + phone);
    if (!el) return;
    const img = new Image();
    img.onload = () => { el.innerHTML = ""; img.className = ""; el.appendChild(img); };
    img.src = url;
    img.style.cssText = "width:48px;height:48px;border-radius:50%;object-fit:cover;";
  }

  // Profile pic modal
  async function openPicModal(phone, name) {
    const modal = document.getElementById("pic-modal");
    const cachedUrl = picUrlCache.get(phone);
    if (!cachedUrl) return;
    modal.hidden = false;
    modal.innerHTML = `
      <div style="position:relative;text-align:center;">
        <img src="${cachedUrl}" alt="${escHtml(name)}" style="max-width:80vw;max-height:70vh;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
        <p style="color:#fff;margin-top:12px;font-size:16px;font-weight:600;">${escHtml(name)}</p>
        <p style="color:#ccc;font-size:13px;">+${escHtml(phone)}</p>
      </div>`;
    modal.addEventListener("click", () => { modal.hidden = true; }, { once: true });
  }

  // Chat popup
  async function openChat(phone) {
    const contact = allContacts.find((c) => c.phone === phone);
    const name = contact?.pushName || "Unknown";
    const modal = document.getElementById("chat-modal");
    modal.hidden = false;
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <div class="contact-pic" style="width:36px;height:36px;"><span style="font-size:16px;">👤</span></div>
          <div style="flex:1;min-width:0;">
            <h3>${escHtml(name)}</h3>
            <p>+${escHtml(phone)}</p>
          </div>
          <button class="modal-close" id="chat-close">×</button>
        </div>
        <div class="chat-messages" id="chat-msgs">
          <p style="text-align:center;color:var(--text-light);margin:auto;">Loading messages...</p>
        </div>
      </div>`;
    document.getElementById("chat-close").addEventListener("click", () => { modal.hidden = true; });
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

    try {
      const resp = await apiGet(`/ui/messages/${selectedUserId}/${phone}`);
      const data = await resp.json();
      const messages = (data.messages || []).filter((m) => m.text || m.mediaType);
      const container = document.getElementById("chat-msgs");
      if (!messages.length) {
        container.innerHTML = '<p style="text-align:center;color:var(--text-light);margin:auto;">No messages found.</p>';
        return;
      }
      container.innerHTML = messages.map((m) => {
        const cls = m.fromMe ? "sent" : "received";
        const time = m.timestamp ? new Date(m.timestamp).toLocaleString([], { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }) : "";
        let media = "";
        if (m.mediaUrl && m.mediaType === "image") {
          media = `<img src="${escHtml(m.mediaUrl)}" style="max-width:100%;border-radius:8px;margin-bottom:4px;">`;
        } else if (m.mediaType && !m.mediaUrl) {
          media = `<span style="font-size:11px;color:var(--text-light);">📎 ${m.mediaType}</span>`;
        }
        return `<div class="msg-bubble ${cls}">${media}${m.text ? escHtml(m.text) : ""}<span class="msg-time">${time}</span></div>`;
      }).join("");
      container.scrollTop = container.scrollHeight;
    } catch (err) {
      document.getElementById("chat-msgs").innerHTML = `<p style="color:var(--red);text-align:center;margin:auto;">${err.message}</p>`;
    }
  }

  // =========================================================================
  // TN LOOKUP
  // =========================================================================

  document.getElementById("tn-lookup-btn").addEventListener("click", async () => {
    const raw = document.getElementById("tn-input").value.trim();
    if (!raw) return;
    const mobiles = parseMobiles(raw);
    if (!mobiles.length) { document.getElementById("tn-status").textContent = "No valid numbers found."; return; }
    await runBatchTnLookup(mobiles);
  });

  document.getElementById("tn-lookup-contacts-btn").addEventListener("click", async () => {
    if (!allContacts.length) return;
    const mobiles = allContacts.map((c) => (c.phone || "").replace(/^91/, "")).filter((m) => /^[6-9]\d{9}$/.test(m));
    if (!mobiles.length) { document.getElementById("tn-status").textContent = "No Indian mobiles found."; return; }
    document.getElementById("tn-input").value = mobiles.join("\n");
    await runBatchTnLookup(mobiles);
  });

  function parseMobiles(raw) {
    return raw.split(/[\n,;\s]+/).map((s) => s.replace(/[^0-9]/g, "")).filter((s) => s.length >= 10).map((s) => s.slice(-10));
  }

  async function runBatchTnLookup(mobiles) {
    const btn = document.getElementById("tn-lookup-btn");
    const status = document.getElementById("tn-status");
    const tbody = document.getElementById("tn-results-tbody");
    const wrapper = document.getElementById("tn-results");
    btn.disabled = true;
    status.textContent = `Looking up ${mobiles.length} number(s)…`;
    let allResults = [];

    const chunks = [];
    for (let i = 0; i < mobiles.length; i += 20) chunks.push(mobiles.slice(i, i + 20));

    let done = 0;
    for (const chunk of chunks) {
      try {
        const resp = await apiPost("/ui/tn-batch", { mobiles: chunk });
        const data = await resp.json();
        const results = data.results || [];
        allResults.push(...results);
        results.forEach((r) => { if (r.name) tnNameCache.set(r.mobile, r.name); });
      } catch {}
      done += chunk.length;
      status.textContent = `Processed ${done} / ${mobiles.length}…`;
    }

    const successCount = allResults.filter((r) => r.name).length;
    status.textContent = `Done — ${successCount} resolved out of ${allResults.length}`;
    wrapper.hidden = false;
    document.getElementById("tn-results-summary").textContent = `${successCount}/${allResults.length} found`;

    tbody.innerHTML = allResults.map((r) => {
      const st = r.name ? '<span style="color:var(--green);font-weight:600;">✓ Found</span>' : `<span style="color:var(--red);">${escHtml(r.error || "not found")}</span>`;
      return `<tr><td style="font-family:monospace;">${escHtml(r.mobile)}</td><td style="font-weight:${r.name ? '600' : '400'};">${r.name ? escHtml(r.name) : '—'}</td><td>${st}</td></tr>`;
    }).join("");
    btn.disabled = false;
    renderContacts(); // update contact cards with new names
  }

  // TN Export CSV
  document.getElementById("tn-export-btn").addEventListener("click", () => {
    const rows = document.querySelectorAll("#tn-results-tbody tr");
    if (!rows.length) return;
    let csv = "Mobile,Verified Name,Status\n";
    rows.forEach((tr) => {
      const cells = tr.querySelectorAll("td");
      const m = cells[0]?.textContent || "";
      const n = (cells[1]?.textContent || "").replace(/"/g, '""');
      const s = cells[2]?.textContent?.includes("Found") ? "found" : "not_found";
      csv += `${m},"${n}",${s}\n`;
    });
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tn-results-${Date.now()}.csv`;
    a.click();
  });

  // Auto TN lookup for contacts
  async function autoLookupAllContacts() {
    if (tnAutoRunning) return;
    const allMobiles = allContacts.map((c) => (c.phone || "").replace(/^91/, "")).filter((m) => /^[6-9]\d{9}$/.test(m));
    const unique = [...new Set(allMobiles.filter((m) => !tnNameCache.has(m)))];
    if (!unique.length) return;
    tnAutoRunning = true;

    const chunks = [];
    for (let i = 0; i < unique.length; i += 50) chunks.push(unique.slice(i, i + 50));

    await Promise.all(chunks.map((chunk) =>
      apiPost("/ui/tn-batch", { mobiles: chunk })
        .then((r) => r.json())
        .then((data) => {
          (data.results || []).forEach((r) => {
            if (r.name) tnNameCache.set(r.mobile, r.name);
            applyTnToCard(r.mobile, r.name);
          });
        })
        .catch(() => {})
    ));
    tnAutoRunning = false;
  }

  function applyTnToCard(mobile, name) {
    const el = document.getElementById("tn-" + mobile);
    if (!el) return;
    if (name) {
      el.outerHTML = `<p class="contact-tn">✓ ${escHtml(name)}</p>`;
    } else {
      el.outerHTML = `<p style="font-size:11px;color:var(--text-light);">— not found</p>`;
    }
  }

  // =========================================================================
  // MESSAGING
  // =========================================================================

  document.getElementById("msg-send-btn").addEventListener("click", async () => {
    const phone = document.getElementById("msg-phone").value.trim();
    const text = document.getElementById("msg-text").value.trim();
    const result = document.getElementById("msg-result");
    if (!phone || !text) { result.textContent = "Fill in both fields."; result.style.color = "var(--red)"; return; }
    const btn = document.getElementById("msg-send-btn");
    btn.disabled = true;

    try {
      const resp = await apiPost("/ui/send", { recipientPhone: phone, text });
      const data = await resp.json();
      if (data.success) {
        result.textContent = "✓ Sent via WhatsApp Web";
        result.style.color = "var(--green)";
        document.getElementById("msg-text").value = "";
        loadStats();
      } else if (data.channel === "cloud_api") {
        result.textContent = "→ Routed to Cloud API: " + data.reason;
        result.style.color = "var(--text-muted)";
      } else {
        result.textContent = "✗ " + (data.error || "Send failed");
        result.style.color = "var(--red)";
      }
    } catch (err) {
      result.textContent = "✗ " + err.message;
      result.style.color = "var(--red)";
    } finally { btn.disabled = false; }
  });

  // =========================================================================
  // HELPERS
  // =========================================================================

  function escHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  // =========================================================================
  // INIT
  // =========================================================================

  function initApp() {
    checkStatus();
    statusInterval = setInterval(checkStatus, 10000);
    loadTnCache();
    loadSessions();
    loadContacts(); // will show "select user" if none selected
  }

  // Preload TN cache so contact cards show names immediately
  async function loadTnCache() {
    try {
      const resp = await apiGet("/ui/tn-cache");
      const data = await resp.json();
      const cache = data.cache || {};
      for (const [mobile, name] of Object.entries(cache)) {
        tnNameCache.set(mobile, name);
      }
    } catch {}
  }

  // Auto-login if token exists
  if (authToken) {
    // Validate token
    fetch("/ui/status", { headers: { "X-Auth-Token": authToken } })
      .then((r) => { if (r.ok) showApp(); else showLogin(); })
      .catch(() => showLogin());
  } else {
    showLogin();
  }

})();
