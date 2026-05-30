const selfRegistrationAccount =
  window.SELF_REGISTRATION_ACCOUNT || {};
const initialSelfRegistration =
  window.INITIAL_SELF_REGISTRATION || {};
const historyContainer = document.querySelector(
  "#submission-history"
);
const verifiedMobileCopy = document.querySelector(
  "#verified-mobile-copy"
);

initializeSelfRegistrationPage();

function initializeSelfRegistrationPage() {
  if (verifiedMobileCopy) {
    verifiedMobileCopy.textContent =
      selfRegistrationAccount.mobileNumber || "";
  }

  const initialRecord = normalizeInitialSubmission(
    initialSelfRegistration
  );

  if (
    window.registrationFormApi &&
    hasRegistrationData(initialRecord)
  ) {
    window.registrationFormApi.populateRegistrationForm(
      initialRecord
    );
  }

  const mobileInput = document.querySelector(
    "#mobileNumber"
  );

  if (mobileInput && selfRegistrationAccount.mobileNumber) {
    mobileInput.value =
      selfRegistrationAccount.mobileNumber;
    mobileInput.readOnly = true;
  }

  loadSelfRegistrationHistory();

  document.addEventListener(
    "registration:submitted",
    (event) => {
      const detail = event.detail || {};

      if (
        detail.submitUrl !==
        "/api/self-registrations"
      ) {
        return;
      }

      loadSelfRegistrationHistory();
    }
  );
}

async function loadSelfRegistrationHistory() {
  if (!historyContainer) {
    return;
  }

  historyContainer.innerHTML = "Loading history...";

  try {
    const response = await fetch(
      "/api/self-registrations/me"
    );
    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body.error || "Unable to load history."
      );
    }

    const history = Array.isArray(body.history)
      ? body.history
      : [];

    if (!history.length) {
      historyContainer.innerHTML =
        "No pending versions yet.";
      return;
    }

    historyContainer.innerHTML = history
      .map(renderHistoryCard)
      .join("");
  } catch (error) {
    historyContainer.innerHTML =
      error.message || "Unable to load history.";
  }
}

function renderHistoryCard(item) {
  const fullName = [
    item.firstName?.en,
    item.middleName?.en,
    item.lastName?.en
  ]
    .filter(Boolean)
    .join(" ");

  const status = formatStatus(
    item.submissionStatus || "pending"
  );

  const auditItems = Array.isArray(item.auditTrail)
    ? item.auditTrail
        .map(
          (entry) => `
            <li>
              ${escapeHtml(formatStatus(entry.type || ""))}
              by
              ${escapeHtml(entry.actor || "-")}
              on
              ${escapeHtml(formatDate(entry.timestamp))}
              ${entry.note ? `(${escapeHtml(entry.note)})` : ""}
            </li>
          `
        )
        .join("")
    : "";

  return `
    <article class="recent-card">
      <strong>
        Version ${item.version || 1}
      </strong>
      <span>
        ${escapeHtml(fullName || "Unnamed applicant")}
      </span>
      <span>
        Status: ${escapeHtml(status)}
      </span>
      <span>
        Saved: ${escapeHtml(formatDate(item.createdAt))}
      </span>
      <ul style="margin:8px 0 0 18px;">
        ${auditItems}
      </ul>
    </article>
  `;
}

function normalizeInitialSubmission(value) {
  if (!value || !value.version) {
    return {};
  }

  return value;
}

function hasRegistrationData(value) {
  return Boolean(
    value.firstName ||
    value.mobileNumber ||
    (value.familyMembers || []).length
  );
}

function formatStatus(value) {
  return String(value || "")
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

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[character];
  });
}
