const userForm = document.querySelector(
  "#user-management-form"
);
const userRoleSelect = document.querySelector(
  "#new-role"
);
const usersTableBody = document.querySelector(
  "#users-table-body"
);

const allowedUserRoles = Array.isArray(
  window.ALLOWED_USER_ROLES
)
  ? window.ALLOWED_USER_ROLES
  : [];
const currentRole = window.CURRENT_ROLE || "";

initializeUserManagement();

function initializeUserManagement() {
  if (!userForm || !userRoleSelect || !usersTableBody) {
    return;
  }

  renderRoleOptions();
  loadUsers();
  userForm.addEventListener(
    "submit",
    handleUserCreate
  );
}

function renderRoleOptions() {
  userRoleSelect.innerHTML = allowedUserRoles
    .map(
      (role) => `
        <option value="${role}">
          ${formatRole(role)}
        </option>
      `
    )
    .join("");
}

async function loadUsers() {
  try {
    const response = await fetch("/api/users");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        payload.error || "Unable to load users."
      );
    }

    const users = Array.isArray(payload.items)
      ? payload.items
      : [];

    if (!users.length) {
      usersTableBody.innerHTML = `
        <tr>
          <td colspan="6">No users found.</td>
        </tr>
      `;
      return;
    }

    usersTableBody.innerHTML = users
      .map(renderUserRow)
      .join("");
  } catch (error) {
    usersTableBody.innerHTML = `
      <tr>
        <td colspan="6">${escapeHtml(error.message)}</td>
      </tr>
    `;
  }
}

async function handleUserCreate(event) {
  event.preventDefault();

  const username = document.querySelector(
    "#new-username"
  ).value.trim();
  const password = document.querySelector(
    "#new-password"
  ).value;
  const role = userRoleSelect.value;

  try {
    const response = await fetch("/api/users", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username,
        password,
        role
      })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        payload.error || "Unable to create user."
      );
    }

    userForm.reset();
    renderRoleOptions();
    window.alert("User created successfully.");
    await loadUsers();
  } catch (error) {
    window.alert(
      error.message || "Unable to create user."
    );
  }
}

function renderUserRow(user) {
  const deleteAction = canDeleteUser(user)
    ? `
      <button
        type="button"
        class="button-ghost"
        data-delete-username="${escapeHtmlAttribute(user.username || "")}"
      >
        Delete
      </button>
    `
    : "";

  const changePasswordAction = canChangePassword(user)
    ? `
      <button
        type="button"
        class="button-ghost"
        data-change-password-username="${escapeHtmlAttribute(user.username || "")}"
      >
        Change password
      </button>
    `
    : "";

  const actions = [changePasswordAction, deleteAction].filter(Boolean).join("") || "-";

  return `
    <tr>
      <td>${escapeHtml(user.username || "")}</td>
      <td>${escapeHtml(formatRole(user.role || ""))}</td>
      <td>${user.isActive ? "Yes" : "No"}</td>
      <td>${escapeHtml(user.createdBy || "-")}</td>
      <td>${escapeHtml(formatDate(user.createdAt))}</td>
      <td style="white-space:nowrap;">${actions}</td>
    </tr>
  `;
}

function canChangePassword(user) {
  const role = user.role || "";

  if (currentRole === "super_admin") {
    return true;
  }

  if (currentRole === "admin") {
    return role === "operator" || role === "viewer";
  }

  return false;
}

function canDeleteUser(user) {
  const role = user.role || "";

  if (currentRole === "super_admin") {
    return true;
  }

  if (currentRole === "admin") {
    return role === "operator" || role === "viewer";
  }

  return false;
}

document.addEventListener("click", async (event) => {
  const deleteButton = event.target.closest(
    "[data-delete-username]"
  );

  if (deleteButton) {
    const username = deleteButton.dataset.deleteUsername || "";

    if (!username) return;

    const confirmed = window.confirm(
      `Delete user "${username}"?`
    );

    if (!confirmed) return;

    deleteButton.disabled = true;

    try {
      const response = await fetch(
        `/api/users/${encodeURIComponent(username)}`,
        { method: "DELETE" }
      );

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(
          payload.error || "Unable to delete user."
        );
      }

      window.alert("User deleted successfully.");
      await loadUsers();
    } catch (error) {
      deleteButton.disabled = false;
      window.alert(
        error.message || "Unable to delete user."
      );
    }

    return;
  }

  const changePasswordButton = event.target.closest(
    "[data-change-password-username]"
  );

  if (changePasswordButton) {
    const username = changePasswordButton.dataset.changePasswordUsername || "";
    openChangePasswordDialog(username);
  }
});

function formatRole(role) {
  return role
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

// ── Change Password Modal ────────────────────────────────────────────────────

const changePasswordDialog = document.querySelector("#change-password-dialog");
const changePasswordForm = document.querySelector("#change-password-form");
const changePasswordLabel = document.querySelector("#change-password-label");
const changePasswordInput = document.querySelector("#change-password-input");
const changePasswordConfirm = document.querySelector("#change-password-confirm");
const changePasswordError = document.querySelector("#change-password-error");
const changePasswordCancel = document.querySelector("#change-password-cancel");
const changePasswordSubmit = document.querySelector("#change-password-submit");

let pendingChangePasswordUsername = null;

function openChangePasswordDialog(username) {
  pendingChangePasswordUsername = username;
  changePasswordLabel.textContent = `Set a new password for "${username}"`;
  changePasswordInput.value = "";
  changePasswordConfirm.value = "";
  changePasswordError.textContent = "";
  changePasswordDialog.showModal();
  changePasswordInput.focus();
}

if (changePasswordCancel) {
  changePasswordCancel.addEventListener("click", () => {
    changePasswordDialog.close();
  });
}

if (changePasswordForm) {
  changePasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    changePasswordError.textContent = "";

    const password = changePasswordInput.value;
    const confirm = changePasswordConfirm.value;

    if (password.length < 6) {
      changePasswordError.textContent = "Password must be at least 6 characters.";
      return;
    }

    if (password !== confirm) {
      changePasswordError.textContent = "Passwords do not match.";
      return;
    }

    changePasswordSubmit.disabled = true;
    changePasswordSubmit.textContent = "Saving...";

    try {
      const username = pendingChangePasswordUsername;
      const response = await fetch(
        `/api/users/${encodeURIComponent(username)}/password`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        }
      );

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Unable to change password.");
      }

      changePasswordDialog.close();
      window.alert(`Password for "${username}" changed successfully.`);
    } catch (error) {
      changePasswordError.textContent = error.message || "Unable to change password.";
    } finally {
      changePasswordSubmit.disabled = false;
      changePasswordSubmit.textContent = "Save";
    }
  });
}
