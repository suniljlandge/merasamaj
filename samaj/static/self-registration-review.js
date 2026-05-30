const reviewList = document.querySelector(
  "#self-registration-review-list"
);
const submissionViewer = document.querySelector(
  "#submission-viewer"
);
const submissionViewerBody = document.querySelector(
  "#submission-viewer-body"
);
const reviewItemsByAccountId = new Map();

if (reviewList) {
  loadReviewQueue();
}

async function loadReviewQueue() {
  reviewList.innerHTML = "Loading submissions...";

  try {
    const response = await fetch(
      "/api/self-registrations/review"
    );
    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body.error || "Unable to load review queue."
      );
    }

    const items = Array.isArray(body.items)
      ? body.items
      : [];
    reviewItemsByAccountId.clear();

    items.forEach((item) => {
      const accountId = item.account?.id;

      if (accountId) {
        reviewItemsByAccountId.set(accountId, item);
      }
    });

    if (!items.length) {
      reviewList.innerHTML =
        "No self-registration submissions found.";
      return;
    }

    reviewList.innerHTML = items
      .map(renderReviewCard)
      .join("");
  } catch (error) {
    reviewList.innerHTML =
      error.message || "Unable to load review queue.";
  }
}

function renderReviewCard(item) {
  const account = item.account || {};
  const submission = item.latestSubmission || {};
  const history = Array.isArray(item.history)
    ? item.history
    : [];
  const fullName = [
    submission.firstName?.en,
    submission.middleName?.en,
    submission.lastName?.en
  ]
    .filter(Boolean)
    .join(" ");

  const historyMarkup = history
    .map(
      (entry) => `
        <li>
          Version ${entry.version || 1}
          -
          ${escapeHtml(entry.submissionStatus || "pending")}
          -
          ${escapeHtml(formatDate(entry.createdAt))}
          <button
            type="button"
            class="button-ghost"
            data-view-submission="${escapeHtmlAttribute(account.id || "")}"
            data-view-version="${escapeHtmlAttribute(String(entry.version || 1))}"
            style="margin-left:8px;"
          >
            View
          </button>
        </li>
      `
    )
    .join("");

  return `
    <article class="recent-card" style="margin-bottom:16px;">
      <strong>${escapeHtml(fullName || "Unnamed applicant")}</strong>
      <span>Mobile: ${escapeHtml(account.mobileNumber || "-")}</span>
      <span>Status: ${escapeHtml(account.status || "pending")}</span>
      <span>Latest version: ${submission.version || 0}</span>
      <span>${escapeHtml(submission.district || "-")}, ${escapeHtml(submission.taluka || "-")}</span>
      <details style="margin-top:10px;">
        <summary>Version history</summary>
        <ul style="margin:10px 0 0 18px;">
          ${historyMarkup}
        </ul>
      </details>
      <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:16px;">
        <button
          type="button"
          class="button-secondary"
          data-view-submission="${escapeHtmlAttribute(account.id || "")}"
          data-view-version="${escapeHtmlAttribute(String(submission.version || 0))}"
        >
          View full form
        </button>
        <button
          type="button"
          class="button-primary"
          data-approve-account="${escapeHtmlAttribute(account.id || "")}"
        >
          Approve
        </button>
        <button
          type="button"
          class="button-secondary"
          data-reject-account="${escapeHtmlAttribute(account.id || "")}"
        >
          Reject
        </button>
      </div>
    </article>
  `;
}

document.addEventListener("click", async (event) => {
  const approveButton = event.target.closest(
    "[data-approve-account]"
  );
  const rejectButton = event.target.closest(
    "[data-reject-account]"
  );
  const viewButton = event.target.closest(
    "[data-view-submission]"
  );
  const closeButton = event.target.closest(
    "[data-close-review-modal]"
  );

  if (viewButton) {
    openSubmissionViewer(
      viewButton.dataset.viewSubmission,
      Number(viewButton.dataset.viewVersion || 0)
    );
    return;
  }

  if (closeButton) {
    closeSubmissionViewer();
    return;
  }

  if (approveButton) {
    await submitReviewAction(
      approveButton.dataset.approveAccount,
      "approve",
      "Approval note (optional):"
    );
  }

  if (rejectButton) {
    await submitReviewAction(
      rejectButton.dataset.rejectAccount,
      "reject",
      "Rejection note (optional):"
    );
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSubmissionViewer();
  }
});

async function submitReviewAction(accountId, action, promptText) {
  if (!accountId) {
    return;
  }

  const note = window.prompt(promptText) || "";

  try {
    const response = await fetch(
      `/api/self-registrations/${encodeURIComponent(accountId)}/${action}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ note })
      }
    );
    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body.error || `Unable to ${action} submission.`
      );
    }

    window.alert(
      `Submission ${action}d successfully.`
    );
    loadReviewQueue();
  } catch (error) {
    window.alert(
      error.message || `Unable to ${action} submission.`
    );
  }
}

function openSubmissionViewer(accountId, versionNumber) {
  if (!submissionViewer || !submissionViewerBody) {
    return;
  }

  const item = reviewItemsByAccountId.get(accountId);

  if (!item) {
    window.alert("Submission details not found.");
    return;
  }

  const history = Array.isArray(item.history)
    ? item.history
    : [];
  const submission = history.find(
    (entry) => Number(entry.version || 0) === Number(versionNumber || 0)
  ) || item.latestSubmission || {};

  submissionViewerBody.innerHTML =
    renderSubmissionViewer(submission);
  submissionViewer.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSubmissionViewer() {
  if (!submissionViewer) {
    return;
  }

  submissionViewer.hidden = true;
  document.body.style.overflow = "";
}

function renderSubmissionViewer(submission) {
  const fullName = formatFullName(submission);
  const familyMembers = Array.isArray(submission.familyMembers)
    ? submission.familyMembers
    : [];

  const familyMarkup = familyMembers.length
    ? familyMembers.map(renderFamilyMemberCard).join("")
    : "<p>No family members added.</p>";

  return `
    <div class="review-detail-grid">
      <article class="review-detail-card">
        <h3>Applicant</h3>
        ${renderDetailRow("Version", submission.version || 0)}
        ${renderDetailRow("Status", formatStatus(submission.submissionStatus || "pending"))}
        ${renderDetailRow("Name", fullName || "-")}
        ${renderDetailRow("Name (Marathi)", formatFullName(submission, "mr") || "-")}
        ${renderDetailRow("Birth date", submission.birthDate || "-")}
        ${renderDetailRow("Birth year", submission.birthYear || "-")}
        ${renderDetailRow("Mobile", submission.mobileNumber || "-")}
      </article>

      <article class="review-detail-card">
        <h3>Address</h3>
        ${renderDetailRow("Address 1", submission.address1?.en || "-")}
        ${renderDetailRow("Address 1 (Marathi)", submission.address1?.mr || "-")}
        ${renderDetailRow("Address 2", submission.address2?.en || "-")}
        ${renderDetailRow("Address 2 (Marathi)", submission.address2?.mr || "-")}
        ${renderDetailRow("State", submission.state || "-")}
        ${renderDetailRow("District", submission.district || "-")}
        ${renderDetailRow("Taluka", submission.taluka || "-")}
      </article>
    </div>

    <article class="review-detail-card" style="margin-top:16px;">
      <h3>Family members</h3>
      <div class="review-family-grid">
        ${familyMarkup}
      </div>
    </article>
  `;
}

function renderFamilyMemberCard(member) {
  return `
    <article class="review-family-card">
      <strong>${escapeHtml(formatMemberName(member) || "Unnamed member")}</strong>
      <span>Relation: ${escapeHtml(member.relationToApplicant || member.relation || "-")}</span>
      <span>Mobile: ${escapeHtml(member.contactNumber || "-")}</span>
      <span>Married: ${member.isMarried ? "Yes" : "No"}</span>
      <span>Spouse: ${escapeHtml(formatMemberName({ name: member.spouseName }) || "-")}</span>
      <span>Spouse mobile: ${escapeHtml(member.spouseContactNumber || "-")}</span>
      <span>Current city: ${escapeHtml(member.currentCity || "-")}</span>
    </article>
  `;
}

function renderDetailRow(label, value) {
  return `
    <div class="review-detail-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value || "-"))}</strong>
    </div>
  `;
}

function formatFullName(record, language = "en") {
  return [
    record.firstName?.[language],
    record.middleName?.[language],
    record.lastName?.[language]
  ]
    .filter(Boolean)
    .join(" ");
}

function formatMemberName(member) {
  return member?.name?.en || member?.name?.mr || "";
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

function escapeHtmlAttribute(value = "") {
  return escapeHtml(value);
}
