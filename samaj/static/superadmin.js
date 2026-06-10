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

  if (saveConfigBtn) {
    saveConfigBtn.addEventListener("click", saveRoleConfig);
  }
  if (exportBtn) {
    exportBtn.addEventListener("click", downloadExport);
  }
}

async function loadRoleConfig() {
  try {
    const response = await fetch("/api/role-config");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to load configuration.");
    }

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
    permissionsTableBody.innerHTML = `
      <tr><td colspan="5">${escapeHtml(error.message)}</td></tr>
    `;
  }
}

function renderPermissionsTable() {
  const { roles, capabilities, config, lockedCapabilities } = configState;

  permissionsHeaderRow.innerHTML =
    `<th>Capability</th>` +
    roles
      .map((role) => `<th style="text-align:center;">${escapeHtml(role.label)}</th>`)
      .join("");

  permissionsTableBody.innerHTML = capabilities
    .map((capability) => {
      const cells = roles
        .map((role) => {
          const enabled = Boolean(
            (config.permissions[role.key] || {})[capability.key]
          );
          const locked =
            (lockedCapabilities[role.key] || []).indexOf(capability.key) !== -1;

          return `
            <td style="text-align:center;">
              <input
                type="checkbox"
                data-role="${escapeHtmlAttribute(role.key)}"
                data-capability="${escapeHtmlAttribute(capability.key)}"
                ${enabled ? "checked" : ""}
                ${locked ? "disabled title='Always enabled for this role'" : ""}
              >
            </td>
          `;
        })
        .join("");

      return `
        <tr>
          <td>
            <strong>${escapeHtml(capability.label)}</strong>
            <div style="font-size:12px;opacity:0.7;">
              ${escapeHtml(capability.description || "")}
            </div>
          </td>
          ${cells}
        </tr>
      `;
    })
    .join("");
}

function renderLimits() {
  const { limits, config } = configState;

  limitsGrid.innerHTML = limits
    .map((limit) => {
      const value =
        config.limits[limit.key] !== undefined
          ? config.limits[limit.key]
          : limit.default;

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
        </label>
      `;
    })
    .join("");
}

function collectConfigFromForm() {
  const permissions = {};

  configState.roles.forEach((role) => {
    permissions[role.key] = {};
  });

  permissionsTableBody
    .querySelectorAll("input[type=checkbox]")
    .forEach((input) => {
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
    if (key && !Number.isNaN(parsed)) {
      limits[key] = parsed;
    }
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

    if (!response.ok) {
      throw new Error(payload.error || "Unable to save configuration.");
    }

    configState.config = payload.config || configState.config;
    renderPermissionsTable();
    renderLimits();
    configStatus.textContent = "Saved.";
    window.setTimeout(() => {
      configStatus.textContent = "";
    }, 2500);
  } catch (error) {
    configStatus.textContent = error.message || "Unable to save.";
  }
}

async function loadExportFilters() {
  try {
    const response = await fetch("/api/export/filters");
    const payload = await response.json();

    if (!response.ok) {
      return;
    }

    fillSelect("#export-state", payload.states, "All states");
    fillSelect("#export-district", payload.districts, "All districts");
    fillSelect("#export-taluka", payload.talukas, "All talukas");
    fillSelect("#export-surname", payload.surnameGroups, "All surnames");
    fillSelect("#export-created-by", payload.createdBy, "All operators");
  } catch (error) {
    /* filters are optional; ignore */
  }
}

function fillSelect(selector, values, allLabel) {
  const select = document.querySelector(selector);
  if (!select) {
    return;
  }
  const options = Array.isArray(values) ? values : [];
  select.innerHTML =
    `<option value="">${escapeHtml(allLabel)}</option>` +
    options
      .map(
        (value) =>
          `<option value="${escapeHtmlAttribute(value)}">${escapeHtml(value)}</option>`
      )
      .join("");
}

function downloadExport() {
  const params = new URLSearchParams();
  params.set("mode", valueOf("#export-mode"));

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
    if (value) {
      params.set(key, value);
    }
  });

  exportStatus.textContent = "Preparing download...";
  window.location.href = `/api/export?${params.toString()}`;
  window.setTimeout(() => {
    exportStatus.textContent = "";
  }, 4000);
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
