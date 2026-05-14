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
        <td colspan="6">
          Loading...
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
    const response = await fetch(
      `/api/member-search?${params}`
    );

    const body =
      await response.json();

    const totalMembersCount =
    document.querySelector(
        "#totalMembersCount"
    );

    if (totalMembersCount) {
    totalMembersCount.textContent =
        body.items.length;
    }

    if (!body.items?.length) {
      directoryTableBody.innerHTML =
        `
          <tr>
            <td colspan="6">
              No members found
            </td>
          </tr>
        `;

      return;
    }

    directoryTableBody.innerHTML =
      body.items
        .map(renderDirectoryRow)
        .join("");
  }

  catch (error) {
    console.error(error);

    directoryTableBody.innerHTML =
      `
        <tr>
          <td colspan="6">
            Failed to load members
          </td>
        </tr>
      `;
  }
}

function renderDirectoryRow(
  record
) {
  const englishName = [
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

  return `
    <tr>

      <td>
        <div class="member-name">
          ${escapeHtml(
            englishName
          )}
        </div>
      </td>

      <td>
        <div class="member-marathi">
          ${escapeHtml(
            marathiName
          )}
        </div>
      </td>

      <td>
        ${escapeHtml(
          record.district || ""
        )}
      </td>

      <td>
        ${escapeHtml(
          record.taluka || ""
        )}
      </td>

      <td>
        <span class="member-mobile">
          ${maskMobile(
            record.mobileNumber
          )}
        </span>
      </td>

      <td>
        <span class="member-count-pill">
          ${
            record.membersCount || 0
          }
        </span>
      </td>

    </tr>
  `;
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

