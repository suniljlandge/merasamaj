const LOCATION_DATA = {
  Maharashtra: {
    Washim: [
      "Washim",
      "Malegaon",
      "Mangrulpir",
      "Karanja",
      "Risod",
      "Manora"
    ],

    Amravati: [
      "Amravati",
      "Achalpur",
      "Chandur Railway",
      "Daryapur",
      "Morshi"
    ],

    Akola: [
      "Akola",
      "Balapur",
      "Patur",
      "Murtizapur"
    ],

    Buldhana: [
      "Buldhana",
      "Khamgaon",
      "Shegaon",
      "Malkapur"
    ],

    Yavatmal: [
      "Yavatmal",
      "Darwha",
      "Pusad",
      "Umarkhed"
    ]
  }
};

const searchInput =
  document.querySelector(
    "#searchInput"
  );

const searchButton =
  document.querySelector(
    "#searchButton"
  );

const filterDistrict =
  document.querySelector(
    "#filterDistrict"
  );

const filterTaluka =
  document.querySelector(
    "#filterTaluka"
  );

const directoryTableBody =
  document.querySelector(
    "#directoryTableBody"
  );

const totalMembersCount =
  document.querySelector(
    "#totalMembersCount"
  );

let currentPage = 1;
const PER_PAGE = 15;

setupSearchFilters();

loadMemberDirectory(currentPage);

searchButton.addEventListener(
  "click",
  () => {
    currentPage = 1;
    loadMemberDirectory(currentPage);
  }
);

searchInput.addEventListener(
  "keydown",
  (event) => {

    if (event.key === "Enter") {
      currentPage = 1;
      loadMemberDirectory(currentPage);
    }

  }
);

function setupSearchFilters() {

  const districts =
    Object.keys(
      LOCATION_DATA.Maharashtra
    );

  filterDistrict.innerHTML =
    `
      <option value="">
        All districts
      </option>
    ` +
    districts
      .map(
        (district) => `
          <option value="${district}">
            ${district}
          </option>
        `
      )
      .join("");

  filterDistrict.addEventListener(
    "change",
    () => {

      const talukas =
        LOCATION_DATA.Maharashtra[
          filterDistrict.value
        ] || [];

      filterTaluka.innerHTML =
        `
          <option value="">
            All talukas
          </option>
        ` +
        talukas
          .map(
            (taluka) => `
              <option value="${taluka}">
                ${taluka}
              </option>
            `
          )
          .join("");

      currentPage = 1;
      loadMemberDirectory(currentPage);
    }
  );

  filterTaluka.addEventListener(
    "change",
    () => {
      currentPage = 1;
      loadMemberDirectory(currentPage);
    }
  );
}

async function loadMemberDirectory(page = 1) {

  currentPage = Number(page) || 1;

  directoryTableBody.innerHTML =
    `
      <tr>
        <td colspan="7" class="px-6 py-10 text-center text-slate-500">
          Loading members...
        </td>
      </tr>
    `;

  const params =
    new URLSearchParams({

      q:
        searchInput.value || "",

      district:
        filterDistrict.value || "",

      taluka:
        filterTaluka.value || ""

    });

  // pagination params
  params.set("page", String(currentPage));
  params.set("per_page", String(PER_PAGE));

  try {

    const response =
      await fetch(
        `/api/member-search?${params}`
      );

    const body =
      await response.json();

    if (totalMembersCount) {

      totalMembersCount.textContent =
        body.total_count || 0;
    }

    if (!body.items?.length) {

      directoryTableBody.innerHTML =
        `
          <tr>
            <td
              colspan="7"
              class="
                px-6 py-10
                text-center
                text-slate-500
              "
            >
              No members found
            </td>
          </tr>
        `;

      renderPagination(body.total_count || 0, body.page || currentPage, body.per_page || PER_PAGE);

      return;
    }

    const pageNum = body.page || currentPage;
    const pageSize = body.per_page || PER_PAGE;
    const startIndex = ((pageNum - 1) * pageSize) || 0;

    directoryTableBody.innerHTML =
      body.items
        .map((item, index) => renderMemberRow(item, startIndex + index))
        .join("");

    renderPagination(body.total_count || 0, pageNum, pageSize);

  }

  catch (error) {

    console.error(error);

    directoryTableBody.innerHTML =
      `
        <tr>
          <td
            colspan="7"
            class="
              px-6 py-10
              text-center
              text-red-500
            "
          >
            Failed to load members
          </td>
        </tr>
      `;
  }
}

function renderPagination(totalCount, page, perPage) {
  const el = document.querySelector("#paginationControls");
  if (!el) return;

  if (!totalCount) {
    el.innerHTML = "";
    return;
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;

  el.innerHTML = `
    <div class="flex items-center gap-3">
      <button id="paginationPrev" class="px-3 py-1 rounded border ${prevDisabled ? 'opacity-50 pointer-events-none' : ''}">Prev</button>
      <div class="text-sm text-slate-600">Page ${page} of ${totalPages}</div>
      <button id="paginationNext" class="px-3 py-1 rounded border ${nextDisabled ? 'opacity-50 pointer-events-none' : ''}">Next</button>
    </div>
  `;

  const prevBtn = document.getElementById("paginationPrev");
  const nextBtn = document.getElementById("paginationNext");

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      if (page > 1) {
        currentPage = page - 1;
        loadMemberDirectory(currentPage);
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      if (page < totalPages) {
        currentPage = page + 1;
        loadMemberDirectory(currentPage);
      }
    });
  }
}

function renderMemberRow(
  record,
  index
) {

  const fullName = [

    record.firstName?.en,

    record.middleName?.en,

    record.lastName?.en

  ]
    .filter(Boolean)
    .join(" ");

  const marathiName = [

    record.firstName?.mr,

    record.middleName?.mr,

    record.lastName?.mr

  ]
    .filter(Boolean)
    .join(" ");

  const address =
    record.address1?.en || "-";

  const taluka =
    record.taluka || "-";

  const maskedMobile =
    maskMobile(
      record.mobileNumber
    );

const membersCount =
  calculateFamilyMembersCount(
    record.familyMembers || []
  ) + 1;

  return `
    <tr
      class="
        hover:bg-slate-50
        transition
      "
    >

      <td
        class="
          px-6 py-4
          font-semibold
          text-slate-500
          whitespace-nowrap
        "
      >
        ${index + 1}
      </td>

      <td
        class="
          px-6 py-4
          font-semibold
          whitespace-nowrap
        "
      >
        ${escapeHtml(fullName)}
      </td>

      <td
        class="
          px-6 py-4
          whitespace-nowrap
        "
      >
        ${escapeHtml(marathiName)}
      </td>

      <td
        class="
          px-6 py-4
        "
      >
        ${escapeHtml(address)}
      </td>

      <td
        class="
          px-6 py-4
          whitespace-nowrap
        "
      >
        ${escapeHtml(taluka)}
      </td>

      <td
        class="
          px-6 py-4
          whitespace-nowrap
        "
      >
        ${escapeHtml(maskedMobile)}
      </td>

      <td
        class="
          px-6 py-4
          whitespace-nowrap
        "
      >
        ${membersCount}
      </td>
<td class="px-6 py-4">

  ${renderActionButtons(record)}

</td>
    </tr>
  `;
}


function renderActionButtons(
  record
) {

  const role =
    window.CURRENT_ROLE;
  const currentUsername =
    window.CURRENT_USERNAME || "";
  const currentOwnedRegistrationId =
    window.CURRENT_OWNED_REGISTRATION_ID || "";

  const canEdit =
  role === "admin" ||
  role === "super_admin" ||
  (
    role === "operator" &&
    record.createdBy === currentUsername
  ) ||
  (
    role === "viewer" &&
    (
      record.createdBy === currentUsername ||
      record._id === currentOwnedRegistrationId
    )
  );
  const canView =
    role === "admin" ||
    role === "super_admin" ||
    (
      role === "operator" &&
      record.createdBy === currentUsername
    ) ||
    (
      role === "viewer" &&
      (
        record.createdBy === currentUsername ||
        record._id === currentOwnedRegistrationId
      )
    );
  const canViewTree =
    role === "admin" ||
    role === "super_admin" ||
    role === "operator";

  const canDelete =
    role === "admin" ||
    role === "super_admin";

  if (!canView && !canEdit && !canViewTree) {
    return "";
  }

  return `
    <div
      style="
        display:flex;
        gap:8px;
      "
    >

      ${
        canView
          ? `
            <button
              class="button-secondary"
              onclick="viewMember('${record._id}')"
            >
              View
            </button>
          `
          : ""
      }

      ${
        canViewTree
          ? `
            <button
              class="button-secondary"
              onclick="viewFamilyTree('${record._id}')"
            >
              Tree
            </button>
          `
          : ""
      }

      ${
        canEdit
          ? `
            <button
              class="button-primary"
              onclick="editMember('${record._id}')"
            >
              Edit
            </button>
          `
          : ""
      }

      ${
        canDelete
          ? `
            <button
              class="button-secondary"
              style="color:#b91c1c;border-color:#fecaca"
              onclick="deleteMember('${record._id}')"
            >
              Delete
            </button>
          `
          : ""
      }

    </div>
  `;
}


function viewMember(id) {

  window.location.href =
    `/view-member/${id}`;
}

function editMember(id) {

  window.location.href =
    `/edit-member/${id}`;
}

function viewFamilyTree(id) {

  window.location.href =
    `/family-tree/${id}`;
}

async function deleteMember(id) {

  if (!confirm("Delete this member? This cannot be undone.")) {
    return;
  }
  const selector = `[onclick="deleteMember('${id}')"]`;
  let btn = document.querySelector(selector);
  const originalText = btn ? btn.textContent : null;

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Deleting...";
    }

    const res = await fetch(`/api/registrations/${id}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (res.ok) {
      alert("Member deleted");

      if (btn) {
        const row = btn.closest("tr");
        if (row) row.remove();
      }

      if (totalMembersCount) {
        const n = Number(totalMembersCount.textContent || 0) - 1;
        totalMembersCount.textContent = String(n >= 0 ? n : 0);
      }

      return;
    }

    const body = await res.json().catch(() => ({}));
    alert(body.error || "Failed to delete member");

  } catch (err) {
    console.error(err);
    alert("Failed to delete member");
  } finally {
    btn = document.querySelector(selector);
    if (btn) {
      btn.disabled = false;
      if (originalText) btn.textContent = originalText;
    }
  }

}

function calculateFamilyMembersCount(
  members = []
) {
  const excludedMarriedRelations =
    new Set([
      "daughter",
      "daughter(beti)",
      "granddaughter",
      "granddaughter(poti)",
      "grand-daughter",
      "sister",
      "sister(behen)"
    ]);
  const countedSpouseRelations =
    new Set([
      "son",
      "grandson",
      "grand-son",
      "brother",
      "uncle",
      "cousin",
      "nephew"
    ]);

  return members.reduce(
    (total, member) => {
      const relation =
        readRelationText(
          member.relationToApplicant
          || member.relation
          || ""
        )
          .toLowerCase();
      const married =
        member.isMarried === true;

      if (
        married
        && excludedMarriedRelations.has(relation)
      ) {
        return total;
      }

      let nextTotal =
        total + 1;

      if (
        married
        && countedSpouseRelations.has(relation)
        && member.spouseName?.en
      ) {
        nextTotal += 1;
      }

      return nextTotal;
    },
    0
  );
}

function readRelationText(value = "") {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    return value.en || value.mr || "";
  }

  return "";
}

function maskMobile(
  mobile
) {

  mobile =
    String(mobile || "");

  if (mobile.length < 4) {
    return mobile;
  }

  const last4 =
    mobile.slice(-4);

  return `XXXXXX${last4}`;
}

function escapeHtml(
  value = ""
) {

  return String(value)
    .replace(
      /[&<>"']/g,
      (character) => {

        const entities = {

          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;"

        };

        return entities[
          character
        ];
      }
    );
}
