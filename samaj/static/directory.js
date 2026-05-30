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

setupSearchFilters();

loadMemberDirectory();

searchButton.addEventListener(
  "click",
  loadMemberDirectory
);

searchInput.addEventListener(
  "keydown",
  (event) => {

    if (event.key === "Enter") {
      loadMemberDirectory();
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

      loadMemberDirectory();
    }
  );

  filterTaluka.addEventListener(
    "change",
    loadMemberDirectory
  );
}

async function loadMemberDirectory() {

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

  try {

    const response =
      await fetch(
        `/api/member-search?${params}`
      );

    const body =
      await response.json();

    if (totalMembersCount) {

      totalMembersCount.textContent =
        body.items.length;
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

      return;
    }

    directoryTableBody.innerHTML =
      body.items
        .map(
          (
            item,
            index
          ) =>
            renderMemberRow(
              item,
              index
            )
        )
        .join("");

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

  if (!canView && !canEdit) {
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

function calculateFamilyMembersCount(
  members = []
) {
  const excludedMarriedRelations =
    new Set([
      "daughter",
      "granddaughter",
      "grand-daughter",
      "sister"
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
