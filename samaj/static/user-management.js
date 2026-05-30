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
    : "-";

  return `
    <tr>
      <td>${escapeHtml(user.username || "")}</td>
      <td>${escapeHtml(formatRole(user.role || ""))}</td>
      <td>${user.isActive ? "Yes" : "No"}</td>
      <td>${escapeHtml(user.createdBy || "-")}</td>
      <td>${escapeHtml(formatDate(user.createdAt))}</td>
      <td>${deleteAction}</td>
    </tr>
  `;
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

  if (!deleteButton) {
    return;
  }

  const username = deleteButton.dataset.deleteUsername || "";

  if (!username) {
    return;
  }

  const confirmed = window.confirm(
    `Delete user "${username}"?`
  );

  if (!confirmed) {
    return;
  }

  deleteButton.disabled = true;

  try {
    const response = await fetch(
      `/api/users/${encodeURIComponent(username)}`,
      {
        method: "DELETE"
      }
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
