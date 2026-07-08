const permissionsHeaderRow = document.querySelector("#permissions-header-row");
const permissionsTableBody = document.querySelector("#permissions-table-body");
const limitsGrid = document.querySelector("#limits-grid");
const saveConfigBtn = document.querySelector("#save-config-btn");
const configStatus = document.querySelector("#config-status");
const exportBtn = document.querySelector("#export-btn");
const exportStatus = document.querySelector("#export-status");

let configState = {
  roles: [],
  capabilities: [],
  limits: [],
  config: { permissions: {}, limits: {} },
  lockedCapabilities: {},
};

initialize();

function initialize() {
  loadRoleConfig();
  loadExportFilters();
  loadExportColumns();
  loadPublicAccounts();
  loadSignupDefault();
  loadSidecarStatus();

  if (saveConfigBtn) saveConfigBtn.addEventListener("click", saveRoleConfig);
  if (exportBtn) exportBtn.addEventListener("click", downloadExport);

  const saveExportColsBtn = document.querySelector("#save-export-cols-btn");
  if (saveExportColsBtn) saveExportColsBtn.addEventListener("click", saveExportColumns);

  const publicAccountsSearch = document.querySelector("#public-accounts-search");
  if (publicAccountsSearch) publicAccountsSearch.addEventListener("input", renderPublicAccounts);

  const saveSignupDefaultBtn = document.querySelector("#save-signup-default-btn");
  if (saveSignupDefaultBtn) saveSignupDefaultBtn.addEventListener("click", saveSignupDefault);

  const sidecarRefreshBtn = document.querySelector("#sidecar-refresh-btn");
  if (sidecarRefreshBtn) sidecarRefreshBtn.addEventListener("click", loadSidecarStatus);

  const reconnectAllBtn = document.querySelector("#sidecar-reconnect-all-btn");
  if (reconnectAllBtn) reconnectAllBtn.addEventListener("click", sidecarReconnectAll);

  const sidecarStartBtn = document.querySelector("#sidecar-start-btn");
  if (sidecarStartBtn) sidecarStartBtn.addEventListener("click", sidecarStart);

  const sidecarLogsBtn = document.querySelector("#sidecar-logs-btn");
  if (sidecarLogsBtn) sidecarLogsBtn.addEventListener("click", sidecarViewLogs);

  const sidecarLogsCloseBtn = document.querySelector("#sidecar-logs-close-btn");
  if (sidecarLogsCloseBtn) sidecarLogsCloseBtn.addEventListener("click", () => {
    const panel = document.querySelector("#sidecar-log-panel");
    if (panel) panel.style.display = "none";
  });
}

let exportColsState = { columns: [], roles: [], matrix: {} };

async function loadExportColumns() {
  const body = document.querySelector("#export-cols-body");
  if (!body) return;
  try {
    const response = await fetch("/api/data-tools/export-config");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Unable to load export columns.");
    }
    exportColsState = {
      columns: payload.columns || [],
      roles: payload.roles || [],
      matrix: payload.matrix || {},
    };
    renderExportColumns();
  } catch (error) {
    body.innerHTML = `<tr><td>${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderExportColumns() {
  const { columns, roles, matrix } = exportColsState;
  document.querySelector("#export-cols-header").innerHTML =
    `<th>Column</th>` +
    roles
      .map((role) => `<th style="text-align:center;">${escapeHtml(role.label)}</th>`)
      .join("");

  document.querySelector("#export-cols-body").innerHTML = columns
    .map((col) => {
      const cells = roles
        .map((role) => {
          const enabled = Boolean((matrix[role.key] || {})[col.key]);
          return `
            <td style="text-align:center;">
              <input
                type="checkbox"
                data-ec-role="${escapeHtmlAttribute(role.key)}"
                data-ec-col="${escapeHtmlAttribute(col.key)}"
                ${enabled ? "checked" : ""}
              >
            </td>`;
        })
        .join("");
      return `<tr><td><strong>${escapeHtml(col.label)}</strong></td>${cells}</tr>`;
    })
    .join("");
}

async function saveExportColumns() {
  const status = document.querySelector("#export-cols-status");
  status.textContent = "Saving...";

  const matrix = {};
  exportColsState.roles.forEach((role) => { matrix[role.key] = {}; });
  document.querySelectorAll("#export-cols-body input[type=checkbox]").forEach((input) => {
    const role = input.getAttribute("data-ec-role");
    const col = input.getAttribute("data-ec-col");
    if (role && col) {
      matrix[role] = matrix[role] || {};
      matrix[role][col] = input.checked;
    }
  });

  try {
    const response = await fetch("/api/data-tools/export-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ matrix }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to save.");
    status.textContent = "Saved.";
    window.setTimeout(() => { status.textContent = ""; }, 2500);
  } catch (error) {
    status.textContent = error.message || "Unable to save.";
  }
}

async function loadRoleConfig() {
  try {
    const response = await fetch("/api/role-config");
    const payload = await response.json();

    if (!response.ok) throw new Error(payload.error || "Unable to load configuration.");

    configState = {
      roles: payload.roles || [],
      capabilities: payload.capabilities || [],
      limits: payload.limits || [],
      config: payload.config || { permissions: {}, limits: {} },
      lockedCapabilities: payload.lockedCapabilities || {},
    };

    renderPermissionsTable();
    renderLimits();
  } catch (error) {
    permissionsTableBody.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderPermissionsTable() {
  const { roles, capabilities, config, lockedCapabilities } = configState;

  permissionsHeaderRow.innerHTML =
    `<th>Capability</th>` +
    roles.map((role) => `<th style="text-align:center;">${escapeHtml(role.label)}</th>`).join("");

  permissionsTableBody.innerHTML = capabilities
    .map((capability) => {
      const cells = roles
        .map((role) => {
          const enabled = Boolean((config.permissions[role.key] || {})[capability.key]);
          const locked = (lockedCapabilities[role.key] || []).indexOf(capability.key) !== -1;
          return `
            <td style="text-align:center;">
              <input
                type="checkbox"
                data-role="${escapeHtmlAttribute(role.key)}"
                data-capability="${escapeHtmlAttribute(capability.key)}"
                ${enabled ? "checked" : ""}
                ${locked ? "disabled title='Always enabled for this role'" : ""}
              >
            </td>`;
        })
        .join("");
      return `
        <tr>
          <td>
            <strong>${escapeHtml(capability.label)}</strong>
            <div style="font-size:12px;opacity:0.7;">${escapeHtml(capability.description || "")}</div>
          </td>
          ${cells}
        </tr>`;
    })
    .join("");
}

function renderLimits() {
  const { limits, config } = configState;
  limitsGrid.innerHTML = limits
    .map((limit) => {
      const value = config.limits[limit.key] !== undefined ? config.limits[limit.key] : limit.default;
      return `
        <label class="field">
          <span>${escapeHtml(limit.label)}</span>
          <input
            type="number"
            data-limit="${escapeHtmlAttribute(limit.key)}"
            value="${escapeHtmlAttribute(String(value))}"
            min="${escapeHtmlAttribute(String(limit.min))}"
            max="${escapeHtmlAttribute(String(limit.max))}"
          >
        </label>`;
    })
    .join("");
}

function collectConfigFromForm() {
  const permissions = {};
  configState.roles.forEach((role) => { permissions[role.key] = {}; });
  permissionsTableBody.querySelectorAll("input[type=checkbox]").forEach((input) => {
    const role = input.getAttribute("data-role");
    const capability = input.getAttribute("data-capability");
    if (role && capability) {
      permissions[role] = permissions[role] || {};
      permissions[role][capability] = input.checked;
    }
  });

  const limits = {};
  limitsGrid.querySelectorAll("input[data-limit]").forEach((input) => {
    const key = input.getAttribute("data-limit");
    const parsed = parseInt(input.value, 10);
    if (key && !Number.isNaN(parsed)) limits[key] = parsed;
  });

  return { permissions, limits };
}

async function saveRoleConfig() {
  configStatus.textContent = "Saving...";
  try {
    const response = await fetch("/api/role-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectConfigFromForm()),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to save configuration.");
    configState.config = payload.config || configState.config;
    renderPermissionsTable();
    renderLimits();
    configStatus.textContent = "Saved.";
    window.setTimeout(() => { configStatus.textContent = ""; }, 2500);
  } catch (error) {
    configStatus.textContent = error.message || "Unable to save.";
  }
}

async function loadExportFilters() {
  try {
    const response = await fetch("/api/export/filters");
    const payload = await response.json();
    if (!response.ok) return;
    fillSelect("#export-state", payload.states, "All states");
    fillSelect("#export-district", payload.districts, "All districts");
    fillSelect("#export-taluka", payload.talukas, "All talukas");
    fillSelect("#export-surname", payload.surnameGroups, "All surnames");
    fillSelect("#export-created-by", payload.createdBy, "All operators");
    fillSortOptions(payload.sortOptions);
    renderRelationCheckboxes(payload.relations);
  } catch (error) {
    /* filters are optional; ignore */
  }
}

function fillSortOptions(options) {
  const select = document.querySelector("#export-sort");
  if (!select) return;
  const list = Array.isArray(options) ? options : [];
  select.innerHTML = list
    .map((option) => `<option value="${escapeHtmlAttribute(option.key)}">${escapeHtml(option.label)}</option>`)
    .join("");
}

function renderRelationCheckboxes(relations) {
  const grid = document.querySelector("#relations-grid");
  if (!grid) return;
  const list = Array.isArray(relations) ? relations : [];
  grid.innerHTML = list
    .map((relation) => `
        <label style="display:flex;align-items:center;gap:8px;font-size:14px;">
          <input type="checkbox" class="relation-checkbox" value="${escapeHtmlAttribute(relation.key)}" checked>
          <span>${escapeHtml(relation.label)}</span>
        </label>`)
    .join("");

  const selectAll = document.querySelector("#relations-select-all");
  const clearAll = document.querySelector("#relations-clear");
  if (selectAll) selectAll.addEventListener("click", () => toggleAllRelations(true));
  if (clearAll) clearAll.addEventListener("click", () => toggleAllRelations(false));
}

function toggleAllRelations(checked) {
  document.querySelectorAll(".relation-checkbox").forEach((input) => { input.checked = checked; });
}

function selectedRelationKeys() {
  const checkboxes = Array.from(document.querySelectorAll(".relation-checkbox"));
  if (!checkboxes.length) return { keys: [], allSelected: true };
  const keys = checkboxes.filter((input) => input.checked).map((input) => input.value);
  return { keys, allSelected: keys.length === checkboxes.length };
}

function fillSelect(selector, values, allLabel) {
  const select = document.querySelector(selector);
  if (!select) return;
  const options = Array.isArray(values) ? values : [];
  select.innerHTML =
    `<option value="">${escapeHtml(allLabel)}</option>` +
    options.map((value) => `<option value="${escapeHtmlAttribute(value)}">${escapeHtml(value)}</option>`).join("");
}

function downloadExport() {
  const params = new URLSearchParams();
  params.set("mode", valueOf("#export-mode"));

  const sort = valueOf("#export-sort");
  if (sort) params.set("sort", sort);

  const q = valueOf("#export-q").trim();
  if (q) params.set("q", q);

  const map = {
    state: "#export-state",
    district: "#export-district",
    taluka: "#export-taluka",
    surname: "#export-surname",
    createdBy: "#export-created-by",
  };
  Object.keys(map).forEach((key) => {
    const value = valueOf(map[key]);
    if (value) params.set(key, value);
  });

  const relations = selectedRelationKeys();
  if (!relations.keys.length) {
    exportStatus.textContent = "Tick at least one relation to export.";
    return;
  }
  if (!relations.allSelected) params.set("relations", relations.keys.join(","));

  exportStatus.textContent = "Preparing download...";
  window.location.href = `/api/export?${params.toString()}`;
  window.setTimeout(() => { exportStatus.textContent = ""; }, 4000);
}

function valueOf(selector) {
  const element = document.querySelector(selector);
  return element ? element.value || "" : "";
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Public account types
// ---------------------------------------------------------------------------

let publicAccountsState = [];

async function readJsonOrThrow(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    if (response.status === 401 || response.status === 403) throw new Error("Your session expired. Please sign in again.");
    if (response.status === 404) throw new Error("Endpoint not found. The server may need to be restarted to load the latest changes.");
    throw new Error(`Unexpected server response (HTTP ${response.status}).`);
  }
  return response.json();
}

async function loadPublicAccounts() {
  const body = document.querySelector("#public-accounts-body");
  if (!body) return;
  try {
    const response = await fetch("/api/public-accounts");
    const payload = await readJsonOrThrow(response);
    if (!response.ok) throw new Error(payload.error || "Unable to load accounts.");
    publicAccountsState = payload.accounts || [];
    renderPublicAccounts();
  } catch (error) {
    body.innerHTML = `<tr><td colspan="4">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderPublicAccounts() {
  const body = document.querySelector("#public-accounts-body");
  if (!body) return;

  const searchInput = document.querySelector("#public-accounts-search");
  const term = (searchInput ? searchInput.value : "").trim().toLowerCase();
  const accounts = term
    ? publicAccountsState.filter((account) => String(account.mobileNumber || "").toLowerCase().includes(term))
    : publicAccountsState;

  if (!accounts.length) {
    body.innerHTML = `<tr><td colspan="4">No accounts found.</td></tr>`;
    return;
  }

  body.innerHTML = accounts
    .map((account) => {
      const isCampaigner = account.accountType === "campaigner";
      const nextType = isCampaigner ? "registrant" : "campaigner";
      const buttonLabel = isCampaigner ? "Make registrant" : "Make campaigner";
      const typeLabel = isCampaigner ? "Campaigner" : "Registrant";
      return `
        <tr>
          <td>${escapeHtml(account.mobileNumber)}</td>
          <td>${escapeHtml(typeLabel)}</td>
          <td>${escapeHtml(account.status || "")}</td>
          <td style="text-align:right;">
            <button type="button" class="button-ghost"
              data-account-id="${escapeHtmlAttribute(account.id)}"
              data-next-type="${escapeHtmlAttribute(nextType)}">
              ${escapeHtml(buttonLabel)}
            </button>
          </td>
        </tr>`;
    })
    .join("");

  body.querySelectorAll("button[data-account-id]").forEach((button) => {
    button.addEventListener("click", () => setAccountType(button.dataset.accountId, button.dataset.nextType));
  });
}

async function setAccountType(accountId, accountType) {
  const status = document.querySelector("#public-accounts-status");
  if (status) status.textContent = "Updating...";
  try {
    const response = await fetch(`/api/public-accounts/${accountId}/account-type`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountType }),
    });
    const payload = await readJsonOrThrow(response);
    if (!response.ok) throw new Error(payload.error || "Unable to update account.");
    const updated = payload.account;
    publicAccountsState = publicAccountsState.map((account) => account.id === updated.id ? updated : account);
    renderPublicAccounts();
    if (status) status.textContent = "Saved.";
  } catch (error) {
    if (status) status.textContent = error.message;
  }
}

// ---------------------------------------------------------------------------
// Global default account type for new mobile signups
// ---------------------------------------------------------------------------

async function loadSignupDefault() {
  const select = document.querySelector("#signup-default-type");
  if (!select) return;
  try {
    const response = await fetch("/api/public-signup-settings");
    const payload = await readJsonOrThrow(response);
    if (!response.ok) throw new Error(payload.error || "Unable to load setting.");
    select.value = payload.defaultAccountType || "registrant";
  } catch (error) {
    const status = document.querySelector("#signup-default-status");
    if (status) status.textContent = error.message;
  }
}

async function saveSignupDefault() {
  const select = document.querySelector("#signup-default-type");
  const status = document.querySelector("#signup-default-status");
  if (!select) return;
  if (status) status.textContent = "Saving...";
  try {
    const response = await fetch("/api/public-signup-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAccountType: select.value }),
    });
    const payload = await readJsonOrThrow(response);
    if (!response.ok) throw new Error(payload.error || "Unable to save setting.");
    select.value = payload.defaultAccountType;
    if (status) status.textContent = "Saved.";
  } catch (error) {
    if (status) status.textContent = error.message;
  }
}

// ---------------------------------------------------------------------------
// WhatsApp Sidecar Control
// ---------------------------------------------------------------------------

const SIDECAR_STATUS_COLORS = {
  connected: "#00ed64",
  connecting: "#f5a623",
  reconnecting: "#f5a623",
  disconnected: "#c1ccd6",
  unavailable: "#b42318",
  ok: "#00ed64",
};

async function loadSidecarStatus() {
  const body = document.querySelector("#sidecar-sessions-body");
  const dot = document.querySelector("#sidecar-health-dot");
  const healthText = document.querySelector("#sidecar-health-text");
  const detail = document.querySelector("#sidecar-health-detail");
  if (!body) return;

  body.innerHTML = "<tr><td colspan='5'>Loading...</td></tr>";

  try {
    const resp = await fetch("/api/wa-web/sidecar/status");
    const data = await resp.json();

    const isOk = data.health === "ok";
    if (dot) dot.style.background = isOk ? SIDECAR_STATUS_COLORS.ok : SIDECAR_STATUS_COLORS.unavailable;
    if (healthText) healthText.textContent = isOk ? "Sidecar running" : "Sidecar unavailable";
    if (detail) detail.textContent = isOk
      ? `${data.activeSessions} active session${data.activeSessions !== 1 ? "s" : ""} · MongoDB connected`
      : (data.error || "Cannot reach sidecar service");

    // Show Start button only when sidecar is down
    const startBtn = document.querySelector("#sidecar-start-btn");
    const reconnectAllBtn = document.querySelector("#sidecar-reconnect-all-btn");
    if (startBtn) startBtn.style.display = isOk ? "none" : "";
    if (reconnectAllBtn) reconnectAllBtn.style.display = isOk ? "" : "none";

    const sessions = data.sessions || [];
    if (!sessions.length) {
      body.innerHTML = "<tr><td colspan='5' style='color:var(--steel);'>No sessions found.</td></tr>";
      return;
    }

    body.innerHTML = sessions.map((s) => {
      const live = s.liveStatus || "unknown";
      const liveColor = SIDECAR_STATUS_COLORS[live] || SIDECAR_STATUS_COLORS.disconnected;
      const needsReconnect = live !== "connected" && live !== "connecting" && live !== "reconnecting";
      return `
        <tr>
          <td style="font-family:monospace;font-size:13px;">${escapeHtml(s.userId)}</td>
          <td>${escapeHtml(s.phoneNumber || "—")}</td>
          <td><span class="status-badge status-${escapeHtmlAttribute(s.dbStatus)}">${escapeHtml(s.dbStatus)}</span></td>
          <td>
            <span style="display:inline-flex;align-items:center;gap:6px;">
              <span style="width:8px;height:8px;border-radius:50%;background:${liveColor};flex-shrink:0;"></span>
              ${escapeHtml(live)}
            </span>
          </td>
          <td style="text-align:right;">
            <button type="button" class="button-ghost sidecar-reconnect-btn"
              data-user-id="${escapeHtmlAttribute(s.userId)}"
              ${!needsReconnect ? "disabled title='Already connected'" : ""}>
              Reconnect
            </button>
          </td>
        </tr>`;
    }).join("");

    body.querySelectorAll(".sidecar-reconnect-btn").forEach((btn) => {
      btn.addEventListener("click", () => sidecarReconnectOne(btn.dataset.userId, btn));
    });
  } catch (err) {
    if (dot) dot.style.background = SIDECAR_STATUS_COLORS.unavailable;
    if (healthText) healthText.textContent = "Sidecar unavailable";
    if (detail) detail.textContent = err.message;
    body.innerHTML = `<tr><td colspan='5' style='color:var(--danger);'>${escapeHtml(err.message)}</td></tr>`;
    const startBtn = document.querySelector("#sidecar-start-btn");
    const reconnectAllBtn = document.querySelector("#sidecar-reconnect-all-btn");
    if (startBtn) startBtn.style.display = "";
    if (reconnectAllBtn) reconnectAllBtn.style.display = "none";
  }
}

async function sidecarReconnectOne(userId, btn) {
  const statusEl = document.querySelector("#sidecar-action-status");
  btn.disabled = true;
  btn.textContent = "Reconnecting...";
  if (statusEl) { statusEl.style.color = ""; statusEl.textContent = ""; }

  try {
    const resp = await fetch(`/api/wa-web/sidecar/reconnect/${encodeURIComponent(userId)}`, { method: "POST" });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || "Failed");
    if (statusEl) statusEl.textContent = `✓ Reconnect started for ${userId}`;
    btn.textContent = "Reconnecting...";
    setTimeout(loadSidecarStatus, 4000);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Reconnect";
    if (statusEl) { statusEl.style.color = "var(--danger)"; statusEl.textContent = err.message; }
  }
}

async function sidecarViewLogs() {
  const panel = document.querySelector("#sidecar-log-panel");
  const content = document.querySelector("#sidecar-log-content");
  if (!panel || !content) return;

  panel.style.display = "block";
  content.textContent = "Loading...";

  try {
    const resp = await fetch("/api/wa-web/sidecar/logs?lines=100");
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    const lines = data.lines || [];
    content.textContent = lines.length
      ? lines.join("")
      : (data.note || "No log output yet.");
    // Scroll to bottom (newest entries)
    content.scrollTop = content.scrollHeight;
  } catch (err) {
    content.textContent = "Failed to load logs: " + err.message;
  }
}

async function sidecarStart() {
  const btn = document.querySelector("#sidecar-start-btn");
  const statusEl = document.querySelector("#sidecar-action-status");
  if (btn) { btn.disabled = true; btn.textContent = "Starting..."; }
  if (statusEl) { statusEl.textContent = "Starting sidecar, waiting for MongoDB…"; statusEl.style.color = ""; }

  try {
    // This call blocks up to ~20s on the server while waiting for health=ok
    const resp = await fetch("/api/wa-web/sidecar/start", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || "Failed to start");

    if (data.alreadyRunning) {
      if (statusEl) statusEl.textContent = "✓ Sidecar was already running.";
    } else {
      if (statusEl) statusEl.textContent = `✓ Sidecar started (health: ${data.health}). Reconnecting sessions…`;
      // Auto-trigger reconnect-all so sessions come back immediately
      await fetch("/api/wa-web/sidecar/reconnect-all", { method: "POST" });
    }
    setTimeout(loadSidecarStatus, 3000);
  } catch (err) {
    if (statusEl) { statusEl.style.color = "var(--danger)"; statusEl.textContent = err.message; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Start Sidecar"; }
  }
}

async function sidecarReconnectAll() {
  const btn = document.querySelector("#sidecar-reconnect-all-btn");
  const statusEl = document.querySelector("#sidecar-action-status");
  if (btn) { btn.disabled = true; btn.textContent = "Reconnecting..."; }
  if (statusEl) { statusEl.textContent = ""; statusEl.style.color = ""; }

  try {
    const resp = await fetch("/api/wa-web/sidecar/reconnect-all", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || "Failed");
    if (statusEl) statusEl.textContent = "✓ Reconnecting all sessions in background...";
    setTimeout(loadSidecarStatus, 5000);
  } catch (err) {
    if (statusEl) { statusEl.style.color = "var(--danger)"; statusEl.textContent = err.message; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Reconnect All"; }
  }
}
